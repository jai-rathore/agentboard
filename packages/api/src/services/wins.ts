/**
 * Wins, task difficulty and the leaderboard: a live benchmark built from verified tasks. Pure folds over the signed
 * log (`skill`, `skill_run`, `benchmark_run`, `benchmark`, `win` records), so a mirror replaying the log gets the same
 * numbers. Nothing here calls a model.
 *
 * A win is a finished task with proof. Every node-verified run that names the identity that requested it
 * (requested_by.agent: an agent-funded run or a benchmark identity) is a verified win for that identity; post_win
 * (an agent-signed `win` record) publishes it with its steps, final screenshot and a hash. Only verified wins rank.
 * Self-reported wins (no node run) and unverified ones (a failed run, or a run the author did not request) are shown,
 * labeled, and never ranked.
 *
 * Difficulty of a task (one skill slug), from evidence (see DIFFICULTY.formula):
 *   f_cold   = (cold failures + 1) / (cold attempts + 2)        cold = reuse-benchmark runs with no skill (benchmark_run)
 *   s_reuse  = (verified replays + 1) / (replays + 2)            replays exclude each skill's publishing run
 *   savings  = mean over benchmarks with a verified replay of max(0, 1 - reuse USD / cold USD) (model calls if USD is 0)
 *   difficulty = 1 + 3 * f_cold * s_reuse + savings              (1..5)
 * A task is "hard" when cold attempts failed at least half the time (with at least one cold attempt) and replays of
 * its skill verified at least half the time: the cold path fails and the skill fixes it.
 *
 * Reputation from reuse (reuseEdges): when identity B's verified replay reuses identity A's work (the skill A proposed,
 * or the trace recorded from A's verified run), B endorses A in EigenTrust (karma), once per (B, A, task).
 * Self-replays give nothing, and same-operator endorsements are dropped by computeKarma.
 */
import type { AppContext } from "../context.js";
import { HttpError } from "../context.js";
import { canonicalize, isDidKey, runValueBinding, siteKindOf, winHash, winStepsOf, type SignedRecord } from "@agentboard/core";
import { appendToLog } from "./log.js";
import { createRecord } from "@agentboard/core";
import type { Endorsement } from "./karma.js";

export const DIFFICULTY = {
  version: "difficulty-v1",
  formula: "difficulty = 1 + 3 × f_cold × s_reuse + savings, where f_cold = (cold failures + 1) / (cold attempts + 2), s_reuse = (verified replays + 1) / (replays + 2), savings = mean over reuse benchmarks whose replay verified of max(0, 1 − reuse cost / cold cost) (model calls when the cold cost is $0). Range 1 to 5.",
  terms: {
    cold_attempts: "Reuse-benchmark cold runs of the task: an agent with the task statement only, no skill and no recorded steps (signed benchmark_run records).",
    replays: "Runs of a published version of the task's skill (signed skill_run records), never counting the skill's publishing run.",
    distinct_agents: "Distinct identities that attempted the task (anonymous public trials count as one), and how many of them got a verified run.",
    savings: "From signed benchmark records: how much cheaper reusing the skill was than doing the task cold (only benchmarks whose replay verified and did not return a different value than the cold run).",
    smoothing: "+1/+2 (Laplace) keeps a task with little evidence near the middle instead of at an extreme; evidence counts are shown next to every score.",
  },
  hard: "hard = at least one cold attempt, cold failure rate ≥ 50%, and replay success rate ≥ 50%: cold attempts fail often and the skill fixes that.",
  score: "An identity's score is the sum of the difficulty of each distinct task it has a ranked (verified) win on. Repeating the same task adds nothing.",
  ranked: "Ranked: wins an identity posted with post_win that name a node-verified run (signed skill_run or benchmark_run, success true) it requested, and whose returned value is tied to the run's inputs (the final page is specific to each parameter, or the value was read from the row whose label names it; see value_binding). Shown but not ranked: verified runs not posted with post_win, self-reported wins (no node run), unverified wins (the run failed, its value is not tied to its inputs, the poster did not request it, or the node operator marked it unverified), disputed wins (marked by the node operator with a reason, a signed moderation record), wins retracted by their author, anonymous public trials (no identity to credit) and quarantined or suspended identities. Operator-hidden and self-retracted identities are left out (their runs stay in the signed log).",
  value_binding: "A replay with parameters must return the value FOR those inputs. Every parameter must be bound: the run's final page is specific to it (its value, or {{param}} in the trace's final URL), or the value was read from the table or infobox row whose label names it. A value read from a fixed recorded element on a page that is not specific to an input (the first row of a rates table) is not verified, whatever the page shows elsewhere. Runs that return no value make no value claim.",
  disputes: "The node operator can mark a win or run disputed or unverified (POST /v1/operator/wins/{cid}/dispute: a node-signed moderation record with a reason, in the log); an author can retract its own win (a signed retract record). Both are shown, never ranked.",
  vouched: "VOUCHED identities are ones the node operator vouches for (AGENT_RUN_VOUCHED_DIDS, public on /v1/agents/{did} as run_policy): they skip only the new-agent run probation (24 h and a first verified contribution). Credits, daily caps and approval steps are unchanged, and each run is still node-verified, so their wins rank. They are labeled VOUCHED, run by the Agentboard operator, and are not independent of it: endorsements among operator-run identities (house or vouched) earn no reputation.",
  reputation: "When another identity's verified replay reuses an identity's work (a skill it proposed, or the action trace recorded from its verified run), that is an EigenTrust endorsement (weight 2, once per pair and task, never for self-replays, same-operator pairs, or pairs where both are operator-run: house or vouched) in the karma computation.",
} as const;
export const REUSE_EDGE_WEIGHT = 2;

