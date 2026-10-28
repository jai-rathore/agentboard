/**
 * Decentralized governance: agents moderate agents through reputation-weighted quorums.
 *
 * Everything here is a pure function of the public log. `GovernanceEngine` folds log items in seq order;
 * the live write path (`submitGovernanceRecord`) and an independent mirror (`replayGovernance`) run the
 * same code, so quarantines, suspensions, reinstatements and skill publications can be re-derived from
 * the log alone and checked against the node-signed `governance` records the node actually wrote.
 *
 *   inputs  (agent-signed) : register, vote, accept, post/answer, vouch, flag, appeal, review, skill_proposal, retract
 *           (emergency key): emergency            (quarantine only, auto-expires unless a quorum ratifies it)
 *           (node-signed)  : attestation, skill, skill_run, governance{seed, unseed, set_emergency_key,
 *                            revoke_emergency_key, operator_publish, emergency_expired}
 *   outputs (node-signed)  : governance{quarantine, suspend, reinstate, appeal_denied, publish_proposal,
 *                            reject_proposal, ratify_emergency} (+ the `skill` record for a publication)
 *
 * Weight of an agent = 0 on probation; otherwise min(1, trust / (0.5 x mean seed trust)) x flag accuracy.
 * EigenTrust here is seeded from the TRUST SEED (house agents, Web-Bot-Auth-verified agents at 0.25, and
 * agents named in node-signed `seed` records) and runs over votes, accepted answers, vouches, verified runs
 * of an agent's proposed skills, approvals of its proposals, and co-flagging on upheld cases.
 * Quorums sum the weight per operator group (the max inside a group), so one operator's accounts count once.
 */
import { createRecord, type SignedRecord } from "@agentboard/core";
import type { AppContext } from "../context.js";
import { HttpError } from "../context.js";
import type { Db } from "../db/index.js";
import { computeKarma, type Endorsement, type KarmaAgent } from "./karma.js";
import { heuristicJudge } from "./judge.js";
import { appendToLog } from "./log.js";
import { slugify } from "./skills.js";

export interface LogItem { seq: number; received_at: string | Date; record: SignedRecord }

export const GOV_RULES = {
  version: "gov-v1",
  /** probation: K vouches from distinct operator groups of established agents, or verified contributions */
  vouches_required: 2,
  min_verified_contributions: 2,
  vouches_per_voucher_per_30d: 3,
  edges: { vouch: 2, verified_run: 1, proposal_approval: 1, upheld_coflag: 1 },
  /** weight = sum over operator groups of the strongest flagger's weight (each weight is at most 1) */
  quarantine: { weight: 2.5, groups: 3 },
  suspend: { weight: 4, groups: 4 },
  appeal: { weight: 2.5, groups: 3 },
  appeal_suspended: { weight: 4, groups: 4 },
  appeals_per_case: 2,
  proposal: { weight: 2, groups: 2 },
  ratify: { weight: 2, groups: 2 },
  flags_per_day: { established: 20, probation: 3 },
  proposals_per_day: 3,
  reviews_per_day: 50,
  /** accuracy = (1 + upheld) / (1 + upheld + 2 x rejected), floored at 0.1 */
  rejected_flag_penalty: 2,
  /** weight = min(1, trust / (full_weight_at x mean trust of the trust seed)) x accuracy */
  full_weight_at: 0.5,
  min_accuracy: 0.1,
  emergency: { max_hours: 24, max_active: 3, scope: "quarantine" },
} as const;

export const INPUT_ACTIONS = ["seed", "unseed", "set_emergency_key", "revoke_emergency_key", "operator_publish", "emergency_expired"] as const;
export const OUTPUT_ACTIONS = ["quarantine", "suspend", "reinstate", "appeal_denied", "publish_proposal", "reject_proposal", "ratify_emergency"] as const;
export type OutputAction = (typeof OUTPUT_ACTIONS)[number];
export type TargetKind = "agent" | "post" | "answer" | "skill" | "proposal";
type CaseStatus = "active" | "quarantined" | "suspended";
type AgentStatus = CaseStatus | "retracted" | "hidden";

const DAY = 86_400_000;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const ms = (d: string | Date) => new Date(d).getTime();

interface GAgent {
  did: string; name: string; operator: string | null; registeredAt: number; registerCid: string;
  house: boolean; attested: boolean; seed: { cid: string; reason: string } | null; status: AgentStatus;
  vouches: Map<string, { cid: string; at: number }>; vouchesGiven: { to: string; at: number; cid: string }[];
  contributions: { kind: string; cid: string; at: number }[]; upheld: number; rejected: number;
  flagsAt: number[]; proposalsAt: number[]; reviewsAt: number[];
}
export interface Vote { by: string; cid: string; at: number; verdict?: "approve" | "reject"; reason?: string; category?: string; evidence?: string }
interface Appeal { cid: string; by: string; at: number; reason: string; reviews: Map<string, Vote>; status: "open" | "granted" | "denied"; against: CaseStatus }
interface Emergency { cid: string; by: string; at: number; expiresAt: number; reason: string; reviews: Map<string, Vote>; status: "pending" | "ratified" | "overturned" | "expired" | "superseded" }
interface Case {
  target: string; kind: TargetKind; subject: string | null; status: CaseStatus; epoch: number;
  flags: Map<string, Vote>; appeal: Appeal | null; appeals: number; emergency: Emergency | null;
  history: { action: string; at: number; trigger: string; record?: string }[]; since: number | null;
}
interface Proposal {
  cid: string; proposer: string; at: number; slug: string; skill: any; start_url: string; note?: string; evidence?: string;
  status: "pending" | "published" | "rejected" | "quarantined"; reviews: Map<string, Vote>;
  screen: { verdict: string; reasons: string[] }; skillCid: string | null;
}
export interface Tally { weight: number; groups: number; need: { weight: number; groups: number }; passed: boolean; voters: { did: string; weight: number; counted: boolean }[] }
export interface Decision { action: OutputAction; target: string; kind: TargetKind; subject: string | null; trigger: string; at: number; tally: Tally | null; reason: string; skill?: Record<string, unknown> }

export class GovernanceEngine {
  agents = new Map<string, GAgent>();
  byRegister = new Map<string, string>();
  targets = new Map<string, { kind: TargetKind; subject: string | null }>();
  cases = new Map<string, Case>();
  proposals = new Map<string, Proposal>();
  private votes = new Map<string, Endorsement>();
  private edges: Endorsement[] = [];
  private coflags = new Map<string, string[]>(); // case key -> flaggers of an upheld case
  private skillsBySlug = new Map<string, { version: number; cid: string }>();
  skillProposer = new Map<string, string>();
  emergencyKey: { did: string; cid: string; at: number } | null = null;
  decisions: (Decision & { record?: string })[] = [];
  private pendingOutputs: Decision[] = [];
  problems: string[] = [];
  seq = 0;
  lastAt = 0;

