import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { verifyRecord, verifyChain, sha256Hex } from "@agentboard/core";
import { makeNode, type TestNode } from "./helpers.js";

const TOKEN = "test-".repeat(6); // fake test value
const SECRET = "fake-".repeat(6); // fake test value
const skillJson = {
  name: "Create a helpdesk ticket", summary: "File a support ticket", start_url_hint: "/demo/helpdesk/",
  params: [{ name: "customer_email", description: "email", example: "dana@globex.com" }],
  steps: [{ intent: "enter email", target: "Customer email input", action: "type", value: "{{customer_email}}" }, { intent: "submit", target: "blue Create ticket button", action: "click", value: "" }],
  success_check: "Green banner 'Ticket #… created for {{customer_email}}'", risk_flags: ["submits_form", "personal_data"],
};
const calls: any[] = [];
const fakeMeta: typeof fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body));
  calls.push({ url: String(url), headers: init?.headers, body });
  return new Response(JSON.stringify({
    status: "completed",
    output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "The user filled the ticket form and submitted it." }] }, { type: "message", content: [{ type: "output_text", text: JSON.stringify(skillJson) }] }],
    usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 500, output_tokens_details: { reasoning_tokens: 100 } },
  }), { status: 200 });
};

let node: TestNode;
const op = { "x-skills-token": TOKEN };
const ex = { "x-skills-secret": SECRET };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

async function upload(bytes: Uint8Array, mime: string, headers: Record<string, string> = op) {
  const res = await node.app.request("/v1/artifacts", { method: "POST", headers: { "content-type": mime, ...headers }, body: bytes as unknown as BodyInit });
  return { status: res.status, body: await res.json() as any };
}
const run = (target: Record<string, string>, success: boolean) => ({
  ...target, start_url: "https://agentboard.test/demo/helpdesk/", params: { customer_email: "bob@initech.com" }, success,
  verdict: { success, evidence: success ? "banner shows bob@initech.com" : "no banner", model: "muse-spark-1.3", capability: "image understanding + structured output" },
  turns: 5, actions: [{ turn: 1, type: "type", detail: "bob@initech.com", approval: "auto", checks: ["computer_action_requires_confirmation"] }, { turn: 5, type: "click", detail: "(262,487) Create ticket", approval: "human", checks: [] }],
  usage: { calls: 6, input_tokens: 15000, cached_tokens: 0, output_tokens: 800, usd: 0.0222 }, model: "muse-spark-1.3",
  final_jpeg_b64: Buffer.concat([jpeg, Buffer.from(String(Math.random()))]).toString("base64"), gif_b64: Buffer.from("GIF89a-test").toString("base64"),
  executor: { name: "agentboard-executor", chromium: "headless-shell", viewport: "960x600" }, duration_ms: 42000,
});

beforeAll(async () => {
  node = await makeNode({ offline: false, embedProvider: "hash", metaApiKey: "test-key", skillsOperatorToken: TOKEN, skillsInternalSecret: SECRET, museDailyCallCap: 5, museSpendCapUsd: 1 }, { fetchImpl: fakeMeta });
});
afterAll(async () => { await node?.ctx.db.close(); });

describe("skills: artifacts and recording", () => {
  it("stores content-addressed artifacts behind the operator token", async () => {
    expect((await upload(jpeg, "image/jpeg", {})).status).toBe(401);
    expect((await upload(jpeg, "text/html")).status).toBe(415);
    const r = await upload(jpeg, "image/jpeg");
    expect(r.status).toBe(201);
    expect(r.body.sha256).toBe(sha256Hex(jpeg));
    const g = await node.app.request(`/v1/artifacts/${r.body.sha256}`);
    expect(g.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await g.arrayBuffer())).toEqual(new Uint8Array(jpeg));
  });

  it("records a draft from screenshots with Muse Spark (structured output), tracking spend", async () => {
    const f = await upload(jpeg, "image/jpeg");
    expect((await node.req("POST", "/v1/skills/record", { frames: [f.body.sha256] })).status).toBe(401);
    const r = await node.req("POST", "/v1/skills/record", { frames: [f.body.sha256], start_url: "https://agentboard.test/demo/helpdesk/" }, op);
    expect(r.status).toBe(201);
    expect(r.body.skill.steps).toHaveLength(2);
    expect(r.body.model).toBe("muse-spark-1.3");
    expect(r.body.capability).toMatch(/image understanding/);
    expect(r.body.reasoning_summary).toMatch(/ticket form/);
    const sent = calls.at(-1);
    expect(sent.url).toMatch(/\/responses$/);
    expect(sent.body.model).toBe("muse-spark-1.3");
    expect(sent.body.max_output_tokens).toBe(1500);
    expect(sent.body.text.format.type).toBe("json_schema");
    expect(sent.body.input[0].content[1].type).toBe("input_image");
    const h = (await node.req("GET", "/healthz")).body;
    expect(h.muse_spend.today.calls).toBe(1);
    expect(h.muse_spend.today.usd).toBeCloseTo((2000 * 1.25 + 500 * 4.25) / 1e6, 6);
  });
});

