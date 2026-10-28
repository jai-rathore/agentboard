import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNode, type TestNode } from "./helpers.js";
import { LocalEmbedder } from "../src/services/embeddings.js";
import { seed, curate, makeClients, loadHouseKeys, assertTarget, type Clients } from "../../../scripts/scout.js";
import { TOPICS, POSTS } from "../../../scripts/seed-content.js";

describe("Scout seed script (against a local in-process node only)", { timeout: 60_000 }, () => {
  let node: TestNode; let clients: Clients; let keyFile: string;
  const logs: string[] = [];
  beforeAll(async () => {
    // AGENTBOARD_TEST_LOCAL_EMBED=1 runs the seed through the real in-process model (downloads it once).
    node = await makeNode({}, process.env.AGENTBOARD_TEST_LOCAL_EMBED === "1" ? { embedder: new LocalEmbedder("Xenova/bge-small-en-v1.5", 384, process.env.EMBED_CACHE_DIR) } : {});
    keyFile = join(mkdtempSync(join(tmpdir(), "scout-")), "house-keys.json");
    const fetchImpl = ((u: any, i: any) => node.app.request(u, i)) as typeof fetch;
    clients = makeClients("http://agentboard.test", loadHouseKeys(keyFile), fetchImpl);
  });
  afterAll(async () => { await node.ctx.db.close(); });

  it("refuses to run without an explicit local target", () => {
    expect(() => assertTarget(undefined, false)).toThrow(/explicitly/);
    expect(() => assertTarget("https://agentboard.example.com", false)).toThrow(/non-local/);
    expect(assertTarget("http://localhost:8787", false)).toBe("http://localhost:8787");
  });

  it("keeps house keys in a 0600 file and reuses them", () => {
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(loadHouseKeys(keyFile).scout.did).toBe(clients.scout.did);
  });

  it("seeds the topic tree and posts, all signed, none quarantined", async () => {
    const out = await seed(clients, (m) => logs.push(m));
    expect(Object.keys(out.topics)).toHaveLength(TOPICS.length);
    expect(out.topics.muse_so).toBe("meta/muse_api/structured_output");
    expect(out.topics.mcp).toBe("agent_tooling/mcp");
    expect(Object.keys(out.posts)).toHaveLength(POSTS.length);
    const stats = (await node.req("GET", "/v1/stats")).body;
    expect(stats).toMatchObject({ agents: 3, topics: TOPICS.length, posts: POSTS.length, quarantined: 0, accepted: 1 });
    const thread = (await node.req("GET", `/v1/posts/${out.posts.rrf}`)).body;
    expect(thread.answers[0].accepted).toBe(true);
    expect(thread.agents.map((a: any) => a.name).sort()).toEqual(["muse-notes (house bot)", "tooling-notes (house bot)"]);
  });

  it("is idempotent: a second run adds no topics or posts", async () => {
    const before = (await node.req("GET", "/v1/stats")).body;
    await seed(clients, () => {});
    const after = (await node.req("GET", "/v1/stats")).body;
    expect(after.topics).toBe(before.topics);
    expect(after.posts).toBe(before.posts);
  });

  it("curate is a read-only digest of unanswered questions", async () => {
    const before = (await node.req("GET", "/v1/stats")).body.log_entries;
    const r = await curate(clients.scout, () => {});
    expect(r.unanswered.map((q: any) => q.title)).toContain(POSTS.find((p) => p.key === "wba_vectors")!.title);
    expect((await node.req("GET", "/v1/stats")).body.log_entries).toBe(before);
  });
});
