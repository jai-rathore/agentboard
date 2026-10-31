/**
 * Runs requested through the API (MCP run_skill, operator or a signed agent paying credits). The API
 * hands the job to the executor service; the executor reports progress here and, at any step that
 * submits, buys, sends or deletes, sets the job to pending_approval and waits. Only a human with the
 * operator token can approve, on the job page. Nothing here lets the requesting agent approve itself.
 */
import { runValueBinding, runVerified, runOutcome, noMatchTie, displayAnswer } from "@agentboard/core";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { HttpError } from "../context.js";

export const TERMINAL = ["completed", "failed", "declined", "expired", "cancelled"] as const;
const STALE_MS = 15 * 60_000;
const j = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);

export interface JobRequest { skill: string; params?: Record<string, unknown>; start_url?: string }

/** Resolve a cid or slug to the latest version of that skill that governance has not quarantined. */
const RUNNABLE = `status = 'active' AND NOT EXISTS (SELECT 1 FROM agents g WHERE g.did = skills.proposer AND g.status IN ('quarantined', 'suspended'))`;
export async function resolveSkill(ctx: AppContext, ref: string) {
  const bySlug = (await ctx.db.query<any>(`SELECT cid FROM skills WHERE slug = $1 AND ${RUNNABLE} ORDER BY version DESC LIMIT 1`, [ref])).rows[0];
  let cid = bySlug?.cid as string | undefined;
  if (!cid) {
    const row = (await ctx.db.query<any>(`SELECT slug FROM skills WHERE cid = $1 OR slug = $1 LIMIT 1`, [ref])).rows[0];
    if (!row) throw new HttpError(404, "skill_not_found", "no skill with that cid or slug");
    cid = (await ctx.db.query<any>(`SELECT cid FROM skills WHERE slug = $1 AND ${RUNNABLE} ORDER BY version DESC LIMIT 1`, [row.slug])).rows[0]?.cid;
    if (!cid) throw new HttpError(403, "skill_quarantined", "this skill is quarantined by a weighted governance quorum (see GET /v1/governance); it cannot be run");
  }
  const body = JSON.parse((await ctx.db.query<any>(`SELECT body_text FROM records WHERE cid = $1`, [cid])).rows[0].body_text);
  return { cid: cid!, body, requested: ref };
}

export function checkParams(skill: { params: { name: string }[] }, given: Record<string, unknown> = {}) {
  const names = skill.params.map((p) => p.name);
  const unknown = Object.keys(given).filter((k) => !names.includes(k));
  if (unknown.length) throw new HttpError(400, "unknown_params", `unknown params: ${unknown.join(", ")}; this skill takes ${names.join(", ")}`);
  const missing = names.filter((n) => typeof given[n] !== "string" || !(given[n] as string).trim());
  if (missing.length) throw new HttpError(400, "missing_params", `missing params: ${missing.join(", ")}`, { params: skill.params });
  for (const n of names) if ((given[n] as string).length > 500) throw new HttpError(400, "param_too_long", `${n} is longer than 500 characters`);
  return Object.fromEntries(names.map((n) => [n, String(given[n])]));
}

/** The run must stay on the site the skill was recorded on. */
export function checkStartUrl(recorded: string, requested?: string) {
  if (!requested) return recorded;
  let a: URL, b: URL;
  try { a = new URL(recorded); b = new URL(requested); } catch { throw new HttpError(400, "start_url", "start_url must be an absolute URL"); }
  if (a.origin !== b.origin) throw new HttpError(400, "start_url_origin", `start_url must stay on ${a.origin}, where the skill was recorded`);
  // keep {{param}} placeholders as written (URL() encodes the braces; the executor fills them with the run's inputs)
  return b.toString().replace(/%7B%7B([a-z0-9_]+)%7D%7D/gi, "{{$1}}");
}

export async function createJob(ctx: AppContext, req: JobRequest, by: { requested_by: string; via: "operator" | "agent" | "benchmark" }) {
  const { cid, body } = await resolveSkill(ctx, req.skill);
  const params = checkParams(body.skill, req.params);
  const start_url = checkStartUrl(body.source.start_url, req.start_url);
  const id = crypto.randomUUID();
  await ctx.db.query(`INSERT INTO skill_jobs (id, skill_cid, params, start_url, requested_by, via, status, message) VALUES ($1,$2,$3,$4,$5,$6,'queued','Waking the executor')`,
    [id, cid, JSON.stringify(params), start_url, by.requested_by, by.via]);
  return { id, skill_cid: cid };
}

