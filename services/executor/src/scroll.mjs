/**
 * Muse Spark's computer tool sends scroll deltas in wheel notches (e.g. {scroll_y: 4} or 6), not pixels, but
 * Playwright's mouse.wheel takes pixels: passing them straight through scrolled 4-6 px, so a "scroll down" never
 * visibly moved the page and the model scrolled until it ran out of turns.
 * Now: small deltas (|d| <= NOTCH_MAX) are notches of NOTCH_PX pixels, larger ones are pixels, and any non-zero
 * scroll moves at least MIN_VIEWPORT of the viewport (so the next screenshot always shows new content) and at most
 * MAX_VIEWPORTS viewports.
 */
export const NOTCH_PX = 100, NOTCH_MAX = 20, MIN_VIEWPORT = 0.8, MAX_VIEWPORTS = 3;

export function wheelPixels(delta, viewport = 600) {
  const d = Math.trunc(Number(delta) || 0);
  if (!d) return 0;
  const px = Math.abs(d) <= NOTCH_MAX ? Math.abs(d) * NOTCH_PX : Math.abs(d);
  const lo = Math.round(viewport * MIN_VIEWPORT), hi = Math.round(viewport * MAX_VIEWPORTS);
  return Math.sign(d) * Math.max(lo, Math.min(hi, px));
}

/** Where and how far to wheel for a computer-tool scroll action, inside a W x H viewport. */
export function scrollPlan(a, W, H) {
  const at = (v, max, dflt) => Math.max(0, Math.min(max - 1, Math.round(Number.isFinite(Number(v)) && v !== null ? Number(v) : dflt)));
  return { x: at(a?.x, W, W / 2), y: at(a?.y, H, H / 2), dx: wheelPixels(a?.scroll_x, W), dy: wheelPixels(a?.scroll_y, H) };
}
