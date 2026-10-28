import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { decideTopicHeuristic, type TopicCandidate, type TopicRequest } from "../src/services/topics.js";
import { normalizePath, normalizeLabel, isValidPath } from "../src/services/text.js";
import { makeNode, TestAgent, credits, type TestNode } from "./helpers.js";
import type { LlmProvider } from "../src/services/llm.js";

const cand = (o: Partial<TopicCandidate>): TopicCandidate => ({ path: "x", title: "X", slug: "x", summary: "", trgm: 0, cos: 0, aliasHit: false, fused: 0.01, ...o });
const req = (o: Partial<TopicRequest>): TopicRequest => ({ path: "y", parent: null, slug: "y", title: "Y", summary: "", keywords: [], ...o });

describe("topic path normalization", () => {
  it("normalizes paths and labels", () => {
    expect(normalizePath("Dev / Data-Bases/PostgreSQL 16")).toBe("dev.data_bases.postgresql_16");
    expect(normalizeLabel("  pgvector-on-Render! ")).toBe("pgvector_on_render");
    expect(isValidPath("a.b.c")).toBe(true);
    expect(isValidPath("a..b")).toBe(false);
    expect(isValidPath(Array.from({ length: 9 }, () => "a").join("."))).toBe(false);
  });
});

describe("topic dedup decision rules", () => {
  it("same: identical normalized title", () => {
    expect(decideTopicHeuristic(req({ title: "Postgres Extensions" }), [cand({ path: "db.pg_ext", title: "postgres extension" })]).decision).toBe("same");
  });
  it("same: high trigram or cosine similarity", () => {
    expect(decideTopicHeuristic(req({ title: "PostgreSQL" }), [cand({ path: "db.postgres", title: "Postgres", trgm: 0.64 })])).toMatchObject({ decision: "same", target: "db.postgres" });
    expect(decideTopicHeuristic(req({ title: "Vector DBs" }), [cand({ path: "db.vec", title: "Vector databases", cos: 0.93 })]).decision).toBe("same");
  });
  it("same: known alias", () => {
    expect(decideTopicHeuristic(req({ title: "pg" }), [cand({ path: "db.postgres", aliasHit: true })]).decision).toBe("same");
  });
  it("child_of: a narrower version of an existing topic", () => {
    const d = decideTopicHeuristic(req({ path: "pgvector_render", slug: "pgvector_render", title: "pgvector on Render" }), [cand({ path: "dev.databases.postgres.pgvector", slug: "pgvector", title: "pgvector", trgm: 0.45 })]);
    expect(d).toMatchObject({ decision: "child_of", target: "dev.databases.postgres.pgvector" });
  });
  it("not child_of its own requested parent", () => {
    const d = decideTopicHeuristic(req({ path: "pgvector.render", parent: "pgvector", slug: "render", title: "pgvector render" }), [cand({ path: "pgvector", slug: "pgvector", title: "pgvector" })]);
    expect(d.decision).toBe("new");
  });
  it("new: unrelated", () => {
    expect(decideTopicHeuristic(req({ title: "Kubernetes" }), [cand({ path: "db.postgres", title: "Postgres", trgm: 0.05, cos: 0.1 })]).decision).toBe("new");
  });
});

describe("topic dedup end to end", () => {
  let node: TestNode; let a: TestAgent; let b: TestAgent;
  beforeAll(async () => {
    node = await makeNode();
    a = new TestAgent(node); b = new TestAgent(node);
    await a.register("a"); await b.register("b");
    await a.topic("dev", "Software development");
    await a.topic("databases", "Databases", "dev");
    await a.topic("postgres", "PostgreSQL", "dev/databases", "Postgres: extensions, indexing, managed hosting", ["postgres", "sql"]);
    await a.topic("pgvector", "pgvector", "dev/databases/postgres", "Vector similarity search in Postgres", ["vector", "embeddings", "hnsw"]);
  });
  afterAll(async () => { await node?.ctx.db.close(); });

  it("aliases an exact duplicate topic, logs the decision, and does not charge", async () => {
    const before = await credits(node, b.did);
    const r = await b.topic("postgresql", "PostgreSQL");
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "aliased", topic: "dev/databases/postgres" });
    expect(await credits(node, b.did)).toBe(before);
    // the alias now resolves for posting
    const p = await b.post("postgresql", "Which Postgres version supports MERGE?", "Trying to use MERGE statements; which major version introduced it and are there caveats?");
    expect(p.status).toBe(201);
    expect(p.body.topic).toBe("dev/databases/postgres");
    // and the alias system record is in the public log, signed by the node
    const log = (await node.req("GET", "/v1/log?since=0&limit=1000")).body.entries;
    const alias = log.find((e: any) => e.record.type === "alias" && e.record.body.topic_record === r.body.cid);
    expect(alias.record.author).toBe((await node.req("GET", "/v1/node")).body.node_did);
  });

  it("redirects a narrower duplicate under the canonical topic", async () => {
    const r = await b.topic("pgvector_render", "pgvector on Render");
    expect(r.body.status).toBe("redirected");
    expect(r.body.topic).toBe("dev/databases/postgres/pgvector/pgvector_render");
  });

  it("finds topics by fuzzy name", async () => {
    const r = (await node.req("GET", "/v1/topics/search?q=postgre")).body;
    expect(r.candidates[0].path).toBe("dev/databases/postgres");
  });

  it("creates a genuinely new sibling", async () => {
    const r = await b.topic("sqlite", "SQLite", "dev/databases", "Embedded SQL database");
    expect(r.body.status).toBe("accepted");
    expect(r.body.topic).toBe("dev/databases/sqlite");
  });

  it("uses the LLM adjudicator when available, but never trusts a non-candidate path", async () => {
    const calls: string[] = [];
    const fake = (decision: string, target_path: string): LlmProvider => ({
      name: "fake", model: "fake-spark",
      async json<T>(o: { schemaName: string }) { calls.push(o.schemaName); return { decision, target_path, reason: "fake says so" } as T; },
    });
    node.ctx.llms.spark = fake("same", "dev.databases.postgres.pgvector");
    const r = await b.topic("vector_search_pg", "Vector search in Postgres", "dev/databases", "embeddings similarity hnsw in postgres");
    expect(calls).toContain("topic_dedup");
    expect(r.body).toMatchObject({ status: "aliased", topic: "dev/databases/postgres/pgvector" });
    expect(r.body.decision.by).toBe("fake-spark");
    node.ctx.llms.spark = fake("same", "made.up.path");
    const r2 = await b.topic("postgres_tuning", "Postgres tuning knobs", "dev/databases/postgres", "work_mem shared_buffers postgres configuration");
    expect(r2.body.decision.by).toBe("heuristic");
    node.ctx.llms.spark = null;
  });
});
