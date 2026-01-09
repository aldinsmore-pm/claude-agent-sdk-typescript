import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { unstable_v2_prompt } from "@anthropic-ai/claude-agent-sdk";

export type PlanAgentRole = "Researcher" | "Writer" | "Critic" | "Organizer";

export type PlanAgent = {
  name: string;
  role: PlanAgentRole;
};

export type PlanStep = {
  id: string;
  title: string;
  description: string;
  agent: string;
};

export type RunPlan = {
  interpretedGoal: string;
  steps: PlanStep[];
  agents: PlanAgent[];
  outputs: string[];
  questions: string[];
};

export type StepResult = {
  stepId: string;
  title: string;
  agent: string;
  output: string;
};

export type ArtifactResult = {
  outputPath: string;
  relativePath: string;
  content: string;
  previousContent: string;
};

export type RunAgentOptions = {
  prompt: string;
  plan: RunPlan;
  workspaceRoot?: string;
  onStatus?: (message: string) => void;
  onStepStart?: (step: PlanStep) => void;
  onStepComplete?: (result: StepResult) => void;
  onArtifactWritten?: (artifact: ArtifactResult) => void;
  shouldCancel?: () => boolean;
  startingStepIndex?: number;
  clarifications?: string;
  priorArtifacts?: { path: string; content: string }[];
  maxTurns?: number;
};

export type RunAgentResult = {
  artifacts: ArtifactResult[];
  steps: StepResult[];
  sources: string[];
  mainArtifact: string;
  outputs: string[];
  plan: RunPlan;
};

export type PlanOptions = {
  prompt: string;
  workspaceRoot?: string;
  onStatus?: (message: string) => void;
};

export const MAX_STEPS = 8;
export const MAX_AGENTS = 4;
export const MAX_TURNS = 12;

const DEFAULT_MODEL = "claude-3-5-sonnet-latest";
const REQUIRED_OUTPUTS = ["Next Actions.md", "Open Questions.md", "Sources.md"];
const OPTIONAL_OUTPUTS = ["Outline.md", "Critique.md"];
const DEFAULT_MAIN_OUTPUT = "Brief.md";
const AGENT_ARCHETYPES: PlanAgentRole[] = ["Researcher", "Writer", "Critic", "Organizer"];

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

const normalizeDocName = (value: string) => {
  const trimmed = value.trim().replace(/\\/g, "/");
  if (!trimmed) {
    return "";
  }
  const stripped = trimmed.replace(/^\/+/, "");
  if (stripped.includes("..")) {
    return "";
  }
  return stripped.endsWith(".md") ? stripped : `${stripped}.md`;
};

const uniqueByLowercase = (values: string[]) => {
  const map = new Map<string, string>();
  for (const value of values) {
    if (!value) {
      continue;
    }
    const key = value.toLowerCase();
    if (!map.has(key)) {
      map.set(key, value);
    }
  }
  return Array.from(map.values());
};

const buildOutputs = (outputs: string[]) => {
  const normalized = uniqueByLowercase(outputs.map(normalizeDocName).filter(Boolean));
  const withRequired = [...normalized];
  for (const required of REQUIRED_OUTPUTS) {
    if (!withRequired.some((output) => output.toLowerCase() === required.toLowerCase())) {
      withRequired.push(required);
    }
  }

  const reserved = new Set(
    [...REQUIRED_OUTPUTS, ...OPTIONAL_OUTPUTS].map((output) => output.toLowerCase())
  );
  const hasMain = withRequired.some((output) => !reserved.has(output.toLowerCase()));
  if (!hasMain) {
    withRequired.unshift(DEFAULT_MAIN_OUTPUT);
  }

  return uniqueByLowercase(withRequired);
};

const parseJson = (value: string) => {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch {
    return null;
  }
};

