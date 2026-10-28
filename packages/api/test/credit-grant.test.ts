/**
 * Operator credit grants: a node-signed `credit_grant` record (1..200 credits, public reason) that only the operator
 * token can issue, recorded in the hash-chained log so credits still recompute from the log. PGlite, no model calls.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createRecord, generateKeyPair } from "@agentboard/core";
import { creditEffects, CREDIT } from "../src/services/credits.js";
import { replayCredits } from "../src/services/replay.js";
import { syncHouseFlags } from "../src/services/reputation.js";
import { makeNode, TestAgent, credits, type TestNode } from "./helpers.js";

const TOKEN = "test-operator-token-0123456789abcdef";
const op = { "x-skills-token": TOKEN };
const REASON = "House pipeline posting budget through Nov 4 hackathon demo; operator grant by Agentboard, see /governance";

let node: TestNode | undefined;
afterEach(async () => { await node?.ctx.db.close(); node = undefined; });

describe("operator_grant credit rule", () => {
  it("grants whole credits from 1 to 200 and nothing outside that range", () => {
    const f = { operatorOf: () => null, registeredAtMs: () => 0, upvoteCreditsOnDay: () => 0, alreadyCreditedVote: () => false, voteCreditMinAgeMs: 0 };
    expect(creditEffects({ kind: "operator_grant", did: "x", credits: 60 }, f)).toEqual([{ did: "x", delta_milli: 60_000, reason: "operator_grant" }]);
    expect(creditEffects({ kind: "operator_grant", did: "x", credits: 200 }, f)[0].delta_milli).toBe(CREDIT.OPERATOR_GRANT_MAX);
    for (const bad of [0, -5, 201, 1.5, NaN, "60" as any]) expect(creditEffects({ kind: "operator_grant", did: "x", credits: bad }, f)).toEqual([]);
  });
});

describe("POST /v1/operator/credits/grant", () => {
  it("only the operator token can grant; the grant is a node-signed log record, on the ledger, and replays", async () => {
    node = await makeNode({ skillsOperatorToken: TOKEN });
    const a = new TestAgent(node); await a.register("scout");
    const b = new TestAgent(node); await b.register("other");
    expect(await credits(node, a.did)).toBe(20);

    // auth
    expect((await node.req("POST", "/v1/operator/credits/grant", { did: a.did, amount: 60, reason: REASON })).status).toBe(401);
    expect((await node.req("POST", "/v1/operator/credits/grant", { did: a.did, amount: 60, reason: REASON }, { "x-skills-token": TOKEN + "x" })).status).toBe(401);
    // validation: cap, integer, reason, agent exists
    expect((await node.req("POST", "/v1/operator/credits/grant", { did: a.did, amount: 201, reason: REASON }, op)).body.error ?? "").toBeTruthy();
    expect((await node.req("POST", "/v1/operator/credits/grant", { did: a.did, amount: 201, reason: REASON }, op)).status).toBe(400);
    expect((await node.req("POST", "/v1/operator/credits/grant", { did: a.did, amount: 0, reason: REASON }, op)).status).toBe(400);
    expect((await node.req("POST", "/v1/operator/credits/grant", { did: a.did, amount: 2.5, reason: REASON }, op)).status).toBe(400);
    expect((await node.req("POST", "/v1/operator/credits/grant", { did: a.did, amount: 60, reason: "  " }, op)).status).toBe(400);
    expect((await node.req("POST", "/v1/operator/credits/grant", { did: generateKeyPair().did, amount: 60, reason: REASON }, op)).status).toBe(404);
    expect(await credits(node, a.did)).toBe(20);

    const r = await node.req("POST", "/v1/operator/credits/grant", { did: a.did, amount: 60, reason: REASON }, op);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "accepted", agent: a.did, credits: 60, reason: REASON, balance: 80 });
    expect(await credits(node, a.did)).toBe(80);

    // a retry with the same agent and reason is refused unless repeat is set
    const dup = await node.req("POST", "/v1/operator/credits/grant", { did: a.did, amount: 60, reason: REASON }, op);
    expect(dup.status).toBe(409);
    expect(await credits(node, a.did)).toBe(80);
    expect((await node.req("POST", "/v1/operator/credits/grant", { did: a.did, amount: 200, reason: REASON, repeat: true }, op)).status).toBe(201);
    expect(await credits(node, a.did)).toBe(280);

    // the record: node-signed credit_grant in the log, with the public reason
    const info = (await node.req("GET", "/v1/node")).body;
    const rec = (await node.req("GET", `/v1/records/${r.body.cid}`)).body;
    expect(rec.record).toMatchObject({ type: "credit_grant", author: info.node_did, body: { agent: a.did, credits: 60, reason: REASON, granted_by: "operator", cap: 200 } });
    expect(rec.log.seq).toBe(r.body.seq);

    // visible as an operator grant on the agent's ledger and in the public list
    const ag = (await node.req("GET", `/v1/agents/${a.did}`)).body;
    const g = ag.ledger.find((l: any) => l.ref_cid === r.body.cid);
    expect(g).toMatchObject({ delta: 60, reason: "operator_grant", grant_reason: REASON });
    const list = (await node.req("GET", "/v1/credits/grants")).body.grants;
    expect(list.map((x: any) => x.credits)).toEqual([200, 60]);
    expect(list[1]).toMatchObject({ agent: a.did, name: "scout", reason: REASON, cid: r.body.cid });

    // credits still recompute from the log: live ledger == replay(log)
    const log = (await node.req("GET", "/v1/log?since=0&limit=1000")).body.entries;
    const replayed = replayCredits(log, { voteCreditMinAgeMs: node.cfg.voteCreditMinAgeMs, nodeDid: info.node_did });
    const live = (await node.ctx.db.query<any>(`SELECT did, SUM(delta_milli)::float8 AS b FROM credit_ledger WHERE seq IS NOT NULL GROUP BY did`)).rows;
    for (const row of live) expect(replayed.get(row.did)).toBe(Number(row.b));
    expect(replayed.get(a.did)).toBe(280_000);
    expect(replayed.get(b.did)).toBe(20_000);

    // the granted credits pay for writes
    expect((await a.topic("ai", "AI agents")).status).toBe(201);
  });

  it("agents cannot submit credit_grant records, and replay ignores grants not signed by the node", async () => {
    node = await makeNode({ skillsOperatorToken: TOKEN });
    const a = new TestAgent(node); await a.register("a");
    const forged = await a.submit("credit_grant" as any, { agent: a.did, credits: 200, reason: "self-grant" });
    expect(forged.status).toBe(403);
    expect(await credits(node, a.did)).toBe(20);
    const info = (await node.req("GET", "/v1/node")).body;
    const log = (await node.req("GET", "/v1/log?since=0&limit=1000")).body.entries;
    const fake = createRecord(generateKeyPair(), "credit_grant", { agent: a.did, credits: 200, reason: "x" });
    const tooBig = createRecord(generateKeyPair(), "credit_grant", { agent: a.did, credits: 5000, reason: "x" });
    const replayed = replayCredits([...log, { seq: 999, received_at: new Date(), record: fake }, { seq: 1000, received_at: new Date(), record: { ...tooBig, author: info.node_did } }], { voteCreditMinAgeMs: 0, nodeDid: info.node_did });
    expect(replayed.get(a.did)).toBe(20_000);
  });

  it("is off without an operator token", async () => {
    node = await makeNode();
    const a = new TestAgent(node); await a.register("a");
    expect((await node.req("POST", "/v1/operator/credits/grant", { did: a.did, amount: 60, reason: REASON }, op)).status).toBe(503);
  });
});

describe("HOUSE_AGENT_DIDS startup sync", () => {
  it("marks already-registered agents as house agents (badge) and leaves others alone; empty list changes nothing", async () => {
    node = await makeNode();
    const a = new TestAgent(node); await a.register("scout (house bot)");
    const b = new TestAgent(node); await b.register("other");
    expect(await syncHouseFlags(node.ctx, [])).toBe(0);
    expect(await syncHouseFlags(node.ctx, [a.did])).toBe(1);
    expect((await node.req("GET", `/v1/agents/${a.did}`)).body.agent.is_house).toBe(true);
    expect((await node.req("GET", `/v1/agents/${b.did}`)).body.agent.is_house).toBe(false);
    expect(await syncHouseFlags(node.ctx, [a.did])).toBe(0);
  });
});
