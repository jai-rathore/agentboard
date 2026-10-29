/**
 * Reuse benchmark: the same non-sensitive task, done by two different agents (fresh did:key identities, separate
 * clients) on the same executor, model and input.
 *   - Agent A (cold): gets only the task statement (the skill's name, summary and success check, the start URL and
 *     the input). No skill lookup, no recorded steps: the model drives the browser and works the task out itself.
 *   - Agent B (reuse): calls find_skill, finds the published skill, and replays it on the same input.
 * Both runs go through the guarded Muse path, so every model call is counted in muse_spend and in each run's usage.
 * The comparison is published as a node-signed `benchmark` record that links the cold run (`benchmark_run`) and the
 * replay (`skill_run`). Operator-only to start (it spends Muse credits); every read is public and calls no model.
 * At most one cold run and one replay per benchmark, enforced here; the harness (scripts/bench-reuse.ts) opens one
 * benchmark per invocation and refuses to start when lifetime Muse spend plus its estimate would pass the limit.
 */
import { createRecord, isDidKey, type SignedRecord } from "@agentboard/core";
import type { AppContext } from "../context.js";
import { HttpError } from "../context.js";
import { appendToLog } from "./log.js";
import { museHeadroom } from "./muse.js";
import { resolveSkill, checkParams, createJob, dispatchJob, getJob } from "./skillJobs.js";
import { artifactUrl, putArtifact, type RunInput } from "./skills.js";
import { siteKind, SITE_LABEL } from "./skillMetrics.js";

/** Worst case per run: 15 loop turns + 1 verify (+1 heal on a replay), each output-capped; measured runs cost $0.004-0.065. */
export const BENCH = {
  /** Lifetime Muse spend (USD) the benchmark may never pass, kept under the node's $4.00 lifetime cap. */
  spendLimitUsd: 3.5,
  /** Estimate for one benchmark (one cold run + one replay). */
  estimateUsd: 0.3,
  estimateCalls: 34,
  /** Headroom needed to start one run. */
  runUsd: 0.15,
  runCalls: 17,
};

const j = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const lifetimeUsd = async (db: AppContext["db"]) => Number((await db.query<any>(`SELECT COALESCE(SUM(cost_micro),0)::float8 AS c FROM muse_spend WHERE kind NOT LIKE 'open:%'`)).rows[0]?.c ?? 0) / 1e6;

export const METHOD = {
  same_input: "Both agents get the same skill input (params) and the same start URL, on the same executor (headless Chromium, 960x600), the same model (Muse Spark, Standard mode, through the node's guarded, metered Muse path) and the same 15-turn limit.",
  identities: "Two fresh Ed25519 did:key identities, generated for this benchmark only, each using its own client. Agent A signs the request for the cold run; Agent B signs the request for the replay. The node operator funds both runs (new identities cannot spend run credits during probation).",
  agent_a: "Cold: no skill lookup and no recorded steps. Agent A gets the task statement only (the skill's name, summary and success check, filled with the input) and drives the browser itself with the computer tool.",
  agent_b: "Reuse: Agent B calls find_skill on the public MCP endpoint (keyword search over published skills; no model call), takes the matching skill and replays it on the same input. When the skill has a recorded action trace (from an earlier verified run), the executor replays that trace directly in the browser with no model calls and checks the final page deterministically; if a step no longer matches the site, the model takes over from that step (and the recovered trace becomes the next version). Skills without a trace are replayed by the model with the recorded steps as hints.",
  model_call: "A model call is one Muse Responses API request made for the run: each computer-use turn (screenshot in, actions out), the final verification of the screenshot against the success check, and on a replay any self-heal call. A deterministic trace replay makes none; a deterministic final check makes none (otherwise the open-weight verifier is called once). find_skill, the local embedding model and the executor itself make no paid model calls.",
  cost: "USD at Muse Spark list price (Standard: $1.25 per 1M input tokens, $0.15 cached, $4.25 per 1M output), the same accounting as the node's lifetime Muse spend ledger (GET /v1/muse/spend). The harness also records the ledger's change around each run as a cross-check.",
  time: "executor_ms is measured by the executor from browser launch to the end of verification. wall_ms is measured by the harness from the start request to the result, so it also includes queueing and executor wake-up.",
  not_counted: "The one-time cost of recording the skill (the recorder's Muse call and the publishing run) is not part of Agent B's run; it is shown separately with the number of reuses that pay it back.",
};

