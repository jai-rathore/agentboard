/**
 * Hybrid retrieval for find_skill, the same shape as knowledge search (search.ts):
 *   - Postgres FTS over name (A), slug (A), summary (B) and the steps/params text (C), OR-of-prefixes, ts_rank_cd
 *   - pg_trgm word similarity on name and on summary
 *   - bge-small embeddings over name, summary, params and steps (pgvector cosine)
 * merged with reciprocal rank fusion. A vector-only hit must be reasonably close, so nonsense finds nothing.
 * The skill index (search_text, emb) is filled lazily for any version that lacks it, and on boot.
 */
import type { Db } from "../db/index.js";
import type { AppContext } from "../context.js";
import type { Embedder } from "./embeddings.js";
import { cosine, toPgVector } from "./embeddings.js";
import { reciprocalRankFusion, type RankedList } from "./rrf.js";
import { orTsQuery } from "./text.js";

/** The steps/params text a skill is found by (beyond its name and summary). */
export function skillSearchText(body: any): string {
  const sk = body?.skill ?? {};
  let host = "";
  try { host = body?.source?.start_url ? new URL(String(body.source.start_url).replace(/\{\{[^}]*\}\}/g, "x")).hostname.replace(/^www\./, "") : ""; } catch { /* template or bad url */ }
  return [
    ...(sk.params ?? []).map((p: any) => `${p.name ?? ""} ${p.description ?? ""}${p.example ? ` (e.g. ${p.example})` : ""}`),
    ...(sk.steps ?? []).map((s: any) => `${s.intent ?? ""}`),
    sk.success_check ?? "",
    host,
  ].map((x) => String(x).replace(/[_{}]/g, " ").trim()).filter(Boolean).join("\n").slice(0, 4000);
}
export const skillEmbedText = (r: { name: string; summary: string; search_text: string }) => `${r.name}\n${r.summary}\n${r.search_text}`;

/** Fill search_text and emb for skill versions that lack them. Safe to run concurrently (only touches NULL rows). */
export async function indexSkills(db: Db, e: Embedder, batch = 16): Promise<number> {
  let n = 0;
  for (;;) {
    const rows = (await db.query<any>(`SELECT s.cid, s.name, s.summary, r.body_text FROM skills s JOIN records r ON r.cid = s.cid
      WHERE s.search_text IS NULL OR s.emb IS NULL ORDER BY s.created_at LIMIT $1`, [batch])).rows;
    if (!rows.length) return n;
    const docs = rows.map((r) => ({ ...r, search_text: skillSearchText(JSON.parse(r.body_text)) }));
    const vecs = await e.embed(docs.map(skillEmbedText), "document");
    for (let i = 0; i < docs.length; i++) await db.query(`UPDATE skills SET search_text = $2, emb = $3::vector WHERE cid = $1`, [docs[i].cid, docs[i].search_text, toPgVector(vecs[i])]);
    n += rows.length;
  }
}

export interface SkillHit { cid: string; rrf: number; ranks: Record<string, number>; cos: number | null }

/** Ranked candidate cids among `candidateSql` (a SELECT of skill cids, e.g. the latest active versions). */
export async function hybridSkillSearch(ctx: AppContext, q: string, candidateSql: string, opts: { filter?: boolean } = {}): Promise<SkillHit[]> {
  // degrade gracefully: without an embedder the lexical lists still answer
  await indexSkills(ctx.db, ctx.embedder).catch((e) => console.error(`[agentboard] skill index: ${(e as Error).message}`));
  const orq = orTsQuery(q);
  const qvec = await ctx.embedder.embed([q], "query").then((v) => v[0]).catch(() => null);
  const ids = async (sql: string, params: unknown[]) => (await ctx.db.query<{ cid: string }>(sql, params)).rows.map((r) => r.cid);
  const within = `s.cid IN (SELECT cid FROM (${candidateSql}) c)`;
  const [fts, name, summary, vec] = await Promise.all([
    // all words first, then how many distinct query words a skill covers, then ts_rank_cd (name > summary > steps)
    orq ? ctx.db.query<{ cid: string; covered: number; terms: number }>(`SELECT s.cid,
        (SELECT count(*)::int FROM unnest($3::text[]) t WHERE numnode(to_tsquery('english', t)) > 0 AND s.tsv @@ to_tsquery('english', t)) AS covered,
        (SELECT count(*)::int FROM unnest($3::text[]) t WHERE numnode(to_tsquery('english', t)) > 0) AS terms
      FROM skills s WHERE ${within} AND s.tsv @@ to_tsquery('english', $1)
      ORDER BY (s.tsv @@ websearch_to_tsquery('english', $2)) DESC, covered DESC, ts_rank_cd(s.tsv, to_tsquery('english', $1), 32) DESC LIMIT 50`, [orq, q, orq.split(" | ")]).then((r) => r.rows) : Promise.resolve([]),
    ids(`SELECT s.cid FROM skills s WHERE ${within} AND word_similarity($1, s.name) > 0.5 ORDER BY word_similarity($1, s.name) DESC LIMIT 30`, [q]),
    ids(`SELECT s.cid FROM skills s WHERE ${within} AND word_similarity($1, s.summary) > 0.5 ORDER BY word_similarity($1, s.summary) DESC LIMIT 30`, [q]),
    qvec ? ids(`SELECT s.cid FROM skills s WHERE ${within} AND s.emb IS NOT NULL ORDER BY s.emb <=> $1::vector LIMIT 30`, [toPgVector(qvec)]) : Promise.resolve([]),
  ]);
  const hashed = ctx.embedder.model.startsWith("local-hash");
  const coverage = new Map(fts.map((r) => [r.cid, r.covered / Math.max(1, r.terms)]));
  const lists: RankedList[] = [{ name: "fts", ids: fts.map((r) => r.cid), weight: 1 }, { name: "vector", ids: vec, weight: hashed ? 0.6 : 1 }, { name: "trigram_name", ids: name, weight: 0.5 }, { name: "trigram_summary", ids: summary, weight: 0.3 }];
  const fused = reciprocalRankFusion(lists);
  if (!fused.length) return [];
  const embs = new Map((await ctx.db.query<any>(`SELECT cid, emb::text AS emb FROM skills WHERE cid = ANY($1)`, [fused.map((f) => f.id)])).rows.map((r) => [r.cid, r.emb ? (JSON.parse(r.emb) as number[]) : null]));
  return fused.flatMap((f) => {
    const emb = embs.get(f.id);
    const cos = emb && qvec ? cosine(qvec, emb) : null;
    if (opts.filter === false) return [{ cid: f.id, rrf: f.score, ranks: f.ranks, cos }]; // the caller applies its own gate (skillMatch.ts)
    const onlyVector = Object.keys(f.ranks).length === 1 && f.ranks.vector !== undefined;
    if (onlyVector && (cos ?? 0) < ctx.embedder.thresholds.vectorOnlyMin) return []; // semantic-only matches must be close
    // a full-text hit on a small share of the query's words (one of four), with no close vector or trigram match, is
    // noise ("how many people live in a city" matching "city" in a shipping address): left out
    const weakText = f.ranks.fts !== undefined && (coverage.get(f.id) ?? 0) < 1 / 3 && f.ranks.trigram_name === undefined && f.ranks.trigram_summary === undefined;
    if (weakText && (cos ?? 0) < ctx.embedder.thresholds.vectorOnlyMin) return [];
    return [{ cid: f.id, rrf: f.score, ranks: f.ranks, cos }];
  });
}
