/**
 * Trust card for a skill (find_skill, check_workflow, GET /v1/skills/:cid and the web skill page): what an agent needs
 * to decide whether to reuse it, computed only from the signed run records, the benchmark records and the skill
 * record. Where there is no data it says "unknown" or "none yet"; nothing is estimated. No model calls.
 */
import type { AppContext } from "../context.js";
import { effectiveRiskFlags, gatedSteps, runVerified, isNoMatch, displayAnswer, isDidKey } from "@agentboard/core";
import { runRows, requester, classifyRun, siteKind, SITE_LABEL } from "./skillMetrics.js";

const DAY = 86_400_000;
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r4 = (x: number | null) => (x == null ? null : Math.round(x * 10000) / 10000);
const host = (u?: string | null) => { try { return new URL(String(u ?? "").replace(/\{\{[^}]*\}\}/g, "x")).hostname.replace(/^www\./, ""); } catch { return null; } };
const shortReason = (s: string) => { const t = s.replace(/^Not verified:\s*/i, "").replace(/\s*Final URL \S+\.?\s*$/, "").trim(); return t.length > 200 ? `${t.slice(0, 197).replace(/\s+\S*$/, "")}…` : t; };

export const RUNS_WHERE = "Agentboard's hosted Playwright executor (headless Chromium) on Render; nothing runs on the caller's machine";
export const VISIBILITY = "public: every run's inputs, result, final screenshot and the node-signed, hash-chained run record";

