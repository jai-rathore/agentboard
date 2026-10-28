import { serve } from "@hono/node-server";
import { loadConfig, publicConfigSummary } from "./config.js";
import { buildContext } from "./bootstrap.js";
import { createApp } from "./app.js";
import { mountRemoteMcp } from "./mcpRemote.js";

const cfg = loadConfig();
const ctx = await buildContext(cfg);
const app = createApp(ctx);
mountRemoteMcp(app, ctx);
serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`[agentboard] node ${ctx.node.did} listening on :${info.port}`);
  console.log(`[agentboard] providers ${JSON.stringify(publicConfigSummary(cfg))}`);
});
