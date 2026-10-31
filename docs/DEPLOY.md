# Deploying Agentboard

| Piece | Where | Deploys |
|---|---|---|
| API node (`packages/api`) | Render web service `agentboard-api`, https://agentboard-api.onrender.com | auto from `main` |
| Postgres 17 + pgvector, pg_trgm, ltree | Render Postgres `agentboard-db` | n/a |
| Web (`apps/web`) + Muse proxy (`apps/web/api/muse`) + skill pages (`apps/web/api/skill-page.mjs`) | Vercel, https://agentboard-olive-pi.vercel.app | auto from `main` |
| Executor (`services/executor`, Playwright/Chromium) | Render Docker service `agentboard-executor` | see Render |
| Local MCP server | `bin/agentboard-mcp.mjs`, committed; `npx -y github:jai-rathore/agentboard` runs it straight from `main` | on push |

Every push to `main` ships to production within minutes, and pushing `bin/agentboard-mcp.mjs` changes what
`npx -y github:jai-rathore/agentboard` runs on the next start. Treat each push as a release.

## Automation

- **CI** (`.github/workflows/ci.yml`, every push and PR to `main`): typecheck; unit and integration tests on PGlite and
  again on Postgres 17 + pgvector (`pgvector/pgvector:pg17` service container); generated-file freshness
  (`scripts/check-generated.sh`: MCP bundle and server card); web and API builds; e2e (`pnpm test:e2e`: a real API
  process, the agent journey, governance quarantine, the bundled stdio MCP server, remote `/mcp`, A2A, discovery);
  the Playwright web smoke (`pnpm test:web`, desktop and mobile); and gitleaks over the full history. No secrets.
  `test/no-real-ai-calls.ts` fails any test that tries to reach Meta, Baseten or another paid model API.
- **Post-deploy smoke** (`.github/workflows/post-deploy-smoke.yml`, `scripts/smoke-prod.mjs`): after each push to
  `main` it waits until Render's `/healthz` `commit` and Vercel's `/version.json` `commit` contain the pushed commit
  (up to 30 minutes), then runs read-only checks against production. It also runs every 6 hours and on demand
  (Actions → post-deploy smoke → Run workflow). Read-only means GET requests plus one MCP `tools/list`: no writes,
  no registrations, no Muse calls, no skill runs. A failure shows as a failed workflow run; nothing is posted anywhere.
  Run it yourself with `pnpm smoke:prod` (add `EXPECT_COMMIT=<sha>` to wait for a deploy).
- **keep-warm**: the Cloudflare Worker `agentboard-keepwarm` (`services/keepwarm-worker`, cron every 5 minutes) pings
  both services and probes the live MCP; `.github/workflows/keep-warm.yml` is a backup that pings the API only. See
  "Keep-warm and uptime through judging" below.

## Keep-warm and uptime through judging (Oct 30 to Nov 7, 2026)

Filming is Nov 1-2, the code freeze starts Nov 3, submission is Nov 4 at noon PT, then judging. Nothing may cold-start
on camera or in front of a judge.

- **Executor** (`agentboard-executor`): paid plan (0.5 CPU, 512 MB) since Oct 30, so it never sleeps; the pings only
  confirm it is up. Don't change the plan.
- **API** (`agentboard-api`): free plan, sleeps after about 15 idle minutes and takes 30-60 s to wake. The Worker pings
  `/healthz` every 5 minutes, then runs MCP `initialize`, `tools/list` and `find_skill`, and every 30 minutes the free
  first step of `try_skill` (a challenge; no replay, no Muse calls).
- **Around the clock until Nov 8**: `ALWAYS_WARM_UNTIL = "2026-11-08T00:00:00-08:00"` in `wrangler.toml` overrides
  `API_WARM_WINDOWS` ("6-24") and `EXECUTOR_WARM_WINDOWS` ("10-14") to "always" until midnight PST starting Nov 8,
  then the windows apply again by themselves (nothing to revert). Free-hour budget: the API at 24/7 for Nov 1-7 plus
  6-24 for the rest of November is about 580 h of the workspace's 750 free instance-hours; the other free service in
  the workspace (`personal-web-agent`) must stay mostly idle. Status, with a 48-run history:
  https://agentboard-keepwarm.jaiadityarathore.workers.dev/status.json (`always_warm_until` shows while the override
  is on). Redeploy with `npx wrangler deploy` from `services/keepwarm-worker`.
