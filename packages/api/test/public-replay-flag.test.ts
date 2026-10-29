/**
 * The public_replay flag that find_skill, get_skill and the skill list show must match what try_skill accepts:
 * allowlisted AND the latest version safe for public replay. (An allowlisted skill whose step said
 * "Submit the search" was shown as public_replay: true while try_skill refused it.) No real network calls.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeNode, type TestNode } from "./helpers.js";

const TOKEN = "test-".repeat(6), SECRET = "fake-".repeat(6); // fake test values
const op = { "x-skills-token": TOKEN }, ex = { "x-skills-secret": SECRET };
const base = {
  name: "Read a Wikipedia infobox field", summary: "Search Wikipedia and read one infobox field", start_url_hint: "https://en.wikipedia.org/wiki/Special:Search",
  params: [{ name: "search_query", description: "article", example: "Mount Everest" }, { name: "target_field", description: "infobox label", example: "Elevation" }],
  success_check: "infobox shows {{target_field}}", risk_flags: ["none"],
};
const step = (intent: string, action: string, value = "") => ({ intent, target: "search box", action, value });
const V1 = { ...base, steps: [step("type the query", "type", "{{search_query}}"), step("Submit the search", "click"), step("open the article", "click")] };
const V2 = { ...base, steps: [step("type the query", "type", "{{search_query}}"), step("Press Enter to run the search", "keypress", "Enter"), step("open the article", "click")] };

let nextSkill: any = V1;
const fake: typeof fetch = async (url) => {
  if (String(url).endsWith("/jobs")) return new Response("{}", { status: 202 });
  return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(nextSkill) }] }], usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 100 } }), { status: 200 });
};
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(String(Math.random()))]).toString("base64");
let node: TestNode;

async function publish(skill: any, slug: string) {
  nextSkill = skill;
  const sha = (await (await node.app.request("/v1/artifacts", { method: "POST", headers: { "content-type": "image/jpeg", ...op }, body: Buffer.from(jpeg(), "base64") as unknown as BodyInit })).json() as any).sha256;
  const start_url = "https://en.wikipedia.org/wiki/Special:Search";
  const d = await node.req("POST", "/v1/skills/record", { frames: [sha], start_url, parent_slug: slug }, op);
  expect(d.status).toBe(201);
  const r = await node.req("POST", "/internal/skills/runs", {
    draft_id: d.body.id, start_url, params: { search_query: "Mount Everest", target_field: "Elevation" }, success: true,
    verdict: { success: true, evidence: "ok", model: "muse-spark-1.3", capability: "image understanding + structured output" },
    turns: 2, actions: [{ turn: 1, type: "type", detail: "type", approval: "auto", checks: [], target: "search" }],
    usage: { calls: 3, input_tokens: 3000, cached_tokens: 0, output_tokens: 300, usd: 0.01 }, model: "muse-spark-1.3",
    final_jpeg_b64: jpeg(), executor: { name: "agentboard-executor", chromium: "headless-shell", viewport: "960x600" }, duration_ms: 9000,
  }, ex);
  expect(r.status).toBe(201);
  return r.body.skill_cid as string;
}

/** Every place the flag is shown, plus what the public replay status (try_skill's own check) says. */
async function flags(slug: string, cid?: string) {
  const list = (await node.req("GET", "/v1/skills")).body.skills.find((s: any) => s.slug === slug).public_replay;
  const find = (await node.req("GET", `/v1/skills/find?q=${encodeURIComponent("wikipedia infobox")}`)).body.skills.find((s: any) => s.slug === slug).public_replay;
  const one = (await node.req("GET", `/v1/skills/${cid ?? slug}`)).body.public_replay;
  const eligible = Boolean((await node.req("GET", "/v1/skills/public-replay")).body.skills.find((s: any) => s.slug === slug)?.eligible);
  return { list, find, one, eligible };
}

beforeAll(async () => {
  node = await makeNode({ offline: false, embedProvider: "hash", metaApiKey: "test-key", skillsOperatorToken: TOKEN, skillsInternalSecret: SECRET, museDailyCallCap: 200, museSpendCapUsd: 5,
    skillsWebUrl: "https://web.test", skillsExecutorUrl: "https://exec.test", skillsAgentRunsPerDay: 50,
    publicReplaySkills: ["wiki-fact"], publicReplayDailyCap: 4, publicReplayPerIpPerDay: 2, publicReplayPowBits: 4 }, { fetchImpl: fake });
});
afterAll(async () => { await node?.ctx.db.close(); });

describe("public_replay flag matches try_skill eligibility", () => {
  let v1 = "";
  it("allowlisted but unsafe (a step that 'submits'): false everywhere, and not eligible", async () => {
    v1 = await publish(V1, "wiki-fact");
    expect(await flags("wiki-fact")).toEqual({ list: false, find: false, one: false, eligible: false });
    expect((await node.req("POST", "/v1/skills/wiki-fact/public-replay", { params: { search_query: "x", target_field: "y" } }, { "cf-connecting-ip": "10.9.0.1" })).body.error).toBe("not_safe_for_public_replay");
  });
  it("a safe next version flips it to true everywhere, including get_skill on the old version (try_skill runs the latest)", async () => {
    const v2 = await publish(V2, "wiki-fact");
    expect(v2).not.toBe(v1);
    expect(await flags("wiki-fact")).toEqual({ list: true, find: true, one: true, eligible: true });
    expect((await flags("wiki-fact", v1)).one).toBe(true);
  });
  it("safe but not allowlisted, or public replay switched off: false", async () => {
    const saved = node.ctx.cfg.publicReplaySkills;
    (node.ctx.cfg as any).publicReplaySkills = [];
    try { expect(await flags("wiki-fact")).toEqual({ list: false, find: false, one: false, eligible: false }); }
    finally { (node.ctx.cfg as any).publicReplaySkills = saved; }
    const cap = node.ctx.cfg.publicReplayDailyCap;
    (node.ctx.cfg as any).publicReplayDailyCap = 0;
    try { const f = await flags("wiki-fact"); expect([f.list, f.find, f.one]).toEqual([false, false, false]); }
    finally { (node.ctx.cfg as any).publicReplayDailyCap = cap; }
  });
});
