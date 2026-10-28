import { defineConfig } from "tsup";

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
  // Some bundled deps use require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);" },
});