export interface BenchOpen { skill: string; params?: Record<string, unknown>; agent_a: string; agent_b: string; find?: Record<string, unknown> }

/** Refuse to start when lifetime Muse spend plus `needUsd` would pass the benchmark limit (and the node's own guards). */
export async function benchHeadroom(ctx: AppContext, needUsd: number, needCalls: number) {
  const total = await lifetimeUsd(ctx.db);
  const limit = Math.min(BENCH.spendLimitUsd, ctx.cfg.museSpendCapUsd);
  if (total + needUsd > limit) throw new HttpError(429, "bench_spend_limit", `benchmark refused: lifetime Muse spend $${total.toFixed(4)} + estimate $${needUsd.toFixed(2)} would pass $${limit.toFixed(2)}`);
  return museHeadroom(ctx, needCalls, needUsd);
}

export async function openBenchmark(ctx: AppContext, b: BenchOpen) {
  if (!isDidKey(b.agent_a) || !isDidKey(b.agent_b)) throw new HttpError(400, "agents", "agent_a and agent_b must be Ed25519 did:key identities");
  if (b.agent_a === b.agent_b) throw new HttpError(400, "agents", "agent_a and agent_b must be different identities");
  const used = (await ctx.db.query<any>(`SELECT 1 FROM benchmarks WHERE agent_a = ANY($1) OR agent_b = ANY($1) LIMIT 1`, [[b.agent_a, b.agent_b]])).rows[0];
  if (used) throw new HttpError(409, "agents_reused", "benchmark identities must be fresh: one of these already took part in a benchmark");
  await benchHeadroom(ctx, BENCH.estimateUsd, BENCH.estimateCalls);
  const { cid, body } = await resolveSkill(ctx, b.skill);
  const params = checkParams(body.skill, b.params);
  const id = crypto.randomUUID();
  await ctx.db.query(`INSERT INTO benchmarks (id, skill_slug, skill_cid, params, start_url, agent_a, agent_b, find) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, body.slug, cid, JSON.stringify(params), body.source.start_url, b.agent_a, b.agent_b, b.find ? JSON.stringify(b.find).slice(0, 8000) : null]);
  return { id, skill: { slug: body.slug, cid, version: body.version, name: body.skill.name }, params, start_url: body.source.start_url, agent_a: b.agent_a, agent_b: b.agent_b, estimate_usd: BENCH.estimateUsd };
}

async function row(ctx: AppContext, id: string) {
  const r = (await ctx.db.query<any>(`SELECT * FROM benchmarks WHERE id = $1`, [id])).rows[0];
  if (!r) throw new HttpError(404, "benchmark_not_found", "no such benchmark");
  return { ...r, params: j(r.params), find: j(r.find) };
}

/** The task statement Agent A gets: the skill's name, summary and success check, and no recorded steps. */
export function coldTask(skill: any) {
  return {
    name: skill.name,
    summary: `${skill.summary} No recorded steps are given: work out how to do it on the site yourself.`.slice(0, 1000),
    start_url_hint: skill.start_url_hint ?? "",
    params: skill.params,
    steps: [],
    success_check: skill.success_check,
    risk_flags: skill.risk_flags ?? ["none"],
  };
}

/** Agent A (signed request) starts the cold run: a task-only draft the executor drives with no recorded steps. */
export async function startColdRun(ctx: AppContext, id: string, did: string) {
  const b = await row(ctx, id);
  if (did !== b.agent_a) throw new HttpError(403, "not_agent_a", "the cold run must be requested by this benchmark's agent A");
  if (b.status !== "open") throw new HttpError(409, "benchmark_closed", `this benchmark is ${b.status}`);
  await benchHeadroom(ctx, BENCH.runUsd, BENCH.runCalls);
  const skillBody = JSON.parse((await ctx.db.query<any>(`SELECT body_text FROM records WHERE cid = $1`, [b.skill_cid])).rows[0].body_text);
  const draftId = crypto.randomUUID();
  const claimed = await ctx.db.query<any>(`UPDATE benchmarks SET cold_draft_id = $2, updated_at = now() WHERE id = $1 AND cold_draft_id IS NULL RETURNING id`, [id, draftId]);
  if (!claimed.rows.length) throw new HttpError(409, "cold_run_exists", "this benchmark already has its one cold run");
  const source = { video: null, frames: [], start_url: b.start_url, hint: "reuse benchmark: cold run (task statement only)", benchmark: id, agent: did };
  await ctx.db.query(`INSERT INTO skill_drafts (id, status, source, skill, reasoning_summary, model, capability, usage, parent_slug) VALUES ($1,'bench_cold',$2,$3,NULL,'none','task statement only (no recording, no skill)',$4,NULL)`,
    [draftId, JSON.stringify(source), JSON.stringify(coldTask(skillBody.skill)), JSON.stringify({ input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, usd: 0 })]);
  return { benchmark: id, draft_id: draftId, params: b.params, start_url: b.start_url, executor: "open the executor WebSocket with {type: 'start', token, draft_id, params, start_url}" };
}

/** Agent B (signed request) starts the replay of the skill it found, on the same input. Operator-funded job. */
export async function startReuseRun(ctx: AppContext, id: string, did: string, skillRef: string) {
  const b = await row(ctx, id);
  if (did !== b.agent_b) throw new HttpError(403, "not_agent_b", "the replay must be requested by this benchmark's agent B");
  if (b.status !== "open") throw new HttpError(409, "benchmark_closed", `this benchmark is ${b.status}`);
  const { cid, body } = await resolveSkill(ctx, skillRef || b.skill_slug);
  if (body.slug !== b.skill_slug) throw new HttpError(400, "wrong_skill", `this benchmark is for ${b.skill_slug}, not ${body.slug}`);
  await benchHeadroom(ctx, BENCH.runUsd, BENCH.runCalls);
  const job = await ctx.db.tx(async (tx) => {
    const cur = (await tx.query<any>(`SELECT reuse_job_id FROM benchmarks WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (cur?.reuse_job_id) throw new HttpError(409, "reuse_run_exists", "this benchmark already has its one replay");
    const created = await createJob({ ...ctx, db: tx }, { skill: cid, params: b.params, start_url: b.start_url }, { requested_by: did, via: "benchmark" });
    await tx.query(`UPDATE benchmarks SET reuse_job_id = $2, updated_at = now() WHERE id = $1`, [id, created.id]);
    return created;
  });
  await dispatchJob(ctx, job.id);
  return getJob(ctx, job.id);
}

