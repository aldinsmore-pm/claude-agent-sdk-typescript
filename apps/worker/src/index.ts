import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { unstable_v2_prompt } from "@anthropic-ai/claude-agent-sdk";

export type RunAgentOptions = {
  prompt: string;
  workspaceRoot?: string;
  onStatus?: (message: string) => void;
};

export type RunAgentResult = {
  outputPath: string;
  relativePath: string;
  content: string;
  previousContent: string;
  sources: string[];
};

const DEFAULT_MODEL = "claude-3-5-sonnet-latest";

const resolveClaudeExecutable = () => {
  if (process.env.CLAUDE_CODE_PATH) {
    return process.env.CLAUDE_CODE_PATH;
  }
  try {
    return execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
  } catch {
    return "claude";
  }
};

const getWorkspaceRoot = () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "../../../..", "workspace");
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

const ensureDocsPath = (docsRoot: string, relativePath: string) => {
  if (!relativePath || relativePath.includes("..")) {
    throw new Error("Invalid document path.");
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

export const runAgent = async ({
  prompt,
  workspaceRoot,
  onStatus
}: RunAgentOptions): Promise<RunAgentResult> => {
  const resolvedWorkspace = workspaceRoot ?? getWorkspaceRoot();
  const instructionsPath = path.join(resolvedWorkspace, "AGENT_INSTRUCTIONS.md");
  const docsRoot = path.join(resolvedWorkspace, "docs");
  const relativePath = "brief.md";
  const outputPath = ensureDocsPath(docsRoot, relativePath);

  await fs.mkdir(docsRoot, { recursive: true });
  onStatus?.("Reading workspace documents");
  const [instructions, docPaths] = await Promise.all([
    fs.readFile(instructionsPath, "utf8"),
    listMarkdownFiles(docsRoot, docsRoot)
  ]);

  const docs = await Promise.all(
    docPaths.filter((docPath) => docPath !== relativePath).map(async (docPath) => {
      const resolved = ensureDocsPath(docsRoot, docPath);
      const content = await fs.readFile(resolved, "utf8");
      return { path: docPath, content };
    })
  );

  const previousContent = await fs
    .readFile(outputPath, "utf8")
    .catch(() => "");

  const taskPrompt = [
    "You are a knowledge worker assistant.",
    "Only use information from the workspace documents provided below.",
    "Follow these instructions:",
    instructions,
    "Generate a markdown brief with:",
    "- Title",
    "- Executive summary (bullets)",
    "- Key points",
    "- Next actions",
    "- Open questions",
    "- Sources used (list the workspace document names you referenced)",
    "Use clear headings and professional tone.",
    "If a section has no items, write 'None noted.'",
    "Workspace documents:",
    ...docs.map((doc) => `---\nDocument: ${doc.path}\n${doc.content}`),
    "User prompt:",
    prompt
  ].join("\n");

  onStatus?.("Drafting brief");
  const result = await unstable_v2_prompt(taskPrompt, {
    model: DEFAULT_MODEL,
    pathToClaudeCodeExecutable: resolveClaudeExecutable(),
    permissionMode: "dontAsk",
    env: process.env
  });

  if (result.subtype !== "success") {
    throw new Error(result.errors?.join("; ") ?? "Agent run failed.");
  }

  const content = result.result;

  onStatus?.("Writing document");
  await fs.writeFile(outputPath, content, "utf8");

  return {
    outputPath,
    relativePath,
    content,
    previousContent,
    sources: docs.map((doc) => doc.path)
  };
};
