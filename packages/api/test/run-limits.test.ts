/**
 * Run budgets (services/skillJobs.ts runQuota) and bounded MCP waits (packages/mcp server: run_skill, try_skill,
 * skill_run_status answer within the tool deadline, never hang on a stalled connection).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRecord, generateKeyPair } from "@agentboard/core";
import { AgentboardClient, createAgentboardMcpServer } from "@agentboard/mcp";
import { makeNode, TestAgent, type TestNode } from "./helpers.js";
import { appendToLog } from "../src/services/log.js";
import { runQuota } from "../src/services/skillJobs.js";

describe("agent-funded run budget", () => {
  let node: TestNode;
  beforeAll(async () => { node = await makeNode({ skillsAgentRunsPerAgentDay: 5, skillsAgentRunsPerDay: 2, skillsAgentRunsCeiling: 4 } as any); });
  afterAll(async () => { await node.ctx.db.close(); });

  async function job(did: string, via: string, calls: number | null, status = "completed") {
    const ctx = node.ctx, id = randomUUID();
    await ctx.db.query(`INSERT INTO skill_jobs (id, skill_cid, params, start_url, requested_by, via, status, turns, result) VALUES ($1,'x','{}','https://example.org/',$2,$3,$4,'[{"t":1}]'::jsonb,'{}'::jsonb)`, [id, did, via, status]);
    if (calls !== null) {
      const r = createRecord(ctx.node, "skill_run", { skill: "x", success: true, params: {}, actions: [], usage: { calls }, requested_by: { via, agent: did, job: id } }, new Date(ctx.now()));
      await ctx.db.tx(async (tx) => { await appendToLog(tx, ctx, r); });
    }
    return id;
  }

  it("counts per identity; the node limit counts runs that used the model, 0-model replays only the ceiling; public trials use none of it", async () => {
    const a = new TestAgent(node); await a.register("quota-a");
    const b = new TestAgent(node); await b.register("quota-b");
    await job(a.did, "agent", 0); await job(a.did, "agent", 0); // deterministic trace replays
    await job("anonymous", "public", 12); await job("anonymous", "public", 12); // public try_skill: its own cap
    let q = await runQuota(node.ctx, a.did);
    expect(q.yours).toMatchObject({ used: 2, limit: 5 });
    expect(q.node).toMatchObject({ model_runs_used: 0, runs_used: 2, ceiling: 4, remaining: 2 });
    await job(b.did, "agent", 7); // used the model
    await job(b.did, "agent", null, "running"); // in flight: counts as using the model
    q = await runQuota(node.ctx, a.did);
    expect(q.node).toMatchObject({ model_runs_used: 2, model_runs_limit: 2, runs_used: 4, remaining: 0 });
    expect(q.yours.remaining).toBe(0); // the node is out, so you are too
    // a job the executor never took (failed, no turns, no result) counts for no one
    await node.ctx.db.query(`INSERT INTO skill_jobs (id, skill_cid, params, start_url, requested_by, via, status) VALUES ($1,'x','{}','u',$2,'agent','failed')`, [randomUUID(), a.did]);
    expect((await runQuota(node.ctx, a.did)).yours.used).toBe(2);
    // run_policy and the runs list show it
    const p = (await node.req("GET", `/v1/agents/${a.did}`)).body.run_policy;
    expect(p.quota.node.remaining).toBe(0);
    expect(p.runs_left_today).toBe(0);
    const runs = (await node.req("GET", `/v1/agents/${a.did}/runs`)).body;
    expect(runs.runs.length).toBe(3);
    expect(runs.runs.filter((r: any) => r.verified).length).toBe(2);
    expect(runs.runs.find((r: any) => r.run_cid)).toMatchObject({ status: "completed", verified: true, via: "agent" });
  });
});

describe("runs left today is what you can actually start", () => {
  let node: TestNode;
  beforeAll(async () => { node = await makeNode({ skillsAgentRunsPerAgentDay: 10, skillsAgentRunsPerDay: 15, skillsAgentRunsCeiling: 100, skillsAgentRunCredits: 5 } as any); });
  afterAll(async () => { await node.ctx.db.close(); });
  it("is min(your quota, the node's budget, floor(credits / run cost)), and says which one limits it", async () => {
    const a = new TestAgent(node); await a.register("left-a");
    (node.ctx.cfg as any).agentRunVouchedDids = [a.did];
    const bal = async () => Number((await node.ctx.db.query<any>(`SELECT COALESCE(SUM(delta_milli),0)::float8 AS b FROM credit_ledger WHERE did = $1`, [a.did])).rows[0].b);
    const set = async (credits: number) => { await node.ctx.db.query(`INSERT INTO credit_ledger (did, delta_milli, reason, ref_cid, seq, received_at) VALUES ($1,$2,'test',NULL,NULL,now())`, [a.did, credits * 1000 - (await bal())]); };
    await set(0);
    let p = (await node.req("GET", `/v1/agents/${a.did}`)).body.run_policy;
    expect(p).toMatchObject({ eligible: true, runs_left_today: 0, runs_left_limited_by: "credits", runs_affordable: 0 });
    expect(p.quota.yours.remaining).toBe(10);
    await set(14);
    p = (await node.req("GET", `/v1/agents/${a.did}`)).body.run_policy;
    expect(p).toMatchObject({ runs_left_today: 2, runs_left_limited_by: "credits" });
    await set(500);
    p = (await node.req("GET", `/v1/agents/${a.did}`)).body.run_policy;
    expect(p).toMatchObject({ runs_left_today: 10, runs_left_limited_by: "your_quota" });
    await set(50); // 10 affordable = 10 quota left: a tie says both
    p = (await node.req("GET", `/v1/agents/${a.did}`)).body.run_policy;
    expect(p).toMatchObject({ runs_left_today: 10, runs_left_limited_by: "both", runs_affordable: 10 });
  });
});

describe("MCP waits are bounded", () => {
  it("skill_run_status on a stalled node answers 'still running, poll again' within the deadline", async () => {
    // a fetch that never answers (it only gives up when the request's deadline aborts it)
    const stalled = ((_u: any, init: any) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal.reason)))) as typeof fetch;
    const client = new AgentboardClient({ baseUrl: "http://stalled.test", keyPair: generateKeyPair(), fetchImpl: stalled });
    const mcp = createAgentboardMcpServer({ client, toolDeadlineMs: 2_500 });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "0" });
    await Promise.all([mcp.connect(a), c.connect(b)]);
    // serverInfo names the build: VERSION+<commit or source hash>, "dev" when run from source
    expect(c.getServerVersion()?.version).toMatch(/^0\.2\.0\+(dev|src\.[0-9a-f]{10}|[0-9a-f]{7})$/);
    const id = randomUUID();
    const t0 = Date.now();
    const r: any = await c.callTool({ name: "skill_run_status", arguments: { run_id: id, wait_seconds: 100 } });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ run_id: id, still_running: true });
    expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent);
    expect(r.content[1].text).toMatch(/Still running .*poll again with skill_run_status/);
    await c.close();
  }, 15_000);
});
