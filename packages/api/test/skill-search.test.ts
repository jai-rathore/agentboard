/**
 * find_skill hybrid retrieval (services/skillSearch.ts) over a copy of the live skill catalog
 * (fixtures/skills-catalog.json: the latest version of each public skill on agentboard-api, Oct 29, 2026).
 * CI uses the offline hashing embedder, so these paraphrases must be found by FTS/trigram plus the lexical vector;
 * set SKILL_SEARCH_LOCAL_EMBED=1 to run the same queries against bge-small (downloads the model).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { createRecord } from "@agentboard/core";
import { makeNode, type TestNode } from "./helpers.js";
import { appendToLog } from "../src/services/log.js";
import { findSkills } from "../src/services/skills.js";
import { indexSkills, skillSearchText } from "../src/services/skillSearch.js";

const CATALOG: { slug: string; skill: any; source: { start_url: string } }[] = JSON.parse(readFileSync(new URL("./fixtures/skills-catalog.json", import.meta.url), "utf8"));
const local = process.env.SKILL_SEARCH_LOCAL_EMBED === "1";

describe(`find_skill hybrid search (${local ? "bge-small" : "hash embedder"})`, () => {
  let node: TestNode;
  beforeAll(async () => {
    node = await makeNode(local ? { offline: false, embedProvider: "local" } : {});
    const ctx = node.ctx;
    for (const s of CATALOG) {
      const rec = createRecord(ctx.node, "skill", { slug: s.slug, version: 1, prev: null, skill: s.skill, source: s.source }, new Date(ctx.now()));
      await ctx.db.tx(async (tx) => { await appendToLog(tx, ctx, rec); await tx.query(`INSERT INTO skills (cid, slug, version, prev_cid, name, summary, created_at) VALUES ($1,$2,1,NULL,$3,$4,$5)`, [rec.cid, s.slug, s.skill.name, s.skill.summary, rec.created_at]); });
      cids.set(s.slug, rec.cid);
    }
    // a few signed runs, as on the live node: their inputs make a task phrased by its inputs findable
    const run = async (slug: string, params: Record<string, string>, success: boolean, evidence: string) => {
      const r = createRecord(ctx.node, "skill_run", { skill: cids.get(slug), success, params, start_url: CATALOG.find((c) => c.slug === slug)!.source.start_url, actions: [], duration_ms: 6000, usage: { calls: 0, usd: 0 }, replay: { mode: "trace" }, verdict: { success, evidence }, requested_by: { via: "web" } }, new Date(ctx.now()));
      await ctx.db.tx(async (tx) => { await appendToLog(tx, ctx, r); await tx.query(`INSERT INTO skill_runs (cid, skill_cid, success, created_at) VALUES ($1,$2,$3,$4)`, [r.cid, cids.get(slug), success, r.created_at]); });
    };
    await run("x-rates-exchange-rate", { target_currency: "Japanese Yen" }, true, "rate shown");
    await run("wikipedia-infobox-fact", { search_query: "Seoul", target_field: "Population" }, true, "Population row shown");
    await run("wikipedia-infobox-fact", { search_query: "Mount Fuji", target_field: "Elevation" }, false, 'Not verified: this page has no "Elevation" row. Final URL https://en.wikipedia.org/wiki/Mount_Fuji.');
  }, 120_000);
  const cids = new Map<string, string>();
  afterAll(async () => { await node?.ctx.db.close(); });
  const top = async (q: string, n = 3) => (await findSkills(node.ctx, q, n)).map((s) => s.slug);

  it("indexes params, steps and the site host; lazily on the first search", async () => {
    expect(skillSearchText({ skill: { params: [{ name: "target_currency", description: "Currency name", example: "Euro" }], steps: [{ intent: "Find the row" }], success_check: "rate shown" }, source: { start_url: "https://www.x-rates.com/table/?from=USD" } }))
      .toBe("target currency Currency name (e.g. Euro)\nFind the row\nrate shown\nx-rates.com");
    expect((await top("currency conversion rate"))[0]).toBe("x-rates-exchange-rate");
    expect(await indexSkills(node.ctx.db, node.ctx.embedder)).toBe(0); // all indexed by the search above
    expect((await node.ctx.db.query<any>(`SELECT count(*)::int AS n FROM skills WHERE emb IS NULL OR search_text IS NULL`)).rows[0].n).toBe(0);
  });

  it.each([
    ["currency conversion rate", "x-rates-exchange-rate"],
    ["latest version of a python library", "pypi-package-version"],
    ["newest release of a rust crate", "crates-io-version"],
    ["what is the most upvoted story on hacker news right now", "hacker-news-top-story"],
    ["ruby gem version", "rubygems-version"],
    ["version of a go module", "go-package-version"],
    ["file a new support ticket", "create-a-support-ticket"],
    // paraphrases with no shared words need the semantic model (run with SKILL_SEARCH_LOCAL_EMBED=1)
    ...(local ? [["golang module release", "go-package-version"], ["elevation of mount everest", "wikipedia-infobox-fact"], ["convert dollars to yen", "x-rates-exchange-rate"]] : []),
  ])("%s -> %s", async (q, slug) => {
    expect((await top(q))[0]).toBe(slug);
  });

  // off-domain tasks: an explicit no-match, never the nearest demo skill (the bug: "order a pizza" -> the mock shop)
  it.each([
    "book a restaurant reservation for 4 tonight", "restaurant reservation", "book a table at a restaurant",
    "book a flight from SFO to JFK", "find cheap flights", "order a pizza", "order pizza delivery", "buy concert tickets",
    "check the weather in Paris", "rent a car", "download this month's invoice from a vendor portal", "send an email",
    "book a hotel room", "track my package", "what is the stock price of Apple", "translate text to French", "schedule a meeting",
  ])("no match: %s", async (q) => {
    expect(await top(q)).toEqual([]);
    const r = await node.req("GET", `/v1/skills/find?q=${encodeURIComponent(q)}`);
    expect(r.body.matches).toEqual([]);
    expect(r.body.no_match.message).toMatch(/no recently verified workflow/i);
    expect(r.body.no_match.contribute).toMatch(/propose_skill/);
  });

  it.each([
    ["dollars to yen exchange rate", "x-rates-exchange-rate"],
    ["latest release of a rust crate", "crates-io-version"],
    ["hacker news top story", "hacker-news-top-story"],
    ["github repository star count", "github-repo-stars-release"],
    ["search hacker news for sqlite", "hn-search-top-result"],
    ["create a support ticket", "create-a-support-ticket"],
    ["dollars to yen", "x-rates-exchange-rate"], // "yen" only in a verified run's inputs
    ["population of Seoul", "wikipedia-infobox-fact"], // every word in a verified run's inputs, low cosine
    ...(local ? [["dollars to yen", "x-rates-exchange-rate"], ["convert USD to EUR", "x-rates-exchange-rate"], ["latest version of a python package", "pypi-package-version"]] : []),
  ])("true positive, at most 3 results, each with a trust card: %s -> %s", async (q, slug) => {
    const r = await node.req("GET", `/v1/skills/find?q=${encodeURIComponent(q)}&limit=10`);
    expect(r.body.matches[0].slug).toBe(slug);
    expect(r.body.matches.length).toBeLessThanOrEqual(3);
    expect(r.body.no_match).toBeUndefined();
    const t = r.body.matches[0].trust;
    expect(t.task).toBe(r.body.matches[0].name);
    expect(t.time_cost.cold).toMatch(/^unknown/); // no benchmark in this catalog: nothing is invented
    expect(t.login_required).toBe("none");
    if (!["x-rates-exchange-rate", "wikipedia-infobox-fact"].includes(slug)) expect([t.last_verified_run, t.example, t.latest_failure]).toEqual(["none yet", "none yet", "none yet"]);
  });

  it("trust card from the signed runs: counts, latest failure, distinct inputs, identities", async () => {
    const t = (await findSkills(node.ctx, "population of Seoul"))[0].trust;
    expect(t.site).toBe("en.wikipedia.org");
    expect(t.input_schema).toHaveProperty("search_query");
    expect(t.example.input).toEqual({ search_query: "Seoul", target_field: "Population" });
    expect(t.runs_7d).toEqual({ verified: 1, failed: 1 });
    expect(t.latest_failure.input).toEqual({ search_query: "Mount Fuji", target_field: "Elevation" });
    expect(t.latest_failure.reason).toBe('this page has no "Elevation" row.');
    expect(t.distinct_inputs_tested).toEqual({ total: 2, verified: 1 });
    expect(t.identities.operator_house.runs).toBe(2);
    expect(t.identities.independent_agents).toMatchObject({ identities: 0, runs: 0 });
    expect(t.actions).toMatch(/^read-only/);
    expect(t.approvals).toBe("none");
    expect(t.when_not_to_use.join(" ")).toMatch(/Mount Fuji/);
  });

  it("returns nothing for nonsense, keeps the real-site prior, and reads records in one query", async () => {
    expect(await top("zzqx vlorp")).toEqual([]);
    expect(await top("how many people live in a city")).toEqual([]); // only "city" (a shipping address param) matched: noise
    const found = await findSkills(node.ctx, "buy a product in a store", 5);
    expect(found[0].site_kind).toBe("mock"); // a clearly better demo match still wins
    expect(found[0].matched_by?.length).toBeGreaterThan(0);
    const queries: string[] = [];
    const db = node.ctx.db, orig = db.query.bind(db);
    (db as any).query = (sql: string, p?: unknown[]) => { queries.push(sql); return orig(sql, p as any); };
    try { await findSkills(node.ctx, "exchange rate", 5); } finally { (db as any).query = orig; }
    expect(queries.filter((q) => /FROM records WHERE cid = \$1/.test(q))).toEqual([]);
    expect(queries.length).toBeLessThan(15);
  });
});
