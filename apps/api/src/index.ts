import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { runAgent } from "@mvp/worker";

const app = express();
const port = Number.parseInt(process.env.API_PORT ?? "4000", 10);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workspaceRoot = path.join(repoRoot, "workspace");
const docsRoot = path.join(workspaceRoot, "docs");

type RunEvent = {
  event: "started" | "progress" | "done" | "error";
  data: Record<string, unknown>;
};

type RunState = {
  id: string;
  events: RunEvent[];
  listeners: Set<(event: RunEvent) => void>;
  status: "running" | "done" | "error";
};

const runs = new Map<string, RunState>();

const ensureDocsPath = (relativePath: string) => {
  if (!relativePath || relativePath.includes("..")) {
    throw new Error("Invalid path.");
  }
  const resolved = path.resolve(docsRoot, relativePath);
  const normalizedDocsRoot = path.resolve(docsRoot) + path.sep;
  if (!resolved.startsWith(normalizedDocsRoot)) {
    throw new Error("Path escapes workspace/docs.");
  }
  if (path.extname(resolved) !== ".md") {
    throw new Error("Only markdown files are allowed.");
  }
  return resolved;
};

const listMarkdownFiles = async (dir: string, base: string): Promise<string[]> => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(fullPath, base)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const relative = path.relative(base, fullPath).split(path.sep).join("/");
      files.push(relative);
    }
  }
  return files.sort();
};

const emitRunEvent = (run: RunState, event: RunEvent) => {
  run.events.push(event);
  for (const listener of run.listeners) {
    listener(event);
  }
};

app.get("/api/files", async (_req, res) => {
  try {
    await fs.mkdir(docsRoot, { recursive: true });
    const files = await listMarkdownFiles(docsRoot, docsRoot);
    res.json({ files });
  } catch (error) {
    res.status(500).json({ error: "Failed to list files." });
  }
});

app.get("/api/file", async (req, res) => {
  try {
    const relative = String(req.query.path ?? "");
    const resolved = ensureDocsPath(relative);
    const content = await fs.readFile(resolved, "utf8");
    res.json({ path: relative, content });
  } catch (error) {
    res.status(400).json({ error: "Invalid file path." });
  }
});

app.post("/api/run", async (req, res) => {
  const prompt = String(req.body?.prompt ?? "").trim();
  if (!prompt) {
    res.status(400).json({ error: "Prompt is required." });
    return;
  }

  const runId = randomUUID();
  const run: RunState = {
    id: runId,
    events: [],
    listeners: new Set(),
    status: "running"
  };
  runs.set(runId, run);

  emitRunEvent(run, { event: "started", data: { message: "Run started" } });
  emitRunEvent(run, { event: "progress", data: { message: "Agent running" } });

  void (async () => {
    try {
      const result = await runAgent({ prompt, workspaceRoot });
      run.status = "done";
      emitRunEvent(run, {
        event: "done",
        data: { message: "Run completed", outputPath: result.outputPath }
      });
    } catch (error) {
      run.status = "error";
      emitRunEvent(run, {
        event: "error",
        data: {
          message: error instanceof Error ? error.message : "Run failed"
        }
      });
    }
  })();

  res.json({ runId });
});

app.get("/api/run/:id/events", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  const sendEvent = (event: RunEvent) => {
    res.write(`event: ${event.event}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  };

  run.events.forEach(sendEvent);
  const listener = (event: RunEvent) => sendEvent(event);
  run.listeners.add(listener);

  const keepAlive = setInterval(() => {
    res.write(`event: ping\ndata: {}\n\n`);
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    run.listeners.delete(listener);
  });
});

app.listen(port, async () => {
  await fs.mkdir(docsRoot, { recursive: true });
  console.log(`API listening on http://localhost:${port}`);
});
