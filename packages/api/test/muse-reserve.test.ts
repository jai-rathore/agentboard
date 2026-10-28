/**
 * Reserved daily Muse bucket for public replays (MUSE_PUBLIC_RESERVED_CALLS): other jobs cannot use it, public replays
 * (remote MCP try_skill) can use the whole cap. Every Muse call is answered by a fake: nothing reaches api.meta.ai.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { makeNode, type TestNode } from "./helpers.js";
import { loadConfig } from "../src/config.js";
import { museHeadroom, museCallsToday, callsLeft } from "../src/services/muse.js";

const TOKEN = "test-".repeat(6), SECRET = "fake-".repeat(6); // fake test values
const ex = { "x-skills-secret": SECRET };
const urls: string[] = [];
const fake: typeof fetch = async (url) => {
  urls.push(String(url));
  return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 100 } }), { status: 200 });
};
const body = { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] };

let node: TestNode;
let publicJob = "", agentJob = "";
const call = (headers: Record<string, string> = {}) => node.req("POST", "/internal/muse/responses", body, { ...ex, "x-muse-kind": "loop", ...headers });

beforeAll(async () => {
  node = await makeNode({ offline: false, embedProvider: "hash", metaApiKey: "test-key", skillsOperatorToken: TOKEN, skillsInternalSecret: SECRET, museDailyCallCap: 10, musePublicReservedCalls: 4, museSpendCapUsd: 5 }, { fetchImpl: fake });
  publicJob = crypto.randomUUID(); agentJob = crypto.randomUUID();
  for (const [id, via] of [[publicJob, "public"], [agentJob, "agent"]]) {
    await node.ctx.db.query(`INSERT INTO skill_jobs (id, skill_cid, params, start_url, requested_by, via) VALUES ($1,'bagtest','{}','https://news.ycombinator.com/',$2,$2)`, [id, via]);
  }
});
afterAll(async () => { await node?.ctx.db.close(); });
beforeEach(async () => { await node.ctx.db.query(`DELETE FROM muse_spend`); });

describe("MUSE_PUBLIC_RESERVED_CALLS", () => {
  it("defaults to 0 (no reserve) and parses from the environment", () => {
    expect(loadConfig({}).musePublicReservedCalls).toBe(0);
    expect(loadConfig({ MUSE_PUBLIC_RESERVED_CALLS: "30", MUSE_DAILY_CALL_CAP: "400" })).toMatchObject({ musePublicReservedCalls: 30, museDailyCallCap: 400 });
  });

  it("other jobs stop at cap minus the unused reserve; public replays get the rest", async () => {
    for (let i = 0; i < 6; i++) expect((await call()).status).toBe(200); // no job header: default pool
    const blocked = await call();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("muse_daily_cap");
    expect(blocked.body.message).toMatch(/held back for public try_skill/);
    // an agent-funded run's calls are not public
    expect((await call({ "x-skills-job": agentJob })).status).toBe(429);
    await expect(museHeadroom(node.ctx, 1, 0)).rejects.toMatchObject({ code: "muse_daily_cap" });
    await expect(museHeadroom(node.ctx, 4, 0, node.ctx.db, "public")).resolves.toMatchObject({ calls_left: 4, calls_today: 6, public_reserved_calls: 4 });
    await expect(museHeadroom(node.ctx, 5, 0, node.ctx.db, "public")).rejects.toMatchObject({ code: "muse_daily_cap" });
    // the public job's calls use the reserve, and are stored as public:<kind>
    for (let i = 0; i < 4; i++) expect((await call({ "x-skills-job": publicJob })).status).toBe(200);
    expect((await call({ "x-skills-job": publicJob })).status).toBe(429); // the one cap still holds
    const rows = (await node.ctx.db.query<any>(`SELECT kind, calls FROM muse_spend ORDER BY kind`)).rows;
    expect(rows.map((r) => [r.kind, Number(r.calls)])).toEqual([["loop", 6], ["public:loop", 4]]);
    const h = (await node.req("GET", "/healthz")).body.muse_spend;
    expect(h).toMatchObject({ daily_call_cap: 10, public_reserved_calls: 4, public_reserve_left_today: 0, calls_left_today: { public: 0, other: 0 }, today: { calls: 10, public_calls: 4 } });
    expect(h.today.by_kind["public:loop"].calls).toBe(4);
  });

  it("public calls beyond the reserve are fine while the cap has room, and then count against it", async () => {
    for (let i = 0; i < 6; i++) expect((await call({ "x-skills-job": publicJob })).status).toBe(200);
    const t = await museCallsToday(node.ctx);
    expect(t).toMatchObject({ total: 6, public: 6, reserved: 4, reserve_left: 0 });
    expect(callsLeft(node.ctx, t, "default")).toBe(4);
    for (let i = 0; i < 4; i++) expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
  });

  it("an unknown or malformed job header is the default pool", async () => {
    for (let i = 0; i < 6; i++) expect((await call({ "x-skills-job": i % 2 ? "not-a-uuid" : crypto.randomUUID() })).status).toBe(200);
    expect((await call({ "x-skills-job": "not-a-uuid" })).status).toBe(429);
    expect((await call({ "x-skills-job": publicJob })).status).toBe(200);
  });

  it("the reserve never exceeds the cap, and with no reserve everything shares the cap as before", async () => {
    const { musePublicReservedCalls: r, museDailyCallCap: c } = node.ctx.cfg;
    try {
      node.ctx.cfg.musePublicReservedCalls = 50;
      expect((await museCallsToday(node.ctx)).reserved).toBe(10);
      expect((await call()).status).toBe(429);
      node.ctx.cfg.musePublicReservedCalls = 0;
      for (let i = 0; i < 10; i++) expect((await call()).status).toBe(200);
      expect((await call({ "x-skills-job": publicJob })).status).toBe(429);
    } finally { node.ctx.cfg.musePublicReservedCalls = r; node.ctx.cfg.museDailyCallCap = c; }
  });

  it("made no real network calls", () => {
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith("https://api.meta.ai/"))).toBe(true);
  });
});