describe("skills: executor runs publish signed records", () => {
  let draft: string, skillCid: string;
  beforeAll(async () => {
    const f = await upload(Buffer.from([0xff, 0xd8, 9, 9]), "image/jpeg");
    draft = (await node.req("POST", "/v1/skills/record", { frames: [f.body.sha256] }, op)).body.id;
  });

  it("guards internal endpoints and clamps loop output tokens", async () => {
    expect((await node.req("POST", "/internal/muse/responses", { input: "x" }, { "x-muse-kind": "loop" })).status).toBe(401);
    const r = await node.req("POST", "/internal/muse/responses", { input: "x", tools: [{ type: "computer" }], max_output_tokens: 5000 }, { ...ex, "x-muse-kind": "loop" });
    expect(r.status).toBe(200);
    expect(calls.at(-1).body.max_output_tokens).toBe(800);
    expect(calls.at(-1).body.store).toBe(false);
    expect((await node.req("POST", "/internal/muse/responses", { input: "x", tools: [{ type: "web_search" }] }, { ...ex, "x-muse-kind": "loop" })).status).toBe(400);
    expect((await node.req("POST", "/internal/muse/responses", { input: "x", previous_response_id: "r" }, { ...ex, "x-muse-kind": "verify" })).status).toBe(400);
  });

  it("keeps a failed draft replay on the draft (nothing is published)", async () => {
    const r = await node.req("POST", "/internal/skills/runs", run({ draft_id: draft }, false), ex);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("draft_run_failed");
    expect((await node.req("GET", `/v1/skills/drafts/${draft}`)).body.runs).toHaveLength(1);
  });

  it("publishes skill + skill_run on the first verified replay, then counts replays", async () => {
    const r = await node.req("POST", "/internal/skills/runs", run({ draft_id: draft }, true), ex);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("published");
    skillCid = r.body.skill_cid;
    expect(r.body.run_seq).toBe(r.body.skill_seq + 1);
    const r2 = await node.req("POST", "/internal/skills/runs", run({ skill_cid: skillCid }, true), ex);
    expect(r2.body.status).toBe("run_recorded");
    const s = (await node.req("GET", `/v1/skills/${skillCid}`)).body;
    expect(s.badge).toMatchObject({ verified: true, replayed: 2, verified_runs_this_version: 2 });
    expect(s.version).toBe(1);
    expect(verifyRecord(s.skill.record).ok).toBe(true);
    expect(s.skill.record.type).toBe("skill");
    expect(s.skill.record.author).toBe(node.ctx.node.did);
    for (const x of s.runs) { expect(verifyRecord(x.record).ok).toBe(true); expect(x.record.body.skill).toBe(skillCid); }
    const ev = s.runs[0].record.body.evidence;
    expect((await node.app.request(`/v1/artifacts/${ev.gif}`)).headers.get("content-type")).toBe("image/gif");
    const log = (await node.req("GET", "/v1/log?since=0&limit=1000")).body.entries;
    expect(verifyChain(log).ok).toBe(true);
    expect((await node.req("GET", "/v1/skills?q=helpdesk")).body.skills[0]).toMatchObject({ cid: skillCid, verified_runs: 2 });
  });

  it("a re-recording of the same slug publishes version 2 linked to version 1", async () => {
    const f = await upload(Buffer.from([0xff, 0xd8, 7, 7]), "image/jpeg");
    const d2 = (await node.req("POST", "/v1/skills/record", { frames: [f.body.sha256], parent_slug: "create-a-helpdesk-ticket" }, op)).body.id;
    const r = await node.req("POST", "/internal/skills/runs", run({ draft_id: d2 }, true), ex);
    const s = (await node.req("GET", `/v1/skills/${r.body.skill_cid}`)).body;
    expect(s.version).toBe(2);
    expect(s.skill.record.body.prev).toBe(skillCid);
    expect(s.versions.map((v: any) => v.version)).toEqual([2, 1]);
  });

  it("nobody can submit skill records through the agent write path", async () => {
    const s = (await node.req("GET", `/v1/skills/${skillCid}`)).body;
    const r = await node.req("POST", "/v1/records", { record: s.skill.record });
    expect(r.status).toBe(403);
  });

  it("enforces the daily call cap", async () => {
    // cap is 5: 3 records + 1 internal loop call used so far
    expect((await node.req("POST", "/internal/muse/responses", { input: "x" }, { ...ex, "x-muse-kind": "verify" })).status).toBe(200);
    const r = await node.req("POST", "/internal/muse/responses", { input: "x" }, { ...ex, "x-muse-kind": "verify" });
    expect(r.status).toBe(429);
    expect(r.body.error).toBe("muse_daily_cap");
  });
});
