/**
 * Reuse benchmark end to end on PGlite: the harness (scripts/bench-reuse.ts) against the API, with a fake executor and
 * a fake Muse. Nothing here reaches api.meta.ai, inference.baseten.co or the real executor.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, verifyRecord } from "@agentboard/core";
import { makeNode, type TestNode } from "./helpers.js";
import { mountRemoteMcp } from "../src/mcpRemote.js";
import { runBenchmark, ESTIMATE } from "../../../scripts/bench-reuse.js";
import { BENCH, headlineOf } from "../src/services/benchmark.js";
import { signRequest } from "../src/requestAuth.js";
import { sha256Hex } from "@agentboard/core";

const TOKEN = "test-".repeat(6), SECRET = "fake-".repeat(6); // fake test values
const op = { "x-skills-token": TOKEN }, ex = { "x-skills-secret": SECRET };
const API = "http://agentboard.test", EXEC = "https://exec.test";
const WIKI = {
  name: "Read a Wikipedia infobox fact", summary: "Search Wikipedia for a place and read a field from its infobox.", start_url_hint: "https://en.wikipedia.org/wiki/Special:Search",
  params: [{ name: "place", description: "place name", example: "Mount Everest" }, { name: "infobox_field", description: "field", example: "Elevation" }],
  steps: [{ intent: "search for the place", target: "search box", action: "type", value: "{{place}}" }, { intent: "open the article", target: "first result", action: "click", value: "" }],
  success_check: "the {{place}} article's infobox shows {{infobox_field}}", risk_flags: ["none"],
};
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(String(Math.random()))]).toString("base64");

let node: TestNode;
const museCalls: string[] = [];
let busy = false;
/** Fake executor jobs still running; afterAll waits for them so none touches the database after it is closed. */
const inflight = new Set<Promise<unknown>>();
// Fake Muse (Responses API) and the executor's /jobs dispatch, for the node's own outbound calls.
const nodeFetch: typeof fetch = async (url, init) => {
  const u = String(url);
  if (u.endsWith("/jobs")) { const { job_id } = JSON.parse(String(init?.body)); setTimeout(() => { const p = fakeJob(job_id).catch(() => {}); inflight.add(p); void p.finally(() => inflight.delete(p)); }, 5); return new Response("{}", { status: 202 }); }
  museCalls.push((init?.headers as any)?.["x-muse-kind"] ?? "record");
  return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(WIKI) }] }], usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 100 } }), { status: 200 });
};
const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => node.req(method, path, body, headers);

/** What the executor does for a run: N loop turns + 1 verify through the guarded Muse route, then posts the run. */
async function fakeRun(target: Record<string, string>, params: Record<string, string>, start_url: string, turns: number, success = true) {
  const usage = { calls: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0, usd: 0 };
  for (let i = 0; i <= turns; i++) {
    const r = await req("POST", "/internal/muse/responses", { input: [{ role: "user", content: [{ type: "input_text", text: "turn" }] }] }, { ...ex, "x-muse-kind": i < turns ? "loop" : "verify" });
    expect(r.status).toBe(200);
    usage.calls++; usage.input_tokens += r.body.usage.input_tokens; usage.output_tokens += r.body.usage.output_tokens; usage.usd += r.body.usage.usd;
  }
  const run = await req("POST", "/internal/skills/runs", {
    ...target, start_url, params, success,
    verdict: { success, evidence: `infobox shows ${params.infobox_field}`, model: "muse-spark-1.3", capability: "image understanding + structured output" },
    turns, actions: [{ turn: 1, type: "type", detail: `type "${params.place}"`, approval: "auto", checks: [], target: "search box" }, { turn: 1, type: "click", detail: "click", approval: "auto", checks: [], target: "first result" }],
    usage, model: "muse-spark-1.3", final_jpeg_b64: jpeg(), executor: { name: "fake-executor", chromium: "none", viewport: "960x600" }, duration_ms: 1000 * turns,
  }, ex);
  expect(run.status).toBe(201);
  return { ...run.body, usage, turns, verdict: { success } };
}
async function fakeJob(id: string) {
  busy = true;
  try {
    const job = (await req("GET", `/internal/skills/jobs/${id}`, undefined, ex)).body;
    const result = await fakeRun({ skill_cid: job.skill_cid, job_id: id }, job.params, job.start_url, 1);
    await req("POST", `/internal/skills/jobs/${id}/events`, { status: "completed", result }, ex);
  } finally { busy = false; }
}
/** The harness's view of the world: the API in-process, and the executor's /healthz. */
const harnessFetch = (async (url: any, init?: any) => {
  const u = String(url instanceof Request ? url.url : url);
  if (u.startsWith(EXEC)) return new Response(JSON.stringify({ ok: true, busy }), { status: 200 });
  return node.app.fetch(url instanceof Request ? url : new Request(u, init));
}) as typeof fetch;
const runCold = async (a: { draft_id: string; params: Record<string, string>; start_url: string; token: string }) => {
  expect(a.token).toBe(TOKEN);
  const d = (await req("GET", `/v1/skills/drafts/${a.draft_id}`)).body;
  // the cold task carries no recorded steps
  expect(d.skill.steps).toEqual([]);
  expect(d.skill.success_check).toBe(WIKI.success_check);
  return fakeRun({ draft_id: a.draft_id }, a.params, a.start_url, 5);
};
const opts = (o: Partial<Parameters<typeof runBenchmark>[0]> = {}) => ({ api: API, executor: "wss://exec.test", token: TOKEN, skill: "wikipedia-infobox-fact", input: "Mount Kilimanjaro", fetch: harnessFetch, runCold, log: () => {}, pollMs: 20, ...o });