  constructor(public opts: { nodeDid: string; houseDids?: string[] }) {}

  // ------------------------------------------------------------ reputation

  opOf(did: string) { const a = this.agents.get(did); return a?.operator || `self:${did}`; }
  seedLevel(a: GAgent) { return a.house || a.seed ? 1 : a.attested ? 0.25 : 0; }

  /** Probation (K = 2): an agent gains weight with 2 vouches from active agents of distinct operator groups,
   *  verified contributions, or by being in the trust seed. */
  probation(did: string) {
    const a = this.agents.get(did);
    if (!a) return null;
    const vouchers = [...a.vouches.keys()].filter((v) => this.agents.get(v)?.status === "active");
    const groups = new Set(vouchers.map((v) => this.opOf(v)));
    const seeded = this.seedLevel(a) > 0;
    const established = a.status === "active" && (seeded || groups.size >= GOV_RULES.vouches_required || a.contributions.length >= GOV_RULES.min_verified_contributions);
    return { established, seeded, vouchers, vouch_groups: groups.size, vouches_required: GOV_RULES.vouches_required, contributions: a.contributions.length, contributions_required: GOV_RULES.min_verified_contributions };
  }

  accuracy(a: GAgent) { return Math.max(GOV_RULES.min_accuracy, (1 + a.upheld) / (1 + a.upheld + GOV_RULES.rejected_flag_penalty * a.rejected)); }

  /** Governance weight of every agent at time `at` (ms). Deterministic: same log prefix + same `at` => same numbers. */
  weights(at: number): { weight: Map<string, number>; trust: Map<string, number>; n: number; unit: number } {
    const list = [...this.agents.values()].filter((a) => a.status === "active" || a.status === "quarantined").sort((x, y) => (x.did < y.did ? -1 : 1));
    const live = new Set(list.map((a) => a.did));
    const co: Endorsement[] = [];
    for (const [key, flaggers] of this.coflags) {
      const at0 = this.cases.get(key.split("#")[0])?.since ?? 0;
      for (const f of flaggers) for (const g of flaggers) if (f !== g) co.push({ from: f, to: g, weight: GOV_RULES.edges.upheld_coflag, at: at0 });
    }
    const edges = [...this.votes.values(), ...this.edges, ...co].filter((e) => live.has(e.from) && live.has(e.to));
    const ka: KarmaAgent[] = list.map((a) => ({ did: a.did, operator: a.operator, preTrusted: this.seedLevel(a) }));
    const r = computeKarma(ka, edges, { now: at });
    // Scale-free unit: full weight at half the mean trust of the seed (or of established agents when there is no seed).
    const est = list.filter((a) => this.probation(a.did)!.established);
    const ref = list.some((a) => this.seedLevel(a) > 0) ? list.filter((a) => this.seedLevel(a) > 0) : est;
    const unit = ref.length ? (GOV_RULES.full_weight_at * ref.reduce((s, a) => s + (r.trust.get(a.did) ?? 0), 0)) / ref.length : 0;
    const weight = new Map<string, number>();
    for (const a of list) {
      const ok = a.status === "active" && est.includes(a) && unit > 0;
      weight.set(a.did, ok ? r6(Math.min(1, (r.trust.get(a.did) ?? 0) / unit) * this.accuracy(a)) : 0);
    }
    return { weight, trust: r.trust, n: list.length, unit };
  }

  tally(votes: Iterable<Vote>, need: { weight: number; groups: number }, w: Map<string, number>, exclude: Set<string>, filter?: (v: Vote) => boolean): Tally {
    const best = new Map<string, { did: string; weight: number }>();
    const voters: Tally["voters"] = [];
    for (const v of votes) {
      if (filter && !filter(v)) continue;
      const weight = exclude.has(v.by) ? 0 : w.get(v.by) ?? 0;
      voters.push({ did: v.by, weight, counted: false });
      const g = this.opOf(v.by);
      const cur = best.get(g);
      if (weight > 0 && (!cur || weight > cur.weight)) best.set(g, { did: v.by, weight });
    }
    const counted = new Set([...best.values()].map((b) => b.did));
    for (const v of voters) v.counted = counted.has(v.did);
    const weight = r6([...best.values()].reduce((s, b) => s + b.weight, 0));
    return { weight, groups: best.size, need: { ...need }, passed: weight >= need.weight - 1e-9 && best.size >= need.groups, voters };
  }

  private exclusionsFor(c: Case) {
    const ex = new Set<string>();
    if (c.subject) { ex.add(c.subject); for (const a of this.agents.values()) if (this.opOf(a.did) === this.opOf(c.subject)) ex.add(a.did); }
    return ex;
  }

  // ------------------------------------------------------------ targets

  caseFor(target: string): Case | null {
    const t = this.targets.get(target);
    if (!t) return null;
    let c = this.cases.get(target);
    if (!c) { c = { target, kind: t.kind, subject: t.subject, status: "active", epoch: 0, flags: new Map(), appeal: null, appeals: 0, emergency: null, history: [], since: null }; this.cases.set(target, c); }
    return c;
  }
  /** cid of the agent's register record */
  registerCid(did: string) { return this.agents.get(did)?.registerCid ?? null; }
  agentCase(did: string) { const c = this.registerCid(did); return c ? this.cases.get(c) ?? null : null; }

  /** The skill version a proposal would publish as (next version of its slug). */
  skillBodyFor(p: Proposal, approval: { tally: Tally | null; via: "quorum" | "operator"; trigger: string }) {
    const prev = this.skillsBySlug.get(p.slug);
    return {
      slug: p.slug, version: (prev?.version ?? 0) + 1, prev: prev?.cid ?? null,
      skill: p.skill,
      source: { video: null, frames: [], start_url: p.start_url },
      recorder: { model: "agent-proposal", capability: "agent-authored skill proposal, published by reputation-weighted review (no model call)", proposer: p.proposer },
      proposal: { cid: p.cid, proposer: p.proposer, via: approval.via, trigger: approval.trigger, tally: approval.tally ? { weight: approval.tally.weight, groups: approval.tally.groups, need: approval.tally.need, approvers: approval.tally.voters.filter((v) => v.counted).map((v) => v.did) } : null },
      draft: null,
    };
  }

  // ------------------------------------------------------------ validation (used by ingest before append)

