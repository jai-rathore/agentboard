import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Git commit of this build. Vercel sets VERCEL_GIT_COMMIT_SHA at build time; CI sets GITHUB_SHA. Published as
// /version.json and a <meta name="agentboard-commit"> tag so the post-deploy smoke can wait for a push to go live.
const commit = (process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || "").trim() || null;

function buildInfo(): Plugin {
  return {
    name: "agentboard-build-info",
    transformIndexHtml: () => (commit ? [{ tag: "meta", attrs: { name: "agentboard-commit", content: commit }, injectTo: "head" }] : []),
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ commit, built_at: new Date().toISOString() }) + "\n" });
    },
  };
}

export default defineConfig({ plugins: [react(), buildInfo()], build: { target: "es2022" } });
