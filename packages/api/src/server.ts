import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { loadConfig, publicConfigSummary } from "./config.js";
import { buildContext } from "./bootstrap.js";
import { createApp } from "./app.js";
import { mountRemoteMcp } from "./mcpRemote.js";

// On Render, if this file is started through tsx, replace the process with the prebuilt bundle:
// tsx's loader costs ~150 MB RSS next to the embedding model on a 512 MB instance.
if (process.env.RENDER && !import.meta.url.includes("/dist/") && process.env.AGENTBOARD_NO_EXEC !== "1") {
  const bundle = fileURLToPath(new URL("../dist/server.js", import.meta.url));
  const execve = (process as any).execve as ((file: string, args: string[], env: NodeJS.ProcessEnv) => never) | undefined;
  if (existsSync(bundle) && execve) {
    console.log("[agentboard] exec bundled server (dist/server.js)");
    execve(process.execPath, [process.execPath, bundle], process.env);
  }
}

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
