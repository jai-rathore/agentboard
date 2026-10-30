/**
 * Public, read-only numbers for Agentboard Skills, derived from the signed `skill` / `skill_run`
 * records (and the Muse spend ledger). Nothing here calls a model.
 */
import type { AppContext } from "../context.js";
import { HttpError } from "../context.js";
import { museSpend } from "./muse.js";
import { APPROVAL_HUMAN_MS, artifactUrl } from "./skills.js";
import { siteKindOf, displayAnswer, runVerified, runValueBinding } from "@agentboard/core";
import { getJob } from "./skillJobs.js";

const CLICKY = new Set(["click", "double_click", "select", "keypress", "type", "scroll", "drag"]);

interface RunRow { cid: string; skill_cid: string; success: boolean; created_at: string; body_text: string; slug: string; version: number; name: string; seq: number; job_id: string | null; job_via: string | null; job_by: string | null; skill_text: string; skill_seq: number }

async function runRows(ctx: AppContext, where = "", params: unknown[] = [], limit = 5000): Promise<RunRow[]> {
  return (await ctx.db.query<any>(
    `SELECT r.cid, r.skill_cid, r.success, r.created_at, rec.body_text, s.slug, s.version, s.name, l.seq::int AS seq,
        j.id AS job_id, j.via AS job_via, j.requested_by AS job_by, srec.body_text AS skill_text, sl.seq::int AS skill_seq
     FROM skill_runs r JOIN records rec ON rec.cid = r.cid JOIN skills s ON s.cid = r.skill_cid JOIN log l ON l.cid = r.cid
     JOIN records srec ON srec.cid = s.cid JOIN log sl ON sl.cid = s.cid
     LEFT JOIN skill_jobs j ON j.result->>'run_cid' = r.cid
     ${where} ORDER BY r.created_at DESC LIMIT ${Math.max(1, Math.min(limit, 5000))}`, params)).rows;
}

/** Who asked for a run: the signed run record says so for new runs; older runs fall back to the job table. */
function requester(row: RunRow, body: any) {
  const rq = body.requested_by;
  if (rq?.via === "agent" && rq.agent) return { via: "agent" as const, agent: rq.agent as string, job: rq.job ?? row.job_id };
  if (rq?.via === "benchmark" && rq.agent) return { via: "benchmark", agent: rq.agent as string, job: rq.job ?? row.job_id };
  if (rq?.via) return { via: rq.via as string, agent: null, job: rq.job ?? row.job_id };
  if (row.job_via === "agent" && row.job_by) return { via: "agent" as const, agent: row.job_by, job: row.job_id };
  if (row.job_via === "public") return { via: "public", agent: null, job: row.job_id };
  if (row.job_via) return { via: "operator", agent: null, job: row.job_id };
  return { via: "web", agent: null, job: null };
}

/**
 * What a run is evidence of. The publishing run is the draft's first verified replay, signed in the same
 * transaction as the skill record (its log entry follows the skill's): it belongs to the recording and is
 * never counted as reuse. Every other run is a replay of a published version.
 * new_inputs: whether the run's params differ from the values in the recording (the params' examples);
 * null when the skill takes no params. site_kind: Agentboard's /demo/ mock sites vs real sites.
 */