/** Who requested a replay job that belongs to a benchmark (for the signed skill_run record). */
export async function benchmarkForJob(ctx: AppContext, jobId: string): Promise<string | null> {
  return (await ctx.db.query<any>(`SELECT id FROM benchmarks WHERE reuse_job_id = $1`, [jobId])).rows[0]?.id ?? null;
}

/** The executor posts the cold run like any draft run; it is signed as a `benchmark_run` and never publishes a skill. */
export async function submitColdRun(ctx: AppContext, draft: { id: string; source: any; skill: any }, run: RunInput) {
  const b = await row(ctx, draft.source.benchmark);
  if (b.cold_draft_id !== draft.id) throw new HttpError(409, "not_this_benchmark", "draft does not belong to this benchmark");
  if (b.cold_run_cid) throw new HttpError(409, "cold_run_exists", "this benchmark already has its cold run");
  const final = await putArtifact(ctx, Buffer.from(run.final_jpeg_b64, "base64"), "image/jpeg");
  const gif = run.gif_b64 ? await putArtifact(ctx, Buffer.from(run.gif_b64, "base64"), "image/gif") : null;
  const rec = createRecord(ctx.node, "benchmark_run", {
    benchmark: b.id, role: "cold", task_of: { slug: b.skill_slug, skill: b.skill_cid }, task: draft.skill,
    requested_by: { via: "benchmark", agent: b.agent_a },
    params: run.params, start_url: run.start_url, success: run.success, turns: run.turns, duration_ms: run.duration_ms,
    verdict: { success: run.verdict.success, evidence: run.verdict.evidence, model: run.verdict.model, capability: run.verdict.capability },
    loop: { model: run.model === ctx.cfg.openWeightModel ? ctx.cfg.metaModel : run.model, capability: "computer use (built-in computer tool) + image understanding" },
    actions: run.actions, evidence: { final_screenshot: final.sha256, gif: gif?.sha256 ?? null },
    usage: { ...run.usage, usd: round6(run.usage.usd) }, executor: run.executor,
    ...(run.answer ? { answer: run.answer } : {}),
  } as Record<string, unknown>, new Date(ctx.now()));
  const out = await ctx.db.tx(async (tx) => {
    const ok = await tx.query<any>(`UPDATE benchmarks SET cold_run_cid = $2, updated_at = now() WHERE id = $1 AND cold_run_cid IS NULL RETURNING id`, [b.id, rec.cid]);
    if (!ok.rows.length) throw new HttpError(409, "cold_run_exists", "this benchmark already has its cold run");
    const a = await appendToLog(tx, ctx, rec);
    await tx.query(`UPDATE skill_drafts SET status = 'bench_cold_done', runs = runs || $2::jsonb WHERE id = $1`, [draft.id, JSON.stringify([{ run_cid: rec.cid, success: run.success }])]);
    return a;
  });
  ctx.events.dispatchEvent(new CustomEvent("append", { detail: { cid: rec.cid, type: rec.type } }));
  return { status: "benchmark_run_recorded", benchmark: b.id, run_cid: rec.cid, run_seq: out.seq, evidence: { final_screenshot: final.sha256, gif: gif?.sha256 ?? null } };
}

