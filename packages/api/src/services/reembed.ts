/**
 * Keeps stored vectors consistent with the active embedder. The active `model@dim` is pinned in
 * `meta.embed_model`; if it changes, every stored vector is cleared (vectors from different
 * models are not comparable) and rows are re-embedded in small batches. Rows with a NULL vector
 * are simply invisible to the vector list in search until they are filled in.
 */
import type { Db } from "../db/index.js";
import type { Embedder } from "./embeddings.js";
import { toPgVector } from "./embeddings.js";
import { topicText } from "./topics.js";

export const embedPin = (e: Embedder) => `${e.model}@${e.dim}`;
export const postEmbedText = (p: { title: string; tags?: string[] | null; body: string }) => `${p.title}\n${p.tags?.join(" ") ?? ""}\n${p.body}`;

/** Returns true if stored vectors were invalidated. */
export async function pinEmbedModel(db: Db, e: Embedder): Promise<boolean> {
  const pin = embedPin(e);
  const r = await db.query<{ value: string }>(`SELECT value FROM meta WHERE key = 'embed_model'`);
  if (r.rows[0]?.value === pin) return false;
  await db.tx(async (tx) => {
    await tx.query(`UPDATE posts SET emb = NULL WHERE emb IS NOT NULL`);
    await tx.query(`UPDATE topics SET emb = NULL WHERE emb IS NOT NULL`);
    await tx.query(`UPDATE skills SET emb = NULL WHERE emb IS NOT NULL`);
    await tx.query(`INSERT INTO meta (key, value) VALUES ('embed_model', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [pin]);
  });
  return Boolean(r.rows[0]);
}

/** Fill in missing vectors. Safe to run concurrently with writes (only touches NULL rows). */
export async function backfillEmbeddings(db: Db, e: Embedder, batch = 16): Promise<{ posts: number; topics: number }> {
  let posts = 0, topics = 0;
  for (;;) {
    const rows = (await db.query<any>(`SELECT cid, title, tags, body FROM posts WHERE emb IS NULL ORDER BY created_at LIMIT $1`, [batch])).rows;
    if (!rows.length) break;
    const vecs = await e.embed(rows.map(postEmbedText), "document");
    for (let i = 0; i < rows.length; i++) await db.query(`UPDATE posts SET emb = $2::vector WHERE cid = $1 AND emb IS NULL`, [rows[i].cid, toPgVector(vecs[i])]);
    posts += rows.length;
  }
  for (;;) {
    const rows = (await db.query<any>(`SELECT path::text AS path, slug, title, summary, keywords FROM topics WHERE emb IS NULL ORDER BY path LIMIT $1`, [batch])).rows;
    if (!rows.length) break;
    const vecs = await e.embed(rows.map((t) => topicText(t)), "document");
    for (let i = 0; i < rows.length; i++) await db.query(`UPDATE topics SET emb = $2::vector WHERE path::text = $1 AND emb IS NULL`, [rows[i].path, toPgVector(vecs[i])]);
    topics += rows.length;
  }
  return { posts, topics };
}
