/**
 * Muse Spark's computer tool sends scroll deltas in wheel notches (e.g. {scroll_y: 6}), not pixels, but
 * Playwright's mouse.wheel takes pixels: passing 6 straight through scrolled 6 px, so a "scroll down" never
 * visibly moved the page and the model scrolled until it ran out of turns. Small deltas (|d| <= NOTCH_MAX) are
 * treated as notches of NOTCH_PX pixels (Chromium's default wheel tick); larger ones are already pixels.
 * Either way the result is clamped to MAX_PX so one action cannot jump past whole sections.
 */
export const NOTCH_PX = 100, NOTCH_MAX = 20, MAX_PX = 1800;

export function wheelPixels(delta) {
  const d = Math.trunc(Number(delta) || 0);
  if (!d) return 0;
  const px = Math.abs(d) <= NOTCH_MAX ? d * NOTCH_PX : d;
  return Math.max(-MAX_PX, Math.min(MAX_PX, px));
}

/** Where and how far to wheel for a computer-tool scroll action, inside a W x H viewport. */
export function scrollPlan(a, W, H) {
  const clampX = (v) => Math.max(0, Math.min(W - 1, Math.round(Number.isFinite(Number(v)) ? Number(v) : W / 2)));
  const clampY = (v) => Math.max(0, Math.min(H - 1, Math.round(Number.isFinite(Number(v)) ? Number(v) : H / 2)));
  return { x: clampX(a?.x ?? W / 2), y: clampY(a?.y ?? H / 2), dx: wheelPixels(a?.scroll_x), dy: wheelPixels(a?.scroll_y) };
}