const num = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const ClientRunZ = (x: any) => x && typeof x === "object" ? {
  wall_ms: num(x.wall_ms) || null,
  muse_spend_delta_usd: x.muse_spend_delta_usd == null ? null : round6(num(x.muse_spend_delta_usd)),
  muse_spend_delta_calls: x.muse_spend_delta_calls == null ? null : num(x.muse_spend_delta_calls),
} : { wall_ms: null, muse_spend_delta_usd: null, muse_spend_delta_calls: null };

async function recordBody(ctx: AppContext, cid: string) {
  const r = (await ctx.db.query<any>(`SELECT r.body_text, r.type, l.seq::int AS seq FROM records r JOIN log l ON l.cid = r.cid WHERE r.cid = $1`, [cid])).rows[0];
  return r ? { body: JSON.parse(r.body_text), type: r.type as string, seq: r.seq as number } : null;
}

function metricsOf(body: any, extra?: { calls: number; input_tokens: number; cached_tokens: number; output_tokens: number; usd: number }) {
  const u = body.usage ?? {};
  // A replay's signed usage.usd already includes a self-heal call's USD; its calls and tokens are in the healed record.
  return {
    success: Boolean(body.success), turns: num(body.turns), executor_ms: num(body.duration_ms) || null,
    model_calls: num(u.calls) + (extra?.calls ?? 0),
    input_tokens: num(u.input_tokens) + (extra?.input_tokens ?? 0), cached_tokens: num(u.cached_tokens) + (extra?.cached_tokens ?? 0),
    output_tokens: num(u.output_tokens) + (extra?.output_tokens ?? 0), usd: round6(num(u.usd)),
    approvals: (body.actions ?? []).filter((a: any) => a.approval === "human").length,
    verdict: body.verdict?.evidence ?? null,
    // skill_run only: how the replay ran (trace = deterministic, no model calls; trace+recovery; model = hinted model run)
    ...(body.replay ? { replay_mode: String(body.replay.mode), verifier: String(body.replay.verifier ?? "model") } : {}),
    ...(body.answer?.value != null ? { value: String(body.answer.value) } : {}),
    ...(body.answer?.model_text ? { answer_text: String(body.answer.model_text).slice(0, 400) } : {}),
  };
}