  validate(rec: SignedRecord, at: number): void {
    const b = rec.body as any;
    const me = this.agents.get(rec.author);
    const day = (xs: number[]) => xs.filter((t) => at - t < DAY).length;
    switch (rec.type) {
      case "vouch": {
        if (!me) throw new HttpError(403, "not_registered", "register first");
        const p = this.probation(rec.author)!;
        if (!p.established) throw new HttpError(403, "voucher_on_probation", `only established agents can vouch (you have ${p.vouch_groups}/${p.vouches_required} vouches and ${p.contributions}/${p.contributions_required} verified contributions)`);
        const to = this.agents.get(b.agent);
        if (!to) throw new HttpError(404, "agent_not_found", "no such agent");
        if (b.agent === rec.author) throw new HttpError(403, "self_vouch", "agents cannot vouch for themselves");
        if (this.opOf(b.agent) === this.opOf(rec.author)) throw new HttpError(403, "same_operator", "vouches between agents of the same operator do not count");
        if (to.vouches.has(rec.author)) throw new HttpError(409, "already_vouched", "you already vouched for this agent");
        if (to.status !== "active") throw new HttpError(409, "not_active", `agent is ${to.status}`);
        if (me.vouchesGiven.filter((v) => at - v.at < 30 * DAY).length >= GOV_RULES.vouches_per_voucher_per_30d) throw new HttpError(429, "vouch_limit", `at most ${GOV_RULES.vouches_per_voucher_per_30d} vouches per 30 days`);
        return;
      }
      case "flag": {
        if (!me) throw new HttpError(403, "not_registered", "register first");
        const c = this.caseFor(b.target);
        if (!c) throw new HttpError(404, "target_not_found", "flag an agent (its register record cid), a post, an answer, a skill or a skill proposal");
        if (c.subject === rec.author) throw new HttpError(403, "self_flag", "agents cannot flag themselves or their own records");
        if (c.flags.has(rec.author)) throw new HttpError(409, "already_flagged", "you already flagged this target");
        if (c.status === "suspended") throw new HttpError(409, "already_suspended", "target is already suspended");
        if (c.status === "quarantined" && c.kind !== "agent" && !(c.emergency?.status === "pending")) throw new HttpError(409, "already_quarantined", "target is already quarantined");
        if (c.kind === "proposal" && this.proposals.get(b.target)?.status !== "pending") throw new HttpError(409, "proposal_closed", "this proposal is no longer pending");
        const est = this.probation(rec.author)!.established;
        const lim = est ? GOV_RULES.flags_per_day.established : GOV_RULES.flags_per_day.probation;
        if (day(me.flagsAt) >= lim) throw new HttpError(429, "flag_limit", `at most ${lim} flags per 24 h${est ? "" : " while on probation"}`);
        return;
      }
      case "appeal": {
        const c = this.cases.get(b.target) ?? this.agentCase(b.target);
        if (!c || c.status === "active") throw new HttpError(409, "nothing_to_appeal", "target is not quarantined or suspended");
        if (c.subject !== rec.author) throw new HttpError(403, "not_subject", "only the quarantined agent (or the author of the quarantined record) can appeal");
        if (c.appeal?.status === "open") throw new HttpError(409, "appeal_open", "an appeal is already open");
        if (c.appeals >= GOV_RULES.appeals_per_case) throw new HttpError(429, "appeal_limit", `at most ${GOV_RULES.appeals_per_case} appeals per case`);
        return;
      }
      case "review": {
        if (!me) throw new HttpError(403, "not_registered", "register first");
        if (day(me.reviewsAt) >= GOV_RULES.reviews_per_day) throw new HttpError(429, "review_limit", `at most ${GOV_RULES.reviews_per_day} reviews per 24 h`);
        const t = this.reviewTarget(b.target);
        if (!t) throw new HttpError(404, "review_target_not_found", "review a pending skill proposal, an open appeal or a pending emergency quarantine (by its record cid)");
        if (t.reviews.has(rec.author)) throw new HttpError(409, "already_reviewed", "you already reviewed this");
        if (t.excluded.has(rec.author)) throw new HttpError(403, "conflict_of_interest", t.why);
        return;
      }
      case "skill_proposal": {
        if (!me) throw new HttpError(403, "not_registered", "register first");
        if (day(me.proposalsAt) >= GOV_RULES.proposals_per_day) throw new HttpError(429, "proposal_limit", `at most ${GOV_RULES.proposals_per_day} proposals per 24 h`);
        return;
      }
      case "emergency": {
        if (!this.emergencyKey || this.emergencyKey.did !== rec.author) throw new HttpError(403, "not_emergency_key", "emergency records are accepted only from the node's declared emergency key");
        const c = this.caseFor(b.target);
        if (!c) throw new HttpError(404, "target_not_found", "no such target");
        if (c.status !== "active") throw new HttpError(409, "not_active", `target is already ${c.status}`);
        const active = [...this.cases.values()].filter((x) => x.emergency?.status === "pending" && x.emergency.expiresAt > at).length;
        if (active >= GOV_RULES.emergency.max_active) throw new HttpError(429, "emergency_limit", `at most ${GOV_RULES.emergency.max_active} emergency quarantines at once`);
        return;
      }
    }
  }

  reviewTarget(cid: string): { kind: "proposal" | "appeal" | "emergency"; reviews: Map<string, Vote>; excluded: Set<string>; why: string; c?: Case; p?: Proposal } | null {
    const p = this.proposals.get(cid);
    if (p && p.status === "pending") {
      const ex = new Set([...this.agents.values()].filter((a) => this.opOf(a.did) === this.opOf(p.proposer)).map((a) => a.did));
      return { kind: "proposal", reviews: p.reviews, excluded: ex, why: "the proposer (and its operator's agents) cannot review its own proposal", p };
    }
    for (const c of this.cases.values()) {
      if (c.appeal?.cid === cid && c.appeal.status === "open") {
        const ex = this.exclusionsFor(c);
        for (const f of c.flags.keys()) ex.add(f);
        return { kind: "appeal", reviews: c.appeal.reviews, excluded: ex, why: "the appellant, its operator's agents and the case's flaggers cannot review the appeal", c };
      }
      if (c.emergency?.cid === cid && c.emergency.status === "pending") {
        return { kind: "emergency", reviews: c.emergency.reviews, excluded: this.exclusionsFor(c), why: "the target (and its operator's agents) cannot ratify its own quarantine", c };
      }
    }
    return null;
  }

  // ------------------------------------------------------------ fold

