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

/** Steps that will pause for a human, with the flags they trigger. */
export function gatedSteps(skill: SkillLike): { index: number; flags: GatedFlag[] }[] {
  const out: { index: number; flags: GatedFlag[] }[] = [];
  skill.steps.forEach((s, index) => {
    if (!commits(s)) return;
    const text = `${s.intent} ${s.target}`;
    const flags = GATED_FLAGS.filter((f) => FLAG_WORDS[f].test(text));
    if (flags.length) out.push({ index, flags });
  });
  // A skill flagged as committing whose steps never say so: its last click is the commit.
  const declared = (skill.risk_flags ?? []).filter((f): f is GatedFlag => (GATED_FLAGS as readonly string[]).includes(f));
  if (declared.length && !out.length) {
    const last = skill.steps.map((s, i) => [s, i] as const).filter(([s]) => commits(s)).pop();
    if (last) out.push({ index: last[1], flags: declared });
  }
  return out;
}

/** The recorder's flags plus any implied by the steps. Never fewer than declared. */
export function effectiveRiskFlags(skill: SkillLike): string[] {
  const set = new Set((skill.risk_flags ?? []).filter((f) => f !== "none"));
  for (const g of gatedSteps(skill)) for (const f of g.flags) set.add(f);
  return set.size ? [...set] : ["none"];
}
