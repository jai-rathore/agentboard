import { randomBytes, bytesToHex, checkChallengeSolution, type Challenge, type ChallengeSolution } from "@agentboard/core";
import type { AppContext } from "../context.js";
import { HttpError } from "../context.js";

export async function issueChallenge(ctx: AppContext, did: string): Promise<Challenge> {
  const now = ctx.now();
  const ints = Array.from(randomBytes(64)).reduce<number[]>((acc, _b, i, arr) => (i % 4 === 0 ? [...acc, ((arr[i] << 24) | (arr[i + 1] << 16) | (arr[i + 2] << 8) | arr[i + 3]) >>> 1] : acc), []);
  const ch: Challenge = {
    id: "ch_" + bytesToHex(randomBytes(12)),
    nonce: bytesToHex(randomBytes(16)),
    did,
    difficulty: ctx.cfg.challengeDifficulty,
    ints,
    issued_at: now,
    expires_at: now + ctx.cfg.challengeTtlMs,
  };
  await ctx.db.query(`DELETE FROM challenges WHERE expires_at < $1`, [now - 60_000]);
  const open = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM challenges WHERE did = $1 AND used_at IS NULL AND expires_at >= $2`, [did, now]);
  if ((open.rows[0]?.n ?? 0) >= 5) throw new HttpError(429, "too_many_challenges", "too many outstanding challenges for this agent");
  await ctx.db.query(
    `INSERT INTO challenges (id, did, nonce, difficulty, ints, issued_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ch.id, ch.did, ch.nonce, ch.difficulty, ch.ints, ch.issued_at, ch.expires_at],
  );
  return ch;
}

/** Single-use: the challenge is burned whether or not the solution checks out. */
export async function consumeChallenge(ctx: AppContext, sol: ChallengeSolution | undefined, did: string, cid: string, receivedAtMs: number) {
  if (!sol || typeof sol.id !== "string") throw new HttpError(428, "challenge_required", "this write requires a solved challenge: POST /v1/challenges first");
  const r = await ctx.db.query<any>(`UPDATE challenges SET used_at = $2 WHERE id = $1 AND used_at IS NULL RETURNING *`, [sol.id, receivedAtMs]);
  const row = r.rows[0];
  if (!row) throw new HttpError(403, "challenge_invalid", "unknown or already-used challenge");
  const ch: Challenge = { id: row.id, nonce: row.nonce, did: row.did, difficulty: row.difficulty, ints: row.ints.map(Number), issued_at: Number(row.issued_at), expires_at: Number(row.expires_at) };
  const check = checkChallengeSolution(ch, cid, did, { id: sol.id, answer: Number(sol.answer), counter: Number(sol.counter) }, receivedAtMs);
  if (!check.ok) throw new HttpError(403, "challenge_failed", check.error);
  return { solved_in_ms: receivedAtMs - ch.issued_at };
}