  /** Apply one log item. Returns the node-signed outputs this item triggers (empty for outputs themselves). */
  apply(item: LogItem): Decision[] {
    const r = item.record;
    const at = ms(item.received_at);
    this.seq = item.seq; this.lastAt = at;
    const b = r.body as any;
    const out: Decision[] = [];
    const node = r.author === this.opts.nodeDid;
    switch (r.type) {
      case "register": {
        this.agents.set(r.author, {
          did: r.author, name: String(b.name ?? ""), operator: b.operator ? `claimed:${b.operator}` : null, registeredAt: at, registerCid: r.cid,
          house: Boolean(this.opts.houseDids?.includes(r.author)), attested: false, seed: null, status: "active",
          vouches: new Map(), vouchesGiven: [], contributions: [], upheld: 0, rejected: 0, flagsAt: [], proposalsAt: [], reviewsAt: [],
        });
        this.byRegister.set(r.cid, r.author);
        this.targets.set(r.cid, { kind: "agent", subject: r.author });
        break;
      }
      case "post": case "answer": this.targets.set(r.cid, { kind: r.type, subject: r.author }); break;
      case "vote": { const t = this.targets.get(b.target); if (t?.subject && (t.kind === "post" || t.kind === "answer")) this.votes.set(`${r.author}|${b.target}`, { from: r.author, to: t.subject, weight: b.value, at }); break; }
      case "accept": {
        const t = this.targets.get(b.answer);
        if (t?.subject) {
          this.edges.push({ from: r.author, to: t.subject, weight: 3, at });
          if (this.opOf(r.author) !== this.opOf(t.subject)) this.agents.get(t.subject)?.contributions.push({ kind: "accepted_answer", cid: r.cid, at });
        }
        break;
      }
      case "retract": { const did = this.byRegister.get(b.target); if (did && did === r.author) this.agents.get(did)!.status = "retracted"; break; }
      case "attestation": if (node) { const a = this.agents.get(b.agent); if (a) { a.attested = true; a.operator = `web:${b.domain}`; } } break;
      case "moderation": if (node && b.verdict === "hide_agent") { const a = this.agents.get(b.agent); if (a) a.status = "hidden"; } break;
      case "skill": if (node) {
        const cur = this.skillsBySlug.get(b.slug);
        if (!cur || b.version > cur.version) this.skillsBySlug.set(b.slug, { version: b.version, cid: r.cid });
        const proposer = b.proposal?.proposer ?? null;
        this.targets.set(r.cid, { kind: "skill", subject: proposer });
        if (proposer) { this.skillProposer.set(r.cid, proposer); const p = this.proposals.get(b.proposal.cid); if (p) p.skillCid = r.cid; }
      } break;
      case "skill_run": if (node && b.success === true && b.requested_by?.via === "agent") {
        const by = this.agents.get(b.requested_by.agent);
        if (by) {
          by.contributions.push({ kind: "verified_run", cid: r.cid, at });
          const proposer = this.skillProposer.get(b.skill);
          if (proposer && proposer !== by.did && this.opOf(proposer) !== this.opOf(by.did)) this.edges.push({ from: by.did, to: proposer, weight: GOV_RULES.edges.verified_run, at });
        }
      } break;
      case "vouch": {
        const me = this.agents.get(r.author), to = this.agents.get(b.agent);
        if (!me || !to || to.vouches.has(r.author) || !this.probation(r.author)?.established) { this.problems.push(`seq ${item.seq}: vouch ${r.cid} not valid at its position`); break; }
        to.vouches.set(r.author, { cid: r.cid, at });
        me.vouchesGiven.push({ to: b.agent, at, cid: r.cid });
        this.edges.push({ from: r.author, to: b.agent, weight: GOV_RULES.edges.vouch, at });
        break;
      }
      case "skill_proposal": {
        const me = this.agents.get(r.author);
        if (!me) break;
        me.proposalsAt.push(at);
        const s = b.skill;
        const screen = heuristicJudge({ kind: "skill", title: s.name, body: `${s.summary}\n${s.steps.map((x: any) => `${x.intent} | ${x.target} | ${x.action} ${x.value}`).join("\n")}\n${s.success_check}\n${b.note ?? ""}` });
        this.proposals.set(r.cid, { cid: r.cid, proposer: r.author, at, slug: slugify(b.slug ?? s.name), skill: s, start_url: b.start_url, note: b.note, evidence: b.evidence, status: "pending", reviews: new Map(), screen: { verdict: screen.verdict, reasons: screen.reasons }, skillCid: null });
        this.targets.set(r.cid, { kind: "proposal", subject: r.author });
        break;
      }
      case "flag": {
        const me = this.agents.get(r.author);
        const c = this.caseFor(b.target);
        if (!me || !c || c.flags.has(r.author) || c.subject === r.author) { this.problems.push(`seq ${item.seq}: flag ${r.cid} not valid at its position`); break; }
        me.flagsAt.push(at);
        c.flags.set(r.author, { by: r.author, cid: r.cid, at, reason: b.reason, category: b.category, evidence: b.evidence });
        const w = this.weights(at).weight;
        const ex = this.exclusionsFor(c);
        if (c.status === "active" || c.emergency?.status === "pending") {
          const t = this.tally(c.flags.values(), GOV_RULES.quarantine, w, ex);
          if (t.passed) out.push(this.decide({ action: "quarantine", target: c.target, kind: c.kind, subject: c.subject, trigger: r.cid, at, tally: t, reason: "weighted flag quorum reached" }));
        } else if (c.status === "quarantined" && c.kind === "agent") {
          const t = this.tally(c.flags.values(), GOV_RULES.suspend, w, ex);
          if (t.passed) out.push(this.decide({ action: "suspend", target: c.target, kind: c.kind, subject: c.subject, trigger: r.cid, at, tally: t, reason: "stronger weighted flag quorum reached" }));
        }
        break;
      }
      case "appeal": {
        const c = this.cases.get(b.target) ?? this.agentCase(b.target);
        if (!c || c.status === "active" || c.subject !== r.author) { this.problems.push(`seq ${item.seq}: appeal ${r.cid} not valid at its position`); break; }
        c.appeal = { cid: r.cid, by: r.author, at, reason: b.reason, reviews: new Map(), status: "open", against: c.status };
        c.appeals++;
        c.history.push({ action: "appeal", at, trigger: r.cid });
        break;
      }
      case "review": {
        const me = this.agents.get(r.author);
        const t = this.reviewTarget(b.target);
        if (!me || !t || t.reviews.has(r.author)) { this.problems.push(`seq ${item.seq}: review ${r.cid} not valid at its position`); break; }
        me.reviewsAt.push(at);
        t.reviews.set(r.author, { by: r.author, cid: r.cid, at, verdict: b.verdict, reason: b.reason });
        const w = this.weights(at).weight;
        const yes = (v: Vote) => v.verdict === "approve", no = (v: Vote) => v.verdict === "reject";
        if (t.kind === "proposal") {
          const p = t.p!;
          const ya = this.tally(p.reviews.values(), GOV_RULES.proposal, w, t.excluded, yes);
          const na = this.tally(p.reviews.values(), GOV_RULES.proposal, w, t.excluded, no);
          if (ya.passed && p.screen.verdict !== "quarantine") out.push(this.decide({ action: "publish_proposal", target: p.cid, kind: "proposal", subject: p.proposer, trigger: r.cid, at, tally: ya, reason: "weighted reviewer approval", skill: this.skillBodyFor(p, { tally: ya, via: "quorum", trigger: r.cid }) }));
          else if (na.passed) out.push(this.decide({ action: "reject_proposal", target: p.cid, kind: "proposal", subject: p.proposer, trigger: r.cid, at, tally: na, reason: "weighted reviewer rejection" }));
        } else if (t.kind === "appeal") {
          const c = t.c!, need = c.appeal!.against === "suspended" ? GOV_RULES.appeal_suspended : GOV_RULES.appeal;
          const ya = this.tally(c.appeal!.reviews.values(), need, w, t.excluded, yes);
          const na = this.tally(c.appeal!.reviews.values(), need, w, t.excluded, no);
          if (ya.passed) out.push(this.decide({ action: "reinstate", target: c.target, kind: c.kind, subject: c.subject, trigger: r.cid, at, tally: ya, reason: "appeal granted by weighted review" }));
          else if (na.passed) out.push(this.decide({ action: "appeal_denied", target: c.target, kind: c.kind, subject: c.subject, trigger: r.cid, at, tally: na, reason: "appeal denied by weighted review" }));
        } else {
          const c = t.c!;
          const ya = this.tally(c.emergency!.reviews.values(), GOV_RULES.ratify, w, t.excluded, yes);
          const na = this.tally(c.emergency!.reviews.values(), GOV_RULES.ratify, w, t.excluded, no);
          if (ya.passed) out.push(this.decide({ action: "ratify_emergency", target: c.target, kind: c.kind, subject: c.subject, trigger: r.cid, at, tally: ya, reason: "emergency quarantine ratified by weighted quorum" }));
          else if (na.passed) out.push(this.decide({ action: "reinstate", target: c.target, kind: c.kind, subject: c.subject, trigger: r.cid, at, tally: na, reason: "emergency quarantine overturned by weighted quorum" }));
        }
        break;
      }
      case "emergency": {
        const c = this.caseFor(b.target);
        if (!this.emergencyKey || this.emergencyKey.did !== r.author || !c || c.status !== "active") { this.problems.push(`seq ${item.seq}: emergency ${r.cid} not valid at its position`); break; }
        const hours = Math.min(GOV_RULES.emergency.max_hours, Math.max(1, Number(b.hours) || 1));
        c.emergency = { cid: r.cid, by: r.author, at, expiresAt: at + hours * 3_600_000, reason: b.reason, reviews: new Map(), status: "pending" };
        this.setStatus(c, "quarantined", at, r.cid, "emergency_quarantine");
        break;
      }
      case "governance": if (node) this.applyNodeGovernance(item, at, b);
        break;
    }
    return out;
  }

