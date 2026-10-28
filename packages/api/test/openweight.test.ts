// Optional open-weight path (Muse Spark Open on Baseten). Baseten and Meta are both mocked: no network, no spend.
import { describe, it, expect, afterEach, vi } from "vitest";
import { loadConfig, parseOpenWeightTasks, openWeightActive, openWeightSummary } from "../src/config.js";
import { responsesToChat, matchesSchema, extractJson, openCostOf, unwrapAnswer } from "../src/services/openWeight.js";
import { makeNode, type TestNode } from "./helpers.js";

const TOKEN = "test-".repeat(6); // fake test value
const SECRET = "fake-".repeat(6); // fake test value
const FAKE_BASETEN_KEY = "fake-baseten-key"; // fake test value
const OPEN = "meta-models/muse-spark-open";
const skill = {
  name: "Create a helpdesk ticket", summary: "File a support ticket", start_url_hint: "/demo/helpdesk/",
  params: [{ name: "customer_email", description: "email", example: "dana@globex.com" }],
  steps: [{ intent: "enter email", target: "Customer email input", action: "type", value: "{{customer_email}}" }],
  success_check: "Banner 'Ticket created for {{customer_email}}'", risk_flags: ["personal_data"],
};
const verdict = { success: true, evidence: "the banner shows the email" };
const VERIFY_SCHEMA = { type: "object", additionalProperties: false, required: ["success", "evidence"], properties: { success: { type: "boolean" }, evidence: { type: "string" } } };
const verifyBody = {
  reasoning: { effort: "minimal" }, max_output_tokens: 600,
  text: { format: { type: "json_schema", name: "verdict", strict: true, schema: VERIFY_SCHEMA } },
  input: [{ role: "user", content: [{ type: "input_text", text: "Success check: banner" }, { type: "input_image", image_url: "data:image/jpeg;base64,AAAA" }] }],
};

type Mode = "ok" | "500" | "length" | "bad_json" | "bad_schema" | "throw";
interface Seen { meta: any[]; baseten: { url: string; headers: any; body: any }[] }
function fakeFetch(mode: () => Mode, seen: Seen): typeof fetch {
  return (async (url: any, init: any) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (u.startsWith("https://inference.baseten.co/")) {
      seen.baseten.push({ url: u, headers: init.headers, body });
      const m = mode();
      if (m === "throw") throw new TypeError("fetch failed");
      if (m === "500") return new Response(JSON.stringify({ error: "overloaded" }), { status: 500 });
      // Told apart by the schema in the system prompt (the schema name is deliberately not in the prompt).
      const isJudge = body.messages.some((x: any) => typeof x.content === "string" && x.content.includes("banned_topic"));
      const isVerify = !isJudge && JSON.stringify(body.messages).includes("evidence");
      const answer = isJudge ? { spam: 0, injection: 0, quality: 0.9, banned_topic: 0, reason: "useful" } : isVerify ? verdict : skill;
      const content = m === "bad_json" ? "I think it worked" : m === "bad_schema" ? JSON.stringify({ success: "yes" }) : m === "length" ? null : "```json\n" + JSON.stringify(answer) + "\n```";
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: m === "length" ? "length" : "stop" }], usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000, completion_tokens_details: { reasoning_tokens: 50 } } }), { status: 200 });
    }
    if (u.endsWith("/chat/completions")) { // Muse Spark judge (chat completions)
      seen.meta.push({ kind: "judge", body });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ spam: 0, injection: 0, quality: 0.5, banned_topic: 0, reason: "spark" }) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
    }
    const kind = init?.headers?.["x-muse-kind"];
    seen.meta.push({ kind, body });
    const text = JSON.stringify(kind === "verify" ? verdict : skill);
    return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 3000, output_tokens: 600 } }), { status: 200 });
  }) as typeof fetch;
}

const nodes: TestNode[] = [];
async function node(cfg: Record<string, unknown>, mode: () => Mode = () => "ok") {
  const seen: Seen = { meta: [], baseten: [] };
  // The Spark/Glimmer judge providers use the global fetch: mock it too, so nothing leaves the box.
  vi.stubGlobal("fetch", fakeFetch(mode, seen));
  const n = await makeNode({ offline: false, embedProvider: "hash", metaApiKey: "test-key", skillsOperatorToken: TOKEN, skillsInternalSecret: SECRET, museDailyCallCap: 50, museSpendCapUsd: 1, llmDailyCallCap: 50, ...cfg } as any, { fetchImpl: fakeFetch(mode, seen) });
  nodes.push(n);
  const op = { "x-skills-token": TOKEN };
  const upload = async () => (await (await n.app.request("/v1/artifacts", { method: "POST", headers: { "content-type": "image/jpeg", ...op }, body: Buffer.from([0xff, 0xd8, 1, 2, Math.random() * 255]) as unknown as BodyInit })).json() as any).sha256 as string;
  const record = async () => n.req("POST", "/v1/skills/record", { frames: [await upload()], start_url: "https://agentboard.test/demo/helpdesk/" }, op);
  const verify = async (body: any = verifyBody, kind = "verify") => n.req("POST", "/internal/muse/responses", body, { "x-skills-secret": SECRET, "x-muse-kind": kind });
  return { n, seen, record, verify };
}
const ON = { openWeightEnabled: true, basetenApiKey: FAKE_BASETEN_KEY };

