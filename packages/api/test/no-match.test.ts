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
  const heal = (init?.headers as any)?.["x-muse-kind"] === "heal";
  const healed = { success_check: skillJson.success_check, steps: [skillJson.steps[0], { ...skillJson.steps[1], target: "result card" }], changes: [{ step: 2, field: "target", before: "result link", after: "result card", reason: "results are cards now" }] };
  return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(heal ? healed : skillJson) }] }], usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 500, output_tokens_details: { reasoning_tokens: 0 } } }), { status: 200 });
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

// Verified negative (outcome no_match): a skill that declares its site's "no results" wording signs a replay that ends
// on it, tied to the input, as "Verified: no hit"; anything else with no value stays "not verified".
describe("verified negative: declared empty-result signal", () => {
  let v1: string, v2: string, pubRun: string;
  const SIG = "Your search has not returned any results";
  const noHit = (by: Record<string, string>, extra: Record<string, unknown> = {}) => run({ skill_cid: v2 }, true, {
    params: { q: "Nowhereville" }, turns: 0, model: "none (recorded trace)", usage: { calls: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0, usd: 0 },
    verdict: { success: true, evidence: `No hit: the site says "${SIG}" and q "Nowhereville" is echoed in the search field. Final URL https://wiki.test/search.`, model: "deterministic", capability: "deterministic" },
    replay: replay("trace"), answer: { value: null, method: "none", source: null, verified_by: "deterministic" },
    outcome: "no_match", no_match: { signal: SIG, by, evidence: "No hit" }, ...extra,
  });
  it("publishes a skill, then the operator declares its empty-result signal: next version, same trace, no model call", async () => {
    const up = await node.app.request("/v1/artifacts", { method: "POST", headers: { "content-type": "image/jpeg", ...op }, body: jpeg as unknown as BodyInit });
    const draft = (await node.req("POST", "/v1/skills/record", { frames: [((await up.json()) as any).sha256], start_url: "https://wiki.test/" }, op)).body.id;
    const r = await node.req("POST", "/internal/skills/runs", run({ draft_id: draft }, true, { trace: trace(4) }), ex);
    v1 = r.body.skill_cid; pubRun = r.body.run_cid;
    const slug = (await node.req("GET", `/v1/skills/${v1}`)).body.slug;
    expect((await node.req("POST", `/v1/skills/${slug}/empty-result`, { text: SIG })).status).toBe(401);
    expect((await node.req("POST", `/v1/skills/${slug}/empty-result`, { text: "no" }, op)).status).toBe(400);
    const before = calls.length;
    const d = await node.req("POST", `/v1/skills/${slug}/empty-result`, { text: `  ${SIG}  ` }, op);
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ unchanged: false, version: 2, empty_result: { text: SIG } });
    expect(calls.length).toBe(before);
    v2 = d.body.cid;
    const s = (await node.req("GET", `/v1/skills/${v2}`)).body;
    expect(s.skill.record.body.skill.empty_result).toEqual({ text: SIG });
    expect(s.skill.record.body.amended_from).toMatchObject({ skill: v1, change: "declared empty-result signal" });
    expect(s.trace.steps).toHaveLength(4); // inherited: the next replay is still deterministic
    expect(verifyRecord(s.skill.record).ok).toBe(true);
    expect((await node.req("POST", `/v1/skills/${slug}/empty-result`, { text: SIG }, op)).body.unchanged).toBe(true);
  });
  it("a tied no-hit run is verified with outcome no_match, never becomes the replay trace, and shows in the trust card", async () => {
    const r = await node.req("POST", "/internal/skills/runs", noHit({ q: "field" }), ex);
    expect(r.status).toBe(201);
    const d = (await node.req("GET", `/v1/skills/runs/${r.body.run_cid}`)).body;
    expect(d).toMatchObject({ outcome: "no_match", success: true, verified: true, no_match: { label: "Verified: no hit", signal: SIG } });
    expect(d.record?.body?.trace ?? undefined).toBeUndefined();
    const s = (await node.req("GET", `/v1/skills/${v2}`)).body;
    expect(s.trace.source).not.toBe(`run:${r.body.run_cid}`);
    expect(s.trust.no_hit).toMatchObject({ label: "Verified: no hit", signal: SIG, latest: { input: { q: "Nowhereville" }, tied_by: { q: "field" } } });
    expect(s.trust.runs_7d.verified_no_hit).toBe(1);
    expect(s.trust.example.input).toEqual({ q: "Oslo" }); // the example stays a run that returned a value
    const reuse = (await node.req("GET", `/v1/skills/reuse?skill=${s.slug}`)).body;
    expect(reuse.runs.find((x: any) => x.run === r.body.run_cid).outcome).toBe("no_match");
  });
  it("a no-hit claim that is not tied to the input is not verified", async () => {
    const r = await node.req("POST", "/internal/skills/runs", noHit({}), ex);
    const d = (await node.req("GET", `/v1/skills/runs/${r.body.run_cid}`)).body;
    expect(d).toMatchObject({ outcome: "not_verified", verified: false });
    expect((await node.req("POST", "/internal/skills/runs", noHit({ q: "guess" } as any), ex)).status).toBe(400);
  });
  it("a skill with no declared signal says so", async () => {
    expect((await node.req("GET", `/v1/skills/${v1}`)).body.trust.no_hit).toMatch(/not declared/);
    void pubRun;
  });
});