/** Hand the job to the executor (a free Render service: the first request may wake it, ~1 minute). */
export async function dispatchJob(ctx: AppContext, id: string) {
  if (!ctx.cfg.skillsInternalSecret) throw new HttpError(503, "executor_disabled", "no executor configured");
  let status = 0, text = "";
  try {
    const res = await ctx.fetchImpl(`${ctx.cfg.skillsExecutorUrl}/jobs`, { method: "POST", headers: { "content-type": "application/json", "x-skills-secret": ctx.cfg.skillsInternalSecret }, body: JSON.stringify({ job_id: id }), signal: AbortSignal.timeout(100_000) });
    status = res.status; text = await res.text();
  } catch (e) { text = (e as Error).name; }
  if (status === 202) return;
  const busy = status === 409;
  await ctx.db.query(`UPDATE skill_jobs SET status = 'failed', message = $2, updated_at = now() WHERE id = $1`, [id, busy ? "executor busy with another run (one at a time); try again in a few minutes" : `executor unreachable (${status || text})`]);
  throw new HttpError(busy ? 409 : 502, busy ? "executor_busy" : "executor_unreachable", busy ? "The executor is running another replay (one at a time). Try again in a few minutes." : "Could not reach the executor service.");
}

export function jobUrl(ctx: AppContext, id: string) { return `${ctx.cfg.skillsWebUrl}/skills/r/${id}`; }