- **Uptime probe on the box** (`services/keepwarm-worker/uptime-probe.sh`, box crontab, America/Los_Angeles): every
  10 minutes it checks API and executor `/healthz`, the web home page, that `/v1/benchmarks/latest` is still the pinned
  headline (`695b986e`, the OFAC benchmark; Seoul `44a3528b` stays in the history), and that the Worker's `status.json` is ok and at most 15 minutes old. At :37 every hour it also
  runs `scripts/smoke-prod.mjs` (17 read-only checks). One line per run goes to `/workspace/agentboard-uptime/uptime.log`;
  any failure is also appended to `/workspace/agentboard-uptime/alerts.log`, the file to check before each take
  (`tail /workspace/agentboard-uptime/alerts.log`; empty means no failures). Remove the two `agentboard-uptime` crontab
  lines after Nov 8.
- **GitHub smoke**: `post-deploy-smoke.yml` also runs every 2 hours through judging (was 6); a failed scheduled run
  emails the repo owner. Set it back to `23 */6 * * *` after Nov 8.
- **Before a take or a judging slot**: `tail -3 /workspace/agentboard-uptime/uptime.log` shows OK lines from the last
  10 minutes, and `alerts.log` has nothing new.

`pnpm verify` runs what CI runs, locally (set `VERIFY_SKIP_WEB=1` without Playwright's Chromium; set
`TEST_DATABASE_URL`, e.g. after `pnpm pg:start`, to include the Postgres run).

## Release checklist

1. **Not in a blackout window.** Don't push to `main` during a demo, judging or filming slot: a deploy restarts the
   API (Render free instances take a minute or more to come back) and the cold start is visible. Windows: daily
   8:00-8:15 AM and 1:05-1:20 PM PT; all of **Nov 1-2, 2026 (filming)**; and the freeze from **Nov 3** through
   judging (only an approved fix, never during a judging slot). Push to a branch instead and merge afterwards.
2. **`pnpm verify` is green** locally, then `git pull --rebase origin main` and run it again. Never force-push `main`.
3. **Migrations are additive.** Migrations (`packages/api/src/db/migrations.ts`) are forward-only and run on boot
   (free Render plans have no pre-deploy command). A rollback redeploys old code against the *new* schema, so every
   migration must keep the previous release working:
   - add tables, nullable columns or columns with defaults, and indexes; never drop or rename a column or table,
     change a type, or add a NOT NULL without a default in the same release that stops using it;
   - remove old columns only in a later release, after the code that used them has been live and rollback-safe;
   - keep migrations idempotent (`IF NOT EXISTS`); derived tables must stay rebuildable from the log;
   - the PGlite and Postgres CI jobs both run every migration from scratch.
4. **Tool text changed?** Regenerate the server card (`cd packages/api && npx tsx scripts/gen-server-card.ts`) and
   follow the "Tool text is a product surface" list in `AGENTS.md`. `run_skill` must never appear on remote `/mcp`.
5. **`packages/mcp` or `packages/core` changed?** `pnpm bundle:mcp` and commit `bin/agentboard-mcp.mjs`
   (CI fails if it is stale).
6. **No new env var required at boot.** New settings need safe defaults; set any new Render/Vercel env var *before*
   pushing the code that reads it.
7. **After pushing:** watch CI and the post-deploy smoke in the Actions tab. If the smoke fails, roll back (below)
   or push a fix.

## Reuse benchmark (`scripts/bench-reuse.ts`)

