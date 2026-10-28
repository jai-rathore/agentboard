import { describe, it, expect, afterAll } from "vitest";
import { makeNode, TestAgent, type TestNode } from "./helpers.js";
import { buildContext } from "../src/bootstrap.js";
import { loadConfig } from "../src/config.js";
import { HashEmbedder, LocalEmbedder, createEmbedder, cosine, type Embedder } from "../src/services/embeddings.js";
import { pinEmbedModel, backfillEmbeddings, embedPin } from "../src/services/reembed.js";

const nodes: TestNode[] = [];
afterAll(async () => { for (const n of nodes) await n.ctx.db.close(); });

describe("embedding storage", () => {
  it("stores 384-dim vectors (migration 3) and pins model@dim", async () => {
    const n = await makeNode(); nodes.push(n);
    const col = await n.ctx.db.query<any>(`SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'posts'::regclass AND attname = 'emb'`);
    expect(col.rows[0].t).toBe("vector(384)");
    const idx = await n.ctx.db.query<any>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'posts_emb_hnsw'`);
    expect(idx.rows[0].indexdef).toMatch(/hnsw/);
    const pin = await n.ctx.db.query<any>(`SELECT value FROM meta WHERE key = 'embed_model'`);
    expect(pin.rows[0].value).toBe("local-hash-384@384");
  });

  it("clears and re-embeds stored vectors when the model changes", async () => {
    const n = await makeNode(); nodes.push(n);
    const a = new TestAgent(n); await a.register("emb");
    const t = await a.submit("topic", { slug: "vectors", title: "Vector search" });
    expect(t.status).toBe(201);
    const p = await a.submit("post", { topic: "vectors", kind: "learning", title: "HNSW indexes need vector_cosine_ops for cosine", body: "Create the index with vector_cosine_ops when you query with <=>." });
    expect(p.status).toBe(201);
    // a different "model": same dimension, different features
    class OtherModel extends HashEmbedder { override get model() { return "other-model"; } }
    const other: Embedder = new OtherModel(384);
    expect(await pinEmbedModel(n.ctx.db, other)).toBe(true);
    expect((await n.ctx.db.query<any>(`SELECT count(*)::int AS c FROM posts WHERE emb IS NULL`)).rows[0].c).toBe(1);
    expect(await backfillEmbeddings(n.ctx.db, other)).toEqual({ posts: 1, topics: 1 });
    expect((await n.ctx.db.query<any>(`SELECT count(*)::int AS c FROM posts WHERE emb IS NULL`)).rows[0].c).toBe(0);
    expect((await n.ctx.db.query<any>(`SELECT value FROM meta WHERE key = 'embed_model'`)).rows[0].value).toBe(embedPin(other));
    expect(await pinEmbedModel(n.ctx.db, other)).toBe(false);
  });
});

describe("embedder selection", () => {
  it("defaults to the in-process bge-small model; Fireworks is opt-in; offline uses the hash embedder", () => {
    const local = createEmbedder(loadConfig({}));
    expect(local).toBeInstanceOf(LocalEmbedder);
    expect(local.model).toBe("Xenova/bge-small-en-v1.5");
    expect(local.dim).toBe(384);
    // a Fireworks key alone does not switch providers
    expect(createEmbedder(loadConfig({ FIREWORKS_API_KEY: "x" }))).toBeInstanceOf(LocalEmbedder);
    expect(createEmbedder(loadConfig({ EMBED_PROVIDER: "fireworks", FIREWORKS_API_KEY: "x" })).model).toBe("fireworks/qwen3-embedding-8b");
    expect(() => createEmbedder(loadConfig({ EMBED_PROVIDER: "fireworks" }))).toThrow(/FIREWORKS_API_KEY/);
    expect(createEmbedder(loadConfig({ AGENTBOARD_OFFLINE: "1" }))).toBeInstanceOf(HashEmbedder);
  });
});

// Real model run: downloads ~34 MB from Hugging Face on first use, so it is opt-in.
describe.runIf(process.env.AGENTBOARD_TEST_LOCAL_EMBED === "1")("local bge-small model (opt-in)", () => {
  it("embeds semantically and plugs into a node end to end", async () => {
    const e = new LocalEmbedder("Xenova/bge-small-en-v1.5", 384, process.env.EMBED_CACHE_DIR);
    const [q, rel, irr] = [...(await e.embed(["how do I combine two ranked result lists?"], "query")), ...(await e.embed(["Reciprocal rank fusion merges rankings from several retrievers.", "Bananas are a good source of potassium."], "document"))];
    expect(q).toHaveLength(384);
    expect(cosine(q, rel)).toBeGreaterThan(cosine(q, irr) + 0.15);
    const ctx = await buildContext(loadConfig({}, { embedProvider: "local", registerPowBits: 6, challengeDifficulty: 6, voteCreditMinAgeMs: 0 }), { embedder: e, awaitReembed: true });
    expect((await ctx.db.query<any>(`SELECT value FROM meta WHERE key = 'embed_model'`)).rows[0].value).toBe("Xenova/bge-small-en-v1.5@384");
    await ctx.db.close();
  }, 120_000);
});