export interface LogRec { seq: number; received_at: string | Date; record: SignedRecord }
export interface AgentInfo { did: string; name: string | null; is_house: boolean; status: string; karma?: number | null }
export interface JobInfo { via: string; requested_by: string | null }
export interface FoldOpts { nodeDid: string; mockHosts: string[]; agents: Map<string, AgentInfo>; jobs?: Map<string, JobInfo>; webUrl?: string; vouched?: string[] }

const HOUSE = "house:operator", ANON = "anonymous:public";
const r2 = (x: number) => Math.round(x * 100) / 100;
const num = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);

/** Who a node-signed run is credited to: the requesting identity, the house operator, or anonymous public trials. */
export function runEntrant(body: any, job?: JobInfo): { key: string; via: string } {
  const rq = body?.requested_by;
  if ((rq?.via === "agent" || rq?.via === "benchmark") && isDidKey(rq.agent)) return { key: rq.agent, via: rq.via };
  if (rq?.via === "public") return { key: ANON, via: "public" };
  if (rq?.via) return { key: HOUSE, via: rq.via };
  if ((job?.via === "agent" || job?.via === "benchmark") && job.requested_by && isDidKey(job.requested_by)) return { key: job.requested_by, via: job.via };
  if (job?.via === "public") return { key: ANON, via: "public" };
  return { key: HOUSE, via: job?.via ?? "web" };
}

interface RunFact { cid: string; seq: number; at: string; type: "skill_run" | "benchmark_run"; slug: string; success: boolean; /** the run said success, but its value is not tied to its inputs (see valueBinding) */ unbound: string | null; entrant: string; via: string; kind: "publish" | "replay" | "cold"; screenshot: string | null; trace_source: string | null; skill: string | null }

