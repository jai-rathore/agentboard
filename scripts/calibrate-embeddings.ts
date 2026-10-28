/**
 * Prints cosine statistics for the in-process embedder on the seed corpus, to sanity-check the
 * thresholds in BGE_SMALL_THRESHOLDS. Runs fully locally (first run downloads the model).
 *   EMBED_CACHE_DIR=.models npx tsx scripts/calibrate-embeddings.ts
 */
import { LocalEmbedder, cosine } from "../packages/api/src/services/embeddings.js";
import { topicText } from "../packages/api/src/services/topics.js";
import { postEmbedText } from "../packages/api/src/services/reembed.js";
import { TOPICS, POSTS } from "./seed-content.js";

const e = new LocalEmbedder(process.env.EMBED_MODEL || "Xenova/bge-small-en-v1.5", 384, process.env.EMBED_CACHE_DIR);
const maxPair = (vs: number[][], names: string[]) => {
  let best = { c: -1, a: "", b: "" };
  for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) { const c = cosine(vs[i], vs[j]); if (c > best.c) best = { c, a: names[i], b: names[j] }; }
  return best;
};
const tv = await e.embed(TOPICS.map((t) => topicText(t)), "document");
console.log("distinct topics, max cosine:", maxPair(tv, TOPICS.map((t) => t.key)));
const pv = await e.embed(POSTS.map((p) => postEmbedText(p)), "document");
console.log("distinct posts, max cosine:", maxPair(pv, POSTS.map((p) => p.key)));
const para: [object, object][] = [
  [{ title: "Model Context Protocol", slug: "mcp" }, { title: "MCP", slug: "mcp_servers" }],
  [{ title: "Retrieval and embeddings", slug: "retrieval" }, { title: "Embeddings and retrieval", slug: "embeddings" }],
  [{ title: "Meta Model API (Muse)", slug: "muse_api" }, { title: "Muse API", slug: "muse_api_tips" }],
];
for (const [a, b] of para) { const [x, y] = await e.embed([topicText(a as any), topicText(b as any)], "document"); console.log("paraphrase topics", (a as any).title, "~", (b as any).title, cosine(x, y).toFixed(3)); }
const reword = POSTS.find((p) => p.key === "rrf")!;
const [o, r] = await e.embed([postEmbedText(reword), postEmbedText({ ...reword, title: "Hybrid retrieval in Postgres: full text, pgvector and trigram fused by RRF", body: reword.body.replace("One Postgres can do", "A single Postgres handles") })], "document");
console.log("reworded duplicate post:", cosine(o, r).toFixed(3));
const qs = ["how do I combine full text and vector search results", "does meta have an embeddings endpoint", "bananas nutrition"];
const qv = await e.embed(qs, "query");
for (let i = 0; i < qs.length; i++) { const best = Math.max(...pv.map((p) => cosine(qv[i], p))); console.log(`query "${qs[i]}": best post cosine ${best.toFixed(3)}`); }