afterEach(async () => { vi.unstubAllGlobals(); while (nodes.length) await nodes.pop()!.ctx.db.close(); });

describe("open-weight config (default off)", () => {
  it("is off by default, with the documented defaults, and needs both the switch and a key", () => {
    const c = loadConfig({});
    expect(c.openWeightEnabled).toBe(false);
    expect(c.basetenApiKey).toBeUndefined();
    expect(c.openWeightModel).toBe(OPEN);
    expect(c.basetenBaseUrl).toBe("https://inference.baseten.co/v1");
    expect(c.openWeightTasks).toEqual(["judge", "verify", "skill_write"]);
    expect(openWeightActive(c)).toBe(false);
    expect(openWeightActive(loadConfig({ LLM_OPEN_WEIGHT_ENABLED: "true" }))).toBe(false); // no key
    expect(openWeightActive(loadConfig({ BASETEN_API_KEY: FAKE_BASETEN_KEY }))).toBe(false); // switch off
    const on = loadConfig({ LLM_OPEN_WEIGHT_ENABLED: "true", BASETEN_API_KEY: FAKE_BASETEN_KEY, OPEN_WEIGHT_TASKS: "judge, verify" });
    expect(openWeightActive(on, "judge")).toBe(true);
    expect(openWeightActive(on, "skill_write")).toBe(false);
    expect(openWeightActive({ ...on, offline: true }, "judge")).toBe(false);
  });
  it("parses the task selector and refuses contributor models", () => {
    expect(parseOpenWeightTasks("verify,bogus,VERIFY")).toEqual(["verify"]);
    expect(parseOpenWeightTasks("")).toEqual(["judge", "verify", "skill_write"]);
    expect(() => loadConfig({ OPEN_WEIGHT_MODEL: "meta-models/muse-spark-open-contributor" })).toThrow(/contributor/);
  });
  it("the status summary never contains the key", () => {
    const s = JSON.stringify(openWeightSummary(loadConfig({ LLM_OPEN_WEIGHT_ENABLED: "1", BASETEN_API_KEY: FAKE_BASETEN_KEY })));
    expect(s).not.toContain(FAKE_BASETEN_KEY);
    expect(JSON.parse(s)).toMatchObject({ active: true, key_configured: true, tasks: ["judge", "verify", "skill_write"], image_input: true });
  });
});