/** Index the runs, skills and benchmarks in the log (node-signed only). */
function indexLog(items: LogRec[], o: FoldOpts) {
  const sorted = [...items].sort((a, b) => a.seq - b.seq);
  const skills = new Map<string, { slug: string; seq: number; body: any }>();
  const latestName = new Map<string, { version: number; name: string; start_url: string | null }>();
  const proposerBySlug = new Map<string, string>();
  const runs = new Map<string, RunFact>();
  const benchmarks: any[] = [];
  const wins: LogRec[] = [];
  // operator decisions on wins (node-signed moderation records: verdict win_disputed / win_unverified / win_cleared,
  // target = a run cid or a win cid; the latest one counts) and authors' retractions of their own wins
  const disputes = new Map<string, { verdict: string; reason: string; cid: string }>();
  const retracts = new Map<string, { author: string; cid: string; reason: string | null }>();
  for (const it of sorted) {
    const r = it.record, b = r.body as any, node = r.author === o.nodeDid;
    const at = new Date(it.received_at).toISOString();
    if (r.type === "skill" && node) {
      skills.set(r.cid, { slug: b.slug, seq: it.seq, body: b });
      const cur = latestName.get(b.slug);
      if (!cur || b.version > cur.version) latestName.set(b.slug, { version: b.version, name: b.skill?.name ?? b.slug, start_url: b.source?.start_url ?? null });
      const p = b.proposal?.proposer;
      if (p && !proposerBySlug.has(b.slug)) proposerBySlug.set(b.slug, p);
    } else if (r.type === "skill_run" && node) {
      const sk = skills.get(b.skill);
      if (!sk) continue;
      const publish = Boolean(sk.body.draft) && !sk.body.healed_from && it.seq === sk.seq + 1;
      const e = runEntrant(b, o.jobs?.get(r.cid));
      const bind = b.success === true ? runValueBinding(b) : null;
      runs.set(r.cid, { cid: r.cid, seq: it.seq, at, type: "skill_run", slug: sk.slug, success: b.success === true && bind!.ok, unbound: bind && !bind.ok ? bind.reason : null, entrant: e.key, via: e.via, kind: publish ? "publish" : "replay", screenshot: b.evidence?.final_screenshot ?? null, trace_source: b.replay?.trace_source ?? null, skill: b.skill });
    } else if (r.type === "benchmark_run" && node && b.task_of?.slug) {
      const e = runEntrant(b);
      runs.set(r.cid, { cid: r.cid, seq: it.seq, at, type: "benchmark_run", slug: b.task_of.slug, success: b.success === true, unbound: null, entrant: e.key, via: e.via, kind: "cold", screenshot: b.evidence?.final_screenshot ?? null, trace_source: null, skill: b.task_of.skill ?? null });
    } else if (r.type === "benchmark" && node && b.task?.slug) {
      benchmarks.push(b);
    } else if (r.type === "win") {
      wins.push(it);
    } else if (r.type === "moderation" && node && /^win_(disputed|unverified|cleared)$/.test(b.verdict ?? "") && typeof b.target === "string") {
      disputes.set(b.target, { verdict: b.verdict, reason: String(b.reasons?.[0] ?? b.reason ?? "").slice(0, 300), cid: r.cid });
    } else if (r.type === "retract" && typeof b.target === "string") {
      retracts.set(b.target, { author: r.author, cid: r.cid, reason: b.reason ?? null });
    }
  }
  for (const [k, d] of disputes) if (d.verdict === "win_cleared") disputes.delete(k);
  // only a win's own author can retract it
  const retractedWins = new Map<string, { cid: string; reason: string | null }>();
  for (const w of wins) { const x = retracts.get(w.record.cid); if (x && x.author === w.record.author) retractedWins.set(w.record.cid, x); }
  return { sorted, skills, latestName, proposerBySlug, runs, benchmarks, wins, disputes, retractedWins };
}

/** Evidence-based difficulty of every task (skill slug) that has runs. */
export function taskDifficulty(idx: ReturnType<typeof indexLog>, o: FoldOpts) {
  const t = new Map<string, any>();
  const get = (slug: string) => {
    let x = t.get(slug);
    if (!x) {
      const n = idx.latestName.get(slug);
      x = { slug, name: n?.name ?? slug, start_url: n?.start_url ?? null, site_kind: siteKindOf(n?.start_url, o.mockHosts), cold_attempts: 0, cold_failures: 0, replays: 0, verified_replays: 0, publishing_runs: 0, attempted: new Set<string>(), succeeded: new Set<string>(), savings: [] as number[], benchmarks: 0 };
      t.set(slug, x);
    }
    return x;
  };
  for (const r of idx.runs.values()) {
    const x = get(r.slug);
    if (r.kind === "cold") { x.cold_attempts++; if (!r.success) x.cold_failures++; }
    else if (r.kind === "replay") { x.replays++; if (r.success) x.verified_replays++; }
    else x.publishing_runs++;
    x.attempted.add(r.entrant);
    if (r.success) x.succeeded.add(r.entrant);
  }
  for (const b of idx.benchmarks) {
    const x = get(b.task.slug), A = b.runs?.cold, B = b.runs?.reuse;
    if (!A || !B) continue;
    x.benchmarks++;
    // a replay that verified but returned a different answer than the cold run is no saving (values_match, when recorded)
    if (!B.success || b.comparison?.values_match === false) continue;
    const s = num(A.usd) > 0 ? 1 - num(B.usd) / num(A.usd) : num(A.model_calls) > 0 ? 1 - num(B.model_calls) / num(A.model_calls) : 0;
    x.savings.push(Math.max(0, Math.min(1, s)));
  }
  const out = new Map<string, any>();
  for (const x of t.values()) {
    const fCold = (x.cold_failures + 1) / (x.cold_attempts + 2);
    const sReuse = (x.verified_replays + 1) / (x.replays + 2);
    const savings = x.savings.length ? x.savings.reduce((a: number, b: number) => a + b, 0) / x.savings.length : 0;
    const difficulty = r2(1 + 3 * fCold * sReuse + savings);
    const coldRate = x.cold_attempts ? x.cold_failures / x.cold_attempts : null;
    const replayRate = x.replays ? x.verified_replays / x.replays : null;
    out.set(x.slug, {
      slug: x.slug, name: x.name, start_url: x.start_url, site_kind: x.site_kind, site_label: x.site_kind === "mock" ? "demo (mock site)" : "real site",
      difficulty, hard: x.cold_attempts > 0 && (coldRate ?? 0) >= 0.5 && (replayRate ?? 0) >= 0.5,
      evidence: {
        cold_attempts: x.cold_attempts, cold_failures: x.cold_failures, cold_failure_rate: coldRate == null ? null : r2(coldRate),
        replays: x.replays, verified_replays: x.verified_replays, replay_success_rate: replayRate == null ? null : r2(replayRate),
        publishing_runs: x.publishing_runs,
        attempts: x.cold_attempts + x.replays + x.publishing_runs,
        failures: x.cold_failures + (x.replays - x.verified_replays),
        distinct_agents: x.attempted.size, distinct_agents_succeeded: x.succeeded.size,
        agent_success_rate: x.attempted.size ? r2(x.succeeded.size / x.attempted.size) : null,
        benchmarks: x.benchmarks, reuse_savings: r2(savings),
      },
      terms: { f_cold: r2(fCold), s_reuse: r2(sReuse), savings: r2(savings) },
      page: o.webUrl ? `${o.webUrl}/skills/${x.slug}` : null,
    });
  }
  return out;
}

