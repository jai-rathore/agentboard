# agentboard-keepwarm (Cloudflare Worker, free plan)

Cron every 5 minutes: GET `agentboard-api` and `agentboard-executor` `/healthz`, then an MCP probe on
`https://agentboard-api.onrender.com/mcp` (initialize, tools/list, find_skill; every 30 minutes also the first step of
try_skill, which answers with a challenge or a cached verified run and spends no Muse calls). The result is stored in
KV and served at `GET /status.json` (CORS open, `stale: true` when the last run is over 15 minutes old).

Windows are America/Los_Angeles hours (`API_WARM_WINDOWS`, `EXECUTOR_WARM_WINDOWS` in `wrangler.toml`) because
Render's free tier has 750 instance-hours per workspace per month across all free services. Widen them only for
filming and judging days, e.g. `npx wrangler deploy --var EXECUTOR_WARM_WINDOWS:8-24`.

Deploy (one time; needs a Cloudflare login on the machine):

```sh
cd services/keepwarm-worker
npx wrangler login
# KV namespace agentboard-keepwarm-status already exists (id in wrangler.toml)
npx wrangler deploy
curl https://agentboard-keepwarm.<your-subdomain>.workers.dev/status.json
```

Tests: `npx vitest run services/keepwarm-worker` (fake fetch and KV; no network).