export function classifyRun(ctx: AppContext, row: { seq: number; skill_seq: number; skill_text: string }, body: any) {
  const sk = JSON.parse(row.skill_text);
  // The run right after a recorded skill is its publishing run (part of the recording). A self-healed version is
  // published after the run that healed it, so the run that follows it is an ordinary replay.
  const publish = Boolean(sk.draft) && !sk.healed_from && Number(row.seq) === Number(row.skill_seq) + 1;
  const recParams: { name: string; example: string }[] = sk.skill?.params ?? [];
  const norm = (x: unknown) => String(x ?? "").trim().toLowerCase();
  const differing = recParams.filter((p) => norm(body.params?.[p.name]) !== norm(p.example)).map((p) => p.name);
  return {
    kind: publish ? "publish" as const : "replay" as const,
    new_inputs: recParams.length ? differing.length > 0 : null,
    differing_params: differing,
    recording_inputs: Object.fromEntries(recParams.map((p) => [p.name, p.example])),
    site_kind: siteKind(ctx, body.start_url ?? sk.source?.start_url),
    self_healed: Boolean(body.drift?.healed),
  };
}
export const mockHosts = (ctx: AppContext) => [ctx.cfg.skillsWebUrl, ctx.cfg.publicBaseUrl].map((u) => { try { return new URL(u).hostname; } catch { return ""; } }).filter(Boolean);
export const siteKind = (ctx: AppContext, url?: string | null) => siteKindOf(url, mockHosts(ctx));
export const SITE_LABEL = { mock: "demo (mock site)", real: "real site" } as const;

export async function skillMetrics(ctx: AppContext) {
  const one = async (sql: string) => Number((await ctx.db.query<any>(sql)).rows[0]?.n ?? 0);
  const skills = await one(`SELECT count(DISTINCT slug)::int AS n FROM skills`);
  const versions = await one(`SELECT count(*)::int AS n FROM skills`);
  const vrows = (await ctx.db.query<any>(`SELECT rec.body_text FROM skills s JOIN records rec ON rec.cid = s.cid`)).rows;
  const heals = vrows.filter((r) => JSON.parse(r.body_text).healed_from).length;
  // skills by site: latest active version of each slug
  const latest = (await ctx.db.query<any>(`SELECT DISTINCT ON (s.slug) s.slug, rec.body_text FROM skills s JOIN records rec ON rec.cid = s.cid WHERE s.status = 'active' ORDER BY s.slug, s.version DESC`)).rows;
  const skillSites = { real: 0, mock: 0 };
  for (const r of latest) skillSites[siteKind(ctx, JSON.parse(r.body_text).source?.start_url)]++;
  const rows = await runRows(ctx);
  let succeeded = 0, approvals = 0, clicks = 0, actions = 0, savedMs = 0, timed = 0, faster = 0, runMs = 0, agentRuns = 0, healRuns = 0;
  const agents = new Set<string>();
  const replays = { total: 0, verified: 0, real_site: 0, mock_site: 0, real_site_verified: 0, mock_site_verified: 0, new_inputs: 0, self_healed: 0, by_trigger: { operator: 0, agent: 0, public: 0, web: 0 } as Record<string, number> };
  let publishRuns = 0;
  for (const row of rows) {
    const b = JSON.parse(row.body_text);
    const rq = requester(row, b);
    const k = classifyRun(ctx, row, b);
    if (k.kind === "publish") publishRuns++;
    else {
      replays.total++;
      if (row.success) replays.verified++;
      if (k.site_kind === "real") { replays.real_site++; if (row.success) replays.real_site_verified++; } else { replays.mock_site++; if (row.success) replays.mock_site_verified++; }
      if (k.new_inputs) replays.new_inputs++;
      if (k.self_healed) replays.self_healed++;
      replays.by_trigger[rq.via] = (replays.by_trigger[rq.via] ?? 0) + 1;
    }
    if (rq.via === "agent") { agentRuns++; agents.add(rq.agent!); }
    if (b.drift?.healed) healRuns++;
    if (!row.success) continue;
    succeeded++;
    const acts: any[] = b.actions ?? [];
    const ap = acts.filter((a) => a.approval === "human").length;
    approvals += ap;
    actions += acts.length;
    clicks += acts.filter((a) => CLICKY.has(a.type)).length;
    runMs += Number(b.time?.run_ms ?? b.duration_ms ?? 0);
    const rec = b.time?.recording_ms;
    if (rec != null) { timed++; savedMs += Math.max(0, rec - ap * APPROVAL_HUMAN_MS); if (Number(b.time.run_ms ?? b.duration_ms) < rec) faster++; }
  }
  const spend = await museSpend(ctx);
  const kinds = (await ctx.db.query<any>(`SELECT kind, SUM(calls)::int AS calls, SUM(cost_micro)::float8 AS c FROM muse_spend GROUP BY kind ORDER BY kind`)).rows;
  return {
    skills, versions, heals,
    skills_by_site: skillSites,
    // Reuse: runs of a published version. The publishing run (part of the recording) is never counted here.
    replays: { ...replays, publishing_runs: publishRuns, note: "Replays exclude each skill's publishing run (the verification of the recording). mock_site = Agentboard's own /demo/ sites (helpdesk and shop mocks)." },
    runs: { total: rows.length, verified: succeeded, failed: rows.length - succeeded, success_rate: rows.length ? Math.round((succeeded / rows.length) * 1000) / 1000 : null, by_agents: agentRuns, distinct_agents: agents.size, that_healed: healRuns },
    human: {
      clicks_per_run: 0, // the agent does every click; a human only approves risky steps
      approvals, approval_human_ms: APPROVAL_HUMAN_MS,
      agent_actions_done: actions, clicks_saved: clicks,
      time_saved_ms: savedMs, timed_runs: timed, runs_faster_than_human: faster, agent_run_ms_total: runMs,
      note: "Over verified runs. No human clicks except approving risky steps (submit, buy, send, delete; ~5 s each). Time saved = recording length minus approval time; the agent's own wall clock is not counted as human time.",
    },
    muse: { model: spend.model, calls: spend.total_calls, usd: Math.round(spend.total_usd * 1e6) / 1e6, by_kind: Object.fromEntries(kinds.map((k) => [k.kind, { calls: Number(k.calls), usd: Math.round(Number(k.c)) / 1e6 }])), spend_cap_usd: spend.spend_cap_usd },
    at: new Date(ctx.now()).toISOString(),
  };
}

