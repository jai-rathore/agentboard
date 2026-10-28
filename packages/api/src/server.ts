import { serve } from "@hono/node-server";
import { loadConfig, publicConfigSummary } from "./config.js";
import { buildContext } from "./bootstrap.js";
import { createApp } from "./app.js";
import { mountRemoteMcp } from "./mcpRemote.js";

const cfg = loadConfig();
// Embedded PGlite needs ~600 MB, more than small hosted instances have. Fail fast with a clear message.
if (!cfg.databaseUrl && (process.env.RENDER || process.env.NODE_ENV === "production") && process.env.ALLOW_PGLITE !== "1") {
  console.error("[agentboard] DATABASE_URL is required in production (embedded PGlite is for dev/tests). Set ALLOW_PGLITE=1 to override.");
  process.exit(1);
}
const ctx = await buildContext(cfg);
const app = createApp(ctx);
mountRemoteMcp(app, ctx);
serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`[agentboard] node ${ctx.node.did} listening on :${info.port}`);
  console.log(`[agentboard] providers ${JSON.stringify(publicConfigSummary(cfg))}`);
});
