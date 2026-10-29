import { describe, it, expect } from "vitest";
import { wheelPixels, scrollPlan, NOTCH_PX } from "../src/scroll.mjs";
import { snapPoint, distance, addressBarUrl, isAddressBarKey } from "../src/click.mjs";
import { FIND_TOOL, LOOP_INSTRUCTIONS } from "../src/policy.mjs";

describe("executor scroll", () => {
  it("treats Muse's small deltas as wheel notches and always moves at least 0.8 viewport (scroll_y: 4 used to move 4 px)", () => {
    expect(wheelPixels(4, 600)).toBe(480);
    expect(wheelPixels(6, 600)).toBe(6 * NOTCH_PX);
    expect(wheelPixels(-1, 600)).toBe(-480);
    expect(wheelPixels(1, 960)).toBe(768);
  });
  it("passes larger pixel deltas through, within 0.8 to 3 viewports", () => {
    expect(wheelPixels(700, 600)).toBe(700);
    expect(wheelPixels(50, 600)).toBe(480);
    expect(wheelPixels(-100000, 600)).toBe(-1800);
  });
  it("ignores missing or junk deltas", () => {
    for (const d of [0, undefined, null, "x", NaN]) expect(wheelPixels(d, 600)).toBe(0);
  });
  it("plans the wheel at the action's point, inside the viewport, defaulting to the center", () => {
    expect(scrollPlan({ type: "scroll", x: 802, y: 300, scroll_x: 0, scroll_y: 6 }, 960, 600)).toEqual({ x: 802, y: 300, dx: 0, dy: 600 });
    expect(scrollPlan({ type: "scroll", scroll_y: -2 }, 960, 600)).toEqual({ x: 480, y: 300, dx: 0, dy: -480 });
    expect(scrollPlan({ type: "scroll", x: 5000, y: -4, scroll_x: 2 }, 960, 600)).toEqual({ x: 959, y: 0, dx: 768, dy: 0 });
  });
});

describe("executor click targeting", () => {
  // Wikipedia search results at 960x600: the "Reykjavík" link box; the model clicked (164, 406-415), just above it.
  const link = { left: 128, top: 417, right: 202, bottom: 434, tag: "a" };
  it("snaps a near-miss click onto the nearest link's center", () => {
    expect(snapPoint(164, 414, { hit: false, boxes: [link] })).toMatchObject({ x: 165, y: 426, tag: "a", px: 3 });
    expect(snapPoint(164, 406, { hit: false, boxes: [link, { left: 128, top: 553, right: 260, bottom: 570, tag: "a" }] })).toMatchObject({ x: 165, y: 426 });
  });
  it("never moves a direct hit, and leaves far clicks alone", () => {
    expect(snapPoint(150, 425, { hit: true, boxes: [] })).toBeNull();
    expect(snapPoint(164, 300, { hit: false, boxes: [link] })).toBeNull();
    expect(snapPoint(164, 300, null)).toBeNull();
  });
  it("distance is 0 inside a box", () => {
    expect(distance(150, 420, link)).toBe(0);
    expect(distance(164, 414, link)).toBe(3);
  });
  it("address bar: Ctrl/Cmd+L then a same-site URL navigates; other sites and non-URLs do not", () => {
    expect(isAddressBarKey(["Ctrl", "l"])).toBe(true);
    expect(isAddressBarKey(["META", "L"])).toBe(true);
    expect(isAddressBarKey(["Enter"])).toBe(false);
    expect(addressBarUrl("https://en.wikipedia.org/wiki/Reykjavik\n", "https://en.wikipedia.org")).toBe("https://en.wikipedia.org/wiki/Reykjavik");
    expect(addressBarUrl("en.wikipedia.org/wiki/Oslo", "https://en.wikipedia.org")).toBe("https://en.wikipedia.org/wiki/Oslo");
    expect(addressBarUrl("https://evil.example/x", "https://en.wikipedia.org")).toBeNull();
    expect(addressBarUrl("javascript:alert(1)", "https://en.wikipedia.org")).toBeNull();
    expect(addressBarUrl("two words", "https://en.wikipedia.org")).toBeNull();
  });
  it("offers scroll_to_text to the model", () => {
    expect(FIND_TOOL.name).toBe("scroll_to_text");
    expect(LOOP_INSTRUCTIONS).toMatch(/scroll_to_text/);
  });
});
