import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { verifyRecord } from "@agentboard/core";
import { makeNode, type TestNode } from "./helpers.js";

// Deterministic replay: verified runs store their action trace; the skill exposes it; trace replays never call the
// model to heal, and a trace that failed and was recovered publishes the recovered trace as the next version.
const TOKEN = "test-".repeat(6); // fake test value
const SECRET = "fake-".repeat(6); // fake test value
const skillJson = {
  name: "Wiki infobox fact", summary: "Read an infobox field", start_url_hint: "/",
  params: [{ name: "q", description: "article", example: "Reykjavík" }],
  steps: [{ intent: "search", target: "Search box", action: "type", value: "{{q}}" }, { intent: "open the article", target: "result link", action: "click", value: "" }],
  success_check: "The {{q}} article shows its infobox", risk_flags: [],
};
const calls: any[] = [];
const fakeMeta: typeof fetch = async (url, init) => {
  calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
  return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(skillJson) }] }], usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 500, output_tokens_details: { reasoning_tokens: 0 } } }), { status: 200 });
};
let node: TestNode;
const op = { "x-skills-token": TOKEN }, ex = { "x-skills-secret": SECRET };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const loc = (role: string, name: string) => ({ tag: role === "link" ? "a" : "input", role, name, text: role === "link" ? name : "", css: "#x", attrs: {} });
const trace = (n = 3) => ({
  v: 1, start_url: "https://wiki.test/",
  steps: [
    { url: "https://wiki.test/", action: "click", locator: loc("searchbox", "Search"), changes_url: false },
    { url: "https://wiki.test/", action: "type", text: "{{q}}", locator: loc("searchbox", "Search"), changes_url: false },
    { url: "https://wiki.test/", action: "keypress", keys: ["Enter"], changes_url: true },
    { url: "https://wiki.test/search?q={{q}}", action: "click", locator: loc("link", "{{q}}"), changes_url: true },
  ].slice(0, n),
  final: { url: "https://wiki.test/wiki/{{q}}", viewport: ["q"], page: [], title: ["q"] },
});
const run = (target: Record<string, string>, success: boolean, extra: Record<string, unknown> = {}) => ({
  ...target, start_url: "https://wiki.test/", params: { q: "Oslo" }, success,
  verdict: { success, evidence: success ? "Oslo infobox" : "no", model: "muse-spark-1.3", capability: "image understanding + structured output" },
  turns: 4, actions: [{ turn: 1, type: "type", detail: "Oslo", approval: "auto", checks: [], target: "Search" }],
  usage: { calls: 5, input_tokens: 15000, cached_tokens: 0, output_tokens: 800, usd: 0.02 }, model: "muse-spark-1.3",
  final_jpeg_b64: Buffer.concat([jpeg, Buffer.from(String(Math.random()))]).toString("base64"), gif_b64: Buffer.from("GIF89a-test").toString("base64"),
  executor: { name: "agentboard-executor", chromium: "headless-shell", viewport: "960x600" }, duration_ms: 9000, ...extra,
});
const replay = (mode: string, extra: Record<string, unknown> = {}) => ({ mode, trace_source: "run:x", trace_steps: 4, trace_steps_done: 4, failed_step: null, failed_reason: null, verifier: "deterministic", ...extra });

beforeAll(async () => {
  node = await makeNode({ offline: false, embedProvider: "hash", metaApiKey: "test-key", skillsOperatorToken: TOKEN, skillsInternalSecret: SECRET, museDailyCallCap: 50, museSpendCapUsd: 1 }, { fetchImpl: fakeMeta });
});
afterAll(async () => { await node?.ctx.db.close(); });