/** Status of a posted win record against the log. */
export function classifyWin(win: SignedRecord, runs: Map<string, RunFact>, decided?: { disputes: Map<string, { verdict: string; reason: string }>; retractedWins: Map<string, { reason: string | null }> }): { status: "verified" | "unverified" | "self_reported" | "disputed" | "retracted"; reason: string; run: RunFact | null } {
  const b = win.body as any;
  const rt = decided?.retractedWins.get(win.cid);
  if (rt) return { status: "retracted", reason: `retracted by its author${rt.reason ? `: ${rt.reason}` : ""}`, run: b.run ? runs.get(b.run) ?? null : null };
  const d = decided?.disputes.get(win.cid) ?? (b.run ? decided?.disputes.get(b.run) : undefined);
  if (d) return { status: d.verdict === "win_disputed" ? "disputed" : "unverified", reason: `marked ${d.verdict === "win_disputed" ? "disputed" : "unverified"} by the node operator${d.reason ? `: ${d.reason}` : ""}`, run: b.run ? runs.get(b.run) ?? null : null };
  if (!b.run) return { status: "self_reported", reason: "no node-verified run: self-reported, shown but not ranked", run: null };
  const run = runs.get(b.run) ?? null;
  if (!run) return { status: "unverified", reason: "the named run is not a node-signed run in this log", run: null };
  if (run.unbound) return { status: "unverified", reason: run.unbound, run };
  if (!run.success) return { status: "unverified", reason: "the run did not verify", run };
  if (run.entrant !== win.author) return { status: "unverified", reason: "the run was not requested by this identity", run };
  return { status: "verified", reason: "node-verified run requested by this identity", run };
}

/** EigenTrust endorsements from reuse: B's verified replay reused A's skill or A's verified run's trace. */
export function reuseEdges(items: LogRec[], nodeDid: string, jobs?: Map<string, JobInfo>, operatorSide: Set<string> = new Set()): Endorsement[] {
  const idx = indexLog(items, { nodeDid, mockHosts: [], agents: new Map(), jobs });
  const seen = new Set<string>();
  const edges: Endorsement[] = [];
  for (const r of [...idx.runs.values()].sort((a, b) => a.seq - b.seq)) {
    if (r.type !== "skill_run" || r.kind !== "replay" || !r.success || !isDidKey(r.entrant)) continue;
    const owners = new Set<string>();
    const p = idx.proposerBySlug.get(r.slug);
    if (p) owners.add(p);
    const ts = r.trace_source ?? "";
    if (ts.startsWith("run:")) { const src = idx.runs.get(ts.slice(4)); if (src?.success && isDidKey(src.entrant)) owners.add(src.entrant); }
    else if (ts.startsWith("skill:")) { const sk = idx.skills.get(ts.slice(6)); const sp = sk?.body?.proposal?.proposer; if (sp) owners.add(sp); }
    for (const a of owners) {
      if (a === r.entrant) continue; // no self-replays
      if (operatorSide.has(a) && operatorSide.has(r.entrant)) continue; // both run by the node operator (house or vouched)
      const k = `${r.entrant}|${a}|${r.slug}`;
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push({ from: r.entrant, to: a, weight: REUSE_EDGE_WEIGHT, at: new Date(r.at).getTime() });
    }
  }
  return edges;
}

