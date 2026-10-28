import { describe, it, expect } from "vitest";
import { solveChallenge, checkChallengeSolution, puzzleAnswer, Challenge, registrationPowValid, solveRegistrationPow, generateKeyPair, cidForJson } from "../src/index.js";

function makeChallenge(did: string, over: Partial<Challenge> = {}): Challenge {
  const now = Date.now();
  return { id: "ch_1", nonce: "a1b2c3d4e5f60718", did, difficulty: 12, ints: [5, 3, 999999, 42, 7, 1_000_010], issued_at: now, expires_at: now + 1000, ...over };
}

describe("reverse captcha (machine challenge)", () => {
  const kp = generateKeyPair();
  const cid = cidForJson({ some: "record" });

  it("computes the puzzle answer deterministically", () => {
    // sorted: 3,5,7,42,999999,1000010 ; weights 1..6 ; mod 1_000_003
    const expected = (3 * 1 + 5 * 2 + 7 * 3 + 42 * 4 + 999999 * 5 + (1000010 % 1000003) * 6) % 1000003;
    expect(puzzleAnswer([5, 3, 999999, 42, 7, 1_000_010])).toBe(expected);
  });
  it("is solvable well inside the sub-second deadline", () => {
    const ch = makeChallenge(kp.did);
    const t0 = performance.now();
    const sol = solveChallenge(ch, cid);
    const ms = performance.now() - t0;
    expect(checkChallengeSolution(ch, cid, kp.did, sol, Date.now())).toEqual({ ok: true });
    expect(ms).toBeLessThan(500);
  });
  it("rejects solutions after the deadline", () => {
    const ch = makeChallenge(kp.did);
    const sol = solveChallenge(ch, cid);
    const r = checkChallengeSolution(ch, cid, kp.did, sol, ch.expires_at + 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/expired/);
  });
  it("binds the solution to the record CID", () => {
    const ch = makeChallenge(kp.did, { difficulty: 16 });
    const sol = solveChallenge(ch, cid);
    const otherCid = cidForJson({ some: "other record" });
    expect(checkChallengeSolution(ch, otherCid, kp.did, sol, Date.now()).ok).toBe(false);
  });
  it("binds the challenge to the agent", () => {
    const ch = makeChallenge(kp.did);
    const sol = solveChallenge(ch, cid);
    expect(checkChallengeSolution(ch, cid, generateKeyPair().did, sol, Date.now())).toEqual({ ok: false, error: "challenge was issued to a different agent" });
  });
  it("rejects a wrong puzzle answer even with valid-looking work", () => {
    const ch = makeChallenge(kp.did, { difficulty: 0 });
    expect(checkChallengeSolution(ch, cid, kp.did, { id: ch.id, answer: 1, counter: 0 }, Date.now())).toEqual({ ok: false, error: "wrong puzzle answer" });
  });
  it("rejects insufficient work", () => {
    const ch = makeChallenge(kp.did, { difficulty: 30 });
    expect(checkChallengeSolution(ch, cid, kp.did, { id: ch.id, answer: puzzleAnswer(ch.ints), counter: 0 }, Date.now()).ok).toBe(false);
  });
});

describe("registration proof of work", () => {
  it("solves and verifies", () => {
    const { did } = generateKeyPair();
    const n = solveRegistrationPow(did, 10);
    expect(registrationPowValid(did, n, 10)).toBe(true);
    expect(registrationPowValid(generateKeyPair().did, n, 24)).toBe(false);
  });
});
