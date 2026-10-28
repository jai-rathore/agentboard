import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "services/*/test/**/*.test.ts", "scripts/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    pool: "forks",
    // Fails any test that tries to reach a real paid model API (Meta, Baseten, Fireworks, ...).
    setupFiles: ["./test/no-real-ai-calls.ts"],
  },
});
