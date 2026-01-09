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

app.post("/api/file", async (req, res) => {
  try {
    const relative = String(req.body?.path ?? "").trim();
    if (!relative) {
      res.status(400).json({ error: "Path is required." });
      return;
    }
    const resolved = ensureDocsPath(relative);
    const content = String(req.body?.content ?? "");
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf8");
    res.json({ path: relative });
  } catch (error) {
    res.status(400).json({ error: "Failed to create file." });
  }
});

app.patch("/api/file", async (req, res) => {
  try {
    const relative = String(req.body?.path ?? "").trim();
    const nextPath = String(req.body?.newPath ?? "").trim();
    if (!relative || !nextPath) {
      res.status(400).json({ error: "Path and newPath are required." });
      return;
    }
    const resolved = ensureDocsPath(relative);
    const resolvedNext = ensureDocsPath(nextPath);
    await fs.mkdir(path.dirname(resolvedNext), { recursive: true });
    await fs.rename(resolved, resolvedNext);
    res.json({ path: nextPath });
  } catch (error) {
    res.status(400).json({ error: "Failed to rename file." });
  }
});

app.delete("/api/file", async (req, res) => {
  try {
    const relative = String(req.query.path ?? "");
    const resolved = ensureDocsPath(relative);
    await fs.rm(resolved);
    res.json({ path: relative });
  } catch (error) {
    res.status(400).json({ error: "Failed to delete file." });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const query = String(req.query.query ?? "").trim().toLowerCase();
    if (!query) {
      res.json({ results: [] });
      return;
    }
    const files = await listMarkdownFiles(docsRoot, docsRoot);
    const results = [];
    for (const file of files) {
      const resolved = ensureDocsPath(file);
      const content = await fs.readFile(resolved, "utf8");
      const index = content.toLowerCase().indexOf(query);
      if (index >= 0) {
        const start = Math.max(0, index - 60);
        const end = Math.min(content.length, index + 60);
        const snippet = content.slice(start, end).replace(/\s+/g, " ").trim();
        results.push({ path: file, snippet });
      }
    }
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: "Search failed." });
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

  emitRunEvent(run, { event: "started", data: { message: "Started" } });

  void (async () => {
    try {
      const result = await runAgent({
        prompt,
        workspaceRoot,
        onStatus: (message) => emitRunEvent(run, { event: "progress", data: { message } })
      });
      run.status = "done";
      emitRunEvent(run, {
        event: "done",
        data: {
          message: "Done",
          outputPath: result.outputPath,
          relativePath: result.relativePath,
          previousContent: result.previousContent,
          content: result.content,
          sources: result.sources
        }
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
