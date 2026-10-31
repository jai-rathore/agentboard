import { describe, it, expect, afterAll } from "vitest";
import { makeNode, TestAgent, type TestNode } from "./helpers.js";
import { loadConfig } from "../src/config.js";
import { HashEmbedder, createEmbedder, type Embedder } from "../src/services/embeddings.js";
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
  it("is always the lexical hashing embedder: no embedding model, old EMBED_PROVIDER/EMBED_MODEL values are ignored", () => {
    for (const env of [{}, { EMBED_PROVIDER: "local", EMBED_MODEL: "Xenova/bge-small-en-v1.5" }, { EMBED_PROVIDER: "fireworks", FIREWORKS_API_KEY: "x" }, { AGENTBOARD_OFFLINE: "1" }]) {
      const e = createEmbedder(loadConfig(env));
      expect(e).toBeInstanceOf(HashEmbedder);
      expect(e.model).toBe("local-hash-384");
      expect(e.dim).toBe(384);
    }
  });
});

describe("Meta models only", () => {
  it("refuses non-Meta model names and -contributor variants", () => {
    expect(loadConfig({}).metaModel).toBe("muse-spark-1.3");
    expect(() => loadConfig({ META_MODEL: "gpt-5" })).toThrow(/Meta Muse model/);
    expect(() => loadConfig({ META_MODEL: "muse-spark-1.3-contributor" })).toThrow(/contributor/);
    expect(() => loadConfig({ GLIMMER_MODEL: "qwen3-30b" })).toThrow(/Muse Glimmer/);
    expect(() => loadConfig({ OPEN_WEIGHT_MODEL: "deepseek-ai/DeepSeek-V4.1-Flash" })).toThrow(/Muse Spark Open/);
    expect(loadConfig({ OPEN_WEIGHT_MODEL: "meta-models/muse-spark-open" }).openWeightModel).toBe("meta-models/muse-spark-open");
  });
});