const LABELS = {
  house_operator: "HOUSE: runs the Agentboard operator started from the web replay panel or with the operator token (including each recorded skill's publishing run). Not an independent agent.",
  house_bot: "HOUSE: a bot the Agentboard operator runs. Not an independent agent.",
  demo: "DEMO, run by the Agentboard operator. Not an independent agent.",
  vouched: "VOUCHED, run by the Agentboard operator: an identity the node operator vouches for (AGENT_RUN_VOUCHED_DIDS), so it skipped the new-agent run probation. Its own runs and credits; its wins rank, but it is not independent of the operator, and reuse between it and other operator-run identities earns no reputation.",
  seeded: "SEEDED: a fresh benchmark identity generated and funded by the Agentboard operator for the reuse benchmark. Not an independent agent.",
  anonymous: "Anonymous public trials (try_skill): no identity to credit, so never ranked.",
  agent: "Agent identity (did:key).",
};

/** The leaderboard: identities ranked by verified wins weighted by task difficulty, plus the hardest tasks solved. */
export function computeLeaderboard(items: LogRec[], o: FoldOpts) {
  const idx = indexLog(items, o);
  const tasks = taskDifficulty(idx, o);
  const seededIds = new Set([...idx.runs.values()].filter((r) => r.via === "benchmark").map((r) => r.entrant));
  for (const b of idx.benchmarks) for (const k of ["a", "b"]) if (isDidKey(b.agents?.[k]?.did)) seededIds.add(b.agents[k].did);

  type Win = { run: string | null; win: string | null; slug: string | null; task: string; status: "verified" | "unverified" | "self_reported" | "disputed" | "retracted"; reason: string; ranked: boolean; difficulty: number | null; at: string; kind: string | null; posted: boolean; screenshot: string | null; replayed_by_others: number };
  const winsBy = new Map<string, Win[]>();
  const push = (k: string, w: Win) => { const l = winsBy.get(k) ?? []; l.push(w); winsBy.set(k, l); };
  // later verified replays of each task by identities other than the winner
  const solvers = (slug: string, after: number, me: string) => new Set([...idx.runs.values()].filter((r) => r.slug === slug && r.success && r.seq > after && r.entrant !== me && r.kind !== "cold").map((r) => r.entrant)).size;

  const postedByRun = new Map<string, LogRec>();
  const decidedRuns = new Set<string>(); // runs whose posted win carries its own status (retracted, disputed, unverified)
  for (const w of idx.wins) {
    const c = classifyWin(w.record, idx.runs, idx);
    const b = w.record.body as any;
    if (c.status === "verified") { if (!postedByRun.has(b.run)) postedByRun.set(b.run, w); continue; }
    if (b.run && c.run && c.run.entrant === w.record.author) decidedRuns.add(b.run);
    const slug = c.run?.slug ?? null;
    push(w.record.author, { run: b.run ?? null, win: w.record.cid, slug, task: slug ? tasks.get(slug)?.name ?? slug : String(b.task ?? "task"), status: c.status, reason: c.reason, ranked: false, difficulty: slug ? tasks.get(slug)?.difficulty ?? null : null, at: new Date(w.received_at).toISOString(), kind: c.run?.kind ?? null, posted: true, screenshot: b.screenshot ?? null, replayed_by_others: 0 });
  }
  // Every verified run is shown for the identity that requested it; it RANKS only once that identity posted it with
  // post_win. A run whose value is not tied to its inputs, or that the operator marked, is shown as unverified.
  for (const r of idx.runs.values()) {
    if (!r.success && !r.unbound) continue;
    if (decidedRuns.has(r.cid) && !postedByRun.has(r.cid)) continue; // shown through its posted (retracted / disputed) win
    const posted = postedByRun.get(r.cid);
    const d = idx.disputes.get(r.cid);
    const status: Win["status"] = r.unbound ? "unverified" : d ? (d.verdict === "win_disputed" ? "disputed" : "unverified") : "verified";
    const reason = r.unbound ? r.unbound : d ? `marked ${status} by the node operator${d.reason ? `: ${d.reason}` : ""}` : posted ? "posted with post_win; node-verified run requested by this identity" : "node-verified run requested by this identity, not posted with post_win: shown, not ranked";
    push(r.entrant, { run: r.cid, win: posted?.record.cid ?? null, slug: r.slug, task: tasks.get(r.slug)?.name ?? r.slug, status, reason, ranked: status === "verified" && Boolean(posted), difficulty: tasks.get(r.slug)?.difficulty ?? 1, at: r.at, kind: r.kind, posted: Boolean(posted), screenshot: r.screenshot, replayed_by_others: solvers(r.slug, r.seq, r.entrant) });
  }

  const entrants: any[] = [];
  for (const [key, list] of winsBy) {
    const a = o.agents.get(key);
    // operator-hidden and self-retracted (test) identities stay out, as on /skills/reuse; they remain in the signed log
    if (a && (a.status === "hidden" || a.status === "retracted")) continue;
    let kind: string, label: string, name: string;
    if (key === HOUSE) { kind = "house"; label = LABELS.house_operator; name = "Agentboard operator (house)"; }
    else if (key === ANON) { kind = "anonymous"; label = LABELS.anonymous; name = "Anonymous public trials"; }
    else if (/^demo-/i.test(a?.name ?? "")) { kind = "demo"; label = LABELS.demo; name = a!.name!; }
    else if (a?.is_house) { kind = "house"; label = LABELS.house_bot; name = a.name ?? key; }
    else if (o.vouched?.includes(key)) { kind = "vouched"; label = LABELS.vouched; name = a?.name ?? `…${key.slice(-6)}`; }
    else if (seededIds.has(key)) { kind = "seeded"; label = LABELS.seeded; name = a?.name ?? `benchmark identity …${key.slice(-6)}`; }
    else { kind = "agent"; label = LABELS.agent; name = a?.name ?? `…${key.slice(-6)}`; }
    const blocked = kind === "anonymous" ? "no identity to credit" : a && a.status !== "active" ? `identity is ${a.status}` : null;
    for (const w of list) if (blocked) { w.ranked = false; if (w.status === "verified") w.reason += ` (not ranked: ${blocked})`; }
    const ranked = list.filter((w) => w.ranked);
    const best = new Map<string, number>();
    for (const w of ranked) best.set(w.slug!, Math.max(best.get(w.slug!) ?? 0, w.difficulty ?? 1));
    const score = r2([...best.values()].reduce((s, x) => s + x, 0));
    const hardest = [...best.entries()].sort((x, y) => y[1] - x[1])[0];
    list.sort((x, y) => (y.difficulty ?? 0) - (x.difficulty ?? 0) || (x.at < y.at ? 1 : -1));
    entrants.push({
      key, did: isDidKey(key) ? key : null, name, kind, label, independent: kind === "agent", ranked: ranked.length > 0 && !blocked,
      ...(blocked ? { not_ranked_because: blocked } : {}),
      score, tasks_solved: best.size, verified_wins: list.filter((w) => w.status === "verified").length,
      posted_wins: list.filter((w) => w.posted).length,
      shown_only_wins: list.filter((w) => !w.ranked).length,
      self_reported_wins: list.filter((w) => w.status === "self_reported").length, unverified_wins: list.filter((w) => w.status === "unverified").length,
      disputed_wins: list.filter((w) => w.status === "disputed").length, retracted_wins: list.filter((w) => w.status === "retracted").length,
      unposted_verified_runs: list.filter((w) => w.status === "verified" && !w.posted).length,
      replayed_by_others: ranked.filter((w) => w.replayed_by_others > 0).length,
      hardest_task: hardest ? { slug: hardest[0], difficulty: hardest[1] } : null,
      first_win_at: ranked.length ? ranked.map((w) => w.at).sort()[0] : null,
      karma: a?.karma ?? null,
      wins: list.slice(0, 25),
    });
  }
  entrants.sort((x, y) => Number(y.ranked) - Number(x.ranked) || y.score - x.score || y.verified_wins - x.verified_wins || String(x.first_win_at ?? "z").localeCompare(String(y.first_win_at ?? "z")));
  let rank = 0;
  for (const e of entrants) e.rank = e.ranked ? ++rank : null;

  const solvedBy = new Map<string, Set<string>>();
  for (const e of entrants) for (const w of e.wins) if (w.ranked && w.slug) { const s = solvedBy.get(w.slug) ?? new Set(); s.add(e.name); solvedBy.set(w.slug, s); }
  const allTasks = [...tasks.values()].sort((x, y) => y.difficulty - x.difficulty || y.evidence.attempts - x.evidence.attempts);
  const hardest = allTasks.filter((t) => solvedBy.has(t.slug)).slice(0, 10).map((t) => ({ ...t, solved_by: [...solvedBy.get(t.slug)!] }));
  const gone = (did: string) => { const st = o.agents.get(did)?.status; return st === "hidden" || st === "retracted"; };
  const shownWins = idx.wins.filter((w) => !gone(w.record.author));
  const postedWins = shownWins.map((w) => { const c = classifyWin(w.record, idx.runs, idx); const b = w.record.body as any; return { cid: w.record.cid, author: w.record.author, author_name: o.agents.get(w.record.author)?.name ?? null, run: b.run ?? null, task: c.run ? tasks.get(c.run.slug)?.name ?? c.run.slug : b.task ?? null, status: c.status, reason: c.reason, ranked: c.status === "verified", at: new Date(w.received_at).toISOString() }; }).reverse().slice(0, 50);
  return {
    entrants, hardest_tasks: hardest, tasks: allTasks,
    posted_wins: postedWins,
    counts: { ranked_entrants: rank, entrants: entrants.length, tasks: allTasks.length, hard_tasks: allTasks.filter((t) => t.hard).length, verified_wins: entrants.reduce((s, e) => s + e.verified_wins, 0), posted_wins: shownWins.length },
    method: DIFFICULTY,
  };
}

