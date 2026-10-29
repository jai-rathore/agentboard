/**
 * Wins, task difficulty, reuse reputation and the leaderboard (services/wins.ts): pure folds over signed records,
 * the `win` write path, GET /v1/leaderboard and the MCP client's postWin. No model calls.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRecord, generateKeyPair, winBodyFromRun, selfReportedWinBody, verifyRecord, type KeyPair, type SignedRecord } from "@agentboard/core";
import { AgentboardClient } from "@agentboard/mcp";
import { makeNode, TestAgent, type TestNode } from "./helpers.js";
import { computeLeaderboard, reuseEdges, DIFFICULTY, type LogRec } from "../src/services/wins.js";
import { appendToLog } from "../src/services/log.js";
import { replayKarma } from "../src/services/replay.js";

const NODE = generateKeyPair();
const A = generateKeyPair(), B = generateKeyPair(), C = generateKeyPair(), DEMO = generateKeyPair();
const T0 = Date.parse("2026-10-29T00:00:00Z");
let seq = 0;
const item = (rec: SignedRecord): LogRec => ({ seq: ++seq, received_at: new Date(T0 + seq * 1000), record: rec });
// distinct created_at per record: identical bodies signed in the same millisecond would share a cid
let tick = 0;
const at = () => new Date(T0 + ++tick);
const skill = (slug: string, o: { draft?: boolean; proposer?: string } = {}) => item(createRecord(NODE, "skill", { slug, version: 1, prev: null, skill: { name: `Task ${slug}`, params: [], steps: [] }, source: { start_url: "https://example.org/" }, ...(o.draft ? { draft: "d" } : {}), ...(o.proposer ? { proposal: { proposer: o.proposer, cid: "x" } } : {}) }, at()));
const run = (skillCid: string, by: KeyPair | "web" | "public", success = true, extra: Record<string, unknown> = {}) => item(createRecord(NODE, "skill_run", {
  skill: skillCid, success, params: {}, start_url: "https://example.org/", actions: [{ turn: 1, type: "click", detail: "click go", approval: "auto", checks: [] }],
  evidence: { final_screenshot: "a".repeat(64), gif: null },
  requested_by: by === "web" ? { via: "web" } : by === "public" ? { via: "public", job: "j" } : { via: "agent", agent: by.did, job: "j" }, ...extra,
}, at()));
const cold = (slug: string, skillCid: string, by: KeyPair, success: boolean) => item(createRecord(NODE, "benchmark_run", { benchmark: "b1", role: "cold", task_of: { slug, skill: skillCid }, requested_by: { via: "benchmark", agent: by.did }, success, actions: [], evidence: { final_screenshot: "b".repeat(64) } }, at()));
const opts = (agents: [KeyPair, string, string?][] = []) => ({ nodeDid: NODE.did, mockHosts: [], agents: new Map(agents.map(([k, name, status]) => [k.did, { did: k.did, name, is_house: false, status: status ?? "active" }])) });

describe("difficulty and leaderboard (pure fold)", () => {
  it("scores a task hard when cold attempts fail and replays of its skill verify; ranks only verified wins", () => {
    seq = 0;
    const hard = skill("hard-task", { draft: true });
    const pub = run(hard.record.cid, "web"); // publishing run (seq right after the skill): not a replay
    const easy = skill("easy-task");
    const items = [hard, pub, easy,
      cold("hard-task", hard.record.cid, C, false), cold("hard-task", hard.record.cid, C, false), cold("hard-task", hard.record.cid, C, false),
      run(hard.record.cid, A), run(hard.record.cid, B), run(hard.record.cid, B, false),
      run(easy.record.cid, B), run(easy.record.cid, "public"),
      cold("easy-task", easy.record.cid, C, true),
    ];
    const lb = computeLeaderboard(items, opts([[A, "alpha"], [B, "beta"]]));
    const h = lb.tasks.find((t: any) => t.slug === "hard-task")!, e = lb.tasks.find((t: any) => t.slug === "easy-task")!;
    // f_cold = (3+1)/(3+2) = 0.8; s_reuse = (2+1)/(3+2) = 0.6; no benchmarks -> savings 0; 1 + 3*0.8*0.6 = 2.44
    expect(h.difficulty).toBe(2.44);
    expect(h.hard).toBe(true);
    expect(h.evidence).toMatchObject({ cold_attempts: 3, cold_failures: 3, replays: 3, verified_replays: 2, publishing_runs: 1 });
    expect(e.hard).toBe(false);
    expect(e.difficulty).toBeLessThan(h.difficulty);
    expect(lb.hardest_tasks[0].slug).toBe("hard-task");
    const by = (name: string) => lb.entrants.find((x: any) => x.name === name)!;
    // beta solved both tasks; alpha only the hard one; the score is the sum of distinct tasks' difficulty
    expect(by("beta").score).toBeCloseTo(h.difficulty + e.difficulty, 5);
    expect(by("alpha").score).toBe(h.difficulty);
    expect(by("beta").rank).toBe(1);
    // the house operator (web runs) is labeled, the anonymous public trials are shown and never ranked
    const house = lb.entrants.find((x: any) => x.key === "house:operator")!;
    expect(house.kind).toBe("house");
    expect(house.label).toMatch(/HOUSE/);
    expect(house.independent).toBe(false);
    const anon = lb.entrants.find((x: any) => x.key === "anonymous:public")!;
    expect(anon.ranked).toBe(false);
    expect(anon.rank).toBeNull();
    // benchmark identities are labeled seeded, never disguised as independent agents
    const seeded = lb.entrants.find((x: any) => x.did === C.did);
    expect(seeded.kind).toBe("seeded");
    expect(seeded.label).toMatch(/SEEDED/);
    expect(DIFFICULTY.formula).toMatch(/f_cold/);
  });

  it("posted wins: verified ranks, unverified and self-reported are shown only; demo and hidden identities are labeled or left out", () => {
    seq = 0;
    const s = skill("t");
    const okA = run(s.record.cid, A), failA = run(s.record.cid, A, false), webRun = run(s.record.cid, "web"), okDemo = run(s.record.cid, DEMO), okHidden = run(s.record.cid, C);
    const win = (k: KeyPair, body: Record<string, unknown>) => item(createRecord(k, "win", body, at()));
    const items = [s, okA, failA, webRun, okDemo, okHidden,
      win(A, winBodyFromRun(okA.record.cid, okA.record.body)),
      win(A, winBodyFromRun(failA.record.cid, failA.record.body)),
      win(B, winBodyFromRun(webRun.record.cid, webRun.record.body)), // claims a run it did not request
      win(B, selfReportedWinBody("booked a table", [{ action: "step", detail: "opened the site" }])),
    ];
    const lb = computeLeaderboard(items, opts([[A, "alpha"], [B, "beta"], [DEMO, "demo-reviewer-1"], [C, "hidden-one", "hidden"]]));
    expect(computeLeaderboard(items, opts([[C, "retired-test", "retracted"]])).entrants.find((x: any) => x.did === C.did)).toBeUndefined();
    const a = lb.entrants.find((x: any) => x.did === A.did)!;
    expect(a.ranked).toBe(true);
    expect(a.posted_wins).toBe(2);
    expect(a.wins.find((w: any) => w.run === okA.record.cid)).toMatchObject({ status: "verified", ranked: true, posted: true });
    expect(a.wins.find((w: any) => w.run === failA.record.cid)).toMatchObject({ status: "unverified", ranked: false });
    const b = lb.entrants.find((x: any) => x.did === B.did)!;
    expect(b.ranked).toBe(false);
    expect(b.rank).toBeNull();
    expect(b.wins.map((w: any) => w.status).sort()).toEqual(["self_reported", "unverified"]);
    expect(lb.entrants.find((x: any) => x.did === DEMO.did)).toMatchObject({ kind: "demo", independent: false });
    expect(lb.entrants.find((x: any) => x.did === C.did)).toBeUndefined();
    expect(lb.posted_wins.filter((w: any) => w.ranked)).toHaveLength(1);
  });

  it("reuse edges: another identity's verified replay of your skill or your run's trace endorses you; self-replays never", () => {
    seq = 0;
    const s = skill("p", { proposer: A.did });
    const s2 = skill("q");
    const srcRun = run(s2.record.cid, B);
    const items = [s, s2, srcRun,
      run(s.record.cid, B), run(s.record.cid, B), // B reuses A's proposed skill twice: one edge
      run(s.record.cid, A), // A replays its own skill: nothing
      run(s2.record.cid, C, true, { replay: { mode: "trace", trace_source: `run:${srcRun.record.cid}` } }), // C reuses B's trace
      run(s2.record.cid, B, true, { replay: { mode: "trace", trace_source: `run:${srcRun.record.cid}` } }), // B reuses its own trace: nothing
      run(s.record.cid, C, false), // failed replays endorse nobody
    ];
    const edges = reuseEdges(items, NODE.did);
    expect(edges.map((e) => `${e.from === B.did ? "B" : e.from === C.did ? "C" : "?"}->${e.to === A.did ? "A" : e.to === B.did ? "B" : "?"}`).sort()).toEqual(["B->A", "C->B"]);
    expect(edges.every((e) => e.weight === 2)).toBe(true);
  });
});

describe("win records on a node", () => {
  let node: TestNode;
  beforeAll(async () => { node = await makeNode(); });
  afterAll(async () => { await node.ctx.db.close(); });

  async function nodeRun(slug: string, by: string | null, success = true) {
    const ctx = node.ctx;
    let sk = (await ctx.db.query<any>(`SELECT cid FROM skills WHERE slug = $1`, [slug])).rows[0]?.cid;
    if (!sk) {
      const rec = createRecord(ctx.node, "skill", { slug, version: 1, prev: null, skill: { name: `Task ${slug}`, summary: "s", params: [], steps: [{ intent: "go", target: "x", action: "click", value: "" }], success_check: "ok", risk_flags: ["none"] }, source: { start_url: "https://example.org/" } }, new Date(ctx.now()));
      await ctx.db.tx(async (tx) => { await appendToLog(tx, ctx, rec); await tx.query(`INSERT INTO skills (cid, slug, version, prev_cid, name, summary, created_at) VALUES ($1,$2,1,NULL,$3,'s',$4)`, [rec.cid, slug, `Task ${slug}`, rec.created_at]); });
      sk = rec.cid;
    }
    const r = createRecord(ctx.node, "skill_run", { skill: sk, success, params: {}, start_url: "https://example.org/", actions: [{ turn: 1, type: "click", detail: "click go", approval: "auto", checks: [] }, { turn: -1, type: "note", detail: "internal", approval: "none", checks: [] }], evidence: { final_screenshot: "c".repeat(64), gif: null }, requested_by: by ? { via: "agent", agent: by, job: "j" } : { via: "web" } }, new Date(ctx.now()));
    await ctx.db.tx(async (tx) => { await appendToLog(tx, ctx, r); await tx.query(`INSERT INTO skill_runs (cid, skill_cid, success, created_at) VALUES ($1,$2,$3,$4)`, [r.cid, sk, success, r.created_at]); });
    return r;
  }

  it("accepts a verified win, refuses tampered or duplicate ones, and ranks it on GET /v1/leaderboard", async () => {
    const agent = new TestAgent(node); await agent.register("winner");
    const other = new TestAgent(node); await other.register("claimer");
    const r = await nodeRun("node-task", agent.did);
    const body = winBodyFromRun(r.cid, r.body);
    expect(body.steps).toEqual([{ action: "click", detail: "click go" }]); // agent turns only
    // tampered screenshot / steps / hash
    expect((await agent.submit("win", { ...body, screenshot: "d".repeat(64) })).body.error).toBe("win_mismatch");
    expect((await agent.submit("win", { ...body, steps: [] })).body.error).toBe("win_mismatch");
    expect((await agent.submit("win", { ...body, hash: "0".repeat(64) })).body.error).toBe("win_mismatch");
    expect((await agent.submit("win", { ...body, run: "bagaaierawwvlbxs24372mtijleisiu6ajtpuhdjmiypuvyvjlymxjp47vaqa" })).status).toBe(404);
    const ok = await agent.submit("win", body);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ win_status: "verified", ranked: true });
    expect((await agent.submit("win", { ...body, note: "again" })).body.error).toBe("win_exists");
    // someone else claiming the same run: shown, not ranked
    const claim = await other.submit("win", body);
    expect(claim.body).toMatchObject({ win_status: "unverified", ranked: false });
    const lb = (await node.req("GET", "/v1/leaderboard")).body;
    const w = lb.entrants.find((e: any) => e.did === agent.did);
    expect(w).toMatchObject({ ranked: true, rank: 1, name: "winner", posted_wins: 1 });
    expect(lb.entrants.find((e: any) => e.did === other.did)).toMatchObject({ ranked: false, unverified_wins: 1 });
    expect(lb.method.formula).toMatch(/difficulty = 1 \+ 3/);
    expect(lb.hardest_tasks[0].slug).toBe("node-task");
    expect((await node.req("GET", "/openapi.json")).body.paths["/v1/leaderboard"]).toBeTruthy();
  });

  it("the MCP client posts a win from a run cid, and a self-reported one that is shown but not ranked", async () => {
    const kp = generateKeyPair();
    const client = new AgentboardClient({ baseUrl: "http://agentboard.test", keyPair: kp, agentName: "mcp-winner", fetchImpl: ((u: any, i: any) => node.app.fetch(new Request(String(u), i))) as typeof fetch });
    await client.ensureRegistered();
    const r = await nodeRun("mcp-task", kp.did);
    const res = await client.postWin({ run: r.cid });
    expect(res).toMatchObject({ win_status: "verified", ranked: true });
    const rec = (await node.req("GET", `/v1/records/${res.cid}`)).body.record;
    expect(rec.type).toBe("win");
    expect(verifyRecord(rec).ok).toBe(true);
    const self = await client.postWin({ task: "renewed a library book", steps: [{ action: "step", detail: "logged in" }] });
    expect(self).toMatchObject({ win_status: "self_reported", ranked: false });
  });

  it("karma: a verified replay by another agent of an agent's run trace raises its karma, and live equals log replay", async () => {
    const author = new TestAgent(node); await author.register("author", "op-a");
    const reuser = new TestAgent(node); await reuser.register("reuser", "op-b");
    const src = await nodeRun("karma-task", author.did);
    const ctx = node.ctx;
    const before = Number((await ctx.db.query<any>(`SELECT karma FROM agents WHERE did = $1`, [author.did])).rows[0].karma);
    const sk = (await ctx.db.query<any>(`SELECT cid FROM skills WHERE slug = 'karma-task'`)).rows[0].cid;
    const rr = createRecord(ctx.node, "skill_run", { skill: sk, success: true, params: {}, start_url: "https://example.org/", actions: [], evidence: { final_screenshot: "e".repeat(64) }, requested_by: { via: "agent", agent: reuser.did, job: "j2" }, replay: { mode: "trace", trace_source: `run:${src.cid}` } }, new Date(ctx.now()));
    await ctx.db.tx(async (tx) => { await appendToLog(tx, ctx, rr); });
    const { recomputeKarma } = await import("../src/services/reputation.js");
    await recomputeKarma(ctx);
    const after = Number((await ctx.db.query<any>(`SELECT karma FROM agents WHERE did = $1`, [author.did])).rows[0].karma);
    expect(after).toBeGreaterThan(before);
    const log = (await ctx.db.query<any>(`SELECT l.seq::int AS seq, l.received_at, r.cid, r.type, r.author, r.created_at, r.body_text, r.sig FROM log l JOIN records r ON r.cid = l.cid ORDER BY l.seq`)).rows
      .map((x) => ({ seq: x.seq, received_at: x.received_at, record: { v: 1 as const, type: x.type, author: x.author, created_at: x.created_at, body: JSON.parse(x.body_text), cid: x.cid, sig: x.sig } }));
    const k = replayKarma(log, { nodeDid: ctx.node.did, now: ctx.now() });
    expect(k.karma.get(author.did)).toBeCloseTo(after, 5);
  });
});