/** A value for comparison: a number's digits ("3,477,497" → "3477497"; "8,848.86 m" → "8848.86"), else lowercased text. */
export function normValue(v: unknown): string | null {
  const t = String(v ?? "").replace(/\[[^\]]*\]/g, "").trim();
  if (!t) return null;
  const ver = t.match(/^v?(\d+\.\d+\.\d+[\w.-]*)/);
  if (ver) return ver[1].toLowerCase();
  const n = t.match(/[-−]?\d[\d,\s]*(?:\.\d+)?/);
  if (n && /\d/.test(t) && n[0].replace(/\D/g, "").length >= 1 && /^[^A-Za-z]*\d/.test(t)) return n[0].replace(/[,\s]/g, "").replace("−", "-");
  return t.toLowerCase().replace(/\s+/g, " ").replace(/[.,;:]+$/, "");
}
/** The number an answer gives first: a bold one ("**3,121,707**"), else the first plain number that is not a year. */
export function primaryNumber(text: string): string | null {
  for (const m of String(text).matchAll(/\*\*([^*]{1,60})\*\*/g)) if (/^[\s$€£~≈]*[-−]?\d[\d,]*(?:\.\d+)?\s*[a-z%²]{0,4}$/i.test(m[1].trim())) return normValue(m[1]);
  for (const m of String(text).matchAll(/\d[\d,]*(?:\.\d+)?/g)) if (!/^(1[5-9]|20)\d\d$/.test(m[0]) && m[0].replace(/\D/g, "").length >= 2) return normValue(m[0]);
  return null;
}
/**
 * Did both agents get the same answer? Compares the two returned values; when the cold run has no extracted value,
 * checks whether the replay's value appears in the cold agent's final answer. null when it cannot be told.
 */
export function valuesMatch(A: { value?: string; answer_text?: string }, B: { value?: string; answer_text?: string }): boolean | null {
  const numeric = (x: string | null) => x != null && /^-?[\d.]+$/.test(x);
  let a = normValue(A.value), b = normValue(B.value);
  // the replay read a number but the cold run's page reading is text (a label): use the number the cold agent answered
  if (numeric(b) && !numeric(a) && A.answer_text) a = primaryNumber(A.answer_text) ?? a;
  if (numeric(a) && !numeric(b) && B.answer_text) b = primaryNumber(B.answer_text) ?? b;
  if (a != null && b != null) return a === b;
  const other = b ?? a, text = b != null ? A.answer_text : B.answer_text;
  if (other == null || !text) return null;
  const numbers = [...String(text).matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, ""));
  return /^[-\d.]+$/.test(other) ? numbers.includes(other) : String(text).toLowerCase().includes(other);
}

