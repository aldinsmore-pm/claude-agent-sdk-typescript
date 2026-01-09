import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { unstable_v2_prompt } from "@anthropic-ai/claude-agent-sdk";

export type RunAgentOptions = {
  prompt: string;
  workspaceRoot?: string;
};

export type RunAgentResult = {
  outputPath: string;
  content: string;
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

export const runAgent = async ({ prompt, workspaceRoot }: RunAgentOptions): Promise<RunAgentResult> => {
  const resolvedWorkspace = workspaceRoot ?? getWorkspaceRoot();
  const instructionsPath = path.join(resolvedWorkspace, "AGENT_INSTRUCTIONS.md");
  const docsRoot = path.join(resolvedWorkspace, "docs");
  const outputPath = ensureDocsPath(docsRoot, "brief.md");

  const [instructions] = await Promise.all([
    fs.readFile(instructionsPath, "utf8"),
    fs.mkdir(docsRoot, { recursive: true })
  ]);

  const taskPrompt = [
    "You are a knowledge worker assistant.",
    "Follow these instructions:",
    instructions,
    "Generate a markdown brief with:",
    "- Title",
    "- Bullet summary",
    "- Next actions",
    "Use clear headings.",
    "User prompt:",
    prompt
  ].join("\n");

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

  await fs.writeFile(outputPath, content, "utf8");

  return {
    outputPath,
    content
  };
};
