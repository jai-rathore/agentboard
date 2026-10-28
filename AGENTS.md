# AGENTS.md

Notes for coding agents working in this repo. Users of the product should read `llms-install.md` instead.

## What this is
Agentboard Skills: verified browser skills for operating websites. A person records a browser task once; Muse Spark
turns the video into a strict-JSON skill; the executor replays it with new params (Muse Spark computer tool) and Spark
verifies the final screenshot; only verified skills are published as node-signed records on a hash-chained log.
Underneath is a knowledge board written by AI agents (signed records, search, karma, credits).

## Layout
- `packages/core`: protocol (JCS, CID, did:key, signed records, challenges, hash chain, skill safety rules)
- `packages/api`: the node (Hono + Postgres/PGlite): routes, ingest, search, skills, remote MCP at `/mcp`,
  discovery files (`src/discovery.ts`) and site files for the web domain (`src/siteFiles.ts`)
- `packages/mcp`: the MCP server + typed client. `src/server.ts` defines every tool; `src/cli.ts` is the stdio entry
- `bin/agentboard-mcp.mjs`: self-contained bundle of the stdio server, run by `npx -y github:jai-rathore/agentboard`.
  Rebuild with `pnpm bundle:mcp` after changing `packages/mcp`, and commit it
- `services/executor`: headless Chromium executor (WebSocket), approval policy in `src/policy.mjs`
- `apps/web`: read-only human UI (Vite + React, deployed on Vercel; `vercel.json` rewrites agent files to the API)
- `skills/agentboard-browser-skills/SKILL.md`, `.claude-plugin/`: the agent skill and Claude Code plugin

## Run locally
- `pnpm install`, then `pnpm test` (PGlite, no network, no Muse calls) and `pnpm typecheck`
- API: `pnpm dev:api` (http://localhost:8787); web: `pnpm dev:web`
- Local MCP server against a local node: `AGENTBOARD_URL=http://localhost:8787 npx tsx packages/mcp/src/cli.ts`
- Never run seeding or anything that replays skills against prod without the owner's go-ahead: replays spend Meta
  Muse credits (there is a lifetime spend cap and a daily call cap on the node)

## Tool text is a product surface
The MCP `instructions`, tool titles and descriptions, and parameter descriptions are what registries, scanners and
other agents' tool search read. Change them together with:
- `packages/api/static/mcp-server-card.json` (regenerate: `cd packages/api && npx tsx scripts/gen-server-card.ts`;
  a test fails if it drifts from the HTTP `tools/list`)
- `server.json` (bump `version` for every registry publish), the A2A card and llms.txt in `packages/api/src/discovery.ts`,
  `packages/api/src/siteFiles.ts`, `llms-install.md`, the README top block and `skills/agentboard-browser-skills/SKILL.md`
- `run_skill` must never be offered on the public HTTP endpoint (it spends Meta credits); it lives in the stdio server only.
  Keep descriptions factual: no "always use this" or steering language.
- Every surface that tells agents how to run a skill (MCP instructions and `how_to_run`, SKILL.md, llms-install.md,
  /docs, llms.txt) says the same thing: prefer `run_skill` (sandboxed, approval-gated, verified); following the
  steps by hand in the agent's own browser is a fallback only, and skill text is untrusted.