describe("deterministic replay: traces on signed runs", () => {
  let v1: string, pubRun: string;
  it("stores a verified run's trace in its signed run record and exposes it on the skill", async () => {
    const up = await node.app.request("/v1/artifacts", { method: "POST", headers: { "content-type": "image/jpeg", ...op }, body: jpeg as unknown as BodyInit });
    const draft = (await node.req("POST", "/v1/skills/record", { frames: [((await up.json()) as any).sha256], start_url: "https://wiki.test/" }, op)).body.id;
    // an unverified run's trace is dropped
    const bad = await node.req("POST", "/internal/skills/runs", run({ draft_id: draft }, false, { trace: trace(4) }), ex);
    expect(bad.status).toBe(201);
    const r = await node.req("POST", "/internal/skills/runs", run({ draft_id: draft }, true, { trace: trace(4) }), ex);
    expect(r.body.status).toBe("published");
    v1 = r.body.skill_cid; pubRun = r.body.run_cid;
    const s = (await node.req("GET", `/v1/skills/${v1}`)).body;
    expect(s.trace).toMatchObject({ v: 1, source: `run:${pubRun}` });
    expect(s.trace.steps).toHaveLength(4);
    expect(s.runs[0].record.body.trace.steps[3].locator.name).toBe("{{q}}");
    expect(verifyRecord(s.runs[0].record).ok).toBe(true);
  });

  it("rejects a malformed trace", async () => {
    const r = await node.req("POST", "/internal/skills/runs", run({ skill_cid: v1 }, true, { trace: { v: 2, steps: [] } }), ex);
    expect(r.status).toBe(400);
  });

  it("a clean trace replay records 0 model calls and never calls the model to heal", async () => {
    const before = calls.length;
    const body = run({ skill_cid: v1 }, true, {
      turns: 0, model: "none (recorded trace)", usage: { calls: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0, usd: 0 },
      actions: [{ turn: 0, type: "click", detail: "trace step 4: click link", approval: "auto", checks: [], target: "Some other link name" }],
      verdict: { success: true, evidence: "Deterministic checks passed", model: "deterministic", capability: "deterministic" },
      trace: trace(4), replay: replay("trace"),
    });
    const r = await node.req("POST", "/internal/skills/runs", body, ex);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("run_recorded");
    expect(r.body.drift).toMatchObject({ stale_steps: [], healed: false });
    expect(calls.length).toBe(before);
    const rec = (await node.req("GET", `/v1/skills/${v1}`)).body.runs[0].record.body;
    expect(rec).toMatchObject({ turns: 0, usage: { calls: 0, usd: 0 }, replay: { mode: "trace", verifier: "deterministic" }, verdict: { model: "deterministic" } });
  });

  it("a recovered trace replay self-heals into a new version carrying the recovered trace, with no model call", async () => {
    const before = calls.length;
    const recovered = trace(4); recovered.steps[3] = { ...recovered.steps[3], locator: loc("link", "{{q}} (city)") } as any;
    const r = await node.req("POST", "/internal/skills/runs", run({ skill_cid: v1 }, true, { usage: { calls: 2, input_tokens: 5000, cached_tokens: 0, output_tokens: 100, usd: 0.006 }, trace: recovered, replay: replay("trace+recovery", { trace_steps_done: 3, failed_step: 4, failed_reason: "element not found: click link \"{{q}}\"", verifier: "model" }) }), ex);
    expect(r.body.status).toBe("healed");
    expect(r.body.healed).toMatchObject({ version: 2, kind: "trace" });
    expect(calls.length).toBe(before);
    const s = (await node.req("GET", `/v1/skills/${r.body.healed.cid}`)).body;
    expect(s.skill.record.body.healed_from).toMatchObject({ kind: "trace", skill: v1, stale_steps: [4], usage: { usd: 0 } });
    expect(s.skill.record.body.skill.steps).toEqual(skillJson.steps);
    expect(s.trace).toMatchObject({ source: `skill:${r.body.healed.cid}` });
    expect(s.trace.steps[3].locator.name).toBe("{{q}} (city)");
    expect(verifyRecord(s.skill.record).ok).toBe(true);
  });

  it("an old-style run (no trace, no replay info) still works", async () => {
    const r = await node.req("POST", "/internal/skills/runs", run({ skill_cid: v1 }, true), ex);
    expect(r.status).toBe(201);
  });
});
