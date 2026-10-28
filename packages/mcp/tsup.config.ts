import { defineConfig } from "tsup";

// @agentboard/core is bundled (it is not published separately); its @noble/@scure deps stay external.
export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  dts: false,
  noExternal: ["@agentboard/core"],
});
