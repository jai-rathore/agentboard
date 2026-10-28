/**
 * Public capped replay trigger (POST /v1/skills/:slug/public-replay and the remote MCP try_skill).
 * Every model and executor call is mocked: nothing here reaches api.meta.ai, inference.baseten.co or the executor.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { publicReplaySafety, siteKindOf } from "@agentboard/core";
import { makeNode, type TestNode } from "./helpers.js";
import { loadConfig } from "../src/config.js";
import { mountRemoteMcp } from "../src/mcpRemote.js";
import { solvePublicPow, MCP_CLIENT_IP_HEADER } from "../src/services/publicReplay.js";
import { classifyRun } from "../src/services/skillMetrics.js";

const TOKEN = "test-".repeat(6), SECRET = "fake-".repeat(6); // fake test values
const op = { "x-skills-token": TOKEN }, ex = { "x-skills-secret": SECRET };
const SAFE = {
  name: "Search Hacker News", summary: "Search HN stories", start_url_hint: "https://news.ycombinator.com/",
  params: [{ name: "query", description: "search words", example: "postgres" }],
  steps: [{ intent: "open the search page", target: "address bar", action: "navigate", value: "https://hn.algolia.com/" }, { intent: "type the search words", target: "search input at the top", action: "type", value: "{{query}}" }],
  success_check: "results for {{query}} are listed", risk_flags: ["none"],
};
const UNSAFE = {
  name: "File a helpdesk ticket", summary: "File a ticket", start_url_hint: "/demo/helpdesk/",
  params: [{ name: "subject", description: "subject", example: "VPN" }],
  steps: [{ intent: "type the subject", target: "Subject input", action: "type", value: "{{subject}}" }, { intent: "submit the ticket", target: "blue Create ticket button", action: "click", value: "" }],
  success_check: "Ticket created", risk_flags: ["submits_form"],
};
let nextSkill: any = SAFE;
const urls: string[] = [];
let executorStatus = 202;
const fake: typeof fetch = async (url, init) => {
  const u = String(url);
  urls.push(u);
  if (u.endsWith("/jobs")) return new Response("{}", { status: executorStatus });
  return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(nextSkill) }] }], usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 100 } }), { status: 200 });
};
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(String(Math.random()))]).toString("base64");
const runBody = (target: Record<string, string>, start_url: string, params: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  ...target, start_url, params, success: true,
  verdict: { success: true, evidence: "looks right", model: "muse-spark-1.3", capability: "image understanding + structured output" },
  turns: 2, actions: [{ turn: 1, type: "type", detail: "type", approval: "auto", checks: [], target: "search" }],
  usage: { calls: 3, input_tokens: 3000, cached_tokens: 0, output_tokens: 300, usd: 0.01 }, model: "muse-spark-1.3",
  final_jpeg_b64: jpeg(), executor: { name: "agentboard-executor", chromium: "headless-shell", viewport: "960x600" }, duration_ms: 9000, ...extra,
});

let node: TestNode;
const START = Date.parse("2026-10-28T12:00:00Z");
let now = START;
async function publish(skill: any, slug: string, startUrl: string) {
  nextSkill = skill;
  const d = (await node.req("POST", "/v1/skills/record", { frames: [], video: undefined, start_url: startUrl, hint: slug, parent_slug: slug }, op));
  if (d.status !== 201) {
    // the record route needs a source: upload a screenshot
    const sha = (await (await node.app.request("/v1/artifacts", { method: "POST", headers: { "content-type": "image/jpeg", ...op }, body: Buffer.from(jpeg(), "base64") as unknown as BodyInit })).json() as any).sha256;
    const d2 = await node.req("POST", "/v1/skills/record", { frames: [sha], start_url: startUrl, parent_slug: slug }, op);
    const r = await node.req("POST", "/internal/skills/runs", runBody({ draft_id: d2.body.id }, startUrl, Object.fromEntries(skill.params.map((p: any) => [p.name, p.example]))), ex);
    expect(r.status).toBe(201);
    return r.body;
  }
  throw new Error("unexpected");
}
const post = (slug: string, body: unknown, headers: Record<string, string> = {}) => node.req("POST", `/v1/skills/${slug}/public-replay`, body, headers);
const ip = (x: string) => ({ "cf-connecting-ip": x });
/** Full two-step flow: ask for a challenge, solve the proof of work, start the run. */
async function replay(slug: string, params: Record<string, string>, headers: Record<string, string>) {
  const first = await post(slug, { params }, headers);
  if (first.status !== 428) return first;
  const ch = first.body.challenge;
  return post(slug, { params, challenge: { id: ch.id, counter: solvePublicPow(ch, slug) } }, headers);
}