/** Sign the comparison once both runs have signed records. Client-side numbers (wall time, ledger deltas) are labeled as such. */
export async function finalizeBenchmark(ctx: AppContext, id: string, client: { cold?: unknown; reuse?: unknown; find?: unknown; harness?: unknown } = {}) {
  const b = await row(ctx, id);
  if (b.record_cid) return getBenchmark(ctx, b.record_cid);
  if (!b.cold_run_cid) throw new HttpError(409, "cold_run_missing", "the cold run has not produced a signed record");
  let reuseCid = b.reuse_run_cid as string | null;
  if (!reuseCid && b.reuse_job_id) {
    const job = await getJob(ctx, b.reuse_job_id);
    reuseCid = job.result?.run_cid ?? null;
  }
  if (!reuseCid) throw new HttpError(409, "reuse_run_missing", "the replay has not produced a signed record");
  const cold = await recordBody(ctx, b.cold_run_cid), reuse = await recordBody(ctx, reuseCid);
  if (!cold || cold.type !== "benchmark_run" || !reuse || reuse.type !== "skill_run") throw new HttpError(409, "runs_invalid", "benchmark runs not found in the log");
  if (reuse.body.requested_by?.benchmark !== b.id) throw new HttpError(409, "runs_invalid", "the replay record does not name this benchmark");
  // a self-heal during the replay: its Muse call (tokens) lives on the healed skill version
  let heal: { calls: number; input_tokens: number; cached_tokens: number; output_tokens: number; usd: number } | undefined;
  if (reuse.body.drift?.healed) {
    const h = (await ctx.db.query<any>(`SELECT body_text FROM records WHERE type = 'skill' AND body_text LIKE $1 LIMIT 1`, [`%"run":"${reuseCid}"%`])).rows[0];
    const hf = h ? JSON.parse(h.body_text).healed_from : null, hu = hf?.kind === "trace" ? null : hf?.usage;
    if (hu) heal = { calls: 1, input_tokens: num(hu.input_tokens), cached_tokens: num(hu.cached_tokens), output_tokens: num(hu.output_tokens), usd: num(hu.usd) };
  }
  const reusedSkillCid = reuse.body.skill as string;
  const skillRec = await recordBody(ctx, reusedSkillCid);
  const sk = skillRec?.body ?? {};
  // one-time cost of the recording: the recorder's Muse call and the publishing run of version 1 of this slug
  const v1 = (await ctx.db.query<any>(`SELECT cid FROM skills WHERE slug = $1 ORDER BY version ASC LIMIT 1`, [b.skill_slug])).rows[0]?.cid;
  const v1Body = v1 ? (await recordBody(ctx, v1))?.body : null;
  const pubRun = v1 ? (await ctx.db.query<any>(`SELECT r.body_text FROM skill_runs s JOIN records r ON r.cid = s.cid JOIN log l ON l.cid = s.cid WHERE s.skill_cid = $1 ORDER BY l.seq ASC LIMIT 1`, [v1])).rows[0] : null;
  const recorderUsd = num(v1Body?.recorder?.usage?.usd), publishUsd = pubRun ? num(JSON.parse(pubRun.body_text).usage?.usd) : 0;
  const A = metricsOf(cold.body), B = metricsOf(reuse.body, heal);
  const savedUsd = round6(A.usd - B.usd);
  const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) / 100 : null);
  const recordingUsd = round6(recorderUsd + publishUsd);
  const comparison = {
    usd_ratio: ratio(A.usd, B.usd), model_calls_ratio: ratio(A.model_calls, B.model_calls), executor_time_ratio: ratio(A.executor_ms ?? 0, B.executor_ms ?? 0),
    usd_saved: savedUsd, model_calls_saved: A.model_calls - B.model_calls,
    tokens_saved: (A.input_tokens + A.output_tokens) - (B.input_tokens + B.output_tokens),
    both_verified: A.success && B.success,
    // the same answer from both agents (normalized); a cheaper replay that returns a different value is not a win
    values_match: valuesMatch(A, B), cold_value: A.value ?? null, reuse_value: B.value ?? null,
    recording_one_time_usd: recordingUsd || null,
    reuses_to_pay_back_recording: savedUsd > 0 && recordingUsd > 0 ? Math.ceil(recordingUsd / savedUsd) : null,
  };
  const c = (client ?? {}) as any;
  const web = ctx.cfg.skillsWebUrl;
  const body = {
    benchmark: b.id,
    task: { slug: b.skill_slug, name: sk.skill?.name ?? null, start_url: b.start_url, site_kind: siteKind(ctx, b.start_url), site_label: SITE_LABEL[siteKind(ctx, b.start_url)] },
    input: b.params,
    agents: {
      a: { did: b.agent_a, role: "cold", client: typeof c.cold?.client === "string" ? c.cold.client.slice(0, 120) : null, skill_lookup: false },
      b: { did: b.agent_b, role: "reuse", client: typeof c.reuse?.client === "string" ? c.reuse.client.slice(0, 120) : null, skill_lookup: true },
    },
    find_skill: b.find ?? (c.find && typeof c.find === "object" ? c.find : null),
    runs: {
      cold: { record: b.cold_run_cid, type: "benchmark_run", seq: cold.seq, page: `${web}/benchmark?id=${b.id}#cold`, ...A, client: ClientRunZ(c.cold) },
      reuse: { record: reuseCid, type: "skill_run", seq: reuse.seq, page: `${web}/skills/runs/${reuseCid}`, job: b.reuse_job_id, skill: reusedSkillCid, skill_version: sk.version ?? null, self_healed: Boolean(reuse.body.drift?.healed), ...B, client: ClientRunZ(c.reuse) },
    },
    comparison,
    method: METHOD,
    models: { loop: cold.body.loop?.model ?? null, verifier: cold.body.verdict?.model ?? null },
    harness: c.harness && typeof c.harness === "object" ? { name: String(c.harness.name ?? "").slice(0, 80), version: String(c.harness.version ?? "").slice(0, 40) } : null,
  };
  const rec = createRecord(ctx.node, "benchmark", body as Record<string, unknown>, new Date(ctx.now()));
  await ctx.db.tx(async (tx) => {
    const ok = await tx.query<any>(`UPDATE benchmarks SET record_cid = $2, reuse_run_cid = $3, status = 'published', updated_at = now() WHERE id = $1 AND record_cid IS NULL RETURNING id`, [b.id, rec.cid, reuseCid]);
    if (!ok.rows.length) throw new HttpError(409, "already_published", "this benchmark is already published");
    await appendToLog(tx, ctx, rec);
  });
  ctx.events.dispatchEvent(new CustomEvent("append", { detail: { cid: rec.cid, type: rec.type } }));
  return getBenchmark(ctx, rec.cid);
}