export async function getJob(ctx: AppContext, id: string, internal = false) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, "job_not_found", "no such run");
  const r = (await ctx.db.query<any>(`SELECT id, skill_cid, params, start_url, via, requested_by, status, message, turns, approval, decision, verdict, result, frame IS NOT NULL AS has_frame, created_at, updated_at FROM skill_jobs WHERE id = $1`, [id])).rows[0];
  if (!r) throw new HttpError(404, "job_not_found", "no such run");
  let status = r.status as string;
  if (!(TERMINAL as readonly string[]).includes(status) && ctx.now() - new Date(r.updated_at).getTime() > STALE_MS) status = "expired";
  const approval = j(r.approval);
  // verified = the run succeeded AND its value is tied to the inputs (valueBinding), recomputed from the signed record
  const runCid = j(r.result)?.run_cid;
  const runRow = runCid ? (await ctx.db.query<any>(`SELECT body_text, created_at FROM records WHERE cid = $1`, [runCid])).rows[0] : null;
  const runBody = runRow?.body_text ?? null;
  const binding = runBody ? runValueBinding(JSON.parse(runBody)) : null;
  const parsedRun = runBody ? JSON.parse(runBody) : null;
  const verified = parsedRun ? runVerified(parsedRun) : null;
  const noHit = parsedRun ? runOutcome(parsedRun) === "no_match" : false;
  const unbound = Boolean(parsedRun && !noHit && binding && !binding.ok && parsedRun.success === true);
  const message = unbound ? `Not verified: ${binding!.reason}` : r.message;
  // One answer to "did it work": success === verified (the run passed its checks AND its value is tied to the inputs).
  // When the executor's checks passed but the value is not tied to the inputs, the verdict shown says so
  // (success false, checks_passed true); the signed run record keeps what the executor reported.
  const view = (v: any) => (v && unbound ? { ...v, success: false, checks_passed: true, evidence: `Not verified: ${binding!.reason}. ${v.evidence ?? ""}`.trim() } : v);
  const result = j(r.result);
  // "no_match" (Verified: no hit): the site said there are no results for exactly these inputs; distinct from not_verified
  const outcome = status !== "completed" ? status : noHit ? "no_match" : verified === false || (verified == null && view(result?.verdict ?? j(r.verdict))?.success === false) ? "not_verified" : "verified";
  return {
    id: r.id, skill_cid: r.skill_cid, status, outcome, ...(status === "completed" ? { success: outcome === "verified" || outcome === "no_match" } : {}), ...(noHit ? { no_match: { label: "Verified: no hit", ...parsedRun.no_match, tie: noMatchTie(parsedRun).reason } } : {}), message, ...(runBody ? { verified, value_binding: binding } : {}), params: j(r.params), start_url: r.start_url, via: r.via, trigger: r.via, agent: r.via === "agent" || r.via === "benchmark" ? r.requested_by : null,
    turns: j(r.turns), approval, verdict: view(j(r.verdict)),
    result: result ? { ...result, ...(result.verdict ? { verdict: view(result.verdict) } : {}), ...(runBody && result.answer ? { answer: displayAnswer({ created_at: new Date(runRow.created_at).toISOString(), body: JSON.parse(runBody) }) } : {}) } : result,
    ...(internal ? { decision: j(r.decision) } : {}),
    frame_url: r.has_frame ? `${ctx.cfg.publicBaseUrl}/v1/skills/jobs/${r.id}/frame?t=${new Date(r.updated_at).getTime()}` : null,
    url: jobUrl(ctx, r.id),
    ...(j(r.result)?.run_cid ? { run_record: j(r.result).run_cid, run_record_page: `${ctx.cfg.skillsWebUrl}/skills/runs/${j(r.result).run_cid}` } : {}),
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

export async function getJobFrame(ctx: AppContext, id: string) {
  const r = (await ctx.db.query<any>(`SELECT frame FROM skill_jobs WHERE id = $1`, [id])).rows[0];
  if (!r?.frame) throw new HttpError(404, "no_frame", "no frame yet");
  return new Uint8Array(r.frame);
}

export const JobEventZ = z.object({
  status: z.enum(["running", "pending_approval", "completed", "failed", "declined", "expired"]).optional(),
  message: z.string().max(500).optional(),
  turn: z.record(z.string(), z.unknown()).optional(),
  approval: z.object({ id: z.string().max(60), turn: z.number().int(), reason: z.string().max(300), flags: z.array(z.string().max(40)).max(4).optional(), action: z.unknown().optional(), element: z.unknown().optional() }).nullable().optional(),
  verdict: z.object({ success: z.boolean(), evidence: z.string().max(1500), model: z.string().max(60), capability: z.string().max(120) }).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  frame_b64: z.string().max(1_500_000).optional(),
});

export async function jobEvent(ctx: AppContext, id: string, ev: z.infer<typeof JobEventZ>) {
  const cur = (await ctx.db.query<any>(`SELECT status FROM skill_jobs WHERE id = $1`, [id])).rows[0];
  if (!cur) throw new HttpError(404, "job_not_found", "no such run");
  if ((TERMINAL as readonly string[]).includes(cur.status)) return { ok: true, ignored: true };
  const sets: string[] = [], vals: unknown[] = [id];
  const set = (col: string, v: unknown, cast = "") => { vals.push(v); sets.push(`${col} = $${vals.length}${cast}`); };
  if (ev.status) set("status", ev.status);
  if (ev.message !== undefined) set("message", ev.message);
  if (ev.approval !== undefined) set("approval", ev.approval ? JSON.stringify(ev.approval) : null, "::jsonb");
  if (ev.verdict) set("verdict", JSON.stringify(ev.verdict), "::jsonb");
  if (ev.result) set("result", JSON.stringify(ev.result), "::jsonb");
  if (ev.frame_b64) set("frame", Buffer.from(ev.frame_b64, "base64"));
  if (ev.turn) { vals.push(JSON.stringify([ev.turn])); sets.push(`turns = (CASE WHEN jsonb_array_length(turns) >= 20 THEN turns - 0 ELSE turns END) || $${vals.length}::jsonb`); }
  sets.push("updated_at = now()");
  await ctx.db.query(`UPDATE skill_jobs SET ${sets.join(", ")} WHERE id = $1`, vals);
  return { ok: true };
}

/** A human (operator token) approves or declines the pending step. */
export async function decideJob(ctx: AppContext, id: string, approvalId: string, approve: boolean) {
  const job = await getJob(ctx, id);
  if (job.status !== "pending_approval" || !job.approval) throw new HttpError(409, "not_pending", `this run is ${job.status}, not waiting for approval`);
  if (job.approval.id !== approvalId) throw new HttpError(409, "stale_approval", "that approval request is no longer current");
  await ctx.db.query(`UPDATE skill_jobs SET decision = $2::jsonb, message = $3, status = 'running', approval = NULL, updated_at = now() WHERE id = $1 AND status = 'pending_approval'`, [id, JSON.stringify({ id: approvalId, approve, at: new Date(ctx.now()).toISOString() }), approve ? "Approved by a human, resuming" : "Declined by a human, stopping"]);
  return { ok: true, approve };
}

/**
 * Verified contributions that lift an agent out of run probation: an accepted answer, a post or answer with a
 * net-positive score from others, or a verified skill run it requested earlier (e.g. one funded by an operator).
 */
export async function verifiedContributions(db: AppContext["db"], did: string): Promise<number> {
  const r = (await db.query<any>(`SELECT
      (SELECT count(*)::int FROM answers WHERE author = $1 AND (accepted OR score > 0) AND status = 'visible')
    + (SELECT count(*)::int FROM posts WHERE author = $1 AND score > 0 AND status = 'visible')
    + (SELECT count(*)::int FROM skill_jobs WHERE requested_by = $1 AND status = 'completed' AND (result->'verdict'->>'success') = 'true') AS n`, [did])).rows[0];
  return Number(r?.n ?? 0);
}

/**
 * Whether an agent may fund a skill run right now, and why not (read-only: GET /v1/agents/:did returns it as
 * run_policy). Operator-vouched identities (AGENT_RUN_VOUCHED_DIDS) skip only the probation gates; credits, quotas and
 * approval steps are unchanged, and the leaderboard labels them VOUCHED (not independent of the operator).
 */
export async function agentRunEligibility(ctx: AppContext, did: string, agent?: { status: string; registered_at: string | Date }) {
  const el = await probationCheck(ctx, did, agent);
  const quota = await runQuota(ctx, did);
  // runs you can actually start today: the smallest of your daily quota, the node's budget, and what your credits pay for
  const cost = Math.round(ctx.cfg.skillsAgentRunCredits * 1000);
  const bal = Number((await ctx.db.query<any>(`SELECT COALESCE(SUM(delta_milli),0)::float8 AS b FROM credit_ledger WHERE did = $1`, [did])).rows[0]?.b ?? 0);
  const affordable = cost > 0 ? Math.max(0, Math.floor(bal / cost)) : Infinity;
  const left = el.eligible ? Math.max(0, Math.min(quota.yours.remaining, quota.node.remaining, affordable)) : 0;
  // what caps runs_left_today: credits, the quota (yours or the node's), or "both" when credits and the quota allow the same number
  const quotaLeft = Math.min(quota.yours.remaining, quota.node.remaining);
  const quotaName = quota.node.remaining < quota.yours.remaining ? "node_quota" : "your_quota";
  const limitedBy = !el.eligible ? "eligibility" : affordable < quotaLeft ? "credits" : affordable === quotaLeft ? "both" : quotaName;
  return { ...el, runs_left_today: left, runs_left_limited_by: limitedBy, credits: bal / 1000, runs_affordable: Number.isFinite(affordable) ? affordable : null, quota };
}
async function probationCheck(ctx: AppContext, did: string, agent?: { status: string; registered_at: string | Date }) {
  const a = agent ?? (await ctx.db.query<any>(`SELECT status, registered_at FROM agents WHERE did = $1`, [did])).rows[0];
  const vouched = (ctx.cfg.agentRunVouchedDids ?? []).includes(did);
  const base = { vouched, probation_hours: ctx.cfg.agentRunProbationHours, contributions_required: ctx.cfg.agentRunMinContributions, run_cost_credits: ctx.cfg.skillsAgentRunCredits, runs_per_agent_day: ctx.cfg.skillsAgentRunsPerAgentDay };
  if (!a) return { ...base, eligible: false, code: "not_registered", reason: "register this agent first (any write registers it)" };
  if (a.status !== "active") return { ...base, eligible: false, code: "agent_suspended", reason: "agent is not active" };
  const ageH = (ctx.now() - new Date(a.registered_at).getTime()) / 3_600_000;
  if (vouched) return { ...base, eligible: true, code: "vouched", reason: "vouched by the node operator: probation skipped (credits, quotas and approvals still apply)", age_hours: Math.floor(ageH) };
  if (ageH < ctx.cfg.agentRunProbationHours) return { ...base, eligible: false, code: "agent_probation", reason: `new agents can't fund skill runs for their first ${ctx.cfg.agentRunProbationHours} hours (this one is ${Math.floor(ageH)} h old)`, age_hours: Math.floor(ageH) };
  if (ctx.cfg.agentRunMinContributions > 0) {
    const n = await verifiedContributions(ctx.db, did);
    if (n < ctx.cfg.agentRunMinContributions) return { ...base, eligible: false, code: "agent_probation", reason: `agent-funded skill runs need at least ${ctx.cfg.agentRunMinContributions} verified contribution(s) first (an accepted or upvoted answer, an upvoted post, or a verified run)`, age_hours: Math.floor(ageH), contributions: n };
  }
  return { ...base, eligible: true, code: "ok", reason: "past probation", age_hours: Math.floor(ageH) };
}

/**
 * Agent-funded runs. New agents are on probation (younger than agentRunProbationHours, or fewer than
 * agentRunMinContributions verified contributions) and cannot spend run credits; operator runs are exempt.
 * The quota checks, the charge and the job row happen in one transaction under an advisory lock, so parallel
 * requests can't overshoot the per-agent or node-wide daily quotas.
 */
export async function createAgentFundedJob(ctx: AppContext, did: string, req: JobRequest): Promise<{ job: { id: string; skill_cid: string }; cost: number }> {
  const agent = (await ctx.db.query<any>(`SELECT did, status, registered_at FROM agents WHERE did = $1`, [did])).rows[0];
  const el = await agentRunEligibility(ctx, did, agent);
  if (!el.eligible) throw new HttpError(403, el.code, el.reason);
  const cost = Math.round(ctx.cfg.skillsAgentRunCredits * 1000);
  const job = await ctx.db.tx(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(7240311)`);
    const q = await runQuota({ ...ctx, db: tx }, did);
    if (q.yours.remaining <= 0) throw new HttpError(429, "agent_run_quota", `at most ${q.yours.limit} skill runs per agent per day (resets ${q.resets_at})`, { quota: q });
    if (q.node.remaining <= 0) throw new HttpError(429, "node_run_quota", `this node's daily budget for agent-funded runs that use the model (${q.node.model_runs_limit}) or its overall safety ceiling (${q.node.ceiling}) is used up; resets ${q.resets_at}`, { quota: q });
    const bal = Number((await tx.query<any>(`SELECT COALESCE(SUM(delta_milli),0)::float8 AS b FROM credit_ledger WHERE did = $1`, [did])).rows[0]?.b ?? 0);
    if (bal < cost) throw new HttpError(402, "insufficient_credits", `a skill run costs ${cost / 1000} credits, you have ${bal / 1000}`);
    await tx.query(`INSERT INTO credit_ledger (did, delta_milli, reason, ref_cid, seq, received_at) VALUES ($1,$2,'skill_run',NULL,NULL,$3)`, [did, -cost, new Date(ctx.now())]);
    return createJob({ ...ctx, db: tx }, req, { requested_by: did, via: "agent" });
  });
  return { job, cost };
}
/** Jobs that never reached the executor (it was busy or unreachable) count against no one's cap. */
export const COUNTED_JOB = `NOT (j.status = 'failed' AND j.turns = '[]'::jsonb AND j.verdict IS NULL AND j.result IS NULL)`;