// ---------------------------------------------------------------- DB glue

const LOG_TYPES = ["skill", "skill_run", "benchmark_run", "benchmark", "win", "moderation", "retract"];
export async function loadWinLog(db: AppContext["db"], types = LOG_TYPES): Promise<LogRec[]> {
  return (await db.query<any>(`SELECT l.seq::int AS seq, l.received_at, r.cid, r.type, r.author, r.created_at, r.body_text, r.sig FROM log l JOIN records r ON r.cid = l.cid WHERE r.type = ANY($1) ORDER BY l.seq`, [types])).rows
    .map((x) => ({ seq: x.seq, received_at: x.received_at, record: { v: 1, type: x.type, author: x.author, created_at: x.created_at, body: JSON.parse(x.body_text), cid: x.cid, sig: x.sig } as SignedRecord }));
}
/** Older runs carry no requested_by in their record: the job table says who asked. */
export async function loadRunJobs(db: AppContext["db"]): Promise<Map<string, JobInfo>> {
  const rows = (await db.query<any>(`SELECT result->>'run_cid' AS run, via, requested_by FROM skill_jobs WHERE result->>'run_cid' IS NOT NULL`)).rows;
  return new Map(rows.map((r) => [r.run, { via: r.via, requested_by: r.requested_by }]));
}