describe("open-weight routing (mocked Baseten)", () => {
  it("default off: drafts, verifies and judges go to Muse Spark exactly as before; Baseten is never called", async () => {
    const { n, seen, record, verify } = await node({});
    const d = await record();
    expect(d.status).toBe(201);
    expect(d.body.model).toBe("muse-spark-1.3");
    expect((await verify()).body.model).toBe("muse-spark-1.3");
    expect(n.ctx.llms.open).toBeUndefined();
    expect(seen.baseten).toHaveLength(0);
    const h = (await n.req("GET", "/healthz")).body;
    expect(h.open_weight).toMatchObject({ enabled: false, active: false, key_configured: false, tasks: [], model: OPEN, spend: { total_calls: 0 } });
    expect(h.muse_spend.total_calls).toBe(2);
  });

  it("switch on but no key: identical to off", async () => {
    const { seen, record } = await node({ openWeightEnabled: true });
    expect((await record()).body.model).toBe("muse-spark-1.3");
    expect(seen.baseten).toHaveLength(0);
  });

  it("routes skill drafting and verify to Muse Spark Open, labels the model, and accounts usage apart from Meta", async () => {
    const { n, seen, record, verify } = await node(ON);
    const d = await record();
    expect(d.status).toBe(201);
    expect(d.body.model).toBe(OPEN);
    expect(d.body.usage.provider).toBe("baseten");
    expect((await n.req("GET", `/v1/skills/drafts/${d.body.id}`)).body.model).toBe(OPEN);
    const call = seen.baseten[0];
    expect(call.url).toBe("https://inference.baseten.co/v1/chat/completions");
    expect(call.headers.authorization).toBe(`Bearer ${FAKE_BASETEN_KEY}`);
    expect(call.body.model).toBe(OPEN);
    expect(call.body.max_tokens).toBe(1500); // record ceiling
    expect(call.body.response_format).toBeUndefined(); // not supported for this model on Baseten: schema is in the prompt
    expect(call.body.messages[1].content.some((p: any) => p.type === "image_url")).toBe(true);
    const v = await verify();
    expect(v.body.model).toBe(OPEN);
    expect(JSON.parse(v.body.response.output[0].content[0].text)).toEqual(verdict);
    expect(seen.baseten[1].body.max_tokens).toBe(600); // verify ceiling
    expect(seen.meta).toHaveLength(0);
    const h = (await n.req("GET", "/healthz")).body;
    expect(h.open_weight).toMatchObject({ enabled: true, active: true, tasks: ["judge", "verify", "skill_write"] });
    expect(h.open_weight.spend.total_calls).toBe(2);
    // $1.25/M input + $4.25/M output: 1M in + 100k out = $1.675 per call
    expect(h.open_weight.spend.total_usd).toBeCloseTo(3.35, 6);
    expect(h.muse_spend).toMatchObject({ total_calls: 0, total_usd: 0 }); // Meta spend untouched
    expect(JSON.stringify(h)).not.toContain(FAKE_BASETEN_KEY);
  });

  it("computer-use (loop) calls always stay on Muse Spark", async () => {
    const { seen, verify } = await node(ON);
    const r = await verify({ input: "x", tools: [{ type: "computer" }], max_output_tokens: 800 }, "loop");
    expect(r.body.model).toBe("muse-spark-1.3");
    expect(seen.baseten).toHaveLength(0);
  });

  it("respects the per-task selector", async () => {
    const { seen, record, verify } = await node({ ...ON, openWeightTasks: ["verify"] });
    expect((await record()).body.model).toBe("muse-spark-1.3");
    expect((await verify()).body.model).toBe(OPEN);
    expect(seen.baseten).toHaveLength(1);
  });

  for (const mode of ["500", "length", "bad_json", "bad_schema", "throw"] as const) {
    it(`falls back to Muse Spark when Baseten ${mode}`, async () => {
      const { seen, verify, record } = await node(ON, () => mode);
      expect((await verify()).body.model).toBe("muse-spark-1.3");
      expect((await record()).body.model).toBe("muse-spark-1.3");
      expect(seen.baseten).toHaveLength(2);
      expect(seen.meta.map((m) => m.kind)).toEqual(["verify", "record"]);
    });
  }

  it("stops calling Baseten at the open-weight spend ceiling and falls back", async () => {
    const { seen, verify } = await node({ ...ON, openWeightSpendCapUsd: 1 });
    expect((await verify()).body.model).toBe(OPEN); // costs $1.675
    expect((await verify()).body.model).toBe("muse-spark-1.3");
    expect(seen.baseten).toHaveLength(1);
  });

  it("judge: the open-weight judge runs first and is labelled; on error the Spark judge takes over", async () => {
    const ok = await node(ON);
    const v = await ok.n.ctx.judge.judge({ kind: "post", title: "How to pin pnpm", body: "Use packageManager in package.json with the exact version; corepack picks it up." });
    expect(v.model).toBe(`muse-open:${OPEN}+heuristic-v1`);
    expect(ok.seen.meta).toHaveLength(0);
    const bad = await node(ON, () => "500");
    const w = await bad.n.ctx.judge.judge({ kind: "post", title: "How to pin pnpm", body: "Use packageManager in package.json with the exact version; corepack picks it up." });
    expect(w.model).toBe("muse-spark:muse-spark-1.3+heuristic-v1");
    expect(bad.seen.baseten).toHaveLength(1);
  });
});

describe("open-weight helpers", () => {
  it("translates Responses bodies (text, image, video) and refuses tool calls", () => {
    const c = responsesToChat({ instructions: "be brief", text: { format: { type: "json_schema", name: "skill", schema: VERIFY_SCHEMA } }, input: [{ role: "user", content: [{ type: "input_text", text: "t" }, { type: "input_video", video_url: "https://x/v.mp4" }] }] })!;
    expect(c.messages[0]).toEqual({ role: "system", content: "be brief" });
    expect(c.messages[1].content[1]).toEqual({ type: "video_url", video_url: { url: "https://x/v.mp4" } });
    expect(responsesToChat({ ...verifyBody, tools: [{ type: "computer" }] })).toBeNull();
    expect(responsesToChat({ input: "x" })).toBeNull();
  });
  it("checks answers against the flat schema and extracts fenced JSON", () => {
    expect(matchesSchema(verdict, VERIFY_SCHEMA)).toBe(true);
    expect(matchesSchema({ success: true }, VERIFY_SCHEMA)).toBe(false);
    expect(matchesSchema({ ...verdict, extra: 1 }, VERIFY_SCHEMA)).toBe(false);
    expect(extractJson('Sure:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(openCostOf({ prompt_tokens: 2_000_000, completion_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 1_000_000 } }).usd).toBeCloseTo(1.25 + 0.15 + 4.25, 6);
  });
  it("unwraps an answer wrapped in its schema name ({\"skill\": {...}}), and only then", () => {
    const schema = { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } } };
    expect(unwrapAnswer({ skill: { a: "x" } }, "skill", schema)).toEqual({ a: "x" });
    expect(unwrapAnswer({ a: "x" }, "skill", schema)).toEqual({ a: "x" });
    expect(unwrapAnswer({ other: { a: "x" } }, "skill", schema)).toEqual({ other: { a: "x" } });
    expect(unwrapAnswer({ skill: { b: 1 } }, "skill", schema)).toEqual({ skill: { b: 1 } });
  });
});