beforeAll(async () => {
  node = await makeNode({ offline: false, embedProvider: "hash", metaApiKey: "test-key", skillsOperatorToken: TOKEN, skillsInternalSecret: SECRET, museDailyCallCap: 200, museSpendCapUsd: 4,
    skillsWebUrl: "https://web.test", skillsExecutorUrl: EXEC }, { fetchImpl: nodeFetch });
  mountRemoteMcp(node.app, node.ctx);
  // publish the skill the usual way: record (fake Muse) + a verified publishing run
  const sha = (await (await node.app.request("/v1/artifacts", { method: "POST", headers: { "content-type": "image/jpeg", ...op }, body: Buffer.from(jpeg(), "base64") as unknown as BodyInit })).json() as any).sha256;
  const d = await req("POST", "/v1/skills/record", { frames: [sha], start_url: WIKI.start_url_hint, parent_slug: "wikipedia-infobox-fact" }, op);
  expect(d.status).toBe(201);
  const pub = await fakeRun({ draft_id: d.body.id }, { place: "Mount Everest", infobox_field: "Elevation" }, WIKI.start_url_hint, 3);
  expect(pub.status).toBe("published");
});
afterAll(async () => {
  for (let i = 0; i < 50 && inflight.size; i++) await Promise.allSettled([...inflight, new Promise((r) => setTimeout(r, 20))]);
  await node?.ctx.db.close();
});

