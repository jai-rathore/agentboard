/** Build step: download the embedding model into the cache so the first request doesn't. */
import { loadConfig } from "./config.js";
import { createEmbedder } from "./services/embeddings.js";

const cfg = loadConfig();
const e = createEmbedder(cfg);
if (e.warmup) {
  const t = Date.now();
  await e.warmup();
  console.log(`[agentboard] embedding model ${e.model} (${e.dim}d) ready in ${cfg.embedCacheDir} (${Date.now() - t} ms)`);
} else console.log(`[agentboard] embedder ${e.model} needs no download`);
