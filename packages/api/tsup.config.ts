import { defineConfig } from "tsup";

// Production bundle: plain JS (no tsx at runtime; tsx's loader costs ~150 MB RSS with
// transformers.js). Workspace packages are bundled; npm dependencies stay external.
export default defineConfig({
  entry: { server: "src/server.ts", "migrate-cli": "src/db/migrate-cli.ts", "fetch-model": "src/fetch-model.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: false,
  noExternal: [/^@agentboard\//],
});
