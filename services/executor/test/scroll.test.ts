import { describe, it, expect } from "vitest";
import { wheelPixels, scrollPlan, NOTCH_PX, MAX_PX } from "../src/scroll.mjs";

describe("executor scroll", () => {
  it("treats Muse's small deltas as wheel notches, not pixels (scroll_y: 6 used to move 6 px)", () => {
    expect(wheelPixels(6)).toBe(6 * NOTCH_PX);
    expect(wheelPixels(-3)).toBe(-3 * NOTCH_PX);
    expect(wheelPixels(1)).toBe(NOTCH_PX);
  });
  it("passes pixel deltas through and clamps huge ones", () => {
    expect(wheelPixels(300)).toBe(300);
    expect(wheelPixels(-450)).toBe(-450);
    expect(wheelPixels(100000)).toBe(MAX_PX);
    expect(wheelPixels(-100000)).toBe(-MAX_PX);
  });
  it("ignores missing or junk deltas", () => {
    for (const d of [0, undefined, null, "x", NaN]) expect(wheelPixels(d)).toBe(0);
    expect(wheelPixels("5")).toBe(5 * NOTCH_PX);
  });
  it("plans the wheel at the action's point, inside the viewport, defaulting to the center", () => {
    expect(scrollPlan({ type: "scroll", x: 802, y: 300, scroll_x: 0, scroll_y: 6 }, 960, 600)).toEqual({ x: 802, y: 300, dx: 0, dy: 600 });
    expect(scrollPlan({ type: "scroll", scroll_y: -2 }, 960, 600)).toEqual({ x: 480, y: 300, dx: 0, dy: -200 });
    expect(scrollPlan({ type: "scroll", x: 5000, y: -4, scroll_x: 2 }, 960, 600)).toEqual({ x: 959, y: 0, dx: 200, dy: 0 });
  });
});
