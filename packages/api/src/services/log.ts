/**
 * Append a verified record to the hash-chained log inside the caller's transaction, and emit a
 * signed checkpoint every `checkpointEvery` entries.
 */
import { entryHash, GENESIS_HASH, signCheckpoint, type SignedRecord } from "@agentboard/core";
import type { Db } from "../db/index.js";
import type { AppContext } from "../context.js";

export interface Appended { seq: number; entry_hash: string; received_at: Date }

export async function appendToLog(tx: Db, ctx: AppContext, rec: SignedRecord): Promise<Appended> {
  // serialize appenders (no-op cost on PGlite, real lock on Postgres)
  await tx.query(`SELECT pg_advisory_xact_lock(7243)`);
  const head = (await tx.query<{ seq: number; entry_hash: string }>(`SELECT seq::int AS seq, entry_hash FROM log ORDER BY seq DESC LIMIT 1`)).rows[0];
  const seq = (head?.seq ?? 0) + 1;
  const prev = head?.entry_hash ?? GENESIS_HASH;
  const h = entryHash(prev, seq, rec.cid);
  const receivedAt = new Date(ctx.now());
  await tx.query(
    `INSERT INTO records (cid, type, author, created_at, body, body_text, sig, received_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [rec.cid, rec.type, rec.author, rec.created_at, JSON.stringify(rec.body), JSON.stringify(rec.body), rec.sig, receivedAt],
  );
  await tx.query(`INSERT INTO log (seq, cid, prev_hash, entry_hash, received_at) VALUES ($1,$2,$3,$4,$5)`, [seq, rec.cid, prev, h, receivedAt]);
  if (seq % ctx.cfg.checkpointEvery === 0) {
    const cp = signCheckpoint(ctx.node, seq, h, receivedAt);
    await tx.query(`INSERT INTO checkpoints (seq, head, checkpoint) VALUES ($1,$2,$3)`, [seq, h, JSON.stringify(cp)]);
  }
  return { seq, entry_hash: h, received_at: receivedAt };
}

export function recordFromRow(r: { cid: string; type: string; author: string; created_at: string; body_text: string; sig: string }): SignedRecord {
  return { v: 1, type: r.type as SignedRecord["type"], author: r.author, created_at: r.created_at, body: JSON.parse(r.body_text) as Record<string, unknown>, cid: r.cid, sig: r.sig };
}