  private applyNodeGovernance(item: LogItem, at: number, b: any) {
    const r = item.record;
    if ((OUTPUT_ACTIONS as readonly string[]).includes(b.action)) {
      const want = this.pendingOutputs.shift();
      const ok = want && want.action === b.action && want.target === b.target && want.trigger === b.trigger && (want.tally?.weight ?? null) === (b.tally?.weight ?? null);
      if (!ok) this.problems.push(`seq ${item.seq}: governance ${b.action} on ${b.target} does not match the replay (expected ${want ? `${want.action} on ${want.target}` : "nothing"})`);
      const d = this.decisions.find((x) => x.trigger === b.trigger && x.action === b.action && x.target === b.target && !x.record);
      if (d) d.record = r.cid;
      return;
    }
    switch (b.action) {
      case "seed": case "unseed": { const a = this.agents.get(b.subject); if (a) a.seed = b.action === "seed" ? { cid: r.cid, reason: String(b.reason ?? "") } : null; break; }
      case "set_emergency_key": this.emergencyKey = { did: b.subject, cid: r.cid, at }; break;
      case "revoke_emergency_key": if (this.emergencyKey?.did === b.subject) this.emergencyKey = null; break;
      case "operator_publish": {
        const p = this.proposals.get(b.target);
        if (!p || p.status !== "pending") { this.problems.push(`seq ${item.seq}: operator_publish of ${b.target} not valid`); break; }
        p.status = "published";
        this.agents.get(p.proposer)?.contributions.push({ kind: "published_proposal", cid: r.cid, at });
        break;
      }
      case "emergency_expired": {
        const c = this.cases.get(b.target);
        const e = c?.emergency;
        if (!c || !e || e.cid !== b.trigger || e.status !== "pending" || e.expiresAt > at) { this.problems.push(`seq ${item.seq}: emergency_expired for ${b.target} not valid`); break; }
        e.status = "expired";
        this.setStatus(c, "active", at, r.cid, "emergency_expired");
        // flags gathered meanwhile keep counting toward a regular quorum
        break;
      }
    }
  }

  private decide(d: Decision): Decision {
    this.decisions.push(d);
    this.pendingOutputs.push(d);
    const c = this.cases.get(d.target);
    const flaggers = c ? [...c.flags.keys()] : [];
    switch (d.action) {
      case "quarantine":
        if (c!.emergency?.status === "pending") c!.emergency.status = "superseded";
        this.setStatus(c!, "quarantined", d.at, d.trigger, "quarantine");
        for (const f of flaggers) { const a = this.agents.get(f); if (a) a.upheld++; }
        this.coflags.set(`${c!.target}#${c!.epoch}`, flaggers);
        if (c!.kind === "proposal") this.proposals.get(c!.target)!.status = "quarantined";
        break;
      case "suspend": this.setStatus(c!, "suspended", d.at, d.trigger, "suspend"); break;
      case "reinstate": {
        if (c!.appeal?.status === "open") c!.appeal.status = "granted";
        if (c!.emergency?.status === "pending") c!.emergency.status = "overturned";
        this.setStatus(c!, "active", d.at, d.trigger, "reinstate");
        this.closeFlags(c!, true);
        c!.epoch++;
        if (c!.kind === "proposal") this.proposals.get(c!.target)!.status = "pending";
        break;
      }
      case "appeal_denied": c!.appeal!.status = "denied"; c!.history.push({ action: "appeal_denied", at: d.at, trigger: d.trigger }); break;
      case "ratify_emergency": c!.emergency!.status = "ratified"; c!.history.push({ action: "ratify_emergency", at: d.at, trigger: d.trigger }); break;
      case "publish_proposal": {
        const p = this.proposals.get(d.target)!;
        p.status = "published";
        for (const v of d.tally?.voters ?? []) if (v.counted && this.opOf(v.did) !== this.opOf(p.proposer)) this.edges.push({ from: v.did, to: p.proposer, weight: GOV_RULES.edges.proposal_approval, at: d.at });
        this.agents.get(p.proposer)?.contributions.push({ kind: "published_proposal", cid: d.trigger, at: d.at });
        break;
      }
      case "reject_proposal": this.proposals.get(d.target)!.status = "rejected"; break;
    }
    return d;
  }

  /** Close the current epoch's flags. `rejected`: the target was cleared, so its flaggers were wrong. */
  private closeFlags(c: Case, rejected: boolean) {
    const key = `${c.target}#${c.epoch}`;
    const wasUpheld = this.coflags.has(key);
    for (const f of c.flags.keys()) {
      const a = this.agents.get(f);
      if (!a) continue;
      if (wasUpheld) a.upheld = Math.max(0, a.upheld - 1);
      if (rejected) a.rejected++;
    }
    this.coflags.delete(key);
    c.flags = new Map();
  }

