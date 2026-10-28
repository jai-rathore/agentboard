import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { verifyRecord, verifyChain, gatedSteps, effectiveRiskFlags } from "@agentboard/core";
import { AgentboardClient } from "@agentboard/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeNode, TestAgent, type TestNode } from "./helpers.js";
import { staleSteps, mp4DurationMs, timeSaved } from "../src/services/skills.js";
import { checkStartUrl } from "../src/services/skillJobs.js";
import { mountRemoteMcp } from "../src/mcpRemote.js";

const TOKEN = "test-".repeat(6); // fake test value
const SECRET = "fake-".repeat(6); // fake test value
const v1 = {
  name: "Create a helpdesk ticket", summary: "File a support ticket", start_url_hint: "/demo/helpdesk/",
  params: [{ name: "customer_email", description: "email", example: "dana@globex.com" }],
  steps: [{ intent: "enter email", target: "Customer email input", action: "type", value: "{{customer_email}}" }, { intent: "submit the ticket", target: "blue Create ticket button", action: "click", value: "" }],
  success_check: "Green banner 'Ticket #… created for {{customer_email}}'", risk_flags: ["personal_data"],
};
const healed = {
  success_check: v1.success_check,
  steps: [{ intent: "enter email", target: "Requester e-mail input", action: "type", value: "{{customer_email}}" }, { intent: "submit the request", target: "green Submit request button at the top right", action: "click", value: "" }],
  changes: [{ step: 1, field: "target", before: "Customer email input", after: "Requester e-mail input", reason: "label renamed" }, { step: 2, field: "target", before: "blue Create ticket button", after: "green Submit request button at the top right", reason: "button renamed and moved" }],
};
const calls: any[] = [];
let executorReplies: number[] = [];
const dispatched: any[] = [];
const fake: typeof fetch = async (url, init) => {
  const u = String(url);
  if (u.endsWith("/jobs")) { dispatched.push({ headers: init?.headers, body: JSON.parse(String(init?.body)) }); const s = executorReplies.shift() ?? 202; return new Response(JSON.stringify({}), { status: s }); }
  const body = JSON.parse(String(init?.body));
  const kind = (init?.headers as any)["x-muse-kind"];
  calls.push({ kind, body });
  const text = JSON.stringify(kind === "heal" ? healed : v1);
  return new Response(JSON.stringify({ status: "completed", output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "Labels and the submit button changed." }] }, { type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 3000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 600 } }), { status: 200 });
};

// 7.0 s mp4 header: ftyp + moov/mvhd (version 0, timescale 1000, duration 7000)
function mp4(ms: number) {
  const mvhd = Buffer.alloc(8 + 100); mvhd.writeUInt32BE(108, 0); mvhd.write("mvhd", 4); mvhd.writeUInt32BE(1000, 8 + 12); mvhd.writeUInt32BE(ms, 8 + 16);
  const moov = Buffer.concat([Buffer.from([0, 0, 0, 116]), Buffer.from("moov"), mvhd]);
  return Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("ftypisom"), Buffer.from([0, 0, 2, 0]), moov]);
}
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(String(Math.random()))]);
let node: TestNode;
const op = { "x-skills-token": TOKEN }, ex = { "x-skills-secret": SECRET };
const upload = async (bytes: Uint8Array, mime: string) => (await (await node.app.request("/v1/artifacts", { method: "POST", headers: { "content-type": mime, ...op }, body: bytes as unknown as BodyInit })).json() as any).sha256 as string;
const run = (target: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  ...target, start_url: "https://agentboard.test/demo/helpdesk/", params: { customer_email: "bob@initech.com" }, success: true,
  verdict: { success: true, evidence: "banner shows bob@initech.com", model: "muse-spark-1.3", capability: "image understanding + structured output" },
  turns: 4, actions: [{ turn: 1, type: "type", detail: "type", approval: "auto", checks: [], target: "Customer email" }, { turn: 4, type: "click", detail: "click Create ticket", approval: "human", checks: [], target: "Create ticket", flags: ["submits_form"] }],
  usage: { calls: 5, input_tokens: 15000, cached_tokens: 0, output_tokens: 800, usd: 0.02 }, model: "muse-spark-1.3",
  final_jpeg_b64: jpeg().toString("base64"), executor: { name: "agentboard-executor", chromium: "headless-shell", viewport: "960x600" }, duration_ms: 40000, ...extra,
});

