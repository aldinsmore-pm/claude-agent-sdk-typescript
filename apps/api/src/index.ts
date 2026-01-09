import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  createPlan,
  runAgent,
  type RunPlan,
  type ArtifactResult,
  type PlanAgentRole
} from "@mvp/worker";

const app = express();
const port = Number.parseInt(process.env.API_PORT ?? "4000", 10);

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workspaceRoot = path.join(repoRoot, "workspace");
const docsRoot = path.join(workspaceRoot, "docs");

type RunEvent = {
  event:
    | "started"
    | "planning"
    | "step_started"
    | "step_completed"
    | "artifact_written"
    | "done"
    | "error"
    | "cancelled";
  data: Record<string, unknown>;
};

type RunState = {
  id: string;
  events: RunEvent[];
  listeners: Set<(event: RunEvent) => void>;
  status: "running" | "done" | "error" | "cancelled";
  cancelled: boolean;
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

const normalizePlanInput = (plan: RunPlan) => ({
  interpretedGoal: String(plan.interpretedGoal ?? ""),
  steps: Array.isArray(plan.steps)
    ? plan.steps.map((step) => ({
        id: String(step.id ?? ""),
        title: String(step.title ?? ""),
        description: String(step.description ?? ""),
        agent: String(step.agent ?? "")
      }))
    : [],
  agents: Array.isArray(plan.agents)
    ? plan.agents.map((agent) => ({
        name: String(agent.name ?? ""),
        role: String(agent.role ?? "Writer") as PlanAgentRole
      }))
    : [],
  outputs: Array.isArray(plan.outputs) ? plan.outputs.map((output) => String(output)) : [],
  questions: Array.isArray(plan.questions)
    ? plan.questions.map((question) => String(question)).filter(Boolean)
    : []
});

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

app.post("/api/plan", async (req, res) => {
  const prompt = String(req.body?.prompt ?? "").trim();
  if (!prompt) {
    res.status(400).json({ error: "Prompt is required." });
    return;
  }

  try {
    const plan = await createPlan({
      prompt,
      workspaceRoot,
      onStatus: () => undefined
    });
    res.json({ plan });
  } catch (error) {
    res.status(500).json({ error: "Failed to create plan." });
  }
});

app.post("/api/run", async (req, res) => {
  const prompt = String(req.body?.prompt ?? "").trim();
  const planInput = req.body?.plan as RunPlan | undefined;
  if (!prompt || !planInput) {
    res.status(400).json({ error: "Prompt and plan are required." });
    return;
  }

  const plan = normalizePlanInput(planInput);
  const clarifications = String(req.body?.clarifications ?? "").trim();
  if (plan.questions.length > 0 && !clarifications) {
    res.status(400).json({ error: "Clarifications required before running the plan." });
    return;
  }

  const startingStepIndex = Number.parseInt(req.body?.startingStepIndex ?? "0", 10);
  const priorArtifacts = Array.isArray(req.body?.priorArtifacts)
    ? (req.body?.priorArtifacts as { path: string; content: string }[]).map((artifact) => ({
        path: String(artifact.path ?? ""),
        content: String(artifact.content ?? "")
      }))
    : [];

  const runId = randomUUID();
  const run: RunState = {
    id: runId,
    events: [],
    listeners: new Set(),
    status: "running",
    cancelled: false
  };
  runs.set(runId, run);

  emitRunEvent(run, { event: "started", data: { message: "Started", runId } });

  void (async () => {
    try {
      emitRunEvent(run, { event: "planning", data: { message: "Planning" } });

      const result = await runAgent({
        prompt,
        plan,
        workspaceRoot,
        clarifications,
        priorArtifacts,
        startingStepIndex: Number.isNaN(startingStepIndex) ? 0 : startingStepIndex,
        shouldCancel: () => run.cancelled,
        onStatus: (message) => emitRunEvent(run, { event: "planning", data: { message } }),
        onStepStart: (step) =>
          emitRunEvent(run, {
            event: "step_started",
            data: { stepId: step.id, title: step.title, agent: step.agent }
          }),
        onStepComplete: (stepResult) =>
          emitRunEvent(run, {
            event: "step_completed",
            data: { stepId: stepResult.stepId, title: stepResult.title, agent: stepResult.agent }
          }),
        onArtifactWritten: (artifact: ArtifactResult) =>
          emitRunEvent(run, {
            event: "artifact_written",
            data: { path: artifact.relativePath }
          })
      });

      run.status = "done";
      emitRunEvent(run, {
        event: "done",
        data: {
          message: "Done",
          artifacts: result.artifacts,
          steps: result.steps,
          sources: result.sources,
          outputs: result.outputs,
          mainArtifact: result.mainArtifact,
          plan: result.plan
        }
      });
    } catch (error) {
      if (run.cancelled) {
        run.status = "cancelled";
        emitRunEvent(run, {
          event: "cancelled",
          data: { message: "Cancelled" }
        });
        return;
      }
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

app.post("/api/run/:id/cancel", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  run.cancelled = true;
  res.json({ status: "cancelling" });
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