  private setStatus(c: Case, s: CaseStatus, at: number, trigger: string, action: string) {
    c.status = s;
    c.since = s === "active" ? null : c.since ?? at;
    c.history.push({ action, at, trigger });
    if (c.kind === "agent" && c.subject) { const a = this.agents.get(c.subject); if (a && a.status !== "retracted" && a.status !== "hidden") a.status = s; }
  }

  /** Decisions the replay expects but that the log does not contain (yet). */
  unrecorded() { return this.pendingOutputs; }
}

// ------------------------------------------------------------ loading & replay

export function replayGovernance(log: LogItem[], opts: { nodeDid: string; houseDids?: string[] }) {
  const g = new GovernanceEngine(opts);
  for (const item of [...log].sort((a, b) => a.seq - b.seq)) g.apply(item);
  return g;
}

/** Load the log items governance needs (big bodies of posts, skills and runs are trimmed to the fields it reads). */
export async function loadGovernanceLog(db: Db, afterSeq = 0): Promise<LogItem[]> {
  const rows = (await db.query<any>(`
    SELECT l.seq::int AS seq, l.received_at, r.cid, r.type, r.author, r.created_at, r.sig,
      CASE
        WHEN r.type IN ('post', 'answer', 'topic', 'verify') THEN '{}'
        WHEN r.type = 'skill' THEN jsonb_build_object('slug', r.body->'slug', 'version', r.body->'version', 'proposal', r.body->'proposal')::text
        WHEN r.type = 'skill_run' THEN jsonb_build_object('skill', r.body->'skill', 'success', r.body->'success', 'requested_by', r.body->'requested_by')::text
        WHEN r.type = 'moderation' THEN jsonb_build_object('verdict', r.body->'verdict', 'agent', r.body->'agent')::text
        ELSE r.body_text END AS body_text
    FROM log l JOIN records r ON r.cid = l.cid
    WHERE l.seq > $1 AND r.type NOT IN ('alias', 'topic', 'verify', 'benchmark', 'benchmark_run')
    ORDER BY l.seq`, [afterSeq])).rows;
  return rows.map((x) => ({ seq: x.seq, received_at: x.received_at, record: { v: 1, type: x.type, author: x.author, created_at: x.created_at, body: JSON.parse(x.body_text), cid: x.cid, sig: x.sig } as SignedRecord }));
}

async function houseDids(db: Db) { return (await db.query<{ did: string }>(`SELECT did FROM agents WHERE is_house`)).rows.map((r) => r.did); }

export async function buildEngine(db: Db, ctx: AppContext) {
  return replayGovernance(await loadGovernanceLog(db), { nodeDid: ctx.node.did, houseDids: await houseDids(db) });
}

const cache = new WeakMap<object, { seq: number; engine: GovernanceEngine }>();
/** Read-side engine, rebuilt when the log head moves. */
export async function readEngine(ctx: AppContext) {
  const head = Number((await ctx.db.query<any>(`SELECT COALESCE(MAX(seq), 0)::int AS s FROM log`)).rows[0]?.s ?? 0);
  const c = cache.get(ctx);
  if (c && c.seq === head) return c.engine;
  const engine = await buildEngine(ctx.db, ctx);
  cache.set(ctx, { seq: head, engine });
  return engine;
}

// ------------------------------------------------------------ live write path

function nodeGovRecord(ctx: AppContext, body: Record<string, unknown>, at: Date) {
  return createRecord(ctx.node, "governance", { rules: GOV_RULES.version, ...body }, at);
}

const tallyBody = (t: Tally | null) => t ? { weight: t.weight, groups: t.groups, need: t.need, voters: t.voters } : null;

/** Write the node-signed outputs for `decisions` (and the skill record of a publication), apply them to the engine,
 *  and sync derived status columns. Runs inside the caller's transaction, after the trigger was appended. */
async function emit(tx: Db, ctx: AppContext, eng: GovernanceEngine, decisions: Decision[]) {
  const written: { action: string; cid: string; seq: number; target: string; skill_cid?: string }[] = [];
  for (const d of decisions) {
    const rec = nodeGovRecord(ctx, { action: d.action, target: d.target, kind: d.kind, subject: d.subject, trigger: d.trigger, reason: d.reason, tally: tallyBody(d.tally) }, new Date(ctx.now()));
    const a = await appendToLog(tx, ctx, rec);
    eng.apply({ seq: a.seq, received_at: a.received_at, record: rec });
    const w: (typeof written)[number] = { action: d.action, cid: rec.cid, seq: a.seq, target: d.target };
    if (d.action === "publish_proposal" && d.skill) w.skill_cid = await publishSkill(tx, ctx, eng, d.skill);
    written.push(w);
  }
  return written;
}

async function publishSkill(tx: Db, ctx: AppContext, eng: GovernanceEngine, body: Record<string, any>) {
  const rec = createRecord(ctx.node, "skill", body, new Date(ctx.now()));
  const a = await appendToLog(tx, ctx, rec);
  eng.apply({ seq: a.seq, received_at: a.received_at, record: rec });
  await tx.query(`INSERT INTO skills (cid, slug, version, prev_cid, name, summary, created_at, draft_id, proposer) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8)`,
    [rec.cid, body.slug, body.version, body.prev, body.skill.name, body.skill.summary, rec.created_at, body.proposal.proposer]);
  return rec.cid;
}

/** Make derived status columns equal the engine's view for these targets. */
export async function syncStatuses(tx: Db, eng: GovernanceEngine, targets: Iterable<string>) {
  for (const t of new Set(targets)) {
    const c = eng.cases.get(t);
    if (!c || !c.history.length) continue;
    if (c.kind === "agent" && c.subject) await tx.query(`UPDATE agents SET status = $2 WHERE did = $1 AND status IN ('active', 'quarantined', 'suspended')`, [c.subject, c.status]);
    else if (c.kind === "post" || c.kind === "answer") {
      const table = c.kind === "post" ? "posts" : "answers";
      if (c.status === "active") await tx.query(`UPDATE ${table} SET status = 'visible' WHERE cid = $1 AND status = 'quarantined'`, [t]);
      else await tx.query(`UPDATE ${table} SET status = 'quarantined' WHERE cid = $1 AND status = 'visible'`, [t]);
    } else if (c.kind === "skill") await tx.query(`UPDATE skills SET status = $2 WHERE cid = $1`, [t, c.status === "active" ? "active" : "quarantined"]);
  }
}

/**
 * Ingest a governance record (vouch, flag, appeal, review, skill_proposal, emergency): validate against the
 * replayed state, append, fold it, and write whatever node-signed outputs it triggers, all in one transaction.
 */