/** Agent reuse: which agent ran which skill, when, and what happened. Filter by skill (slug or cid) or agent DID. */
/**
 * Who ran which skill. Runs requested by agents that are no longer active (hidden by the operator or
 * self-retracted test identities) are left out by default; include_hidden brings them back (they stay
 * in the signed log either way). Asking for one agent explicitly always shows its runs.
 */
export async function skillReuse(ctx: AppContext, o: { skill?: string; agent?: string; limit?: number; includeHidden?: boolean }) {
  const where: string[] = [], params: unknown[] = [];
  if (o.skill) { params.push(o.skill); where.push(`(s.slug = $${params.length} OR s.cid = $${params.length})`); }
  let rows = await runRows(ctx, where.length ? `WHERE ${where.join(" AND ")}` : "", params, o.agent ? 5000 : (o.limit ?? 100));
  const out = rows.map((row) => {
    const b = JSON.parse(row.body_text);
    const rq = requester(row, b);
    const k = classifyRun(ctx, row, b);
    return {
      run: row.cid, seq: row.seq, at: row.created_at, skill: { cid: row.skill_cid, slug: row.slug, version: row.version, name: row.name },
      via: rq.via, trigger: rq.via, agent: rq.agent, job: rq.job,
      kind: k.kind, site_kind: k.site_kind, new_inputs: k.new_inputs, self_healed: k.self_healed,
      run_page: `${ctx.cfg.skillsWebUrl}/skills/runs/${row.cid}`,
      outcome: row.success ? "verified" : "not_verified", healed: Boolean(b.drift?.healed),
      human_clicks: 0, approvals: (b.actions ?? []).filter((a: any) => a.approval === "human").length,
      run_ms: b.time?.run_ms ?? b.duration_ms ?? null, recording_ms: b.time?.recording_ms ?? null,
      evidence: b.verdict?.evidence ?? null,
    };
  });
  const mine = o.agent ? out.filter((r) => r.agent === o.agent).slice(0, o.limit ?? 100) : out;
  const allDids = [...new Set(mine.map((r) => r.agent).filter(Boolean))] as string[];
  const names = new Map((allDids.length ? (await ctx.db.query<any>(`SELECT did, name, status FROM agents WHERE did = ANY($1)`, [allDids])).rows : []).map((a) => [a.did, a]));
  // Reuse-benchmark agents are fresh, unregistered identities by design: their runs stay visible.
  const inactive = (r: { agent: string | null; via: string }) => Boolean(r.agent) && !(r.via === "benchmark" && !names.has(r.agent!)) && names.get(r.agent!)?.status !== "active";
  const showHidden = Boolean(o.includeHidden || o.agent);
  const filtered = showHidden ? mine : mine.filter((r) => !inactive(r));
  const hiddenRuns = showHidden ? 0 : mine.length - filtered.length;
  const dids = [...new Set(filtered.map((r) => r.agent).filter(Boolean))] as string[];
  if (o.skill && !filtered.length && !(await ctx.db.query(`SELECT 1 FROM skills WHERE slug = $1 OR cid = $1`, [o.skill])).rows[0]) throw new HttpError(404, "skill_not_found", "no such skill");
  return {
    runs: filtered.map((r) => ({ ...r, agent: r.agent ? { did: r.agent, name: names.get(r.agent)?.name ?? null, status: names.get(r.agent)?.status ?? null } : null })),
    summary: { runs: filtered.length, agents: dids.length, verified: filtered.filter((r) => r.outcome === "verified").length, hidden_runs: hiddenRuns, include_hidden: showHidden,
      replays: filtered.filter((r) => r.kind === "replay").length, publishing_runs: filtered.filter((r) => r.kind === "publish").length,
      replays_real_site: filtered.filter((r) => r.kind === "replay" && r.site_kind === "real").length, replays_mock_site: filtered.filter((r) => r.kind === "replay" && r.site_kind === "mock").length,
      replays_new_inputs: filtered.filter((r) => r.kind === "replay" && r.new_inputs).length },
  };
}

