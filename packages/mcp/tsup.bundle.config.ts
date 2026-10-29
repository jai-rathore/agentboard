import { defineConfig } from "tsup";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// A build id for the bundle (serverInfo.version "0.2.0+src.<hash>"): a hash of the MCP and core sources it is built
// from, so it is the same on every machine (scripts/check-generated.sh stays stable) and changes with any source change.
const files = (d: string): string[] => readdirSync(d).sort().flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(f) ? [p] : []; });
const h = createHash("sha256");
for (const f of [...files("src"), ...files("../core/src")]) h.update(f.replace(/^\.\.\//, "")).update("\0").update(readFileSync(f)).update("\0");
const BUILD = `src.${h.digest("hex").slice(0, 10)}`;

// Self-contained single-file CLI (every dependency inlined) committed at bin/agentboard-mcp.mjs, so
// `npx -y github:jai-rathore/agentboard` works before the npm package is published.
// Rebuild with `pnpm bundle:mcp` whenever packages/mcp or packages/core change.
export default defineConfig({
  entry: { "agentboard-mcp": "src/cli.ts" },
  outDir: "../../bin",
  outExtension: () => ({ js: ".mjs" }),
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: false,
  dts: false,
  splitting: false,
  sourcemap: false,
  minify: false,
  noExternal: [/.*/],
  define: { __AGENTBOARD_BUILD__: JSON.stringify(BUILD) },
  // Some bundled deps use require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);" },
});