const buildFallbackPlan = (prompt: string, outputs: string[]): RunPlan => {
  const fallbackAgents: PlanAgent[] = [
    { name: "Researcher", role: "Researcher" as PlanAgentRole },
    { name: "Writer", role: "Writer" as PlanAgentRole },
    { name: "Critic", role: "Critic" as PlanAgentRole },
    { name: "Organizer", role: "Organizer" as PlanAgentRole }
  ].slice(0, MAX_AGENTS);

  const fallbackSteps: PlanStep[] = [
    {
      id: "step-1",
      title: "Review workspace context",
      description: "Scan the workspace documents for relevant facts and context.",
      agent: fallbackAgents[0]?.name ?? "Researcher"
    },
    {
      id: "step-2",
      title: "Draft outline and key points",
      description: "Outline the main deliverable and capture key points to address the prompt.",
      agent: fallbackAgents[1]?.name ?? "Writer"
    },
    {
      id: "step-3",
      title: "Critique and refine",
      description: "Surface risks, gaps, and questions to improve the final outputs.",
      agent: fallbackAgents[2]?.name ?? "Critic"
    },
    {
      id: "step-4",
      title: "Assemble artifacts",
      description: "Compile the deliverable, next actions, open questions, and sources.",
      agent: fallbackAgents[3]?.name ?? "Organizer"
    }
  ].slice(0, MAX_STEPS);

  return {
    interpretedGoal: prompt.slice(0, 120),
    steps: fallbackSteps,
    agents: fallbackAgents,
    outputs: buildOutputs(outputs),
    questions: []
  };
};

const normalizePlan = (plan: RunPlan, prompt: string) => {
  const agents = uniqueByLowercase(
    plan.agents.map((agent) => agent.name).filter(Boolean)
  ).map((name, index) => {
    const role = plan.agents.find((agent) => agent.name === name)?.role;
    return {
      name,
      role: role && AGENT_ARCHETYPES.includes(role) ? role : AGENT_ARCHETYPES[index % 4]
    } as PlanAgent;
  });

  const trimmedAgents = agents.slice(0, MAX_AGENTS);
  if (trimmedAgents.length === 0) {
    trimmedAgents.push({ name: "Writer", role: "Writer" });
  }

  const steps = plan.steps.slice(0, MAX_STEPS).map((step, index) => {
    const agentName = trimmedAgents.find((agent) => agent.name === step.agent)?.name;
    return {
      id: step.id || `step-${index + 1}`,
      title: step.title || `Step ${index + 1}`,
      description: step.description || "",
      agent: agentName ?? trimmedAgents[index % trimmedAgents.length].name
    } as PlanStep;
  });

  if (steps.length === 0) {
    return buildFallbackPlan(prompt, plan.outputs);
  }

  return {
    interpretedGoal: plan.interpretedGoal || prompt.slice(0, 120),
    steps,
    agents: trimmedAgents,
    outputs: buildOutputs(plan.outputs),
    questions: (plan.questions ?? []).slice(0, 3).filter(Boolean)
  } satisfies RunPlan;
};

const buildPlanPrompt = (prompt: string, docNames: string[]) => [
  "You are a planning assistant for a document workflow app.",
  "Return only valid JSON with the shape:",
  "{",
  "  \"interpretedGoal\": string,",
  "  \"steps\": [{\"title\": string, \"description\": string, \"agent\": string}],",
  "  \"agents\": [{\"name\": string, \"role\": string}],",
  "  \"outputs\": [string],",
  "  \"questions\": [string]",
  "}",
  `Constraints: steps <= ${MAX_STEPS}, agents <= ${MAX_AGENTS}, questions <= 3.`,
  "Use only these agent archetypes: Researcher, Writer, Critic, Organizer.",
  "Outputs must be markdown files under workspace/docs (e.g., Brief.md).",
  "Outputs must include a main deliverable plus: Next Actions.md, Open Questions.md, Sources.md.",
  "If details are missing, ask up to 3 clarifying questions.",
  `Workspace documents available: ${docNames.length ? docNames.join(", ") : "None"}.`,
  `User prompt: ${prompt}`
].join("\n");