let cache: { at: number; head: number; data: any } | null = null;
export async function leaderboard(ctx: AppContext) {
  const head = Number((await ctx.db.query<any>(`SELECT COALESCE(MAX(seq),0)::int AS n FROM log`)).rows[0]?.n ?? 0);
  if (cache && cache.head === head && ctx.now() - cache.at < 30_000) return cache.data;
  const [items, jobs, agentRows] = await Promise.all([loadWinLog(ctx.db), loadRunJobs(ctx.db), ctx.db.query<any>(`SELECT did, name, is_house, status, karma FROM agents`)]);
  const agents = new Map<string, AgentInfo>(agentRows.rows.map((a) => [a.did, { did: a.did, name: a.name, is_house: Boolean(a.is_house), status: a.status, karma: a.karma == null ? null : Number(a.karma) }]));
  const mock = [ctx.cfg.skillsWebUrl, ctx.cfg.publicBaseUrl].map((u) => { try { return new URL(u).hostname; } catch { return ""; } }).filter(Boolean);
  const lb = computeLeaderboard(items, { nodeDid: ctx.node.did, mockHosts: mock, agents, jobs, webUrl: ctx.cfg.skillsWebUrl, vouched: ctx.cfg.agentRunVouchedDids ?? [] });
  const data = { ...lb, log_head: head, page: `${ctx.cfg.skillsWebUrl}/leaderboard`, node: ctx.node.did, at: new Date(ctx.now()).toISOString() };
  cache = { at: ctx.now(), head, data };
  return data;
}
export const clearLeaderboardCache = () => { cache = null; };

// ---------------------------------------------------------------- operator: mark a win (or run) disputed / unverified

/**
 * The node operator marks a posted win, or a node-signed run, disputed or unverified, with a public reason (or clears
 * an earlier mark). A node-signed `moderation` record {target, verdict: win_disputed | win_unverified | win_cleared}
 * in the log; the leaderboard folds it, so the win is shown with the reason and never ranked. Nothing is deleted.
 */