beforeAll(async () => {
  node = await makeNode({ offline: false, embedProvider: "hash", metaApiKey: "test-key", skillsOperatorToken: TOKEN, skillsInternalSecret: SECRET, museDailyCallCap: 200, museSpendCapUsd: 5,
    skillsWebUrl: "https://web.test", skillsExecutorUrl: "https://exec.test", skillsAgentRunsPerDay: 50,
    publicReplaySkills: ["search-hn", "file-ticket"], publicReplayDailyCap: 4, publicReplayPerIpPerDay: 2, publicReplayPowBits: 4 }, { fetchImpl: fake, now: () => now });
  mountRemoteMcp(node.app, node.ctx);
  await publish(SAFE, "search-hn", "https://news.ycombinator.com/");
  await publish(UNSAFE, "file-ticket", "https://agentboard.test/demo/helpdesk/");
  await publish({ ...SAFE, name: "Search HN again" }, "not-listed", "https://news.ycombinator.com/");
});
afterAll(async () => { await node?.ctx.db.close(); });

describe("public replay: off by default", () => {
  it("PUBLIC_REPLAY_DAILY_CAP defaults to 0 and the endpoint says disabled", async () => {
    const cfg = loadConfig({});
    expect(cfg.publicReplayDailyCap).toBe(0);
    expect(cfg.publicReplayPerIpPerDay).toBe(3);
    expect(cfg.publicReplaySkills).toEqual([]);
    expect(loadConfig({ PUBLIC_REPLAY_SKILLS: " Hacker-News-Top-Story, bad slug!,wiki " }).publicReplaySkills).toEqual(["hacker-news-top-story", "wiki"]);
    const off = await makeNode({ skillsInternalSecret: SECRET, publicReplaySkills: ["search-hn"] }, { fetchImpl: fake });
    try {
      const r = await off.req("POST", "/v1/skills/search-hn/public-replay", { params: { query: "x" } }, ip("1.2.3.4"));
      expect(r.status).toBe(503);
      expect(r.body.error).toBe("public_replay_disabled");
      expect((await off.req("GET", "/v1/skills/public-replay")).body).toMatchObject({ enabled: false, daily_cap: 0 });
      expect((await off.req("GET", "/v1/node")).body.providers.skills.public_replay.enabled).toBe(false);
    } finally { await off.ctx.db.close(); }
  });
});

describe("public replay: allowlist, safety and params", () => {
  it("only allowlisted, non-destructive skills", async () => {
    expect((await post("not-listed", { params: { query: "x" } }, ip("9.9.9.1"))).body.error).toBe("not_allowlisted");
    const unsafe = await post("file-ticket", { params: { subject: "x" } }, ip("9.9.9.1"));
    expect(unsafe.status).toBe(403);
    expect(unsafe.body.error).toBe("not_safe_for_public_replay");
    expect(publicReplaySafety(SAFE).ok).toBe(true);
    expect(publicReplaySafety(UNSAFE).ok).toBe(false);
    // words alone disqualify, even with no declared flag and a non-click action
    expect(publicReplaySafety({ ...SAFE, steps: [{ intent: "delete the draft", target: "trash", action: "keypress", value: "" }] }).ok).toBe(false);
    expect(publicReplaySafety({ ...SAFE, risk_flags: ["login_required"] }).ok).toBe(false);
    const st = (await node.req("GET", "/v1/skills/public-replay")).body;
    expect(st.enabled).toBe(true);
    expect(st.skills.find((s: any) => s.slug === "search-hn").eligible).toBe(true);
    expect(st.skills.find((s: any) => s.slug === "file-ticket").eligible).toBe(false);
  });
  it("validates inputs against the skill's params before issuing a challenge", async () => {
    expect((await post("search-hn", { params: { query: "x", extra: "y" } }, ip("9.9.9.2"))).body.error).toBe("unknown_params");
    expect((await post("search-hn", { params: {} }, ip("9.9.9.2"))).body.error).toBe("missing_params");
    expect((await post("search-hn", { params: { query: "   " } }, ip("9.9.9.2"))).body.error).toBe("missing_params");
    expect((await post("search-hn", { params: { query: "x".repeat(501) } }, ip("9.9.9.2"))).body.error).toBe("param_too_long");
    expect((await post("search-hn", { params: { query: 5 } }, ip("9.9.9.2"))).body.error).toBe("missing_params");
    expect((await post("search-hn", "[1]", ip("9.9.9.2"))).status).toBe(400);
  });
});