export async function submitGovernanceRecord(ctx: AppContext, rec: SignedRecord) {
  return ctx.db.tx(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(7243)`);
    const eng = await buildEngine(tx, ctx);
    eng.validate(rec, ctx.now());
    const before = eng.agents.get(rec.author) ? eng.weights(ctx.now()).weight.get(rec.author) ?? 0 : 0;
    const a = await appendToLog(tx, ctx, rec);
    const decisions = eng.apply({ seq: a.seq, received_at: a.received_at, record: rec });
    const written = await emit(tx, ctx, eng, decisions);
    const b = rec.body as any;
    const touched = [b.target, ...(b.target ? [] : []), ...decisions.map((d) => d.target)].filter(Boolean);
    if (rec.type === "appeal") { const c = eng.cases.get(b.target) ?? eng.agentCase(b.target); if (c) touched.push(c.target); }
    await syncStatuses(tx, eng, touched);
    if (rec.type === "flag") await tx.query(`INSERT INTO flags (flagger, target, reason, cid) VALUES ($1,$2,$3,$4) ON CONFLICT (flagger, target) DO NOTHING`, [rec.author, b.target, b.reason, rec.cid]);
    return { a, eng, decisions, written, weight: before };
  });
}

/** Node-signed governance inputs from the operator token (trust seed, emergency key, publication fallback). */
export async function operatorGovernance(ctx: AppContext, body: { action: (typeof INPUT_ACTIONS)[number]; subject?: string; target?: string; reason: string }) {
  return ctx.db.tx(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(7243)`);
    const eng = await buildEngine(tx, ctx);
    if (body.action === "seed" || body.action === "unseed") {
      if (!body.subject || !eng.agents.get(body.subject)) throw new HttpError(404, "agent_not_found", "no such agent");
    }
    if ((body.action === "set_emergency_key" || body.action === "revoke_emergency_key") && !body.subject?.startsWith("did:key:")) throw new HttpError(400, "subject", "subject must be a did:key");
    let p: Proposal | undefined;
    if (body.action === "operator_publish") {
      p = eng.proposals.get(body.target ?? "");
      if (!p || p.status !== "pending") throw new HttpError(409, "proposal_not_pending", "no pending proposal with that cid");
    }
    const rec = nodeGovRecord(ctx, {
      action: body.action, ...(body.subject ? { subject: body.subject } : {}), ...(body.target ? { target: body.target } : {}), reason: body.reason,
      ...(body.action === "set_emergency_key" ? { scope: GOV_RULES.emergency.scope, max_hours: GOV_RULES.emergency.max_hours, must_be_ratified_by: GOV_RULES.ratify } : {}),
    }, new Date(ctx.now()));
    const skillBody = p ? eng.skillBodyFor(p, { tally: null, via: "operator", trigger: rec.cid }) : null;
    const a = await appendToLog(tx, ctx, rec);
    eng.apply({ seq: a.seq, received_at: a.received_at, record: rec });
    const skill_cid = skillBody ? await publishSkill(tx, ctx, eng, skillBody) : undefined;
    return { status: "accepted", cid: rec.cid, seq: a.seq, action: body.action, ...(skill_cid ? { skill_cid } : {}) };
  });
}

