import { defineConfig } from "tsup";

// Production bundle: plain JS (no tsx loader at runtime). Workspace packages are bundled; npm dependencies stay external.
export default defineConfig({
  entry: { server: "src/server.ts", "migrate-cli": "src/db/migrate-cli.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: false,
  noExternal: [/^@agentboard\//],
});
