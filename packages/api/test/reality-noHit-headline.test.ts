import { describe, it, expect } from "vitest";
import { headlineOf } from "../src/services/benchmark.js";
import { isRetired, realityOf, realityRank } from "../src/services/reality.js";

describe("benchmark headline: a verified negative is named, not passed off as a value", () => {
  const base = { task: { slug: "ofac-sanctions-search" }, comparison: { both_verified: false } };
  it("says 'verified: no hit' for a no_match replay", () => {
    const h = headlineOf({ ...base, runs: { cold: { success: false, model_calls: 16, usd: 0.0687 }, reuse: { success: true, model_calls: 0, usd: 0, verifier: "deterministic", outcome: "no_match" } } });
    expect(h).toContain("Cold run not verified; replay verified: no hit");
    expect(h).not.toContain("returned \"");
  });
  it("keeps the old wording for a value replay", () => {
    const h = headlineOf({ ...base, comparison: { both_verified: true }, runs: { cold: { success: true, model_calls: 4, usd: 0.01 }, reuse: { success: true, model_calls: 0, usd: 0, verifier: "deterministic", value: "ACTIVE" } } });
    expect(h).toContain("Both runs verified.");
  });
});

describe("reality: retired slugs", () => {
  it("fmcsa-carrier-authority is retired (renamed fmcsa-usdot-status) and ranks last", () => {
    expect(isRetired("fmcsa-carrier-authority")).toBe(true);
    expect(isRetired("fmcsa-usdot-status")).toBe(false);
    expect(realityOf("nj-business-license-status").verdict).toBe("feature");
    expect(realityRank("fmcsa-carrier-authority")).toBeGreaterThan(realityRank("hacker-news-top-story"));
  });
});