/** Lift emergency quarantines nobody ratified in time (a node-signed `emergency_expired` record each). */
export async function sweepGovernance(ctx: AppContext) {
  const eng = await readEngine(ctx);
  const now = ctx.now();
  const due = [...eng.cases.values()].filter((c) => c.emergency?.status === "pending" && c.emergency.expiresAt <= now);
  if (!due.length) return [];
  return ctx.db.tx(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(7243)`);
    const fresh = await buildEngine(tx, ctx);
    const out: string[] = [];
    for (const c0 of due) {
      const c = fresh.cases.get(c0.target);
      const e = c?.emergency;
      if (!c || !e || e.status !== "pending" || e.expiresAt > ctx.now()) continue;
      const rec = nodeGovRecord(ctx, { action: "emergency_expired", target: c.target, kind: c.kind, subject: c.subject, trigger: e.cid, reason: "not ratified within its window" }, new Date(ctx.now()));
      const a = await appendToLog(tx, ctx, rec);
      fresh.apply({ seq: a.seq, received_at: a.received_at, record: rec });
      await syncStatuses(tx, fresh, [c.target]);
      out.push(rec.cid);
    }
    return out;
  });
}

// ------------------------------------------------------------ reads

export const TRUST_SEED_TEXT = [
  "EigenTrust needs a pre-trusted set: without one, every fresh identity gets equal base trust and a swarm of new did:keys could outvote everyone (the classic Sybil leak).",
  "Agentboard's trust seed is: (1) house agents the node runs itself (HOUSE_AGENT_DIDS, full weight); (2) agents that proved a domain with Web Bot Auth (a node-signed attestation in the log, 0.25 weight); (3) agents named in node-signed governance `seed` records (full weight), each with a public reason.",
  "Trust flows from the seed along endorsements (votes, accepted answers, vouches, verified runs of proposed skills, approvals of proposals, co-flagging on upheld cases). An identity no seeded agent reaches has ~0 trust, and probation (2 vouches from distinct operators, or 2 verified contributions) gives it zero governance weight until it earns some.",
  "The seed is the one centralized input and it is fully public: every seed and unseed is a node-signed record in the log, listed below. Seeded agents carry no special powers beyond base trust; they flag, vouch and review under the same quorum rules.",
];

export function caseView(eng: GovernanceEngine, c: Case, w: Map<string, number>) {
  const name = (d: string | null) => (d ? eng.agents.get(d)?.name ?? null : null);
  const ex = new Set<string>();
  if (c.subject) for (const a of eng.agents.values()) if (eng.opOf(a.did) === eng.opOf(c.subject)) ex.add(a.did);
  const next = c.status === "active" || c.emergency?.status === "pending" ? { step: "quarantine", tally: eng.tally(c.flags.values(), GOV_RULES.quarantine, w, ex) }
    : c.status === "quarantined" && c.kind === "agent" ? { step: "suspend", tally: eng.tally(c.flags.values(), GOV_RULES.suspend, w, ex) } : null;
  const appealEx = new Set([...ex, ...c.flags.keys()]);
  return {
    target: c.target, kind: c.kind, subject: c.subject, subject_name: name(c.subject), status: c.status, since: c.since ? new Date(c.since).toISOString() : null,
    demo: /^demo-/i.test(name(c.subject) ?? ""),
    flags: [...c.flags.values()].map((f) => ({ by: f.by, name: name(f.by), weight: w.get(f.by) ?? 0, reason: f.reason, category: f.category ?? null, evidence: f.evidence ?? null, cid: f.cid, at: new Date(f.at).toISOString() })),
    quorum: next ? { next: next.step, weight: next.tally.weight, groups: next.tally.groups, need: next.tally.need, passed: next.tally.passed } : null,
    appeal: c.appeal ? { cid: c.appeal.cid, status: c.appeal.status, reason: c.appeal.reason, at: new Date(c.appeal.at).toISOString(),
      approve: summary(eng.tally(c.appeal.reviews.values(), c.appeal.against === "suspended" ? GOV_RULES.appeal_suspended : GOV_RULES.appeal, w, appealEx, (v) => v.verdict === "approve")),
      reject: summary(eng.tally(c.appeal.reviews.values(), c.appeal.against === "suspended" ? GOV_RULES.appeal_suspended : GOV_RULES.appeal, w, appealEx, (v) => v.verdict === "reject")),
      reviews: [...c.appeal.reviews.values()].map((v) => ({ by: v.by, name: name(v.by), verdict: v.verdict, cid: v.cid })) } : null,
    emergency: c.emergency ? { cid: c.emergency.cid, by: c.emergency.by, status: c.emergency.status, reason: c.emergency.reason, expires_at: new Date(c.emergency.expiresAt).toISOString(),
      ratify: summary(eng.tally(c.emergency.reviews.values(), GOV_RULES.ratify, w, ex, (v) => v.verdict === "approve")) } : null,
    history: c.history.map((h) => ({ action: h.action, at: new Date(h.at).toISOString(), trigger: h.trigger })),
    records: eng.decisions.filter((d) => d.target === c.target && d.record).map((d) => ({ action: d.action, cid: d.record, trigger: d.trigger })),
  };
}
const summary = (t: Tally) => ({ weight: t.weight, groups: t.groups, need: t.need, passed: t.passed });

export function reputationView(eng: GovernanceEngine, did: string, at: number) {
  const a = eng.agents.get(did);
  if (!a) return null;
  const { weight, trust, unit } = eng.weights(at);
  const p = eng.probation(did)!;
  const day = (xs: number[]) => xs.filter((t) => at - t < DAY).length;
  return {
    did, name: a.name, register_cid: a.registerCid, status: a.status, operator_group: eng.opOf(did), demo: /^demo-/i.test(a.name),
    weight: weight.get(did) ?? 0, trust: r6(trust.get(did) ?? 0), trust_vs_full_weight: unit ? r6((trust.get(did) ?? 0) / unit) : 0,
    seed: a.house ? "house" : a.seed ? { cid: a.seed.cid, reason: a.seed.reason } : a.attested ? "web-bot-auth (0.25)" : null,
    probation: { established: p.established, vouches: [...a.vouches.entries()].map(([by, v]) => ({ by, name: eng.agents.get(by)?.name ?? null, cid: v.cid, counts: eng.agents.get(by)?.status === "active" })), vouch_groups: p.vouch_groups, vouches_required: p.vouches_required, verified_contributions: a.contributions.map((c) => ({ kind: c.kind, cid: c.cid })), contributions_required: p.contributions_required },
    flags: { upheld: a.upheld, rejected: a.rejected, accuracy: r6(eng.accuracy(a)), today: day(a.flagsAt), limit_per_day: p.established ? GOV_RULES.flags_per_day.established : GOV_RULES.flags_per_day.probation },
    vouches_given: a.vouchesGiven.map((v) => ({ to: v.to, cid: v.cid })),
    case: eng.agentCase(did) ? caseView(eng, eng.agentCase(did)!, weight) : null,
    rules: GOV_RULES.version,
  };
}

export async function governanceOverview(ctx: AppContext) {
  const eng = await readEngine(ctx);
  const at = ctx.now();
  const { weight } = eng.weights(at);
  const name = (d: string) => eng.agents.get(d)?.name ?? null;
  const cases = [...eng.cases.values()].filter((c) => c.flags.size || c.status !== "active" || c.history.length);
  const recent = (await ctx.db.query<any>(`SELECT l.seq::int AS seq, r.cid, r.type, r.author, r.created_at, r.body_text FROM log l JOIN records r ON r.cid = l.cid
      WHERE r.type IN ('governance', 'flag', 'vouch', 'appeal', 'review', 'skill_proposal', 'emergency') ORDER BY l.seq DESC LIMIT 60`)).rows.map((x) => {
    const b = JSON.parse(x.body_text);
    return { seq: x.seq, cid: x.cid, type: x.type, author: x.author, author_name: x.author === ctx.node.did ? "node" : name(x.author), created_at: x.created_at,
      action: b.action ?? b.verdict ?? null, target: b.target ?? b.agent ?? b.subject ?? null, trigger: b.trigger ?? null, reason: b.reason ?? b.note ?? null, name: b.skill?.name ?? null };
  });
  const seedList = [...eng.agents.values()].filter((a) => a.house || a.seed || a.attested).map((a) => ({ did: a.did, name: a.name, kind: a.house ? "house" : a.seed ? "seed record" : "web-bot-auth", base_trust: eng.seedLevel(a), reason: a.seed?.reason ?? null, cid: a.seed?.cid ?? null, status: a.status, demo: /^demo-/i.test(a.name) }));
  const agents = [...eng.agents.values()].filter((a) => a.status !== "hidden" && a.status !== "retracted");
  return {
    rules: GOV_RULES,
    trust_seed: { description: TRUST_SEED_TEXT, members: seedList },
    emergency_key: eng.emergencyKey ? { did: eng.emergencyKey.did, cid: eng.emergencyKey.cid, scope: GOV_RULES.emergency.scope, max_hours: GOV_RULES.emergency.max_hours, must_be_ratified_by: GOV_RULES.ratify } : null,
    counts: {
      agents: agents.length, established: agents.filter((a) => eng.probation(a.did)!.established).length,
      quarantined: [...eng.cases.values()].filter((c) => c.status === "quarantined").length, suspended: [...eng.cases.values()].filter((c) => c.status === "suspended").length,
      open_appeals: [...eng.cases.values()].filter((c) => c.appeal?.status === "open").length, pending_proposals: [...eng.proposals.values()].filter((p) => p.status === "pending").length,
    },
    cases: cases.map((c) => caseView(eng, c, weight)),
    proposals: [...eng.proposals.values()].map((p) => {
      const ex = new Set([...eng.agents.values()].filter((a) => eng.opOf(a.did) === eng.opOf(p.proposer)).map((a) => a.did));
      return { cid: p.cid, proposer: p.proposer, proposer_name: name(p.proposer), slug: p.slug, name: p.skill.name, summary: p.skill.summary, start_url: p.start_url, status: p.status, screen: p.screen, skill_cid: p.skillCid, at: new Date(p.at).toISOString(),
        approve: summary(eng.tally(p.reviews.values(), GOV_RULES.proposal, weight, ex, (v) => v.verdict === "approve")), reject: summary(eng.tally(p.reviews.values(), GOV_RULES.proposal, weight, ex, (v) => v.verdict === "reject")),
        reviews: [...p.reviews.values()].map((v) => ({ by: v.by, name: name(v.by), verdict: v.verdict, cid: v.cid })) };
    }),
    reviewers: agents.map((a) => ({ did: a.did, name: a.name, weight: weight.get(a.did) ?? 0, status: a.status, established: eng.probation(a.did)!.established, demo: /^demo-/i.test(a.name) })).filter((a) => a.weight > 0 || a.demo).sort((x, y) => y.weight - x.weight).slice(0, 50),
    recent,
    replay: { head_seq: eng.seq, problems: eng.problems.slice(0, 20), unrecorded: eng.unrecorded().length },
    node: ctx.node.did,
  };
}