function present(ctx: AppContext, rec: { cid: string; author: string; created_at: string; sig: string; seq: number; log: { prev_hash: string; entry_hash: string }; body: any }) {
  return {
    id: rec.body.benchmark, cid: rec.cid, seq: rec.seq, log: rec.log, created_at: rec.created_at,
    headline: headlineOf(rec.body),
    verified: benchmarkVerified(rec.body),
    reuse_cheaper: reuseCheaper(rec.body),
    values_match: rec.body?.comparison?.values_match ?? null,
    headline_eligible: benchmarkHeadlineable(rec.body),
    record: { v: 1, type: "benchmark", author: rec.author, created_at: rec.created_at, body: rec.body, cid: rec.cid, sig: rec.sig },
    page: `${ctx.cfg.skillsWebUrl}/benchmark?id=${rec.body.benchmark}`,
    verify: `GET ${ctx.cfg.publicBaseUrl}/v1/records/${rec.cid}, or the MCP verify_record tool`,
  };
}

/** One sentence, from the signed record only. */
export function headlineOf(b: any): string {
  const A = b.runs?.cold, B = b.runs?.reuse, c = b.comparison ?? {};
  if (!A || !B) return "";
  const usd = (x: number) => `$${Number(x).toFixed(4)}`;
  const calls = (k: number) => `${k} model call${k === 1 ? "" : "s"}`;
  if (B.model_calls === 0 && A.model_calls > 0) {
    const verified0 = c.both_verified ? "Both runs verified." : `Cold run ${A.success ? "verified" : "not verified"}; replay ${B.success ? "verified" : "not verified"}.`;
    return `Same task and input, two agents: reusing the ${b.task?.slug} skill replayed its recorded trace with no model calls (${usd(B.usd)}${B.verifier === "deterministic" ? ", checked deterministically" : ""}${B.value ? `, returned "${B.value}"` : ""}); doing it cold took ${calls(A.model_calls)} (${usd(A.usd)}). ${verified0}${c.values_match === true ? " Both returned the same value." : c.values_match === false ? ` The values differ (cold: "${c.cold_value ?? "?"}").` : ""}`;
  }
  const verified = c.both_verified ? "Both runs verified." : `Cold run ${A.success ? "verified" : "not verified"}; replay ${B.success ? "verified" : "not verified"}.`;
  return `Same task and input, two agents: reusing the ${b.task?.slug} skill took ${calls(B.model_calls)} (${usd(B.usd)}); doing it cold took ${calls(A.model_calls)} (${usd(A.usd)})${c.usd_ratio ? `, ${c.usd_ratio}x the cost` : ""}. ${verified}`;
}

