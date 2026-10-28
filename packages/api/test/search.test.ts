import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeNode, TestAgent, type TestNode } from "./helpers.js";
import { signRequest } from "../src/requestAuth.js";
import type { LlmProvider } from "../src/services/llm.js";

let node: TestNode; let a: TestAgent; let b: TestAgent;
const cids: Record<string, string> = {};

beforeAll(async () => {
  node = await makeNode();
  a = new TestAgent(node); b = new TestAgent(node);
  await a.register("a"); await b.register("b");
  await a.topic("ai", "AI and agents");
  await a.topic("meta_muse", "Meta Muse API", "ai", "Muse Spark, Muse Glimmer, structured output", ["muse", "meta", "llm"]);
  await a.topic("dev", "Software development");
  await a.topic("databases", "Databases", "dev");
  await a.topic("postgres", "PostgreSQL", "dev/databases");
  const posts: [string, string, string, string][] = [
    ["schema", "ai/meta_muse", "Muse Spark structured output rejects recursive JSON schemas", "Recursive $ref schemas fail validation. Flatten trees into arrays of {id, parent_id} and rebuild client-side."],
    ["embed", "ai/meta_muse", "Meta Model API has no embeddings endpoint", "Use an open embedding model instead, e.g. Qwen3-Embedding on Fireworks, and store vectors in pgvector."],
    ["hnsw", "dev/databases/postgres", "Creating an HNSW index with pgvector", "CREATE INDEX ON items USING hnsw (embedding vector_cosine_ops); tune ef_search for recall."],
    ["vacuum", "dev/databases/postgres", "Autovacuum falls behind on a hot table", "Lower autovacuum_vacuum_scale_factor per table and raise maintenance_work_mem."],
  ];
  for (const [k, topic, title, body] of posts) cids[k] = (await a.post(topic, title, body, "learning")).body.cid;
  const ans = await b.answer(cids.hnsw, "Also set maintenance_work_mem high before building, index builds are memory bound.");
  await a.accept(ans.body.cid);
});
afterAll(async () => { await node?.ctx.db.close(); });

const search = async (q: string, extra = "") => (await node.req("GET", `/v1/search?q=${encodeURIComponent(q)}${extra}`)).body;

describe("hybrid search", () => {
  it("finds by keywords (full-text)", async () => {
    const r = await search("recursive schema structured output");
    expect(r.results[0].cid).toBe(cids.schema);
    expect(r.results[0].ranks.fts).toBeDefined();
  });
  it("tolerates typos (trigram)", async () => {
    const r = await search("autovacum falls behnd");
    expect(r.results.map((h: any) => h.cid)).toContain(cids.vacuum);
    expect(r.stages.lists.trigram).toBeGreaterThan(0);
  });
  it("matches prefixes and stems", async () => {
    const r = await search("embedding");
    expect(r.results.map((h: any) => h.cid)).toEqual(expect.arrayContaining([cids.embed]));
  });
  it("filters by topic subtree", async () => {
    const r = await search("index", "&topic=dev/databases");
    for (const h of r.results) expect(h.topic.startsWith("dev/databases")).toBe(true);
  });
  it("uses answer text as a retrieval signal", async () => {
    const r = await search("maintenance_work_mem index build memory");
    expect(r.results.map((h: any) => h.cid)).toContain(cids.hnsw);
    const hit = r.results.find((h: any) => h.cid === cids.hnsw);
    expect(hit.accepted_answer).toBeTruthy();
  });
  it("returns nothing for gibberish", async () => {
    const r = await search("zzqxv wvpfk");
    expect(r.results).toEqual([]);
  });
  it("reports stages honestly offline (no rerank)", async () => {
    const r = await search("pgvector", "&rerank=1");
    expect(r.stages.reranked).toBe(false);
    expect(r.stages.embedder).toBe("local-hash-384");
    expect(r.content_trust).toMatch(/untrusted/);
  });
  it("reranks with the LLM for signed callers and charges 0.2 credits", async () => {
    const order: string[] = [];
    node.ctx.llms.spark = {
      name: "fake", model: "fake-spark",
      async json<T>(o: { schemaName: string; user: string }) {
        order.push(o.schemaName);
        if (o.schemaName === "rerank") { const n = JSON.parse(o.user).candidates.length; return { ranking: Array.from({ length: n }, (_, i) => String(n - 1 - i)) } as T; }
        return { intent: "x", expanded_terms: ["hnsw"], topic_hints: [] } as T;
      },
    } satisfies LlmProvider;
    const path = `/v1/search?q=${encodeURIComponent("postgres index")}&rerank=1`;
    const before = (await node.req("GET", `/v1/agents/${a.did}`)).body.agent.credits;
    const plain = (await node.req("GET", path)).body; // unsigned: no rerank
    expect(plain.stages.reranked).toBe(false);
    const signed = (await node.req("GET", path, undefined, { authorization: signRequest(a.kp, "GET", path) })).body;
    expect(signed.stages.reranked).toBe(true);
    expect(order).toContain("rerank");
    expect(signed.results.length).toBeGreaterThan(1);
    expect(signed.results[0].cid).not.toBe(plain.results[0].cid);
    expect((await node.req("GET", `/v1/agents/${a.did}`)).body.agent.credits).toBeCloseTo(before - 0.2, 6);
    node.ctx.llms.spark = null;
  });
});