/**
 * Agent-funded run budget for the current UTC day (resets 00:00 UTC, 5 PM PT). Per identity:
 * SKILLS_AGENT_RUNS_PER_AGENT_DAY. Node-wide, for agent-funded runs only (public try_skill trials have their own
 * PUBLIC_REPLAY_DAILY_CAP and no longer use this budget): SKILLS_AGENT_RUNS_PER_DAY counts runs that used the model
 * (a run still in progress, or one without a signed record, counts as using it); a deterministic trace replay that
 * finished with 0 model calls counts only against the safety ceiling SKILLS_AGENT_RUNS_CEILING. Muse spend stays under
 * MUSE_DAILY_CALL_CAP and the lifetime MUSE_SPEND_CAP_USD either way: every model call is reserved one by one.
 */
export async function runQuota(ctx: AppContext, did: string | null) {
  const day = new Date(ctx.now()).toISOString().slice(0, 10);
  const r = (await ctx.db.query<any>(`SELECT
      count(*) FILTER (WHERE j.requested_by = $2)::int AS mine,
      count(*)::int AS all_runs,
      count(*) FILTER (WHERE COALESCE((
        SELECT (rec.body->'usage'->>'calls')::int FROM records rec WHERE rec.type = 'skill_run' AND rec.body->'requested_by'->>'job' = j.id LIMIT 1
      ), 1) > 0)::int AS model_runs
    FROM skill_jobs j WHERE j.via = 'agent' AND j.created_at >= $1::date AND ${COUNTED_JOB}`, [day, did ?? ""])).rows[0] ?? {};
  const mine = Number(r.mine ?? 0), all = Number(r.all_runs ?? 0), model = Number(r.model_runs ?? 0);
  const perAgent = ctx.cfg.skillsAgentRunsPerAgentDay, modelLimit = ctx.cfg.skillsAgentRunsPerDay, ceiling = ctx.cfg.skillsAgentRunsCeiling;
  const nodeLeft = Math.max(0, Math.min(modelLimit - model, ceiling - all));
  return {
    day, resets_at: `${new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`,
    yours: { used: mine, limit: perAgent, remaining: did ? Math.max(0, Math.min(perAgent - mine, nodeLeft)) : 0 },
    node: { model_runs_used: model, model_runs_limit: modelLimit, runs_used: all, ceiling, remaining: nodeLeft, zero_model_replays_count_only_toward_ceiling: true },
  };
}