describe("reuse benchmark", () => {
  it("shows nothing before a benchmark exists", async () => {
    expect((await req("GET", "/v1/benchmarks/latest")).status).toBe(204);
    expect((await req("GET", "/v1/benchmarks")).body.benchmarks).toEqual([]);
    expect(String((await req("GET", "/site/llms.txt")).body)).not.toMatch(/Reuse benchmark/);
  });

  it("dry run is read-only: spend check, params, find_skill; no writes or model calls", async () => {
    const before = museCalls.length;
    const r: any = await runBenchmark(opts({ dryRun: true }));
    expect(r.dry_run).toBe(true);
    expect(r.params).toEqual({ place: "Mount Kilimanjaro", infobox_field: "Elevation" });
    expect(r.find).toMatchObject({ tool: "find_skill", rank: 1, model_calls: 0 });
    expect(museCalls.length).toBe(before);
    expect((await node.ctx.db.query(`SELECT count(*)::int AS n FROM benchmarks`)).rows[0]).toEqual({ n: 0 });
  });

  it("refuses to start when lifetime spend + estimate would pass $3.50", async () => {
    await node.ctx.db.query(`INSERT INTO muse_spend (day, kind, calls, cost_micro) VALUES ('2020-01-01', 'loop', 1, $1)`, [Math.round((BENCH.spendLimitUsd - ESTIMATE.usd + 0.01) * 1e6)]);
    try {
      const before = museCalls.length;
      await expect(runBenchmark(opts())).rejects.toThrow(/refused: lifetime Muse spend/);
      expect(museCalls.length).toBe(before);
      // the node refuses on its own too
      const r = await req("POST", "/v1/operator/benchmarks", { skill: "wikipedia-infobox-fact", agent_a: generateKeyPair().did, agent_b: generateKeyPair().did }, op);
      expect(r.status).toBe(429);
      expect(r.body.error).toBe("bench_spend_limit");
    } finally { await node.ctx.db.query(`DELETE FROM muse_spend WHERE day = '2020-01-01'`); }
  });

  it("runs one cold run and one replay with two identities and signs the comparison", async () => {
    const before = museCalls.length;
    const replaysBefore = (await req("GET", "/v1/skills/metrics")).body.replays?.total ?? 0;
    const skillsBefore = (await req("GET", "/v1/skills")).body.skills.length;
    const keys = { a: generateKeyPair(), b: generateKeyPair() };
    const out: any = await runBenchmark(opts({ keys }));
    // exactly 6 cold calls (5 turns + verify) and 2 replay calls (1 turn + verify)
    expect(museCalls.length - before).toBe(8);
    expect(verifyRecord(out.record).ok).toBe(true);
    expect(out.record.type).toBe("benchmark");
    expect(out.record.author).toBe(node.ctx.node.did);
    const b = out.record.body;
    expect(b.agents.a).toMatchObject({ did: keys.a.did, role: "cold", skill_lookup: false, client: "agentboard-bench/agent-a-cold" });
    expect(b.agents.b).toMatchObject({ did: keys.b.did, role: "reuse", skill_lookup: true, client: "agentboard-bench/agent-b-reuse" });
    expect(b.input).toEqual({ place: "Mount Kilimanjaro", infobox_field: "Elevation" });
    expect(b.runs.cold).toMatchObject({ type: "benchmark_run", model_calls: 6, input_tokens: 12000, output_tokens: 600, success: true });
    expect(b.runs.reuse).toMatchObject({ type: "skill_run", model_calls: 2, input_tokens: 4000, output_tokens: 200, success: true });
    expect(b.comparison.usd_ratio).toBe(3);
    expect(b.comparison.model_calls_ratio).toBe(3);
    expect(b.comparison.both_verified).toBe(true);
    expect(b.comparison.recording_one_time_usd).toBeGreaterThan(0);
    expect(b.comparison.reuses_to_pay_back_recording).toBeGreaterThanOrEqual(1);
    expect(b.runs.cold.client.muse_spend_delta_calls).toBe(6);
    expect(b.runs.reuse.client.muse_spend_delta_calls).toBe(2);
    expect(b.runs.cold.client.muse_spend_delta_usd).toBeCloseTo(b.runs.cold.usd, 6);
    expect(b.find_skill).toMatchObject({ rank: 1, model_calls: 0 });
    expect(b.method.model_call).toMatch(/computer-use turn/);
    expect(out.headline).toBe(headlineOf(b));
    expect(out.headline).toMatch(/reusing the wikipedia-infobox-fact skill took 2 model calls \(\$0\.\d{4}\); doing it cold took 6 model calls \(\$0\.\d{4}\), 3x the cost\. Both runs verified\./);
    // both run records are in the log and verify; the cold run has its own evidence endpoint
    const cold = (await req("GET", `/v1/records/${b.runs.cold.record}`)).body;
    expect(verifyRecord(cold.record ?? cold).ok).toBe(true);
    const coldDetail = (await req("GET", `/v1/benchmarks/runs/${b.runs.cold.record}`)).body;
    expect(coldDetail).toMatchObject({ role: "cold", agent: keys.a.did, success: true });
    const reuseRun = (await req("GET", `/v1/skills/runs/${b.runs.reuse.record}`)).body;
    expect(reuseRun).toMatchObject({ kind: "replay", trigger: "benchmark", agent: keys.b.did, new_inputs: true });
    const reuseList = (await req("GET", "/v1/skills/reuse?skill=wikipedia-infobox-fact")).body;
    expect(reuseList.runs.find((r: any) => r.run === b.runs.reuse.record)).toMatchObject({ via: "benchmark", kind: "replay", agent: { did: keys.b.did } });
    // the cold run published nothing and is not a replay; B's replay is one
    expect((await req("GET", "/v1/skills")).body.skills.length).toBe(skillsBefore);
    expect((await req("GET", "/v1/skills/metrics")).body.replays.total).toBe(replaysBefore + 1);
    // public reads: list, latest, by id, llms.txt
    expect((await req("GET", "/v1/benchmarks/latest")).body.cid).toBe(out.cid);
    expect((await req("GET", `/v1/benchmarks/${out.id}`)).body.cold_run.role).toBe("cold");
    expect((await req("GET", "/v1/benchmarks")).body.benchmarks[0].headline).toBe(out.headline);
    const llms = String((await req("GET", "/site/llms.txt")).body);
    expect(llms).toContain(out.headline);
    expect(llms).toContain("https://web.test/benchmark");
    expect(String((await req("GET", "/llms.txt")).body)).toContain(out.headline);
    // governance replay still re-derives every node-signed governance record
    expect((await req("GET", "/v1/governance")).status).toBe(200);
  });

  it("at most one cold run and one replay per benchmark, each requested by its own agent", async () => {
    const a = generateKeyPair(), b = generateKeyPair();
    const open = await req("POST", "/v1/operator/benchmarks", { skill: "wikipedia-infobox-fact", params: { place: "Kilimanjaro", infobox_field: "Elevation" }, agent_a: a.did, agent_b: b.did }, op);
    expect(open.status).toBe(201);
    const post = (kp: typeof a, path: string, payload: unknown, headers = op) => {
      const raw = JSON.stringify(payload); const p = `${path}?h=${sha256Hex(new TextEncoder().encode(raw))}`;
      return Promise.resolve(node.app.request(p, { method: "POST", headers: { "content-type": "application/json", ...headers, authorization: signRequest(kp, "POST", p) }, body: raw })).then(async (r: Response) => ({ status: r.status, body: await r.json() as any }));
    };
    const base = `/v1/operator/benchmarks/${open.body.id}`;
    expect((await post(b, `${base}/cold`, {})).status).toBe(403); // B can't start A's cold run
    expect((await post(a, `${base}/cold`, {}, {} as any)).status).toBe(401); // needs the operator token too
    const first = await post(a, `${base}/cold`, {});
    expect(first.status).toBe(201);
    expect((await post(a, `${base}/cold`, {})).body.error).toBe("cold_run_exists");
    expect((await post(a, `${base}/reuse`, { skill: "wikipedia-infobox-fact" })).status).toBe(403);
    const r1 = await post(b, `${base}/reuse`, { skill: "wikipedia-infobox-fact" });
    expect(r1.status).toBe(202);
    expect((await post(b, `${base}/reuse`, { skill: "wikipedia-infobox-fact" })).body.error).toBe("reuse_run_exists");
    // finalize waits for both signed run records
    expect((await req("POST", `${base}/finalize`, {}, op)).body.error).toBe("cold_run_missing");
    // the same identities can't be reused for another benchmark
    expect((await req("POST", "/v1/operator/benchmarks", { skill: "wikipedia-infobox-fact", agent_a: a.did, agent_b: generateKeyPair().did }, op)).body.error).toBe("agents_reused");
    expect((await req("POST", "/v1/operator/benchmarks", { skill: "wikipedia-infobox-fact", agent_a: a.did, agent_b: a.did }, op)).status).toBe(400);
    expect((await req("POST", "/v1/operator/benchmarks", { skill: "wikipedia-infobox-fact", agent_a: generateKeyPair().did, agent_b: generateKeyPair().did })).status).toBe(401);
    await new Promise((r) => setTimeout(r, 200)); // let the fake replay job finish
  });
  it("an unverified benchmark is kept in the list, labeled, but never becomes the headline", async () => {
    const verified = (await req("GET", "/v1/benchmarks/latest")).body;
    expect(verified.verified).toBe(true);
    const out: any = await runBenchmark(opts({ input: "Reykjavik", runCold: async (a: any) => fakeRun({ draft_id: a.draft_id }, a.params, a.start_url, 5, false) }));
    expect(out.record.body.comparison.both_verified).toBe(false);
    const list = (await req("GET", "/v1/benchmarks")).body.benchmarks;
    expect(list[0]).toMatchObject({ cid: out.cid, verified: false });
    expect((await req("GET", "/v1/benchmarks/latest")).body.cid).toBe(verified.cid);
    expect((await req("GET", "/v1/benchmarks/latest?any=1")).body.cid).toBe(out.cid);
    expect(String((await req("GET", "/site/llms.txt")).body)).not.toContain(out.cid);
  });
});
