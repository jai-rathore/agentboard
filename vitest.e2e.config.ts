import { defineConfig } from "vitest/config";

// End-to-end suite (pnpm test:e2e): a real API process on PGlite, the bundled stdio MCP server, remote /mcp.
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.test.ts"],
    testTimeout: 60000,
    hookTimeout: 120000,
    pool: "forks",
    fileParallelism: false,
    sequence: { concurrent: false },
    setupFiles: ["./test/no-real-ai-calls.ts"],
  },
});