describe("public replay: client IP and challenge", () => {
  it("needs CF-Connecting-IP or True-Client-IP; X-Forwarded-For is ignored", async () => {
    expect((await post("search-hn", { params: { query: "x" } })).body.error).toBe("client_ip_required");
    expect((await post("search-hn", { params: { query: "x" } }, { "x-forwarded-for": "5.5.5.5" })).body.error).toBe("client_ip_required");
    expect((await post("search-hn", { params: { query: "x" } }, { "cf-connecting-ip": "x".repeat(65) })).body.error).toBe("client_ip_required");
    // a forged in-process MCP header from outside is not trusted
    expect((await post("search-hn", { params: { query: "x" } }, { [MCP_CLIENT_IP_HEADER]: "5.5.5.5", "x-agentboard-mcp-internal": "guess" })).body.error).toBe("client_ip_required");
    const r = await post("search-hn", { params: { query: "x" } }, { "true-client-ip": "2001:db8::1" });
    expect(r.status).toBe(428);
    expect(r.body.challenge).toMatchObject({ kind: "pow", bits: 4 });
  });
  it("challenges are single use and bound to the skill, params and network", async () => {
    const h = ip("7.7.7.7");
    const ch = (await post("search-hn", { params: { query: "cats" } }, h)).body.challenge;
    const counter = solvePublicPow(ch, "search-hn");
    expect((await post("search-hn", { params: { query: "dogs" }, challenge: { id: ch.id, counter } }, h)).body.error).toBe("challenge_mismatch");
    expect((await post("search-hn", { params: { query: "cats" }, challenge: { id: ch.id, counter } }, h)).body.error).toBe("challenge_invalid"); // burned
    const ch2 = (await post("search-hn", { params: { query: "cats" } }, h)).body.challenge;
    expect((await post("search-hn", { params: { query: "cats" }, challenge: { id: ch2.id, counter: solvePublicPow(ch2, "search-hn") } }, ip("7.7.7.8"))).body.error).toBe("challenge_mismatch");
    const ch3 = (await post("search-hn", { params: { query: "cats" } }, h)).body.challenge;
    let bad = 0;
    // find a counter that does NOT satisfy the work
    const { leadingZeroBits } = await import("@agentboard/core");
    const { powDigest } = await import("../src/services/publicReplay.js");
    while (leadingZeroBits(powDigest(ch3.nonce, "search-hn", ch3.params_hash, bad)) >= ch3.bits) bad++;
    expect((await post("search-hn", { params: { query: "cats" }, challenge: { id: ch3.id, counter: bad } }, h)).body.error).toBe("challenge_failed");
    now += 10 * 60_000; // expired
    const ch4 = (await post("search-hn", { params: { query: "cats" } }, h)).body.challenge;
    now += 6 * 60_000;
    expect((await post("search-hn", { params: { query: "cats" }, challenge: { id: ch4.id, counter: solvePublicPow(ch4, "search-hn") } }, h)).body.error).toBe("challenge_expired");
  });
});

