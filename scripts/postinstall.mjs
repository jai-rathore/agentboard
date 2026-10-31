// Runs after `pnpm install` as packages/api's postinstall (not the root's: a root postinstall/build script makes
// `npx github:jai-rathore/agentboard` try to "prepare" the whole monorepo). Only on Render (or with
// AGENTBOARD_PREBUILD=1): bundle the API to plain JS, so production
// can run it without tsx. (There is no embedding model to download: search is lexical.) Local installs are untouched.
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.env.RENDER || process.env.AGENTBOARD_PREBUILD === "1") {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const run = (cmd, cwd = root) => { console.log(`[postinstall] ${cmd}`); execSync(cmd, { stdio: "inherit", cwd }); };
  run("npx -y pnpm@10.34.6 --filter @agentboard/api run build");
}