let skill1: string;
beforeAll(async () => {
  node = await makeNode({ offline: false, embedProvider: "hash", metaApiKey: "test-key", skillsOperatorToken: TOKEN, skillsInternalSecret: SECRET, museDailyCallCap: 50, museSpendCapUsd: 1, skillsWebUrl: "https://web.test", skillsExecutorUrl: "https://exec.test" }, { fetchImpl: fake });
  mountRemoteMcp(node.app, node.ctx);
  const video = await upload(mp4(7000), "video/mp4");
  const d = (await node.req("POST", "/v1/skills/record", { video, start_url: "https://agentboard.test/demo/helpdesk/" }, op)).body.id;
  const r = await node.req("POST", "/internal/skills/runs", run({ draft_id: d }), ex);
  skill1 = r.body.skill_cid;
});
afterAll(async () => { await node?.ctx.db.close(); });

describe("safety and time saved", () => {
  it("parses mp4 duration and computes human time saved", () => {
    expect(mp4DurationMs(mp4(7000))).toBe(7000);
    expect(mp4DurationMs(Buffer.from("no movie here"))).toBeNull();
    expect(timeSaved(7000, { duration_ms: 40000, actions: [{ approval: "human" }, { approval: "auto" }] })).toMatchObject({ human_approvals: 1, human_ms: 5000, saved_ms: 2000 });
    expect(timeSaved(null, { duration_ms: 1, actions: [] }).saved_ms).toBeNull();
  });
  it("infers approval-gated steps even when the recorder forgot the risk flag", () => {
    expect(gatedSteps(v1)).toEqual([{ index: 1, flags: ["submits_form"] }]);
    expect(effectiveRiskFlags(v1)).toEqual(["personal_data", "submits_form"]);
  });
  it("the skill page reports recording length, time saved, and safety", async () => {
    const s = (await node.req("GET", `/v1/skills/${skill1}`)).body;
    expect(s.time).toMatchObject({ recording_ms: 7000, verified_runs: 1, saved_total_ms: 2000 });
    expect(s.runs[0].record.body.time).toMatchObject({ recording_ms: 7000, saved_ms: 2000, human_approvals: 1 });
    expect(s.safety.approval_required_steps).toEqual([{ step: 2, flags: ["submits_form"] }]);
    expect(s.safety.risk_flags).toContain("submits_form");
  });
  it("runs stay on the recorded site", () => {
    expect(checkStartUrl("https://a.test/demo/helpdesk/", "https://a.test/demo/helpdesk/?v=2")).toBe("https://a.test/demo/helpdesk/?v=2");
    expect(() => checkStartUrl("https://a.test/x", "https://evil.test/x")).toThrow(/must stay on/);
  });
});

describe("self-healing", () => {
  it("detects stale steps from the elements actually used", () => {
    expect(staleSteps(v1 as any, [{ target: "Customer email" }, { target: "Create ticket" }])).toEqual([]);
    expect(staleSteps(v1 as any, [{ target: "Requester e-mail" }, { target: "Submit request" }])).toEqual([1, 2]);
    expect(staleSteps(v1 as any, [])).toEqual([]);
  });
  it("a verified replay on a redesigned site publishes a signed v2 with the step diff", async () => {
    const r = await node.req("POST", "/internal/skills/runs", run({ skill_cid: skill1 }, {
      start_url: "https://agentboard.test/demo/helpdesk/?v=2",
      actions: [{ turn: 1, type: "type", detail: "type", approval: "auto", checks: [], target: "Requester e-mail" }, { turn: 3, type: "click", detail: "click", approval: "human", checks: [], target: "Submit request", flags: ["submits_form"] }],
      step_changes: [{ step: 2, observed: "button now reads Submit request, top right", turn: 3 }],
    }), ex);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("healed");
    expect(r.body.healed).toMatchObject({ version: 2 });
    expect(r.body.healed.changes).toHaveLength(2);
    expect(r.body.healed.seq).toBe(r.body.run_seq + 1);
    const heal = calls.filter((c) => c.kind === "heal").at(-1);
    expect(heal.body.max_output_tokens).toBe(2000);
    expect(heal.body.input[0].content[1].type).toBe("input_image");
    const s2 = (await node.req("GET", `/v1/skills/${r.body.healed.cid}`)).body;
    const b = s2.skill.record.body;
    expect(verifyRecord(s2.skill.record).ok).toBe(true);
    expect(b.prev).toBe(skill1);
    expect(b.healed_from).toMatchObject({ skill: skill1, run: r.body.run_cid, stale_steps: [1, 2] });
    expect(b.skill.risk_flags).toEqual(["personal_data"]); // healing never touches params or flags
    expect(b.skill.steps[1].target).toBe("green Submit request button at the top right");
    expect(s2.prev_skill.skill.steps[1].target).toBe("blue Create ticket button");
    expect(s2.badge).toMatchObject({ verified: true, healed: true });
    expect(s2.heal_run.record.cid).toBe(r.body.run_cid);
    const old = (await node.req("GET", `/v1/skills/${skill1}`)).body;
    expect(old.latest_version).toBe(2);
    expect(old.runs[0].record.body.drift).toMatchObject({ stale_steps: [1, 2], healed: true });
    expect(verifyChain((await node.req("GET", "/v1/log?since=0&limit=1000")).body.entries).ok).toBe(true);
  });
  it("only the latest version heals; failed runs never heal", async () => {
    const n = calls.filter((c) => c.kind === "heal").length;
    const stale = [{ turn: 1, type: "click", detail: "click", approval: "auto", checks: [], target: "Something else" }];
    const r1 = await node.req("POST", "/internal/skills/runs", run({ skill_cid: skill1 }, { actions: stale }), ex);
    expect(r1.body.status).toBe("run_recorded");
    expect(r1.body.drift.stale_steps.length).toBeGreaterThan(0);
    const latest = (await node.req("GET", `/v1/skills/${skill1}`)).body.latest_cid;
    const r2 = await node.req("POST", "/internal/skills/runs", run({ skill_cid: latest }, { actions: stale, success: false, verdict: { success: false, evidence: "no banner", model: "muse-spark-1.3", capability: "x" } }), ex);
    expect(r2.body.status).toBe("run_recorded");
    expect(calls.filter((c) => c.kind === "heal").length).toBe(n);
  });
});