const buildStepPrompt = (step: PlanStep, plan: RunPlan, docs: { path: string; content: string }[]) => [
  `You are ${step.agent}, acting as a ${
    plan.agents.find((agent) => agent.name === step.agent)?.role ?? "Writer"
  } sub-agent.`,
  "Your job is to produce concise markdown notes for this step.",
  "Use only the workspace documents and prior notes provided.",
  "Do not reference any information outside the workspace.",
  `Step title: ${step.title}`,
  `Step description: ${step.description}`,
  "Plan steps:",
  ...plan.steps.map((item, index) => `${index + 1}. ${item.title} (${item.agent})`),
  "Workspace documents:",
  ...docs.map((doc) => `---\nDocument: ${doc.path}\n${doc.content}`)
].join("\n");

const buildArtifactPrompt = (
  plan: RunPlan,
  stepOutputs: StepResult[],
  sources: string[],
  clarifications?: string,
  priorArtifacts?: { path: string; content: string }[]
) => [
  "You are the Organizer sub-agent assembling final artifacts.",
  "Return ONLY valid JSON with this shape:",
  "{ \"artifacts\": [{\"path\": string, \"content\": string}] }",
  "Only include markdown files under workspace/docs.",
  `Planned outputs: ${plan.outputs.join(", ")}.`,
  "Ensure Sources.md lists the workspace documents referenced.",
  "Include headings and clear structure.",
  clarifications ? `Clarifications from the user: ${clarifications}` : "",
  priorArtifacts && priorArtifacts.length
    ? [
        "Existing artifacts to refine:",
        ...priorArtifacts.map((artifact) => `---\n${artifact.path}\n${artifact.content}`)
      ].join("\n")
    : "",
  "Step notes:",
  ...stepOutputs.map((step) => `---\n${step.title} (${step.agent})\n${step.output}`),
  "Sources list:",
  sources.join("\n")
].join("\n");

const buildFallbackArtifacts = (
  plan: RunPlan,
  stepOutputs: StepResult[],
  sources: string[],
  clarifications?: string
) => {
  const notes = stepOutputs.map((step) => `## ${step.title}\n${step.output}`).join("\n\n");
  const sourcesContent = sources.length
    ? sources.map((source) => `- ${source}`).join("\n")
    : "- None";

  return plan.outputs.map((output) => {
    if (output.toLowerCase() === "sources.md") {
      return { path: output, content: `# Sources\n\n${sourcesContent}` };
    }
    if (output.toLowerCase() === "next actions.md") {
      return {
        path: output,
        content: "# Next Actions\n\n- Draft next steps based on the brief.\n- Validate open questions with stakeholders."
      };
    }
    if (output.toLowerCase() === "open questions.md") {
      const questions = plan.questions.length
        ? plan.questions.map((question) => `- ${question}`).join("\n")
        : "- None noted.";
      return { path: output, content: `# Open Questions\n\n${questions}` };
    }
    if (output.toLowerCase() === "outline.md") {
      return { path: output, content: `# Outline\n\n${notes}` };
    }
    if (output.toLowerCase() === "critique.md") {
      return {
        path: output,
        content: "# Critique\n\n- Review the brief for gaps or assumptions.\n- Confirm alignment with the prompt."
      };
    }
    return {
      path: output,
      content: [
        `# ${output.replace(/\.md$/i, "")}`,
        plan.interpretedGoal ? `\n**Goal:** ${plan.interpretedGoal}` : "",
        clarifications ? `\n**Clarifications:** ${clarifications}` : "",
        "\n## Notes",
        notes || "No notes available."
      ].join("\n")
    };
  });
};

