# Workspace MVP demo guide

## What this product is
Workspace is a doc-first assistant for knowledge workers. You drop notes into a Notebook of documents, propose a **Run**, and the system turns that plan into a bundle of saved documents. The experience is intentionally not a chat: it is about producing trustworthy artifacts with visible changes.

## What a Run is
A **Run** is the core workflow object:

1. You describe a goal.
2. The system proposes a plan (steps, sub-agents, outputs).
3. You review and edit the plan.
4. The Run executes steps with sub-agents.
5. The Run writes an artifact bundle into `workspace/docs`.

## Quick start

```bash
pnpm install
pnpm smoke
pnpm dev
```

- Web UI: http://localhost:3000
- API: http://localhost:4000

## Suggested demo flow (3 minutes)

1. Open the app and click **Welcome to Workspace** in the sidebar.
2. Skim the sample docs (Client meeting notes, Research notes, Workspace MVP goals).
3. In **Run builder**, enter a prompt such as:
   - "Create a customer brief with risks and next actions."
   - "Turn the research notes into a launch plan with open questions."
   - "Draft a stakeholder memo with an outline and critique."
4. Click **Generate Plan**. Review and edit the steps, agents, and outputs.
5. Answer any clarifying questions and click **Run Plan**.
6. Watch the timeline for step progress and file writes.
7. Open the artifacts bundle (Brief, Next Actions, Open Questions, Sources).
8. Use **Refine outputs**, **Re-run from step**, or **Fork run** to iterate.

## What the agent produces

Every run saves a bundle of markdown artifacts in `workspace/docs`:

- A main deliverable (e.g., `Brief.md`, `Plan.md`, `Memo.md`).
- `Next Actions.md`
- `Open Questions.md`
- `Sources.md` (local workspace docs referenced)
- Optional: `Outline.md`, `Critique.md`

## Guardrails / trust model

- **Workspace-only access**: the API and worker only read and write markdown files inside `workspace/docs`.
- **Safe file writes**: non-markdown extensions and path traversal are rejected.
- **No secret leakage**: the UI never prints environment values, and outputs are limited to workspace content.
- **Ask-when-missing**: the plan can request up to three clarifying questions before execution.
- **Bounded autonomy**: max 8 steps, 4 sub-agents, and a capped turn budget per run.
- **Transparent runs**: the UI shows plan preview, step timeline, and diffs for each artifact.

## Useful commands

- `pnpm dev`: Run the web UI and API concurrently.
- `pnpm smoke`: Run a Claude Agent SDK smoke test (expects `OK`).
- `pnpm build`: Build all workspace packages.

## Troubleshooting

- If `pnpm smoke` fails with auth/network errors, verify `ANTHROPIC_API_KEY` is set and outbound network access is allowed.
- If the UI can't reach the API, set `NEXT_PUBLIC_API_BASE_URL` (e.g., `http://localhost:4000`).
- The agent only reads/writes within `workspace/` and will refuse paths outside `workspace/docs`.
