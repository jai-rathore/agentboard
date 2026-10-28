import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { verifyRecord } from "@agentboard/core";
import { makeNode, TestAgent, credits, type TestNode } from "./helpers.js";
import { replayCredits } from "../src/services/replay.js";

let node: TestNode;
let alice: TestAgent, bob: TestAgent;
let post: string, answer: string, keep: string;

beforeAll(async () => {
  node = await makeNode();
  alice = new TestAgent(node); bob = new TestAgent(node);
  await alice.register("alice"); await bob.register("bob");
  expect((await alice.topic("ops", "Operations")).status).toBe(201);
  post = (await alice.post("ops", "Retraction test post about deploy checks", "Throwaway body: zebra-quokka marker text.")).body.cid;
  keep = (await alice.post("ops", "A post that stays visible after retraction", "Other content that should remain.")).body.cid;
  answer = (await bob.answer(keep, "An answer bob will retract: walrus-marker.")).body.cid;
});
afterAll(async () => { await node?.ctx.db.close(); });

describe("retract", () => {
  it("only the author can retract", async () => {
    const r = await bob.submit("retract", { target: post });
    expect(r.status).toBe(403);
    expect(r.body.code ?? r.body.error).toMatch(/not_author/);
    expect((await alice.submit("retract", { target: "bafkreib2rxk3rybk3aobmojvtgoa35ycjx2jfbrdmfvw6xw2wq4qgo4xnm" })).status).toBe(404);
  });

  it("hides a retracted post from reads, listings and search, and costs nothing", async () => {
    const before = await credits(node, alice.kp.did);
    const r = await alice.submit("retract", { target: post, reason: "test content" });
    expect(r.status).toBe(201);
    expect(r.body.retracted).toBe("post");
    expect(await credits(node, alice.kp.did)).toBe(before);

    const t = (await node.req("GET", `/v1/posts/${post}`)).body;
    expect(t.post.status).toBe("retracted");
    expect(t.post.title).toMatch(/retracted/);
    expect(JSON.stringify(t)).not.toContain("zebra-quokka");
    expect(t.post.retraction).toMatchObject({ cid: r.body.cid, reason: "test content" });
    const retr = t.records.find((x: any) => x.record.cid === r.body.cid);
    expect(retr && verifyRecord(retr.record).ok).toBe(true);

    const recent = (await node.req("GET", "/v1/recent")).body.posts.map((p: any) => p.cid);
    expect(recent).not.toContain(post);
    expect(recent).toContain(keep);
    const topic = (await node.req("GET", "/v1/topics/ops")).body;
    expect(JSON.stringify(topic)).not.toContain(post);
    const s = (await node.req("GET", `/v1/search?q=${encodeURIComponent("retraction test post deploy checks zebra")}`)).body;
    expect(s.results.map((h: any) => h.cid)).not.toContain(post);
    const agent = (await node.req("GET", `/v1/agents/${alice.kp.did}`)).body;
    expect(agent.posts.map((p: any) => p.cid)).not.toContain(post);
  });

  it("keeps both records in the log", async () => {
    const log = (await node.req("GET", "/v1/log?since=0&limit=1000")).body.entries;
    expect(log.map((e: any) => e.record.type)).toContain("retract");
    const orig = log.find((e: any) => e.cid === post);
    expect(orig && verifyRecord(orig.record).ok).toBe(true);
  });

  it("refuses double retraction, votes, and answers on retracted content", async () => {
    expect((await alice.submit("retract", { target: post })).status).toBe(409);
    expect((await bob.vote(post)).status).toBe(409);
    expect((await bob.answer(post, "late answer")).status).toBe(409);
  });

  it("retracts an answer: stub in the thread, answer count drops", async () => {
    const before = (await node.req("GET", `/v1/posts/${keep}`)).body.post.answer_count;
    const r = await bob.submit("retract", { target: answer });
    expect(r.status).toBe(201);
    const t = (await node.req("GET", `/v1/posts/${keep}`)).body;
    const a = t.answers.find((x: any) => x.cid === answer);
    expect(a.status).toBe("retracted");
    expect(a.body).toBe("");
    expect(JSON.stringify(t)).not.toContain("walrus-marker");
    expect(t.post.answer_count).toBe(before - 1);
    expect(t.post.title).toMatch(/stays visible/);
  });

  it("replay still matches incremental credits", async () => {
    const info = (await node.req("GET", "/v1/node")).body;
    const log = (await node.req("GET", "/v1/log?since=0&limit=1000")).body.entries;
    const replayed = replayCredits(log, { voteCreditMinAgeMs: node.cfg.voteCreditMinAgeMs, nodeDid: info.node_did });
    const live = (await node.ctx.db.query<any>(`SELECT did, SUM(delta_milli)::float8 AS b FROM credit_ledger WHERE seq IS NOT NULL GROUP BY did`)).rows;
    for (const r of live) expect(replayed.get(r.did)).toBe(Number(r.b));
  });
});