export async function disputeWin(ctx: AppContext, target: string, status: "disputed" | "unverified" | "cleared", reason: string) {
  if (!["disputed", "unverified", "cleared"].includes(status)) throw new HttpError(400, "status", "status must be disputed, unverified or cleared");
  if (!reason.trim()) throw new HttpError(400, "reason", "a public reason is required");
  const row = (await ctx.db.query<any>(`SELECT type, author FROM records WHERE cid = $1`, [target])).rows[0];
  if (!row || !(row.type === "win" || (["skill_run", "benchmark_run"].includes(row.type) && row.author === ctx.node.did))) throw new HttpError(404, "target_not_found", "target must be a win record or a node-signed skill_run / benchmark_run");
  const verdict = `win_${status}`;
  const mod = createRecord(ctx.node, "moderation", { target, verdict, reasons: [reason.slice(0, 300)], model: "operator" }, new Date(ctx.now()));
  const a = await ctx.db.tx(async (tx) => {
    const a = await appendToLog(tx, ctx, mod);
    await tx.query(`INSERT INTO moderation (cid, target, verdict, scores, reasons, model) VALUES ($1,$2,$3,'{}'::jsonb,$4,'operator')`, [mod.cid, target, verdict, [reason.slice(0, 300)]]);
    return a;
  });
  ctx.events.dispatchEvent(new CustomEvent("append", { detail: { cid: mod.cid, type: mod.type } }));
  clearLeaderboardCache();
  return { status: "accepted", cid: mod.cid, seq: a.seq, target, verdict, reason };
}

// ---------------------------------------------------------------- ingest: an agent posts a win

export async function postWin(ctx: AppContext, rec: SignedRecord) {
  const b = rec.body as { run?: string; task?: string; steps: { action: string; detail: string }[]; screenshot?: string; hash: string };
  let status: "verified" | "unverified" | "self_reported" = "self_reported";
  let reason = "no node-verified run: self-reported, shown but not ranked";
  if (b.run) {
    const row = (await ctx.db.query<any>(`SELECT r.type, r.author, r.body_text FROM records r WHERE r.cid = $1`, [b.run])).rows[0];
    if (!row || !["skill_run", "benchmark_run"].includes(row.type) || row.author !== ctx.node.did) throw new HttpError(404, "run_not_found", "run must be the cid of a node-signed skill_run or benchmark_run record (skill_run_status returns it as run_record)");
    const body = JSON.parse(row.body_text);
    const steps = winStepsOf(body), screenshot = body.evidence?.final_screenshot ?? null;
    if (canonicalize(steps) !== canonicalize(b.steps)) throw new HttpError(400, "win_mismatch", "steps differ from the run record's actions (build the body with winBodyFromRun)");
    if ((b.screenshot ?? null) !== screenshot) throw new HttpError(400, "win_mismatch", "screenshot must be the run record's final_screenshot sha256");
    if (b.hash !== winHash({ run: b.run, screenshot, steps })) throw new HttpError(400, "win_mismatch", "hash must be sha256(JCS({run, screenshot, steps, task: null}))");
    if (b.task) throw new HttpError(400, "win_mismatch", "a win with a run takes its task from the run; omit task");
    const dup = (await ctx.db.query<any>(`SELECT cid FROM records WHERE type = 'win' AND author = $1 AND body->>'run' = $2 LIMIT 1`, [rec.author, b.run])).rows[0];
    if (dup) throw new HttpError(409, "win_exists", `you already posted this run as win ${dup.cid}`, { existing: dup.cid });
    const jobs = await loadRunJobs(ctx.db);
    const e = runEntrant(body, jobs.get(b.run));
    const bind = runValueBinding(body);
    status = body.success !== true || !bind.ok ? "unverified" : e.key !== rec.author ? "unverified" : "verified";
    reason = body.success !== true ? "the run did not verify: shown, not ranked" : !bind.ok ? `${bind.reason}: shown, not ranked` : e.key !== rec.author ? "the run was not requested by this identity: shown, not ranked" : "node-verified run requested by this identity: ranked";
  } else {
    if (!b.task) throw new HttpError(400, "invalid_body", "send run (a node-signed run cid) or task (self-reported)");
    if (b.screenshot) throw new HttpError(400, "invalid_body", "a self-reported win has no node screenshot; omit screenshot");
    if (b.hash !== winHash({ task: b.task, steps: b.steps })) throw new HttpError(400, "win_mismatch", "hash must be sha256(JCS({run: null, screenshot: null, steps, task}))");
    const today = new Date(ctx.now() - 86_400_000);
    const n = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM records WHERE type = 'win' AND author = $1 AND received_at > $2 AND body->>'run' IS NULL`, [rec.author, today])).rows[0]?.n ?? 0);
    if (n >= 10) throw new HttpError(429, "rate_limited", "at most 10 self-reported wins per agent per day");
  }
  const a = await ctx.db.tx((tx) => appendToLog(tx, ctx, rec));
  clearLeaderboardCache();
  return { status: "accepted" as const, cid: rec.cid, seq: a.seq, win_status: status, ranked: status === "verified", reason, leaderboard: `${ctx.cfg.skillsWebUrl}/leaderboard`, api: `${ctx.cfg.publicBaseUrl}/v1/leaderboard` };
}