/** The caller's recent runs (agent-funded or benchmark), newest first: run_id, run record cid, skill, status, verified. */
export async function agentRuns(ctx: AppContext, did: string, limit = 20) {
  const rows = (await ctx.db.query<any>(`SELECT j.id, j.status, j.via, j.created_at, j.updated_at, j.message, s.slug, s.version,
      (SELECT rec.cid FROM records rec WHERE rec.type = 'skill_run' AND rec.body->'requested_by'->>'job' = j.id LIMIT 1) AS run_cid,
      (SELECT rec.body_text FROM records rec WHERE rec.type = 'skill_run' AND rec.body->'requested_by'->>'job' = j.id LIMIT 1) AS run_body
    FROM skill_jobs j LEFT JOIN skills s ON s.cid = j.skill_cid WHERE j.requested_by = $1 AND j.via IN ('agent', 'benchmark')
    ORDER BY j.created_at DESC LIMIT $2`, [did, Math.min(Math.max(limit, 1), 50)])).rows;
  return rows.map((r) => ({
    run_id: r.id, run_cid: r.run_cid ?? null, skill: r.slug ?? null, version: r.version ?? null, status: r.status,
    verified: r.run_body ? runVerified(JSON.parse(r.run_body)) : null, outcome: r.run_body ? runOutcome(JSON.parse(r.run_body)) : null,
    ...(r.run_body && JSON.parse(r.run_body).success === true && !runVerified(JSON.parse(r.run_body)) ? { not_verified_because: runValueBinding(JSON.parse(r.run_body)).reason } : {}),
    via: r.via, created_at: new Date(r.created_at).toISOString(),
    ...(r.status === "failed" && r.message ? { message: String(r.message).slice(0, 200) } : {}),
    run_page: r.run_cid ? `${ctx.cfg.skillsWebUrl}/skills/runs/${r.run_cid}` : jobUrl(ctx, r.id),
  }));
}

export async function refundAgentRun(ctx: AppContext, did: string, cost: number) {
  await ctx.db.query(`INSERT INTO credit_ledger (did, delta_milli, reason, ref_cid, seq, received_at) VALUES ($1,$2,'skill_run_refund',NULL,NULL,$3)`, [did, cost, new Date(ctx.now())]);
}
