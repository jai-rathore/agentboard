/**
 * Skill safety, shared by the API, the web app and the MCP server (the executor carries a copy in
 * services/executor/src/policy.mjs, kept in sync by a test).
 *
 * Steps that submit, buy, send or delete always wait for a human. The recorder's risk flags are not
 * trusted alone: flags are also inferred from the steps' own words, and the executor additionally gates
 * by what a click actually lands on.
 */
export const GATED_FLAGS = ["submits_form", "sends_message", "purchase", "deletes_data"] as const;
export type GatedFlag = (typeof GATED_FLAGS)[number];

export const FLAG_WORDS: Record<GatedFlag, RegExp> = {
  submits_form: /\b(submit|create|file|save|post|confirm|register|sign ?up|apply|update)\b/i,
  sends_message: /\b(send|reply|invite|share|tweet|message)\b/i,
  purchase: /\b(buy|order|pay|checkout|check out|purchase|subscribe|book|reserve|place)\b/i,
  deletes_data: /\b(delete|remove|destroy|erase|cancel|archive|clear|discard)\b/i,
};

export const FLAG_LABELS: Record<string, string> = {
  submits_form: "submits a form", sends_message: "sends a message", purchase: "spends money", deletes_data: "deletes data",
  login_required: "needs a login", personal_data: "handles personal data",
};

interface StepLike { intent: string; target: string; action: string; value?: string }
interface SkillLike { risk_flags?: string[]; steps: StepLike[] }

const commits = (s: StepLike) => s.action === "click" || s.action === "keypress";

/** Words that make a step a search or lookup ("Submit the search", "press Enter to run the query"). */
export const SEARCH_WORDS = /\b(search(es|ing)?|query|look ?up|find)\b/i;
/**
 * A search submit: pressing Enter in, or clicking the button of, a search box. It only navigates to results, so it is
 * not a risky submit even when its words say "submit": the only gated word it may use is submits_form's, and it must
 * say search/query. Real form submits ("Submit the ticket") and anything that buys, sends or deletes stay gated, and
 * the executor still checks the element itself at run time (a read-only GET/role=search form, or no form at all).
 */
/** The target without the neighbors it is located by ("Search button between the per-page dropdown and the Clear button"): a
 * gated word on a neighbor ("Clear") says nothing about the control being clicked. */
export const ownTarget = (t: string | undefined): string => String(t ?? "").split(/\b(?:between|next to|beside|besides|below|above|beneath|near|left of|right of|after|before)\b/i)[0];
export function isSearchSubmit(s: StepLike): boolean {
  if (!commits(s)) return false;
  const text = `${s.intent} ${ownTarget(s.target)}`;
  if (!SEARCH_WORDS.test(text)) return false;
  return GATED_FLAGS.every((f) => f === "submits_form" || !FLAG_WORDS[f].test(text));
}

/** A declared submits_form whose only submitting steps are search submits (the recorder flagged pressing Enter in a search box). */
function explainedBySearch(skill: SkillLike): boolean {
  const c = skill.steps.filter(commits);
  return c.some(isSearchSubmit) && !c.some((s) => !isSearchSubmit(s) && FLAG_WORDS.submits_form.test(`${s.intent} ${s.target}`));
}
function declaredGated(skill: SkillLike): GatedFlag[] {
  const d = (skill.risk_flags ?? []).filter((f): f is GatedFlag => (GATED_FLAGS as readonly string[]).includes(f));
  return explainedBySearch(skill) ? d.filter((f) => f !== "submits_form") : d;
}

/** Steps that will pause for a human, with the flags they trigger. */
export function gatedSteps(skill: SkillLike): { index: number; flags: GatedFlag[] }[] {
  const out: { index: number; flags: GatedFlag[] }[] = [];
  skill.steps.forEach((s, index) => {
    if (!commits(s) || isSearchSubmit(s)) return;
    const text = `${s.intent} ${s.target}`;
    const flags = GATED_FLAGS.filter((f) => FLAG_WORDS[f].test(text));
    if (flags.length) out.push({ index, flags });
  });
  // A skill flagged as committing whose steps never say so: its last click is the commit.
  const declared = declaredGated(skill);
  if (declared.length && !out.length) {
    const last = skill.steps.map((s, i) => [s, i] as const).filter(([s]) => commits(s)).pop();
    if (last) out.push({ index: last[1], flags: declared });
  }
  return out;
}

/** The recorder's flags plus any implied by the steps. Never fewer than declared, except a declared submits_form whose only submitting steps are search submits. */
export function effectiveRiskFlags(skill: SkillLike): string[] {
  const searchOnly = explainedBySearch(skill);
  const set = new Set((skill.risk_flags ?? []).filter((f) => f !== "none" && !(f === "submits_form" && searchOnly)));
  for (const g of gatedSteps(skill)) for (const f of g.flags) set.add(f);
  return set.size ? [...set] : ["none"];
}

/** Flags that keep a skill off the public (no-token) replay trigger: anything that commits, logs in or handles personal data. */
export const PUBLIC_REPLAY_BLOCKING_FLAGS = [...GATED_FLAGS, "login_required", "personal_data"] as const;

/**
 * Whether a skill is non-destructive enough for the public replay trigger: no declared or inferred
 * submit/buy/send/delete flag, no login or personal data, and no step (of any action) whose words say it
 * submits, buys, sends or deletes. The allowlist (PUBLIC_REPLAY_SKILLS) is still required on top of this.
 */
export function publicReplaySafety(skill: SkillLike): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const flags = new Set(effectiveRiskFlags(skill)); // declared flags included (a declared submits_form only drops when it was a search submit)
  for (const f of PUBLIC_REPLAY_BLOCKING_FLAGS) if (flags.has(f)) reasons.push(`risk flag ${f}`);
  skill.steps.forEach((s, i) => {
    const text = `${s.intent} ${s.target}`;
    const hit = isSearchSubmit(s) ? [] : GATED_FLAGS.filter((f) => FLAG_WORDS[f].test(text));
    if (hit.length) reasons.push(`step ${i + 1} looks like it ${hit.map((f) => FLAG_LABELS[f]).join(" and ")}`);
  });
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/**
 * "mock" for Agentboard's own demo sites (the /demo/ pages on the Agentboard web or API host: the Acme Helpdesk and
 * Bean There Coffee mocks), "real" for every other site. mockHosts are the Agentboard hosts (web app, API).
 */
export function siteKindOf(url: string | null | undefined, mockHosts: string[] = []): "real" | "mock" {
  if (!url) return "real";
  let u: URL;
  try { u = new URL(url); } catch { return /^\/?demo\//.test(url) ? "mock" : "real"; }
  const h = u.hostname.toLowerCase();
  const ours = mockHosts.map((x) => x.toLowerCase()).includes(h) || h === "localhost" || h === "127.0.0.1" || /(^|\.)agentboard[^.]*\.(vercel\.app|onrender\.com|test)$/.test(h) || h === "agentboard.test";
  return ours && u.pathname.startsWith("/demo/") ? "mock" : "real";
}