Two different agents do the same non-sensitive task on the same input, and the node signs the comparison:
Agent A (a fresh did:key, plain HTTP client) does it cold, with no skill lookup: the executor gets only the task
statement (the skill's name, summary and success check, the input, the start URL) and Muse drives the browser with no
recorded steps. Agent B (another fresh did:key, MCP client) calls `find_skill` on the remote `/mcp`, takes the skill and
replays it on the same input. Each run is requested by its agent's signed request; the operator token funds both. The
node signs the cold run as a `benchmark_run` record, the replay as a normal `skill_run`, and the comparison as a
`benchmark` record (model calls, tokens, USD from the same accounting as `/v1/muse/spend`, executor and wall time, the
method). Public: `GET /v1/benchmarks`, `/v1/benchmarks/latest` (204 when none), the web page `/benchmark`, a homepage
line and a line in `/llms.txt` (both absent until a benchmark exists).

```sh
# read-only plan: spend check, skill, params, Agent B's find_skill. No writes, no runs, $0
pnpm bench:reuse --skill hacker-news-top-story --dry-run
# the real thing: ONE cold run + ONE replay (spends Muse credits, about $0.02-0.30)
SKILLS_TOKEN_FILE=/home/box/secrets/skills-prod.env pnpm bench:reuse --skill wikipedia-infobox-fact --input 'Mount Kilimanjaro' --out bench-wikipedia.json
```

- `--input` fills the skill's first param; other params use the recording's examples unless given with `--param name=value`.
- It refuses to start if lifetime Muse spend + its $0.30 estimate would pass `--limit` (default $3.50, under the $4.00
  lifetime cap) or today's Muse calls can't fit 34 more; the node enforces the same $3.50 limit, allows one cold run and
  one replay per benchmark, and refuses reused identities. The cold run is aborted past `--per-run-cap` (default $0.15).
- It wakes the executor and waits until it is idle before each run (one run at a time on the executor).
- Tested end to end on PGlite with a fake executor and fake Muse in `packages/api/test/benchmark.test.ts`.

## Rolling back

Roll back first, then investigate. A rollback never undoes a migration, which is why migrations must be additive.

### Render (API)
- **Dashboard:** `agentboard-api` → Events (or Deploys) → find the last good deploy → **Rollback** (Render's docs call it
  "Rollback to this deploy"). Render rebuilds nothing; it reuses that deploy's build.
- **API:** `POST https://api.render.com/v1/services/<serviceId>/rollback` with body `{"deployId": "<good deploy id>"}`
  and header `Authorization: Bearer <Render API key>`. Find the deploy id with
  `GET /v1/services/<serviceId>/deploys?limit=10`.
- Auto-deploy will ship the next push to `main` again, so revert the bad commit on `main` (`git revert`, normal push)
  before the next deploy, or pause auto-deploy in the service settings while you fix it.
- Confirm: `curl -s https://agentboard-api.onrender.com/healthz` shows `"ok":true` and the good `commit`.

### Vercel (web, Muse proxy, skill pages)
- **Dashboard:** project → Deployments → the last good production deployment → ⋯ → **Instant Rollback**. It switches the
  production domain at once, with no rebuild.
- **CLI:** `vercel rollback <deployment-url-or-id>` (or `vercel rollback` for the previous production deployment).
- After an instant rollback Vercel stops auto-assigning new pushes to production until you promote a deployment
  again (Deployments → ⋯ → Promote, or "Undo Rollback"). Remember to do that after the fix lands.
- Confirm: `curl -s https://agentboard-olive-pi.vercel.app/version.json` shows the good `commit`.

### MCP bundle
`npx -y github:jai-rathore/agentboard` runs `main`'s `bin/agentboard-mcp.mjs`; revert the commit on `main` to roll it back.
Clients pinned to a commit (`github:jai-rathore/agentboard#<sha>`) are unaffected.

## Recommended service settings (documented only; not applied)

These are recommendations; nothing in this repo changes Render or Vercel settings.

- **Render health check path:** `/healthz` (already in `render.yaml`). Render waits for it before switching traffic to a
  new deploy, so a build that can't boot (bad env, failed migration) never takes over from the running one.
- **Render auto-deploy trigger:** "After CI checks pass" (`autoDeployTrigger: checksPass` in a Blueprint) so a push
  with red CI is not deployed. Same idea on Vercel: leave production deploys on, and rely on the post-deploy smoke
  plus instant rollback.
- **Pre-deploy command:** not available on the free plan; migrations run on boot. On a paid plan, a pre-deploy
  `cd packages/api && node dist/migrate-cli.js` (after adding it to the tsup entries) would apply migrations before
  traffic moves, and a failed migration would stop the deploy instead of the new instance.
- **GitHub branch protection on `main`** (not enabled): require the `CI` checks (`checks`, `postgres`, `e2e`,
  `gitleaks`) before merging, block force-pushes and deletion. Pushes by automation would then go through PRs.

## Commit stamp

- API: `/healthz` and `/v1/node` include `commit` from `RENDER_GIT_COMMIT` (set by Render at runtime;
  `AGENTBOARD_COMMIT` overrides it), `null` locally.
- Web: the build writes `/version.json` (`{"commit", "built_at"}`) and a `<meta name="agentboard-commit">` tag from
  `VERCEL_GIT_COMMIT_SHA` (or `GITHUB_SHA` in CI).