describe("public replay: caps", () => {
  it("starts a run marked public, and limits each network per UTC day", async () => {
    now = Date.parse("2026-10-29T01:00:00Z");
    const a = await replay("search-hn", { query: "rust" }, ip("10.0.0.1"));
    expect(a.status).toBe(202);
    expect(a.body).toMatchObject({ status: "queued", via: "public", trigger: "public", agent: null, poll: `/v1/skills/jobs/${a.body.id}` });
    expect((await node.req("GET", `/v1/skills/jobs/${a.body.id}`)).body.trigger).toBe("public");
    expect((await replay("search-hn", { query: "go" }, ip("10.0.0.1"))).status).toBe(202);
    const third = await replay("search-hn", { query: "zig" }, ip("10.0.0.1"));
    expect(third.status).toBe(429);
    expect(third.body.error).toBe("public_replay_ip_limit");
    // CF-Connecting-IP wins over True-Client-IP
    expect((await post("search-hn", { params: { query: "zig" } }, { "cf-connecting-ip": "10.0.0.1", "true-client-ip": "10.0.0.99" })).body.error).toBe("public_replay_ip_limit");
    // the executor being busy does not use up a slot
    executorStatus = 409;
    expect((await replay("search-hn", { query: "busy" }, ip("10.0.0.2"))).status).toBe(409);
    executorStatus = 202;
    expect((await replay("search-hn", { query: "a" }, ip("10.0.0.2"))).status).toBe(202);
    expect((await replay("search-hn", { query: "b" }, ip("10.0.0.2"))).status).toBe(202);
    // global daily cap (4)
    const g = await replay("search-hn", { query: "c" }, ip("10.0.0.3"));
    expect(g.status).toBe(429);
    expect(g.body.error).toBe("public_replay_daily_cap");
    // next UTC day: fresh budget
    now = Date.parse("2026-10-30T00:00:01Z");
    expect((await replay("search-hn", { query: "c" }, ip("10.0.0.1"))).status).toBe(202);
  });
  it("shares the node's daily budget for non-operator runs and respects Muse caps", async () => {
    now = Date.parse("2026-10-31T00:10:00Z");
    node.ctx.cfg.skillsAgentRunsPerDay = 1;
    expect((await replay("search-hn", { query: "a" }, ip("10.1.0.1"))).status).toBe(202);
    expect((await replay("search-hn", { query: "b" }, ip("10.1.0.2"))).body.error).toBe("node_run_quota");
    node.ctx.cfg.skillsAgentRunsPerDay = 50;
    const cap = node.ctx.cfg.museSpendCapUsd;
    node.ctx.cfg.museSpendCapUsd = 0.05; // lifetime spend so far plus a run's headroom would cross it
    expect((await post("search-hn", { params: { query: "b" } }, ip("10.1.0.3"))).body.error).toBe("muse_spend_cap");
    node.ctx.cfg.museSpendCapUsd = cap;
    const calls = node.ctx.cfg.museDailyCallCap;
    node.ctx.cfg.museDailyCallCap = 10; // fewer than the 20 calls a run may need
    expect((await post("search-hn", { params: { query: "b" } }, ip("10.1.0.3"))).body.error).toBe("muse_daily_cap");
    node.ctx.cfg.museDailyCallCap = calls;
  });
});

