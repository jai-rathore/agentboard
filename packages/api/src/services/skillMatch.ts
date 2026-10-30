/**
 * find_skill confidence gate. Retrieval (skillSearch.ts) ranks candidates; this decides which are real matches, so an
 * off-domain task ("book a restaurant", "order a pizza") gets an explicit no-match instead of the nearest demo skill.
 *
 * score = cosine(query, skill) + TERM_WEIGHT x coverage, where coverage is the share of the query's content words found
 * in the skill's name, summary, slug, site host and params (names, descriptions, examples) or in the inputs of its
 * verified runs (so "population of Seoul" finds the Wikipedia infobox skill that was verified on Seoul / Population).
 * A candidate matches when its cosine is high on its own, or reasonable with more than half of the words covered, or
 * low but with every word covered (thresholds per embedder in embeddings.ts). Results within MARGIN of the best one are
 * kept, DEFAULT_MATCHES unless the caller asks for more (at most MAX_MATCHES).
 */
import type { EmbedThresholds } from "./embeddings.js";
import { tokenize } from "./embeddings.js";

/** Results returned when the caller does not ask (DEFAULT_MATCHES) and the most a caller may ask for (MAX_MATCHES). */
export const DEFAULT_MATCHES = 3;
export const MAX_MATCHES = 5;
/** Ranking only: when a skill that takes no input matches, a skill that needs an input the query does not give (every
 * query word is already in the skill's own text, none left to be the search term) ranks below it ("top story on HN":
 * the front page, not an HN search). */
export const UNFILLED_INPUT_PENALTY = 0.15;
export const TERM_WEIGHT = 0.3;
export const MARGIN = 0.2;

export const NO_MATCH_MESSAGE = "No recently verified workflow for this task. Continue with your own tools.";
export const CONTRIBUTE_HINT = "To contribute one: propose_skill in the local MCP server (npx -y github:jai-rathore/agentboard) publishes it after reputation-weighted review; every run of it is then verified and logged in public.";

/** Words that say nothing about which site or task ("please show me ... right now"). */
const FILLER = new Set("please me show tell find get look up want need some any right now today currently just give".split(" "));
/** Common web-task synonyms folded to one word on both sides (after tokenize's stemming). */
const SYNONYMS: Record<string, string> = {
  newest: "latest", recent: "latest", current: "latest", last: "latest",
  release: "version",
  library: "package", lib: "package",
  most: "top", upvot: "top", best: "top", highest: "top", popular: "top",
  cost: "price",
};
const norm = (toks: string[]) => toks.filter((t) => !FILLER.has(t)).map((t) => SYNONYMS[t] ?? t);

/** What people call a site whose host name does not say it. */
const SITE_ALIASES: Record<string, string> = {
  "news.ycombinator.com": "hn hacker news",
  "find-and-update.company-information.service.gov.uk": "companies house uk company register",
};
/** Words of a host name worth matching: "en.wikipedia.org" -> wikipedia; "pkg.go.dev" -> pkg, go; plus SITE_ALIASES. */
export function hostWords(url: string | null | undefined): string {
  try {
    const h = new URL(String(url ?? "").replace(/\{\{[^}]*\}\}/g, "x")).hostname.replace(/^www\./, "");
    return [...h.split(".").slice(0, -1).filter((w) => !/^(en|m|api|app|vercel)$/.test(w)), SITE_ALIASES[h] ?? ""].filter(Boolean).join(" ");
  } catch { return ""; }
}

export function skillVocab(s: { slug: string; name: string; summary: string; params?: { name?: string; description?: string; example?: string }[] | null; start_url?: string | null }, opts: { examples?: boolean } = {}): Set<string> {
  return new Set(norm(tokenize([s.name, s.summary, s.slug.replace(/-/g, " "), hostWords(s.start_url),
    ...(s.params ?? []).map((p) => `${String(p.name ?? "").replace(/_/g, " ")} ${p.description ?? ""} ${opts.examples === false ? "" : p.example ?? ""}`)].join(" "))));
}

/** The skill takes inputs but every query word is part of its own text (not an example value): nothing in the query fills them. */
export function inputsUnfilled(terms: string[], s: Parameters<typeof skillVocab>[0]): boolean {
  if (!(s.params ?? []).length || !terms.length) return false;
  const own = skillVocab(s, { examples: false });
  return terms.every((t) => own.has(t));
}

/** Folds input values (a verified run's params) the same way. */
export function inputVocab(values: unknown[], into = new Set<string>()): Set<string> {
  for (const t of norm(tokenize(values.map(String).join(" ")))) into.add(t);
  return into;
}

export function queryTerms(q: string): string[] { return [...new Set(norm(tokenize(q)).filter((t) => t.length > 1))]; }

export function coverage(terms: string[], ...vocabs: Set<string>[]): number {
  if (!terms.length) return 0;
  return terms.filter((t) => vocabs.some((v) => v.has(t))).length / terms.length;
}

export function matchScore(cos: number | null, cov: number): number { return (cos ?? 0) + TERM_WEIGHT * cov; }

export function passesGate(cos: number | null, cov: number, th: Pick<EmbedThresholds, "skillStrongCos" | "skillTermCos" | "skillAllTermsCos">): boolean {
  const c = cos ?? 0;
  return c >= th.skillStrongCos || (cov > 0.5 && c >= th.skillTermCos) || (cov >= 1 && c >= th.skillAllTermsCos);
}

/** Gate, then keep the ones within MARGIN of the best score (sorted by `rank`, which may add a small prior), at most `max`. */
export function selectMatches<T extends { cos: number | null; cov: number; rank: number }>(cands: T[], th: Pick<EmbedThresholds, "skillStrongCos" | "skillTermCos" | "skillAllTermsCos">, max = DEFAULT_MATCHES): T[] {
  const ok = cands.filter((c) => passesGate(c.cos, c.cov, th)).sort((a, b) => b.rank - a.rank);
  if (!ok.length) return [];
  const best = Math.max(...ok.map((c) => matchScore(c.cos, c.cov)));
  return ok.filter((c) => matchScore(c.cos, c.cov) >= best - MARGIN).slice(0, max);
}