/**
 * One run as evidence, by run record cid or by job id: the signed record (with its log position), what it replayed
 * (skill version, the recording it came from), inputs vs the recording's, step screenshots (the GIF's frames and,
 * for API-started runs, each turn's actions), the final screenshot, the verifier verdict, the models, and whether
 * it self-healed. Read-only; no model calls.
 */
export async function runDetail(ctx: AppContext, id: string) {
  let cid = id;
  let job: any = null;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id)) {
    job = await getJob(ctx, id);
    const signed = job.result?.run_cid ?? (await ctx.db.query<any>(`SELECT r.cid FROM skill_runs r JOIN records rec ON rec.cid = r.cid WHERE rec.body_text LIKE $1 LIMIT 1`, [`%"job":"${id}"%`])).rows[0]?.cid;
    if (!signed) return { status: job.status, job, run: null, note: "this run has not produced a signed run record (yet)" };
    cid = signed;
  }
  const rows = await runRows(ctx, "WHERE r.cid = $1", [cid], 1);
  const row = rows[0];
  if (!row) throw new HttpError(404, "run_not_found", "no such skill run");
  const b = JSON.parse(row.body_text);
  const rq = requester(row, b);
  if (!job && rq.job) { try { job = await getJob(ctx, rq.job); } catch { job = null; } }
  const k = classifyRun(ctx, row, b);
  const sk = JSON.parse(row.skill_text);
  const rec = (await ctx.db.query<any>(`SELECT r.cid, r.type, r.author, r.created_at, r.body_text, r.sig, l.seq::int AS seq, l.prev_hash, l.entry_hash FROM records r JOIN log l ON l.cid = r.cid WHERE r.cid = $1`, [cid])).rows[0];
  const healedTo = (await ctx.db.query<any>(`SELECT s.cid, s.version FROM skills s JOIN records rec ON rec.cid = s.cid WHERE s.slug = $1 AND rec.body_text LIKE $2`, [row.slug, `%"run":"${cid}"%`])).rows[0] ?? null;
  const latest = (await ctx.db.query<any>(`SELECT cid, version FROM skills WHERE slug = $1 ORDER BY version DESC LIMIT 1`, [row.slug])).rows[0];
  return {
    run: { seq: rec.seq, log: { prev_hash: rec.prev_hash, entry_hash: rec.entry_hash }, record: { v: 1, type: rec.type, author: rec.author, created_at: rec.created_at, body: b, cid: rec.cid, sig: rec.sig } },
    kind: k.kind,
    label: k.kind === "publish" ? "Publishing run: the first verified replay of the recording, signed together with the skill. Not counted as reuse." : "Replay of a published skill version",
    trigger: rq.via, agent: rq.agent, job: job ? { id: job.id, status: job.status, turns: job.turns, page: job.url } : null,
    skill: { cid: row.skill_cid, slug: row.slug, version: row.version, name: row.name, latest_version: latest?.version ?? row.version, latest_cid: latest?.cid ?? row.skill_cid, page: `${ctx.cfg.skillsWebUrl}/s/${row.skill_cid}` },
    recording: { skill_cid: row.skill_cid, video: sk.source?.video ? artifactUrl(ctx, sk.source.video) : null, frames: (sk.source?.frames ?? []).map((f: string) => artifactUrl(ctx, f)), start_url: sk.source?.start_url ?? null, inputs: k.recording_inputs, recorder_model: sk.recorder?.model ?? null },
    inputs: b.params, new_inputs: k.new_inputs, differing_params: k.differing_params,
    site_kind: k.site_kind, site_label: SITE_LABEL[k.site_kind],
    self_healed: k.self_healed, healed_to: healedTo ? { cid: healedTo.cid, version: healedTo.version } : null,
    // success === verified (checks passed AND the value is tied to the inputs); signed_success is what the record says
    verdict: runVerified(b) || !b.success ? b.verdict : { ...b.verdict, success: false, checks_passed: true, evidence: `Not verified: ${runValueBinding(b).reason}. ${b.verdict?.evidence ?? ""}`.trim() },
    success: runVerified(b), outcome: runVerified(b) ? "verified" : "not_verified", ...(b.success !== runVerified(b) ? { signed_success: b.success } : {}),
    models: { loop: b.loop?.model ?? null, loop_capability: b.loop?.capability ?? null, verifier: b.verdict?.model ?? null, verifier_capability: b.verdict?.capability ?? null },
    evidence: { final_screenshot: b.evidence?.final_screenshot ? artifactUrl(ctx, b.evidence.final_screenshot) : null, gif: b.evidence?.gif ? artifactUrl(ctx, b.evidence.gif) : null, sha256: b.evidence },
    usage: b.usage, turns: b.turns, actions: b.actions, time: b.time,
    answer: displayAnswer({ created_at: new Date(rec.created_at).toISOString(), body: b }), replay: b.replay ?? null, model_calls: Number(b.usage?.calls ?? 0),
    // verified = success AND the returned value is tied to the inputs (valueBinding over the signed record)
    verified: runVerified(b), value_binding: runValueBinding(b),
    signature: { cid: rec.cid, sig: rec.sig, signed_by: rec.author, node: ctx.node.did, verify: `GET ${ctx.cfg.publicBaseUrl}/v1/records/${rec.cid}, or the MCP verify_record tool` },
    page: `${ctx.cfg.skillsWebUrl}/skills/runs/${rec.cid}`,
  };
}

/** Replays per slug (all versions), never counting a publishing run: { slug: { replays, verified, real_site, mock_site } }. */
export async function replayCountsBySlug(ctx: AppContext) {
  const out = new Map<string, { replays: number; verified_replays: number; new_input_replays: number }>();
  for (const row of await runRows(ctx)) {
    const k = classifyRun(ctx, row, JSON.parse(row.body_text));
    if (k.kind !== "replay") continue;
    const o = out.get(row.slug) ?? { replays: 0, verified_replays: 0, new_input_replays: 0 };
    o.replays++; if (row.success) o.verified_replays++; if (k.new_inputs) o.new_input_replays++;
    out.set(row.slug, o);
  }
  return out;
}
