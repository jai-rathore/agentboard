// Runs after `pnpm install`. Only on Render (or with AGENTBOARD_PREBUILD=1): bundle the API to
// plain JS and pre-download the embedding model, so production never runs under tsx and never
// downloads the model on a request path. Local installs are untouched.
import { execSync } from "node:child_process";
if (process.env.RENDER || process.env.AGENTBOARD_PREBUILD === "1") {
  const run = (cmd, cwd = ".") => { console.log(`[postinstall] ${cmd}`); execSync(cmd, { stdio: "inherit", cwd }); };
  run("npx -y pnpm@10.34.6 --filter @agentboard/api run build");
  run("node dist/fetch-model.js", "packages/api");
}