describe("public replay records as evidence", () => {
  it("the signed run record says trigger public; run detail, reuse and metrics count replays only", async () => {
    now = Date.parse("2026-11-01T00:10:00Z");
    const job = (await replay("search-hn", { query: "sqlite" }, ip("10.2.0.1"))).body;
    const skillCid = (await node.req("GET", "/v1/skills/search-hn")).body.skill.record.cid;
    const r = await node.req("POST", "/internal/skills/runs", runBody({ skill_cid: skillCid, job_id: job.id }, "https://news.ycombinator.com/", { query: "sqlite" }), ex);
    expect(r.status).toBe(201);
    const rec = (await node.req("GET", `/v1/records/${r.body.run_cid}`)).body.record;
    expect(rec.body.trigger).toBe("public");
    expect(rec.body.requested_by).toEqual({ via: "public", job: job.id });
    const d = (await node.req("GET", `/v1/skills/runs/${r.body.run_cid}`)).body;
    expect(d).toMatchObject({ kind: "replay", trigger: "public", new_inputs: true, differing_params: ["query"], site_kind: "real", self_healed: false, inputs: { query: "sqlite" } });
    expect(d.recording.inputs).toEqual({ query: "postgres" });
    expect(d.models).toMatchObject({ loop: "muse-spark-1.3", verifier: "muse-spark-1.3" });
    expect(d.evidence.final_screenshot).toMatch(/\/v1\/artifacts\/[0-9a-f]{64}$/);
    expect(d.signature.cid).toBe(r.body.run_cid);
    // the run detail is also reachable by job id
    expect((await node.req("GET", `/v1/skills/runs/${job.id}`)).body.run.record.cid).toBe(r.body.run_cid);
    // the publishing run is not a replay
    const reuse = (await node.req("GET", "/v1/skills/reuse?skill=search-hn")).body;
    expect(reuse.runs.filter((x: any) => x.kind === "publish")).toHaveLength(1);
    expect(reuse.summary).toMatchObject({ replays: 1, publishing_runs: 1, replays_real_site: 1, replays_mock_site: 0, replays_new_inputs: 1 });
    const pub = reuse.runs.find((x: any) => x.kind === "publish");
    expect((await node.req("GET", `/v1/skills/runs/${pub.run}`)).body).toMatchObject({ kind: "publish", new_inputs: false, trigger: "web" });
    const m = (await node.req("GET", "/v1/skills/metrics")).body;
    expect(m.replays).toMatchObject({ total: 1, real_site: 1, mock_site: 0, publishing_runs: 3, by_trigger: { public: 1 } });
    expect(m.skills_by_site).toEqual({ real: 2, mock: 1 });
    const job2 = (await node.req("GET", `/v1/skills/jobs/${job.id}`)).body;
    expect(job2.trigger).toBe("public");
  });
  it("a publishing run is the run right after a recorded version; after a self-healed version it is a replay", () => {
    const ctx: any = { cfg: { skillsWebUrl: "https://agentboard.test", publicBaseUrl: "https://api.agentboard.test" } };
    const skill = { draft: "d1", skill: { params: [{ name: "q", example: "cats" }] }, source: { start_url: "https://news.ycombinator.com/" } };
    const healed = { ...skill, healed_from: { run: "bagrun" } };
    const row = (sk: any, seq: number) => ({ seq, skill_seq: 10, skill_text: JSON.stringify(sk) });
    expect(classifyRun(ctx, row(skill, 11), { params: { q: "cats" } })).toMatchObject({ kind: "publish", new_inputs: false, site_kind: "real" });
    expect(classifyRun(ctx, row(skill, 12), { params: { q: "Dogs" } })).toMatchObject({ kind: "replay", new_inputs: true, differing_params: ["q"] });
    expect(classifyRun(ctx, row(healed, 11), { params: { q: "cats" } }).kind).toBe("replay");
    expect(classifyRun(ctx, row({ skill: skill.skill }, 11), {}).kind).toBe("replay"); // no draft: not a recording
    expect(classifyRun(ctx, row(skill, 11), { start_url: "https://agentboard.test/demo/helpdesk/" }).site_kind).toBe("mock");
  });

  it("labels demo (mock) sites and ranks real sites first", async () => {
    expect(siteKindOf("https://agentboard-olive-pi.vercel.app/demo/shop/")).toBe("mock");
    expect(siteKindOf("https://agentboard-olive-pi.vercel.app/demo/helpdesk/status.html")).toBe("mock");
    expect(siteKindOf("https://news.ycombinator.com/")).toBe("real");
    expect(siteKindOf("https://example.com/demo/")).toBe("real");
    const list = (await node.req("GET", "/v1/skills")).body.skills;
    expect(list.find((s: any) => s.slug === "file-ticket")).toMatchObject({ site_kind: "mock", site_label: "demo (mock site)" });
    expect(list[list.length - 1].site_kind).toBe("mock");
    const found = (await node.req("GET", "/v1/skills/find?q=ticket+search")).body.skills;
    expect(found.every((s: any) => ["real", "mock"].includes(s.site_kind))).toBe(true);
    const real = found.findIndex((s: any) => s.site_kind === "real"), mock = found.findIndex((s: any) => s.site_kind === "mock");
    if (real >= 0 && mock >= 0 && found[real].match === found[mock].match) expect(real).toBeLessThan(mock);
  });
});

