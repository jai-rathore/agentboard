/**
 * Reality check (docs/REALITY_CHECK.md): would a capable agent with web search and fetch check Agentboard first for this?
 *   feature : painful from scratch (postback forms, POST-only search, no keyless API) and the answer is tied to the input
 *   keep    : works and is verified, but a capable agent can usually do it in one fetch; listed, not featured
 *   easy    : a public JSON API answers it in one call; kept as a mechanism demo, never featured
 *   demo    : a page Agentboard hosts to show the mechanism (mock site)
 * Unknown slugs (new skills) are "keep" until reviewed. Listing and the empty-query find_skill order by this.
 */
export type Verdict = "feature" | "keep" | "easy" | "demo";
export const REALITY: Record<string, { verdict: Verdict; why: string }> = {
  "ofac-sanctions-search": { verdict: "feature", why: "ASP.NET postback search (viewstate) with fuzzy scoring: a fetch-only agent cannot submit it; the program is read from the row that names the input" },
  "florida-license-status": { verdict: "feature", why: "POST-only license search with no public API; the status is read from the results row whose license number is the input" },
  "companies-house-last-accounts": { verdict: "keep", why: "the official API needs a registered key, but the company page is one GET by number, so a fetch-capable agent rarely needs a skill" },
  "fmcsa-carrier-authority": { verdict: "keep", why: "USDOT status from SAFER (the API needs a webkey); a direct GET URL exists, and it returns USDOT status, not operating authority yet" },
  "wikipedia-infobox-fact": { verdict: "easy", why: "the Wikipedia API or one page fetch answers it" },
  "x-rates-exchange-rate": { verdict: "easy", why: "free FX APIs answer it in one call" },
  "pypi-package-version": { verdict: "easy", why: "pypi.org/pypi/<name>/json answers it in one call" },
  "crates-io-version": { verdict: "easy", why: "the crates.io API answers it in one call" },
  "rubygems-version": { verdict: "easy", why: "the RubyGems API answers it in one call" },
  "go-package-version": { verdict: "easy", why: "proxy.golang.org @latest answers it in one call" },
  "hacker-news-top-story": { verdict: "easy", why: "the HN Firebase API answers it in one call" },
  "hn-search-top-result": { verdict: "easy", why: "the Algolia HN search API answers it in one call" },
  "github-repo-stars-release": { verdict: "easy", why: "the GitHub REST API answers it in one call" },
};
const ORDER: Record<Verdict, number> = { feature: 0, keep: 1, easy: 2, demo: 3 };
export function realityOf(slug: string, siteKind?: string): { verdict: Verdict; why: string } {
  if (siteKind === "mock") return { verdict: "demo", why: "a page Agentboard hosts to show the mechanism, not a real site" };
  return REALITY[slug] ?? { verdict: "keep", why: "not reviewed yet" };
}
export const realityRank = (slug: string, siteKind?: string) => ORDER[realityOf(slug, siteKind).verdict];
