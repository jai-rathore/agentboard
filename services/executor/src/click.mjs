/**
 * Click targeting. The model aims at what it sees, and is often a few pixels off a link: on Wikipedia's search
 * results it clicked the heading's padding just above "Reykjavík" 11 times, which never navigated. Before a click,
 * the executor asks the page what is under the point; if that is not an interactive element, the click snaps to
 * the center of the nearest visible interactive element within SNAP_RADIUS px. A direct hit is never moved.
 */
export const SNAP_RADIUS = 24;
export const INTERACTIVE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, label, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], [onclick], [contenteditable=""], [contenteditable=true]';

/** Runs in the page: is the point on an interactive element, and if not, the visible interactive boxes nearby. */
export function probeInPage({ x, y, r, sel }) {
  const hit = document.elementFromPoint(x, y);
  if (hit && hit.closest(sel)) return { hit: true, boxes: [] };
  const boxes = [];
  for (const el of document.querySelectorAll(sel)) {
    for (const b of el.getClientRects()) {
      if (b.width < 2 || b.height < 2 || b.right < x - r || b.left > x + r || b.bottom < y - r || b.top > y + r) continue;
      const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
      const top = document.elementFromPoint(cx, cy);
      if (!top || !(top === el || el.contains(top) || top.closest(sel) === el)) continue; // covered by something else
      boxes.push({ left: b.left, top: b.top, right: b.right, bottom: b.bottom, tag: el.tagName.toLowerCase() });
    }
  }
  return { hit: false, boxes };
}

/** Distance from a point to a box (0 inside). */
export const distance = (x, y, b) => Math.hypot(Math.max(b.left - x, 0, x - b.right), Math.max(b.top - y, 0, y - b.bottom));

/** The point to click: unchanged on a direct hit or when nothing is near, else the nearest box's center. */
export function snapPoint(x, y, probe, r = SNAP_RADIUS) {
  if (!probe || probe.hit || !probe.boxes?.length) return null;
  let best = null, bd = Infinity;
  for (const b of probe.boxes) { const d = distance(x, y, b); if (d <= r && d < bd) { bd = d; best = b; } }
  return best ? { x: Math.round((best.left + best.right) / 2), y: Math.round((best.top + best.bottom) / 2), from: { x, y }, tag: best.tag, px: Math.round(bd) } : null;
}

/** Address bar: after Ctrl/Cmd+L, typed text that is a URL becomes a navigation (headless Chromium has no address bar). */
export function addressBarUrl(text, origin) {
  const t = String(text ?? "").trim();
  if (!t || /\s/.test(t)) return null;
  let u;
  try { u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  return u.origin === origin ? u.toString() : null;
}
export const isAddressBarKey = (keys) => { const k = (keys ?? []).map((x) => String(x).toLowerCase()); return k.length === 2 && k.includes("l") && (k.includes("ctrl") || k.includes("control") || k.includes("cmd") || k.includes("meta")); };

/** Runs in the page: scroll the first visible element whose own text contains `text` (label cells first) to the center. */
export function scrollToTextInPage({ text }) {
  const want = String(text ?? "").trim().toLowerCase();
  if (!want || want.length > 200) return { found: false };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const hits = [];
  for (let n = walker.nextNode(); n && hits.length < 200; n = walker.nextNode()) {
    if (!n.nodeValue || !n.nodeValue.toLowerCase().includes(want)) continue;
    const el = n.parentElement;
    if (!el) continue;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || cs.visibility === "hidden" || cs.display === "none") continue;
    hits.push(el);
  }
  if (!hits.length) return { found: false };
  // Prefer a label that IS the text (a heading or row label), then one that starts with it, then label cells, then the first.
  const own = (el) => (el.innerText || el.textContent || "").trim().toLowerCase();
  const labelish = (el) => Boolean(el.closest("th, dt, label, h1, h2, h3, h4, h5, h6, .infobox-label"));
  const score = (el) => (own(el) === want ? 4 : 0) + (own(el).startsWith(want) ? 2 : 0) + (labelish(el) ? 1 : 0);
  const label = hits.reduce((best, el) => (score(el) > score(best) ? el : best), hits[0]);
  label.scrollIntoView({ block: "center", inline: "nearest" });
  return { found: true, tag: label.tagName.toLowerCase(), text: (label.innerText || "").trim().slice(0, 80) };
}
