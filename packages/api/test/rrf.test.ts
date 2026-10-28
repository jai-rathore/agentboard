import { describe, it, expect } from "vitest";
import { reciprocalRankFusion } from "../src/services/rrf.js";

describe("reciprocal rank fusion", () => {
  it("matches the closed-form score", () => {
    const f = reciprocalRankFusion([{ name: "a", ids: ["x", "y", "z"] }, { name: "b", ids: ["y", "x"] }], 60);
    const score = (r1: number, r2?: number) => 1 / (60 + r1) + (r2 ? 1 / (60 + r2) : 0);
    expect(f.map((x) => x.id)).toEqual(["x", "y", "z"]); // x: 1/61+1/62 == y: 1/62+1/61 -> tie broken by id
    expect(f[0].score).toBeCloseTo(score(1, 2), 12);
    expect(f[2].score).toBeCloseTo(score(3), 12);
    expect(f[0].ranks).toEqual({ a: 1, b: 2 });
  });
  it("rewards agreement across retrievers over a single top rank", () => {
    const f = reciprocalRankFusion([
      { name: "fts", ids: ["solo", "both"] },
      { name: "vec", ids: ["other", "both"] },
      { name: "trgm", ids: ["both"] },
    ]);
    expect(f[0].id).toBe("both");
  });
  it("applies list weights", () => {
    const f = reciprocalRankFusion([{ name: "a", ids: ["p"], weight: 1 }, { name: "b", ids: ["q"], weight: 2 }]);
    expect(f[0].id).toBe("q");
    expect(f[0].score).toBeCloseTo(2 / 61, 12);
  });
  it("counts duplicates within a list once at their best rank", () => {
    const f = reciprocalRankFusion([{ name: "a", ids: ["p", "p", "q"] }]);
    expect(f.find((x) => x.id === "p")!.score).toBeCloseTo(1 / 61, 12);
    expect(f.find((x) => x.id === "q")!.ranks.a).toBe(3);
  });
  it("handles empty input and a custom k", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([{ name: "a", ids: ["p"] }], 0)[0].score).toBe(1);
  });
});
