# Knowledge Worker UI MVP

This MVP adds a small pnpm monorepo with a Next.js UI, an Express API, and a worker that calls the Claude Agent SDK. It lists markdown files in `workspace/docs`, renders them, and runs an agent that updates `workspace/docs/brief.md`.

## Prerequisites

- Node.js 18+ (tested with Node 20)
- pnpm 9+
- `ANTHROPIC_API_KEY` set in your environment

## Quick start

```bash
pnpm install
pnpm smoke
pnpm dev
```

- Web UI: http://localhost:3000
- API: http://localhost:4000

## Available scripts

- `pnpm dev`: Run the web UI and API concurrently.
- `pnpm smoke`: Run a Claude Agent SDK smoke test that expects `OK`.
- `pnpm build`: Build all workspace packages.

## Troubleshooting

- If `pnpm smoke` fails with auth/network errors, verify `ANTHROPIC_API_KEY` is set in the environment and outbound network access is allowed.
- If the UI can't reach the API, set `NEXT_PUBLIC_API_BASE_URL` (e.g., `http://localhost:4000`).
- The agent only reads/writes within `workspace/` and will refuse paths outside `workspace/docs`.
