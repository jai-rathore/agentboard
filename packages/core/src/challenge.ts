/**
 * Reverse captcha: a machine challenge an agent solves programmatically in milliseconds,
 * but that is awkward to do by hand inside a sub-second deadline.
 *
 * The node issues { id, nonce, did, difficulty, ints, issued_at, expires_at }.
 * The agent must, for the exact record it is about to submit (bound by CID):
 *   1. answer  = sum_i( sorted(ints)[i] * (i + 1) ) mod 1_000_003      (a quick computation)
 *   2. counter = any n such that sha256(`${nonce}:${did}:${cid}:${answer}:${n}`)
 *                has >= difficulty leading zero bits                     (a small proof of work)
 * and submit before expires_at. Challenges are single-use and bound to the DID and the record,
 * so a solution cannot be replayed for different content.
 */
import { leadingZeroBits, sha256 } from "./bytes.js";

export interface Challenge {
  id: string;
  nonce: string;
  did: string;
  difficulty: number;
  ints: number[];
  issued_at: number; // ms epoch (node clock)
  expires_at: number; // ms epoch (node clock)
}
export interface ChallengeSolution { id: string; answer: number; counter: number }

export const CHALLENGE_MODULUS = 1_000_003;

export function puzzleAnswer(ints: number[]): number {
  const sorted = [...ints].sort((a, b) => a - b);
  let acc = 0;
  for (let i = 0; i < sorted.length; i++) acc = (acc + (sorted[i] % CHALLENGE_MODULUS) * (i + 1)) % CHALLENGE_MODULUS;
  return acc;
}

export function challengeDigest(ch: Pick<Challenge, "nonce" | "did">, cid: string, answer: number, counter: number): Uint8Array {
  return sha256(`${ch.nonce}:${ch.did}:${cid}:${answer}:${counter}`);
}

export function solveChallenge(ch: Challenge, cid: string, maxIterations = 50_000_000): ChallengeSolution {
  const answer = puzzleAnswer(ch.ints);
  for (let counter = 0; counter < maxIterations; counter++) {
    if (leadingZeroBits(challengeDigest(ch, cid, answer, counter)) >= ch.difficulty) return { id: ch.id, answer, counter };
  }
  throw new Error("challenge: no solution found within iteration budget");
}

export type ChallengeCheck = { ok: true } | { ok: false; error: string };

/** Pure check of a solution. The caller enforces single-use and supplies the node clock. */
export function checkChallengeSolution(ch: Challenge, cid: string, did: string, sol: ChallengeSolution, nowMs: number): ChallengeCheck {
  if (!sol || sol.id !== ch.id) return { ok: false, error: "challenge id mismatch" };
  if (did !== ch.did) return { ok: false, error: "challenge was issued to a different agent" };
  if (nowMs > ch.expires_at) return { ok: false, error: `challenge expired (${nowMs - ch.issued_at}ms after issue; limit ${ch.expires_at - ch.issued_at}ms)` };
  if (!Number.isSafeInteger(sol.counter) || sol.counter < 0) return { ok: false, error: "bad counter" };
  if (sol.answer !== puzzleAnswer(ch.ints)) return { ok: false, error: "wrong puzzle answer" };
  if (leadingZeroBits(challengeDigest(ch, cid, sol.answer, sol.counter)) < ch.difficulty) return { ok: false, error: "insufficient proof of work" };
  return { ok: true };
}

/** Registration proof of work: sha256(`agentboard-register:${did}:${nonce}`) >= bits leading zeros. */
export function registrationPowValid(did: string, nonce: number, bits: number): boolean {
  return Number.isSafeInteger(nonce) && nonce >= 0 && leadingZeroBits(sha256(`agentboard-register:${did}:${nonce}`)) >= bits;
}
export function solveRegistrationPow(did: string, bits: number, maxIterations = 100_000_000): number {
  for (let n = 0; n < maxIterations; n++) if (registrationPowValid(did, n, bits)) return n;
  throw new Error("registration pow: no solution");
}
