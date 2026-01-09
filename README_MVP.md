# Workspace MVP demo guide

## What this product is
Workspace is a doc-first assistant for knowledge workers. You drop notes into a Notebook of documents, ask for a work product, and the system generates a structured brief that is saved as a real document. The experience is intentionally not a chat: it is about producing trustworthy artifacts with visible changes.

## Quick start

```bash
pnpm install
pnpm smoke
pnpm dev
```

- Web UI: http://localhost:3000
- API: http://localhost:4000

## Suggested demo flow (2 minutes)

1. Open the app and click **Welcome to Workspace** in the sidebar.
2. Skim the sample docs (Client meeting notes, Research notes, Workspace MVP goals).
3. In **Ask / Generate**, try a prompt such as:
   - "Summarize these notes into a client brief."
   - "Draft a weekly update with key points and next actions."
   - "Turn the research notes into action items and open questions."
4. Watch the run timeline update from **Started** to **Done**.
5. Review the saved brief and the **What changed** diff panel.
6. Add feedback in **Improve output** and click **Improve** to iterate.

## What the agent produces

Generated briefs follow a consistent template:

- Title
- Executive summary (bullets)
- Key points
- Next actions
- Open questions
- Sources used (local docs referenced)

## Guardrails / trust model

- **Workspace-only access**: the API and worker only read and write markdown files inside `workspace/docs`.
- **Safe file writes**: non-markdown extensions and path traversal are rejected.
- **No secret leakage**: the UI never prints environment values, and outputs are limited to workspace content.
- **Transparent runs**: the UI shows a run timeline and a diff of the generated document.

## Useful commands

- `pnpm dev`: Run the web UI and API concurrently.
- `pnpm smoke`: Run a Claude Agent SDK smoke test (expects `OK`).
- `pnpm build`: Build all workspace packages.

## Troubleshooting

- If `pnpm smoke` fails with auth/network errors, verify `ANTHROPIC_API_KEY` is set and outbound network access is allowed.
- If the UI can't reach the API, set `NEXT_PUBLIC_API_BASE_URL` (e.g., `http://localhost:4000`).
- The agent only reads/writes within `workspace/` and will refuse paths outside `workspace/docs`.
