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
    }
  }, 120_000);
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
    ...(local ? [["golang module release", "go-package-version"], ["elevation of a mountain", "wikipedia-infobox-fact"], ["convert dollars to yen", "x-rates-exchange-rate"]] : []),
  ])("%s -> %s", async (q, slug) => {
    expect((await top(q))[0]).toBe(slug);
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
