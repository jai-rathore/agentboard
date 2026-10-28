/**
 * Public, read-only numbers for Agentboard Skills, derived from the signed `skill` / `skill_run`
 * records (and the Muse spend ledger). Nothing here calls a model.
 */
import type { AppContext } from "../context.js";
import { HttpError } from "../context.js";
import { museSpend } from "./muse.js";
import { APPROVAL_HUMAN_MS } from "./skills.js";

const CLICKY = new Set(["click", "double_click", "select", "keypress", "type", "scroll", "drag"]);

interface RunRow { cid: string; skill_cid: string; success: boolean; created_at: string; body_text: string; slug: string; version: number; name: string; seq: number; job_id: string | null; job_via: string | null; job_by: string | null }

async function runRows(ctx: AppContext, where = "", params: unknown[] = [], limit = 5000): Promise<RunRow[]> {
  return (await ctx.db.query<any>(
    `SELECT r.cid, r.skill_cid, r.success, r.created_at, rec.body_text, s.slug, s.version, s.name, l.seq::int AS seq,
        j.id AS job_id, j.via AS job_via, j.requested_by AS job_by
     FROM skill_runs r JOIN records rec ON rec.cid = r.cid JOIN skills s ON s.cid = r.skill_cid JOIN log l ON l.cid = r.cid
     LEFT JOIN skill_jobs j ON j.result->>'run_cid' = r.cid
     ${where} ORDER BY r.created_at DESC LIMIT ${Math.max(1, Math.min(limit, 5000))}`, params)).rows;
}

/** Who asked for a run: the signed run record says so for new runs; older runs fall back to the job table. */
function requester(row: RunRow, body: any) {
  const rq = body.requested_by;
  if (rq?.via === "agent" && rq.agent) return { via: "agent" as const, agent: rq.agent as string, job: rq.job ?? row.job_id };
  if (rq?.via) return { via: rq.via as string, agent: null, job: rq.job ?? row.job_id };
  if (row.job_via === "agent" && row.job_by) return { via: "agent" as const, agent: row.job_by, job: row.job_id };
  if (row.job_via) return { via: "operator", agent: null, job: row.job_id };
  return { via: "web", agent: null, job: null };
}

export async function skillMetrics(ctx: AppContext) {
  const one = async (sql: string) => Number((await ctx.db.query<any>(sql)).rows[0]?.n ?? 0);
  const skills = await one(`SELECT count(DISTINCT slug)::int AS n FROM skills`);
  const versions = await one(`SELECT count(*)::int AS n FROM skills`);
  const vrows = (await ctx.db.query<any>(`SELECT rec.body_text FROM skills s JOIN records rec ON rec.cid = s.cid`)).rows;
  const heals = vrows.filter((r) => JSON.parse(r.body_text).healed_from).length;
  const rows = await runRows(ctx);
  let succeeded = 0, approvals = 0, clicks = 0, actions = 0, savedMs = 0, timed = 0, faster = 0, runMs = 0, agentRuns = 0, healRuns = 0;
  const agents = new Set<string>();
  for (const row of rows) {
    const b = JSON.parse(row.body_text);
    const rq = requester(row, b);
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
    runs: { total: rows.length, verified: succeeded, failed: rows.length - succeeded, success_rate: rows.length ? Math.round((succeeded / rows.length) * 1000) / 1000 : null, by_agents: agentRuns, distinct_agents: agents.size, that_healed: healRuns },
    human: {
      clicks_per_run: 0,
      approvals, approval_human_ms: APPROVAL_HUMAN_MS,
      agent_actions_done: actions, clicks_saved: clicks,
      time_saved_ms: savedMs, timed_runs: timed, runs_faster_than_human: faster, agent_run_ms_total: runMs,
      note: "Over verified replays. Human clicks are 0 by construction: a human only approves gated steps (~5 s each). Time saved = recording length minus approval time; the agent's own wall clock is not counted as human time.",
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
    return {
      run: row.cid, seq: row.seq, at: row.created_at, skill: { cid: row.skill_cid, slug: row.slug, version: row.version, name: row.name },
      via: rq.via, agent: rq.agent, job: rq.job,
      outcome: row.success ? "verified" : "not_verified", healed: Boolean(b.drift?.healed),
      human_clicks: 0, approvals: (b.actions ?? []).filter((a: any) => a.approval === "human").length,
      run_ms: b.time?.run_ms ?? b.duration_ms ?? null, recording_ms: b.time?.recording_ms ?? null,
      evidence: b.verdict?.evidence ?? null,
    };
  });
  const mine = o.agent ? out.filter((r) => r.agent === o.agent).slice(0, o.limit ?? 100) : out;
  const allDids = [...new Set(mine.map((r) => r.agent).filter(Boolean))] as string[];
  const names = new Map((allDids.length ? (await ctx.db.query<any>(`SELECT did, name, status FROM agents WHERE did = ANY($1)`, [allDids])).rows : []).map((a) => [a.did, a]));
  const inactive = (r: { agent: string | null }) => Boolean(r.agent) && names.get(r.agent!)?.status !== "active";
  const showHidden = Boolean(o.includeHidden || o.agent);
  const filtered = showHidden ? mine : mine.filter((r) => !inactive(r));
  const hiddenRuns = showHidden ? 0 : mine.length - filtered.length;
  const dids = [...new Set(filtered.map((r) => r.agent).filter(Boolean))] as string[];
  if (o.skill && !filtered.length && !(await ctx.db.query(`SELECT 1 FROM skills WHERE slug = $1 OR cid = $1`, [o.skill])).rows[0]) throw new HttpError(404, "skill_not_found", "no such skill");
  return {
    runs: filtered.map((r) => ({ ...r, agent: r.agent ? { did: r.agent, name: names.get(r.agent)?.name ?? null, status: names.get(r.agent)?.status ?? null } : null })),
    summary: { runs: filtered.length, agents: dids.length, verified: filtered.filter((r) => r.outcome === "verified").length, hidden_runs: hiddenRuns, include_hidden: showHidden },
  };
}