const benchRows = async (ctx: AppContext, where = "", params: unknown[] = [], limit = 50) => (await ctx.db.query<any>(
  `SELECT r.cid, r.author, r.created_at, r.sig, r.body_text, l.seq::int AS seq, l.prev_hash, l.entry_hash FROM records r JOIN log l ON l.cid = r.cid WHERE r.type = 'benchmark' ${where} ORDER BY l.seq DESC LIMIT ${limit}`, params)).rows
  .map((x) => ({ cid: x.cid, author: x.author, created_at: x.created_at, sig: x.sig, seq: x.seq, log: { prev_hash: x.prev_hash, entry_hash: x.entry_hash }, body: JSON.parse(x.body_text) }));

export async function listBenchmarks(ctx: AppContext) {
  return { benchmarks: (await benchRows(ctx)).map((r) => present(ctx, r)), method: METHOD };
}

/** Both runs verified. */
export const benchmarkVerified = (body: any) => Boolean(body?.comparison?.both_verified);
/** Reuse cost strictly less than the cold run (Muse list price). */
export const reuseCheaper = (body: any) => num(body?.runs?.reuse?.usd) < num(body?.runs?.cold?.usd);
/**
 * Only a benchmark where both runs verified AND reuse was cheaper than cold AND both returned the same value is used as a headline (homepage stat,
 * /benchmark, llms.txt). Others stay in the list, labeled.
 */
export const benchmarkHeadlineable = (body: any) => benchmarkVerified(body) && reuseCheaper(body) && valuesMatched(body);
/** Both agents returned the same value (recorded in the signed comparison; older benchmarks did not record it). */
export const valuesMatched = (body: any) => body?.comparison?.values_match === true;

/** The latest headline benchmark (verified, reuse cheaper, same value); `any` returns the latest one whatever its result. */
export async function latestBenchmark(ctx: AppContext, opts: { any?: boolean } = {}) {
  const r = (await benchRows(ctx, "", [], 200)).find((x) => opts.any || benchmarkHeadlineable(x.body));
  return r ? present(ctx, r) : null;
}

/** By benchmark id or record cid, with both runs' evidence (the cold run has no run page elsewhere). */
export async function getBenchmark(ctx: AppContext, ref: string) {
  const r = (await benchRows(ctx, `AND (r.cid = $1 OR r.body_text LIKE $2)`, [ref, `%"benchmark":"${ref.replace(/[^0-9a-f-]/g, "")}"%`], 1))[0];
  if (!r) throw new HttpError(404, "benchmark_not_found", "no such benchmark");
  const out: any = present(ctx, r);
  const cold = await coldRunDetail(ctx, r.body.runs.cold.record).catch(() => null);
  out.cold_run = cold;
  return out;
}

export async function coldRunDetail(ctx: AppContext, cid: string) {
  const rec = (await ctx.db.query<any>(`SELECT r.cid, r.type, r.author, r.created_at, r.body_text, r.sig, l.seq::int AS seq, l.prev_hash, l.entry_hash FROM records r JOIN log l ON l.cid = r.cid WHERE r.cid = $1 AND r.type = 'benchmark_run'`, [cid])).rows[0];
  if (!rec) throw new HttpError(404, "run_not_found", "no such benchmark run");
  const b = JSON.parse(rec.body_text);
  return {
    run: { seq: rec.seq, log: { prev_hash: rec.prev_hash, entry_hash: rec.entry_hash }, record: { v: 1, type: rec.type, author: rec.author, created_at: rec.created_at, body: b, cid: rec.cid, sig: rec.sig } },
    role: b.role, agent: b.requested_by?.agent ?? null, inputs: b.params, success: b.success, verdict: b.verdict, turns: b.turns, actions: b.actions, usage: b.usage,
    evidence: { final_screenshot: b.evidence?.final_screenshot ? artifactUrl(ctx, b.evidence.final_screenshot) : null, gif: b.evidence?.gif ? artifactUrl(ctx, b.evidence.gif) : null },
    page: `${ctx.cfg.skillsWebUrl}/benchmark?id=${b.benchmark}#cold`,
  };
}