/** Trust cards keyed by slug, for the given skills (their latest version's body). */
export async function trustCards(ctx: AppContext, skills: { slug: string; name: string; body: any }[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  if (!skills.length) return out;
  const slugs = skills.map((s) => s.slug);
  const now = ctx.now();
  const rows = await runRows(ctx, "WHERE s.slug = ANY($1)", [slugs], 2000);
  const benches = (await ctx.db.query<any>(`SELECT b.skill_slug, b.agent_a, b.agent_b, r.body->'runs' AS runs FROM benchmarks b JOIN records r ON r.cid = b.record_cid WHERE b.skill_slug = ANY($1)`, [slugs]).catch(() => ({ rows: [] as any[] }))).rows;
  const seeded = new Set((await ctx.db.query<any>(`SELECT agent_a, agent_b FROM benchmarks`).catch(() => ({ rows: [] as any[] }))).rows.flatMap((b) => [b.agent_a, b.agent_b]));
  const parsed = rows.map((row) => { const body = JSON.parse(row.body_text); return { row, body, rq: requester(row, body), kind: classifyRun(ctx, row, body).kind, verified: runVerified(body) }; });
  const dids = [...new Set(parsed.map((p) => p.rq.agent).filter((d): d is string => isDidKey(d)))];
  const agents = new Map((dids.length ? (await ctx.db.query<any>(`SELECT did, name, is_house, status FROM agents WHERE did = ANY($1)`, [dids])).rows : []).map((a) => [a.did, a]));
  const ipHashes = new Map((await ctx.db.query<any>(`SELECT id, client_ip_hash FROM skill_jobs WHERE via = 'public' AND skill_cid IN (SELECT cid FROM skills WHERE slug = ANY($1))`, [slugs])).rows.map((j) => [j.id, j.client_ip_hash]));
  const vouched = ctx.cfg.agentRunVouchedDids ?? [];

  for (const s of skills) {
    const runs = parsed.filter((p) => p.row.slug === s.slug);
    const sk = s.body.skill ?? {};
    const startUrl = s.body.source?.start_url ?? null;
    const kind = siteKind(ctx, startUrl);
    const flags = effectiveRiskFlags(sk);
    const gated = gatedSteps(sk);
    const readOnly = flags.every((f: string) => f === "none");
    // verified = a value tied to the inputs; no hit = the site said "no results" for exactly these inputs (also verified)
    const noHit = runs.filter((p) => p.verified && isNoMatch(p.body));
    const ok = runs.filter((p) => p.verified && !isNoMatch(p.body)), bad = runs.filter((p) => !p.verified);
    const within = (p: (typeof runs)[number], days: number) => now - new Date(p.row.created_at).getTime() <= days * DAY;
    const window = (days: number) => ({ verified: ok.filter((p) => within(p, days)).length, verified_no_hit: noHit.filter((p) => within(p, days)).length, failed: bad.filter((p) => within(p, days)).length });
    const withValue = ok.find((p) => p.body.answer?.value != null) ?? ok[0];
    const lastNoHit = noHit[0];
    const lastFail = bad[0];
    const key = (p: (typeof runs)[number]) => JSON.stringify(Object.entries(p.body.params ?? {}).map(([k, v]) => [k, String(v).trim().toLowerCase()]).sort());
    // identities: the operator's own runs, its own agents (house / vouched: run by the same person), the operator's
    // seeded benchmark identities, anonymous public trials, and independent agents (none of the above)
    const ids = { house: 0, own: new Map<string, { name: string; did: string; label: string; runs: number; verified: number }>(), seeded: new Map<string, number>(), anon: 0, anonCallers: new Set<string>(), indep: new Map<string, { name: string; did: string; runs: number; verified: number }>() };
    for (const p of runs) {
      const d = p.rq.agent;
      if (p.rq.via === "public") { ids.anon++; const h = ipHashes.get(p.rq.job ?? ""); if (h) ids.anonCallers.add(h); continue; }
      if (!isDidKey(d)) { ids.house++; continue; }
      const a = agents.get(d);
      if (p.rq.via === "benchmark" || seeded.has(d)) { ids.seeded.set(d, (ids.seeded.get(d) ?? 0) + 1); continue; }
      if (a?.is_house || vouched.includes(d)) {
        const o = ids.own.get(d) ?? { name: a?.name ?? `…${d.slice(-6)}`, did: d, label: a?.is_house ? "HOUSE bot, run by the Agentboard operator; not independent" : "VOUCHED, an agent operated by the same person who runs Agentboard; not independent", runs: 0, verified: 0 };
        o.runs++; if (p.verified) o.verified++; ids.own.set(d, o); continue;
      }
      const o = ids.indep.get(d) ?? { name: a?.name ?? `…${d.slice(-6)}`, did: d, runs: 0, verified: 0 };
      o.runs++; if (p.verified) o.verified++; ids.indep.set(d, o);
    }
    // time and cost: reuse = verified replays (not the publishing run); cold = the cold arm of signed benchmarks
    const reuse = ok.filter((p) => p.kind === "replay");
    const reuseTrace = reuse.filter((p) => p.body.replay?.mode === "trace");
    const colds = benches.filter((b) => b.skill_slug === s.slug).map((b) => b.runs?.cold).filter((c) => c?.success);
    const h = host(startUrl);
    out.set(s.slug, {
      site: h ?? "unknown", site_kind: SITE_LABEL[kind], task: s.name,
      input_schema: Object.fromEntries((sk.params ?? []).map((p: any) => [p.name, `string: ${p.description ?? ""}`.trim()])),
      example: withValue ? { input: withValue.body.params ?? {}, output: displayAnswer({ created_at: withValue.row.created_at, body: withValue.body })?.value ?? null, run: withValue.row.cid, at: new Date(withValue.row.created_at).toISOString() } : "none yet",
      when_not_to_use: [
        `tasks on a site other than ${h ?? "its start site"}`,
        ...(readOnly ? ["changing anything on the site: it only reads"] : []),
        "anything behind a login (not supported)",
        "an easy lookup you can already do with one API call: call that API instead",
        ...(bad.length ? [`inputs like the failed ones (latest_failure; ${bad.length} failed run${bad.length === 1 ? "" : "s"} in total, each public)`] : []),
      ],
      last_verified_run: ok[0] ? { at: new Date(ok[0].row.created_at).toISOString(), run: ok[0].row.cid } : "none yet",
      runs_7d: window(7), runs_30d: window(30),
      no_hit: sk.empty_result?.text
        ? { label: "Verified: no hit", signal: sk.empty_result.text, meaning: `the site said "${sk.empty_result.text}" for exactly the given input (tied by the page URL, the echoed search field, the search request or the page text). This is a verified negative, not a failure.`,
            latest: lastNoHit ? { at: new Date(lastNoHit.row.created_at).toISOString(), input: lastNoHit.body.params ?? {}, site_says: lastNoHit.body.no_match?.signal ?? sk.empty_result.text, tied_by: lastNoHit.body.no_match?.by ?? {}, run: lastNoHit.row.cid } : "none yet" }
        : "not declared: a run with no value is reported as not verified",
      latest_failure: lastFail ? { at: new Date(lastFail.row.created_at).toISOString(), input: lastFail.body.params ?? {}, reason: shortReason(String(lastFail.body.verdict?.evidence ?? lastFail.body.replay?.fail_fast ?? "unknown")), run: lastFail.row.cid } : "none yet",
      distinct_inputs_tested: { total: new Set(runs.map(key)).size, verified: new Set(ok.map(key)).size, verified_no_hit: new Set(noHit.map(key)).size },
      identities: {
        operator_house: { runs: ids.house, label: "the Agentboard operator (web replay panel, operator token, publishing runs)" },
        own_agents: [...ids.own.values()],
        seeded_benchmark: { identities: ids.seeded.size, runs: [...ids.seeded.values()].reduce((a, b) => a + b, 0), label: "fresh identities the operator generated for the reuse benchmark; not independent" },
        anonymous_public: { runs: ids.anon, distinct_callers: ids.anonCallers.size, label: "capped public try_skill replays (no identity)" },
        independent_agents: { identities: ids.indep.size, runs: [...ids.indep.values()].reduce((a, b) => a + b.runs, 0), agents: [...ids.indep.values()] },
      },
      time_cost: {
        reuse: reuse.length ? { verified_runs: reuse.length, median_ms: median(reuse.map((p) => Number(p.body.duration_ms) || 0).filter(Boolean)), median_model_calls: median(reuse.map((p) => Number(p.body.usage?.calls ?? 0))), median_usd: r4(median(reuse.map((p) => Number(p.body.usage?.usd ?? 0)))), trace_replays_with_no_model_call: reuseTrace.filter((p) => !Number(p.body.usage?.calls ?? 0)).length } : "none yet",
        cold: colds.length ? { benchmarks: colds.length, median_ms: median(colds.map((c) => Number(c.executor_ms) || 0)), median_model_calls: median(colds.map((c) => Number(c.model_calls) || 0)), median_usd: r4(median(colds.map((c) => Number(c.usd) || 0))), source: "cold arm of the signed reuse benchmarks (same task and input, no skill)" } : "unknown (no cold benchmark for this skill yet)",
        who_pays: `run_skill (local MCP server): the caller pays ${ctx.cfg.skillsAgentRunCredits} Agentboard credits per run, refunded only if the run cannot be dispatched. try_skill (public MCP, allowlisted skills): free to the caller, capped per day and per IP; the node (house) pays. Any model calls are paid from the node's model budget, never by the caller.`,
      },
      login_required: flags.includes("login_required") ? "yes" : "none",
      runs_where: RUNS_WHERE,
      visibility: VISIBILITY,
      actions: readOnly ? "read-only (navigates, types into search boxes, reads the page)" : `may change data: ${flags.filter((f: string) => f !== "none").join(", ")}`,
      approvals: gated.length ? gated.map((g: any) => `step ${g.index + 1} (${sk.steps?.[g.index]?.intent ?? ""}) pauses until a human approves it`) : "none",
      on_failure: "Replays the recorded steps with no model calls. If the skill declares the site's no-results wording and the site shows it for exactly this input, the run is signed as Verified: no hit (outcome no_match). Otherwise, if the input is not on the site, the run stops at once (no model call) and is recorded as failed with the reason. If a recorded step no longer fits the page, the executor falls back to the model loop from that step; if that fails too the run is recorded as failed. A value not tied to the inputs is never returned as verified. Failed runs are public like the rest.",
    });
  }
  return out;
}

/**
 * Verified replays of a skill by registered agent identities other than the operator, its seeded benchmark identities
 * and anonymous public trials: the latest per identity, each labeled own (house / vouched: operated by the same person
 * who runs Agentboard, not independent) or independent. Nothing is shown for identities that never ran it.
 */
export async function agentReuses(ctx: AppContext, slug: string) {
  const rows = await runRows(ctx, "WHERE s.slug = $1", [slug], 2000);
  const seeded = new Set((await ctx.db.query<any>(`SELECT agent_a, agent_b FROM benchmarks`).catch(() => ({ rows: [] as any[] }))).rows.flatMap((b) => [b.agent_a, b.agent_b]));
  const vouched = ctx.cfg.agentRunVouchedDids ?? [];
  const latest = new Map<string, any>();
  for (const row of rows) {
    const body = JSON.parse(row.body_text);
    const rq = requester(row, body);
    if (rq.via !== "agent" || !isDidKey(rq.agent) || seeded.has(rq.agent) || !runVerified(body) || latest.has(rq.agent)) continue;
    latest.set(rq.agent, { row, body });
  }
  if (!latest.size) return [];
  const agents = new Map((await ctx.db.query<any>(`SELECT did, name, is_house, status FROM agents WHERE did = ANY($1)`, [[...latest.keys()]])).rows.map((a) => [a.did, a]));
  return [...latest.entries()].filter(([did]) => !["hidden", "retracted"].includes(agents.get(did)?.status)).map(([did, { row, body }]) => {
    const a = agents.get(did);
    const own = Boolean(a?.is_house) || vouched.includes(did);
    return {
      did, name: a?.name ?? `…${did.slice(-6)}`, independent: !own,
      label: a?.is_house ? "HOUSE bot run by the Agentboard operator; not independent" : own ? "VOUCHED: an agent operated by the same person who runs Agentboard; not independent" : "a registered agent not run by the operator",
      run: row.cid, at: new Date(row.created_at).toISOString(), input: body.params ?? {}, value: displayAnswer({ created_at: row.created_at, body })?.value ?? null,
      model_calls: Number(body.usage?.calls ?? 0), usd: Number(body.usage?.usd ?? 0), executor_ms: Number(body.duration_ms) || null, replay_mode: body.replay?.mode ?? null,
      page: `${ctx.cfg.skillsWebUrl}/skills/runs/${row.cid}`,
    };
  });
}