describe("run_skill jobs", () => {
  it("operator runs: validates params and site, dispatches to the executor, tracks events and human approval", async () => {
    expect((await node.req("POST", "/v1/skills/run", { skill: "create-a-helpdesk-ticket", params: {} }, op)).body.error).toBe("missing_params");
    expect((await node.req("POST", "/v1/skills/run", { skill: "create-a-helpdesk-ticket", params: { customer_email: "x@y.z", evil: "1" } }, op)).body.error).toBe("unknown_params");
    expect((await node.req("POST", "/v1/skills/run", { skill: "create-a-helpdesk-ticket", params: { customer_email: "x@y.z" }, start_url: "https://evil.test/" }, op)).body.error).toBe("start_url_origin");
    expect((await node.req("POST", "/v1/skills/run", { skill: "create-a-helpdesk-ticket", params: { customer_email: "x@y.z" } })).status).toBe(401);
    const r = await node.req("POST", "/v1/skills/run", { skill: skill1, params: { customer_email: "x@y.z" } }, op);
    expect(r.status).toBe(202);
    const id = r.body.id;
    expect(r.body.url).toBe(`https://web.test/skills/r/${id}`);
    expect(dispatched.at(-1).body).toEqual({ job_id: id });
    expect(dispatched.at(-1).headers["x-skills-secret"]).toBe(SECRET);
    const job = (await node.req("GET", `/internal/skills/jobs/${id}`, undefined, ex)).body;
    expect(job.skill_cid).not.toBe(skill1); // the latest (healed) version runs
    expect((await node.req("GET", `/internal/skills/jobs/${id}`)).status).toBe(401);
    await node.req("POST", `/internal/skills/jobs/${id}/events`, { status: "running", turn: { turn: 1, say: "typing" }, frame_b64: jpeg().toString("base64") }, ex);
    expect((await node.app.request(`/v1/skills/jobs/${id}/frame`)).headers.get("content-type")).toBe("image/jpeg");
    const pe = await node.req("POST", `/internal/skills/jobs/${id}/events`, { status: "pending_approval", approval: { id: "a1", turn: 3, reason: "click on button \"Submit request\" submits form: a human must approve", flags: ["submits_form"] } }, ex);
    expect(pe.body).toEqual({ ok: true });
    const pub = (await node.req("GET", `/v1/skills/jobs/${id}`)).body;
    expect(pub).toMatchObject({ status: "pending_approval", approval: { id: "a1" } });
    expect(pub.decision).toBeUndefined();
    expect((await node.req("POST", `/v1/skills/jobs/${id}/decision`, { approval_id: "a1", approve: true })).status).toBe(401);
    expect((await node.req("POST", `/v1/skills/jobs/${id}/decision`, { approval_id: "zz", approve: true }, op)).body.error).toBe("stale_approval");
    expect((await node.req("POST", `/v1/skills/jobs/${id}/decision`, { approval_id: "a1", approve: true }, op)).status).toBe(200);
    expect((await node.req("GET", `/internal/skills/jobs/${id}`, undefined, ex)).body.decision).toMatchObject({ id: "a1", approve: true });
    expect((await node.req("GET", `/v1/skills/jobs/${id}`)).body).toMatchObject({ status: "running", approval: null });
    expect((await node.req("POST", `/v1/skills/jobs/${id}/decision`, { approval_id: "a1", approve: false }, op)).body.error).toBe("not_pending");
    await node.req("POST", `/internal/skills/jobs/${id}/events`, { status: "completed", result: { run_cid: "x", verdict: { success: true } } }, ex);
    expect((await node.req("GET", `/v1/skills/jobs/${id}`)).body.status).toBe("completed");
    const late = await node.req("POST", `/internal/skills/jobs/${id}/events`, { status: "running" }, ex);
    expect(late.body.ignored).toBe(true);
  });
  it("a busy executor fails the job cleanly", async () => {
    executorReplies = [409];
    const r = await node.req("POST", "/v1/skills/run", { skill: skill1, params: { customer_email: "x@y.z" } }, op);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("executor_busy");
  });
  it("agents run skills with signed requests that cost credits, within quotas, and cannot approve", async () => {
    const agent = new TestAgent(node);
    expect((await agent.register("runner")).status).toBe(201);
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => node.app.fetch(new Request(input, init))) as typeof fetch;
    const client = new AgentboardClient({ baseUrl: "http://agentboard.test", keyPair: agent.kp, fetchImpl });
    const bal = async () => (await node.req("GET", `/v1/agents/${agent.did}`)).body.agent.credits;
    const before = await bal();
    const j = await client.runSkill({ skill: "create-a-helpdesk-ticket", params: { customer_email: "agent@x.test" } });
    expect(j.status).toBe("queued");
    expect(await bal()).toBe(before - 5);
    // tampering with the body breaks the signature's body hash
    const raw = JSON.stringify({ skill: "create-a-helpdesk-ticket", params: { customer_email: "a@b.c" } });
    expect((await node.req("POST", `/v1/skills/run?h=${"0".repeat(64)}`, JSON.parse(raw), { authorization: 'Agentboard did="x",ts="1",sig="y"' })).status).toBe(401);
    executorReplies = [409];
    await expect(client.runSkill({ skill: "create-a-helpdesk-ticket", params: { customer_email: "agent@x.test" } })).rejects.toThrow(/another replay/);
    expect(await bal()).toBe(before - 5); // refunded
    await client.runSkill({ skill: "create-a-helpdesk-ticket", params: { customer_email: "agent@x.test" } });
    await expect(client.runSkill({ skill: "create-a-helpdesk-ticket", params: { customer_email: "agent@x.test" } })).rejects.toThrow(/per agent per day/);
    expect((await node.req("POST", `/v1/skills/jobs/${j.id}/decision`, { approval_id: "a1", approve: true }, { authorization: "x" })).status).toBe(401);
  });
  it("find_skill search returns params, approval-gated steps and time", async () => {
    const r = (await node.req("GET", "/v1/skills/find?q=file+a+support+ticket")).body.skills;
    expect(r[0]).toMatchObject({ slug: "create-a-helpdesk-ticket", version: 2, healed: true, recording_ms: 7000 });
    expect(r[0].params[0].name).toBe("customer_email");
    expect(r[0].approval_required_steps[0]).toMatchObject({ step: 2, flags: ["submits_form"] });
    expect((await node.req("GET", "/v1/skills/find?q=zzz")).body.skills).toEqual([]);
  });
});

describe("hosted /mcp", () => {
  const list = async (headers: Record<string, string> = {}) => {
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => node.app.fetch(new Request(input, init))) as typeof fetch;
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL("http://agentboard.test/mcp"), { fetch: fetchImpl, requestInit: { headers } }));
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    await c.close();
    return names;
  };
  it("offers run_skill only with a valid operator token", async () => {
    expect(await list()).not.toContain("run_skill");
    expect(await list({ "x-skills-token": "wrong-".repeat(5) })).not.toContain("run_skill");
    const names = await list(op);
    expect(names).toContain("run_skill");
    expect(names).not.toContain("ask"); // still no agent writes on the hosted endpoint
  });
});