export const createPlan = async ({ prompt, workspaceRoot, onStatus }: PlanOptions) => {
  const resolvedWorkspace = workspaceRoot ?? getWorkspaceRoot();
  const instructionsPath = path.join(resolvedWorkspace, "AGENT_INSTRUCTIONS.md");
  const docsRoot = path.join(resolvedWorkspace, "docs");

  await fs.mkdir(docsRoot, { recursive: true });
  onStatus?.("Planning run");

  const [instructions, docPaths] = await Promise.all([
    fs.readFile(instructionsPath, "utf8").catch(() => ""),
    listMarkdownFiles(docsRoot, docsRoot)
  ]);

  const planPrompt = [
    "Follow these instructions:",
    instructions,
    buildPlanPrompt(prompt, docPaths)
  ].join("\n");

  const result = await unstable_v2_prompt(planPrompt, {
    model: DEFAULT_MODEL,
    pathToClaudeCodeExecutable: resolveClaudeExecutable(),
    permissionMode: "dontAsk",
    env: process.env
  });

  if (result.subtype !== "success") {
    return buildFallbackPlan(prompt, []);
  }

  const parsed = parseJson(result.result ?? "");
  if (!parsed) {
    return buildFallbackPlan(prompt, []);
  }

  const rawPlan: RunPlan = {
    interpretedGoal: String(parsed.interpretedGoal ?? ""),
    steps: Array.isArray(parsed.steps)
      ? parsed.steps.map((step: Record<string, unknown>, index: number) => ({
          id: `step-${index + 1}`,
          title: String(step.title ?? ""),
          description: String(step.description ?? ""),
          agent: String(step.agent ?? "")
        }))
      : [],
    agents: Array.isArray(parsed.agents)
      ? parsed.agents.map((agent: Record<string, unknown>) => ({
          name: String(agent.name ?? ""),
          role: String(agent.role ?? "Writer") as PlanAgentRole
        }))
      : [],
    outputs: Array.isArray(parsed.outputs)
      ? parsed.outputs.map((output: unknown) => String(output ?? ""))
      : [],
    questions: Array.isArray(parsed.questions)
      ? parsed.questions.map((question: unknown) => String(question ?? "")).filter(Boolean)
      : []
  };

  return normalizePlan(rawPlan, prompt);
};

