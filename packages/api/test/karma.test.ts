import { describe, it, expect } from "vitest";
import { computeKarma, voteWeight, type KarmaAgent, type Endorsement } from "../src/services/karma.js";

const NOW = Date.parse("2026-11-01T00:00:00Z");
const e = (from: string, to: string, weight = 1, daysAgo = 0): Endorsement => ({ from, to, weight, at: NOW - daysAgo * 86_400_000 });

describe("EigenTrust karma", () => {
  it("sums to the network and converges", () => {
    const agents: KarmaAgent[] = ["a", "b", "c"].map((did) => ({ did }));
    const r = computeKarma(agents, [e("a", "b"), e("b", "c"), e("c", "a")], { now: NOW });
    const total = [...r.trust.values()].reduce((s, x) => s + x, 0);
    expect(total).toBeCloseTo(1, 9);
    expect(r.iterations).toBeLessThan(100);
  });
  it("ranks the agent endorsed by many above the one endorsed by few", () => {
    const agents: KarmaAgent[] = ["h", "a", "b", "c", "d", "star", "meh"].map((did) => ({ did, preTrusted: did === "h" }));
    const edges = [e("h", "a"), e("h", "b"), e("h", "c"), e("h", "d"), e("a", "star"), e("b", "star"), e("c", "star"), e("d", "meh")];
    const r = computeKarma(agents, edges, { now: NOW });
    expect(r.karma.get("star")!).toBeGreaterThan(r.karma.get("meh")!);
  });
  it("is Sybil-resistant: a ring of fresh accounts endorsing each other earns ~nothing", () => {
    const honest = ["h", "a", "b", "c"];
    const sybils = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const agents: KarmaAgent[] = [...honest, ...sybils].map((did) => ({ did, preTrusted: did === "h" }));
    const edges = [e("h", "a"), e("a", "b"), e("b", "c"), e("c", "a")];
    for (const s of sybils) for (const t of sybils) if (s !== t) edges.push(e(s, t, 1));
    const r = computeKarma(agents, edges, { now: NOW });
    const sybilTotal = sybils.reduce((s, d) => s + r.trust.get(d)!, 0);
    expect(sybilTotal).toBeLessThan(1e-9);
    expect(r.trust.get("a")!).toBeGreaterThan(0.1);
  });
  it("drops self-endorsement and same-operator endorsement", () => {
    const agents: KarmaAgent[] = [{ did: "h", preTrusted: true }, { did: "x", operator: "op1" }, { did: "y", operator: "op1" }, { did: "z" }];
    const r1 = computeKarma(agents, [e("h", "x"), e("x", "x", 5), e("x", "y", 5)], { now: NOW });
    expect(r1.trust.get("y")!).toBeLessThan(1e-9);
  });
  it("collapses agents sharing an operator: 5 farm accounts mint no more base trust than 1", () => {
    const agents: KarmaAgent[] = [...Array.from({ length: 5 }, (_, i) => ({ did: `farm${i}`, operator: "farm" })), { did: "solo" }, { did: "t1" }, { did: "t2" }];
    const edges = [...Array.from({ length: 5 }, (_, i) => e(`farm${i}`, "t1")), e("solo", "t2")];
    const r = computeKarma(agents, edges, { now: NOW });
    expect(r.trust.get("t1")!).toBeCloseTo(r.trust.get("t2")!, 9);
    // without operator attribution the same farm would dominate
    const naive = computeKarma(agents.map((a) => ({ did: a.did })), edges, { now: NOW });
    expect(naive.trust.get("t1")!).toBeGreaterThan(naive.trust.get("t2")! * 2);
  });
  it("decays old endorsements", () => {
    const agents: KarmaAgent[] = ["h", "new", "old"].map((did) => ({ did, preTrusted: did === "h" }));
    const r = computeKarma(agents, [e("h", "new", 1, 0), e("h", "old", 1, 120)], { now: NOW, halfLifeDays: 60 });
    expect(r.trust.get("new")!).toBeGreaterThan(r.trust.get("old")!);
  });
  it("clips net-negative local trust to zero", () => {
    const agents: KarmaAgent[] = ["h", "good", "bad"].map((did) => ({ did, preTrusted: did === "h" }));
    const r = computeKarma(agents, [e("h", "good", 1), e("h", "bad", -3)], { now: NOW });
    expect(r.trust.get("bad")!).toBeLessThan(r.trust.get("good")!);
    expect(r.trust.get("bad")!).toBeGreaterThanOrEqual(0);
  });
  it("is deterministic", () => {
    const agents: KarmaAgent[] = ["h", "a", "b"].map((did) => ({ did, preTrusted: did === "h" }));
    const edges = [e("h", "a"), e("a", "b"), e("b", "a", -1)];
    expect([...computeKarma(agents, edges, { now: NOW }).karma]).toEqual([...computeKarma(agents, edges, { now: NOW }).karma]);
  });
  it("vote weight has a newcomer floor and a cap", () => {
    expect(voteWeight(0, 100)).toBeCloseTo(0.1);
    expect(voteWeight(1, 100)).toBe(1);
  });
});
