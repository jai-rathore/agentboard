import { describe, it, expect, afterAll } from "vitest";
import { creditEffects, CREDIT, type CreditFacts } from "../src/services/credits.js";
import { replayCredits, replayKarma } from "../src/services/replay.js";
import { makeNode, TestAgent, type TestNode } from "./helpers.js";

const facts = (o: Partial<CreditFacts> = {}): CreditFacts => ({
  operatorOf: () => null, registeredAtMs: () => 0, upvoteCreditsOnDay: () => 0, alreadyCreditedVote: () => false, voteCreditMinAgeMs: 3_600_000, ...o,
});
const vote = (o: Partial<{ voter: string; target: string; targetAuthor: string; value: 1 | -1; atMs: number }> = {}) =>
  ({ kind: "vote" as const, voter: "v", target: "t", targetAuthor: "a", value: 1 as const, atMs: 10 * 3_600_000, ...o });

describe("credit rules", () => {
  it("charges for writes and grants on register", () => {
    expect(creditEffects({ kind: "register", did: "x" }, facts())).toEqual([{ did: "x", delta_milli: 20_000, reason: "register" }]);
    expect(creditEffects({ kind: "post", did: "x" }, facts())[0].delta_milli).toBe(-1_000);
    expect(creditEffects({ kind: "topic", did: "x" }, facts())[0].delta_milli).toBe(-2_000);
  });
  it("pays +10 for an accepted answer, but not to yourself or your own operator", () => {
    expect(creditEffects({ kind: "accept", asker: "q", answerer: "a" }, facts())).toEqual([{ did: "a", delta_milli: 10_000, reason: "accepted_answer" }]);
    expect(creditEffects({ kind: "accept", asker: "q", answerer: "q" }, facts())).toEqual([]);
    expect(creditEffects({ kind: "accept", asker: "q", answerer: "a" }, facts({ operatorOf: () => "web:farm.example" }))).toEqual([]);
  });
  it("pays +1 per upvote from an established, independent voter", () => {
    expect(creditEffects(vote(), facts())).toEqual([{ did: "a", delta_milli: 1_000, reason: "upvote_received" }]);
    expect(creditEffects(vote({ value: -1 }), facts())).toEqual([]);
    expect(creditEffects(vote(), facts({ registeredAtMs: () => 10 * 3_600_000 - 60_000 }))).toEqual([]); // voter too new
    expect(creditEffects(vote(), facts({ operatorOf: () => "claimed:same" }))).toEqual([]); // same operator
    expect(creditEffects(vote(), facts({ alreadyCreditedVote: () => true }))).toEqual([]); // vote flip-flop farming
  });
  it("caps upvote credits per author per day", () => {
    expect(creditEffects(vote(), facts({ upvoteCreditsOnDay: () => CREDIT.DAILY_UPVOTE_CREDIT_CAP }))).toEqual([]);
    expect(creditEffects(vote(), facts({ upvoteCreditsOnDay: () => CREDIT.DAILY_UPVOTE_CREDIT_CAP - 400 }))[0].delta_milli).toBe(400);
  });
});

describe("credit + karma accounting replays deterministically from the log", () => {
  let node: TestNode;
  afterAll(async () => { await node?.ctx.db.close(); });

  it("live ledger == replay(log), live karma == replay(log)", async () => {
    node = await makeNode();
    const [a, b, c, d] = [0, 1, 2, 3].map(() => new TestAgent(node));
    await a.register("a"); await b.register("b", "acme"); await c.register("c", "acme"); await d.register("d");
    await a.topic("ai", "AI agents");
    await b.topic("ai_agents", "AI agents"); // aliased duplicate: free
    await b.topic("mcp", "Model Context Protocol", "ai", "MCP servers and clients");
    const q = (await a.post("ai/mcp", "How do I keep an MCP stdio server's key local?", "Want the private key to never leave the machine while the server signs posts.")).body.cid;
    const ans1 = (await b.answer(q, "Store an Ed25519 seed in ~/.config with mode 0600 and sign in-process; only send signatures.")).body.cid;
    const ans2 = (await c.answer(q, "Use an OS keychain via keytar and sign locally; never send the seed over the wire.")).body.cid;
    await d.vote(ans1, 1); await d.vote(ans2, 1); await c.vote(ans1, 1); // c and b share operator: no credit
    await a.vote(ans2, 1); await a.vote(ans2, -1); await a.vote(ans2, 1); // flip-flop earns once
    await a.accept(ans1);
    const info = (await node.req("GET", "/v1/node")).body;
    const log = (await node.req("GET", "/v1/log?since=0&limit=1000")).body.entries;
    const replayed = replayCredits(log, { voteCreditMinAgeMs: node.cfg.voteCreditMinAgeMs, nodeDid: info.node_did });
    const live = (await node.ctx.db.query<any>(`SELECT did, SUM(delta_milli)::float8 AS b FROM credit_ledger WHERE seq IS NOT NULL GROUP BY did`)).rows;
    expect(live.length).toBe(4);
    for (const r of live) expect(replayed.get(r.did)).toBe(Number(r.b));
    // spot-check the economics
    expect(replayed.get(b.did)).toBe(20_000 - 2_000 - 1_000 + 1_000 + 10_000); // reg, topic, answer, upvote from d, accepted
    expect(replayed.get(c.did)).toBe(20_000 - 1_000 + 1_000 + 1_000); // reg, answer, upvotes from d and a (once)
    const k = replayKarma(log, { nodeDid: info.node_did, now: node.ctx.now() });
    const agents = (await node.ctx.db.query<any>(`SELECT did, trust FROM agents`)).rows;
    // live karma is recomputed at write time; replay "as of now" matches within decay drift
    for (const r of agents) expect(k.trust.get(r.did)!).toBeCloseTo(Number(r.trust), 4);
  });
});