describe("try_skill on the remote /mcp", () => {
  const connect = async (headers: Record<string, string>) => {
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => node.app.fetch(new Request(input, init))) as typeof fetch;
    const c = new Client({ name: "url-only", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL("http://agentboard.test/mcp"), { fetch: fetchImpl, requestInit: { headers } }));
    return c;
  };
  const txt = (r: any) => r.content.map((x: any) => x.text).join("\n");
  it("challenge question first, then a real run under the caller's IP limit; run_skill is never offered", async () => {
    now = Date.parse("2026-11-02T00:10:00Z");
    const c = await connect(ip("11.0.0.1"));
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("try_skill");
    expect(names).not.toContain("run_skill");
    expect(c.getInstructions()).toMatch(/Evaluate in 60 seconds/);
    const ask = async (query: string) => {
      const first = await c.callTool({ name: "try_skill", arguments: { slug: "search-hn", inputs: { query } } });
      const t = txt(first);
      expect(t).toMatch(/Step 1 of 2: What is (\d+) × (\d+) \+ (\d+)\?/);
      const [, a, b, cc] = /What is (\d+) × (\d+) \+ (\d+)\?/.exec(t)!;
      const id = /"challenge_id": "([^"]+)"/.exec(t)![1];
      return c.callTool({ name: "try_skill", arguments: { slug: "search-hn", inputs: { query }, challenge_id: id, answer: Number(a) * Number(b) + Number(cc), wait_seconds: 0 } });
    };
    const wrong = await c.callTool({ name: "try_skill", arguments: { slug: "search-hn", inputs: { query: "x" } } });
    const wid = /"challenge_id": "([^"]+)"/.exec(txt(wrong))![1];
    expect(txt(await c.callTool({ name: "try_skill", arguments: { slug: "search-hn", inputs: { query: "x" }, challenge_id: wid, answer: -1, wait_seconds: 0 } }))).toMatch(/challenge_failed/);
    const ok = await ask("mcp one");
    expect(ok.isError).toBeFalsy();
    expect(txt(ok)).toMatch(/"trigger": "public"/);
    expect(txt(ok)).toMatch(/skill_run_status\(\{run_id: /);
    expect((await ask("mcp two")).isError).toBeFalsy();
    const limited = await c.callTool({ name: "try_skill", arguments: { slug: "search-hn", inputs: { query: "three" } } });
    expect(txt(limited)).toMatch(/public_replay_ip_limit/);
    // an HTTP proof-of-work challenge does not work for the MCP path and vice versa
    const httpCh = (await post("search-hn", { params: { query: "mix" } }, ip("11.0.0.2"))).body.challenge;
    const c2 = await connect(ip("11.0.0.2"));
    expect(txt(await c2.callTool({ name: "try_skill", arguments: { slug: "search-hn", inputs: { query: "mix" }, challenge_id: httpCh.id, answer: 1 } }))).toMatch(/other trigger/);
    // no IP header at all: refused
    const c3 = await connect({});
    expect(txt(await c3.callTool({ name: "try_skill", arguments: { slug: "search-hn", inputs: { query: "x" } } }))).toMatch(/client_ip_required/);
    await Promise.all([c.close(), c2.close(), c3.close()]);
  });
  it("made no real network calls", () => {
    expect(urls.every((u) => u.startsWith("https://exec.test/") || u.startsWith("https://api.meta.ai/"))).toBe(true); // all answered by the fake
    expect(urls.some((u) => u.includes("inference.baseten.co"))).toBe(false);
  });
});