export const runAgent = async ({
  prompt,
  plan,
  workspaceRoot,
  onStatus,
  onStepStart,
  onStepComplete,
  onArtifactWritten,
  shouldCancel,
  startingStepIndex = 0,
  clarifications,
  priorArtifacts,
  maxTurns = MAX_TURNS
}: RunAgentOptions): Promise<RunAgentResult> => {
  const resolvedWorkspace = workspaceRoot ?? getWorkspaceRoot();
  const instructionsPath = path.join(resolvedWorkspace, "AGENT_INSTRUCTIONS.md");
  const docsRoot = path.join(resolvedWorkspace, "docs");
  const normalizedPlan = normalizePlan(plan, prompt);

  await fs.mkdir(docsRoot, { recursive: true });
  const [instructions, docPaths] = await Promise.all([
    fs.readFile(instructionsPath, "utf8").catch(() => ""),
    listMarkdownFiles(docsRoot, docsRoot)
  ]);

  const docs = await Promise.all(
    docPaths.map(async (docPath) => {
      const resolved = ensureDocsPath(docsRoot, docPath);
      const content = await fs.readFile(resolved, "utf8");
      return { path: docPath, content };
    })
  );

  let turnCount = 0;
  const consumeTurn = () => {
    turnCount += 1;
    if (turnCount > maxTurns) {
      throw new Error("Run exceeded the maximum number of turns.");
    }
  };

  const stepResults: StepResult[] = [];
  const stepsToRun = normalizedPlan.steps.slice(startingStepIndex);

  for (const step of stepsToRun) {
    if (shouldCancel?.()) {
      throw new Error("Run cancelled.");
    }

    onStatus?.(`Agent ${step.agent} working on ${step.title}`);
    onStepStart?.(step);

    const stepPrompt = [
      "Follow these instructions:",
      instructions,
      buildStepPrompt(step, normalizedPlan, docs)
    ].join("\n");

    consumeTurn();
    const result = await unstable_v2_prompt(stepPrompt, {
      model: DEFAULT_MODEL,
      pathToClaudeCodeExecutable: resolveClaudeExecutable(),
      permissionMode: "dontAsk",
      env: process.env
    });

    if (result.subtype !== "success") {
      throw new Error(result.errors?.join("; ") ?? "Agent step failed.");
    }

    const output = result.result ?? "";
    const stepResult: StepResult = {
      stepId: step.id,
      title: step.title,
      agent: step.agent,
      output
    };

    stepResults.push(stepResult);
    onStepComplete?.(stepResult);
  }

  if (shouldCancel?.()) {
    throw new Error("Run cancelled.");
  }

  onStatus?.("Writing artifacts");
  const artifactPrompt = [
    "Follow these instructions:",
    instructions,
    buildArtifactPrompt(normalizedPlan, stepResults, docPaths, clarifications, priorArtifacts)
  ].join("\n");

  consumeTurn();
  const artifactResult = await unstable_v2_prompt(artifactPrompt, {
    model: DEFAULT_MODEL,
    pathToClaudeCodeExecutable: resolveClaudeExecutable(),
    permissionMode: "dontAsk",
    env: process.env
  });

  let artifactsPayload: { artifacts: { path: string; content: string }[] } | null = null;

  if (artifactResult.subtype === "success") {
    const parsed = parseJson(artifactResult.result ?? "");
    if (parsed && Array.isArray(parsed.artifacts)) {
      artifactsPayload = {
        artifacts: parsed.artifacts
          .map((artifact: Record<string, unknown>) => ({
            path: String(artifact.path ?? ""),
            content: String(artifact.content ?? "")
          }))
          .filter((artifact: { path: string }) => artifact.path)
      };
    }
  }

  const fallbackArtifacts = buildFallbackArtifacts(
    normalizedPlan,
    stepResults,
    docPaths,
    clarifications
  );
  const rawArtifacts = artifactsPayload?.artifacts?.length
    ? artifactsPayload.artifacts
    : fallbackArtifacts;

  const plannedOutputs = normalizedPlan.outputs;
  const finalArtifacts = plannedOutputs.map((output) => {
    const match = rawArtifacts.find(
      (artifact) => artifact.path.toLowerCase() === output.toLowerCase()
    );
    if (match) {
      return match;
    }
    return (
      fallbackArtifacts.find((artifact) => artifact.path.toLowerCase() === output.toLowerCase()) ?? {
        path: output,
        content: ""
      }
    );
  });

  const artifacts: ArtifactResult[] = [];
  for (const artifact of finalArtifacts) {
    if (shouldCancel?.()) {
      throw new Error("Run cancelled.");
    }
    const normalizedPath = normalizeDocName(artifact.path);
    if (!normalizedPath) {
      continue;
    }
    const outputPath = ensureDocsPath(docsRoot, normalizedPath);
    const previousContent = await fs.readFile(outputPath, "utf8").catch(() => "");
    const content = artifact.content ?? "";
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, content, "utf8");

    const artifactResultItem: ArtifactResult = {
      outputPath,
      relativePath: normalizedPath,
      content,
      previousContent
    };
    artifacts.push(artifactResultItem);
    onArtifactWritten?.(artifactResultItem);
  }

  const reserved = new Set(
    [...REQUIRED_OUTPUTS, ...OPTIONAL_OUTPUTS].map((output) => output.toLowerCase())
  );
  const mainArtifact =
    artifacts.find((artifact) => !reserved.has(artifact.relativePath.toLowerCase()))
      ?.relativePath ??
    artifacts[0]?.relativePath ??
    DEFAULT_MAIN_OUTPUT;

  return {
    artifacts,
    steps: stepResults,
    sources: docPaths,
    mainArtifact,
    outputs: plannedOutputs,
    plan: normalizedPlan
  };
};
