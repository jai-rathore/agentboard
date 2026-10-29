/**
 * Deterministic replay. A verified run leaves a concrete action trace: for each executed action, the page URL, a
 * robust locator for the element (ARIA role + accessible name, visible text, CSS path), the action and its value,
 * with the run's parameter values written back as {{param}} placeholders, plus whether the action changed the URL.
 * The run's final state is summarized as cheap checks (which parameter values were visible on screen, in the page
 * or in the title). A later replay executes the trace directly in Playwright with zero model calls; when a step's
 * locator or post-condition fails, the executor falls back to the model loop from that step (the self-heal).
 */
import { fill, approvalFor, nameOf } from "./policy.mjs";

export const TRACE_VERSION = 1;
export const MAX_TRACE_STEPS = 60;
const STR = 200;

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Write parameter values back as {{name}} (longest values first, case-insensitive). Values shorter than 2 chars are left alone. */
export function templ(str, params = {}) {
  let s = String(str ?? "");
  const entries = Object.entries(params).filter(([, v]) => String(v ?? "").trim().length >= 2).sort((a, b) => String(b[1]).length - String(a[1]).length);
  for (const [k, v] of entries) s = s.replace(new RegExp(esc(String(v)), "gi"), `{{${k}}}`);
  // URL-encoded forms of the values too (e.g. Reykjav%C3%ADk in a URL)
  for (const [k, v] of entries) { const e = encodeURIComponent(String(v)); if (e !== String(v)) s = s.replace(new RegExp(esc(e), "gi"), `{{${k}}}`); }
  return s.slice(0, 500);
}
/** Fill {{name}} placeholders; in URLs, values are URL-encoded. */
export const fillUrl = (tpl, params) => String(tpl ?? "").replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (m, k) => (k in params ? encodeURIComponent(params[k]) : m));
export const fillText = (tpl, params) => fill(String(tpl ?? ""), params);

/** Runs in the page: a locator for the element at (x, y) (its interactive ancestor), or the focused element. */
export function describeInPage({ x, y, focused, sel }) {
  let el = focused ? document.activeElement : document.elementFromPoint(x, y);
  if (!el || el === document.body || el === document.documentElement) return null;
  el = el.closest(sel) ?? el;
  const tag = el.tagName.toLowerCase(), type = (el.getAttribute("type") ?? "").toLowerCase();
  const implicit = tag === "a" && el.hasAttribute("href") ? "link" : tag === "button" ? "button" : tag === "select" ? "combobox" : tag === "textarea" ? "textbox"
    : tag === "input" ? (type === "search" ? "searchbox" : ["checkbox", "radio"].includes(type) ? type : ["submit", "button", "reset", "image"].includes(type) ? "button" : "textbox") : tag === "summary" ? "button" : "";
  const role = el.getAttribute("role") || implicit;
  const lbl = el.labels?.[0]?.innerText ?? "";
  const name = (el.getAttribute("aria-label") || (["input", "textarea", "select"].includes(tag) ? lbl || el.getAttribute("placeholder") || el.getAttribute("title") || "" : (el.innerText || el.getAttribute("title") || el.getAttribute("alt") || "")) || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const text = (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const path = [];
  for (let n = el; n && n.nodeType === 1 && path.length < 5; n = n.parentElement) {
    if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) { path.unshift(`#${n.id}`); break; }
    const t = n.tagName.toLowerCase(), sibs = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
    path.unshift(sibs.length > 1 ? `${t}:nth-of-type(${sibs.indexOf(n) + 1})` : t);
  }
  const attrs = {};
  for (const a of ["name", "id", "data-testid"]) { const v = el.getAttribute(a); if (v) attrs[a] = v.slice(0, 120); }
  return { tag, role, name, text, css: path.join(" > "), attrs };
}

/** Runs in the page: text visible in the viewport, the page text and the title (for final checks). */
export function pageTextInPage() {
  const vw = innerWidth, vh = innerHeight, parts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && parts.length < 4000; n = walker.nextNode()) {
    const t = n.nodeValue?.trim(); if (!t || !n.parentElement) continue;
    const r = n.parentElement.getBoundingClientRect();
    if (r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && r.width > 0 && r.height > 0) parts.push(t);
  }
  return { viewport: parts.join(" ").slice(0, 40000), page: (document.body.innerText || "").slice(0, 200000), title: document.title };
}

const norm = (s) => String(s ?? "").normalize("NFC").toLowerCase().replace(/[\s_]+/g, " ").trim();
const has = (hay, needle) => norm(hay).includes(norm(needle));

/** Which parameter values the verified run's final page showed (on screen / in the page / in the title). */
export function finalChecks(texts, params, url) {
  const where = { viewport: [], page: [], title: [] };
  for (const [k, v] of Object.entries(params)) {
    if (String(v ?? "").trim().length < 2) continue;
    if (has(texts.viewport, v)) where.viewport.push(k);
    else if (has(texts.page, v)) where.page.push(k);
    if (has(texts.title, v)) where.title.push(k);
  }
  return { url: templ(url, params), ...where };
}

/** Deterministic verification of a replay's final page against the trace's final checks. */
export function checkFinal(final, texts, params, url) {
  if (!final) return { ok: false, checks: [], reason: "no final checks in the trace" };
  const checks = [], fails = [];
  // the final page is the same page (origin + path, with this run's parameter values) as in the verified run
  if (final.url && url) {
    const path = (u) => { try { const x = new URL(u); return norm(decodeURIComponent(x.origin + x.pathname)); } catch { return norm(u); } };
    const want = fillUrl(final.url, params);
    (path(want) === path(url) ? checks : fails).push(`final page ${want.slice(0, 160)}`);
  }
  const one = (list, hay, label) => { for (const k of list ?? []) { if (!(k in params)) continue; const v = params[k]; (has(hay, v) ? checks : fails).push(`"${v}" ${label}`); } };
  one(final.viewport, texts.viewport, "visible on screen");
  one(final.page, texts.page, "in the page");
  one(final.title, texts.title, "in the page title");
  if (checks.length + fails.length <= 1) return { ok: false, checks, reason: "the trace's final page showed none of the parameter values" };
  if (!checks.length && !fails.length) return { ok: false, checks, reason: "the trace's final page showed none of the parameter values" };
  return fails.length ? { ok: false, checks, reason: `missing: ${fails.join("; ")}` } : { ok: true, checks };
}

/** Build one trace step (before the action runs). */
export function traceStep(a, { url, loc, params, option }) {
  const base = { url: templ(url, params) };
  switch (a.type) {
    case "click": case "double_click": return loc ? { ...base, action: a.type, locator: tplLoc(loc, params) } : null;
    case "type": return { ...base, action: "type", text: templ(a.text, params), ...(loc ? { locator: tplLoc(loc, params) } : {}) };
    case "keypress": return { ...base, action: "keypress", keys: (a.keys ?? []).map(String).slice(0, 6) };
    case "scroll": return { ...base, action: "scroll", scroll_x: Math.round(Number(a.scroll_x) || 0), scroll_y: Math.round(Number(a.scroll_y) || 0) };
    case "scroll_to_text": return { ...base, action: "scroll_to_text", text: templ(a.text, params) };
    case "select_option": return { ...base, action: "select_option", option: templ(option ?? a.option, params), ...(loc ? { locator: tplLoc(loc, params) } : {}) };
    case "navigate": return { ...base, action: "navigate", to: templ(a.url, params) };
    default: return null;
  }
}
const tplLoc = (l, p) => ({ tag: l.tag, role: l.role, name: templ(l.name, p).slice(0, STR), text: templ(l.text, p).slice(0, STR), css: String(l.css ?? "").slice(0, 300), attrs: l.attrs ?? {} });

/** Locate a trace step's element: role + name, then visible text, then attributes, then the CSS path. */
export async function locate(page, loc, params, timeout = 6000) {
  const name = fillText(loc.name, params), text = fillText(loc.text, params);
  const tries = [];
  if (loc.role && name) tries.push(["role+name", () => page.getByRole(loc.role, { name, exact: true })]);
  if (loc.role && name) tries.push(["role+name~", () => page.getByRole(loc.role, { name })]);
  if (text && text.length <= 120) tries.push(["text", () => page.getByText(text, { exact: true })]);
  if (loc.attrs?.id) tries.push(["id", () => page.locator(`[id="${CSS_escape(loc.attrs.id)}"]`)]);
  if (loc.attrs?.name) tries.push(["name", () => page.locator(`${loc.tag}[name="${CSS_escape(loc.attrs.name)}"]`)]);
  if (loc.css) tries.push(["css", () => page.locator(loc.css)]);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const [how, mk] of tries) {
      try {
        const all = mk();
        const n = await all.count();
        for (let i = 0; i < Math.min(n, 5); i++) { const l = all.nth(i); if (await l.isVisible()) return { locator: l, how }; }
      } catch {}
    }
    await page.waitForTimeout(400);
  }
  return null;
}
const CSS_escape = (s) => String(s).replace(/["\\]/g, "\\$&");

/** Summary of a trace for logs and records. */
export const describeTraceStep = (s) => `${s.action}${s.locator ? ` ${s.locator.role || s.locator.tag} "${(s.locator.name || s.locator.text || s.locator.css || "").slice(0, 60)}"` : ""}${s.text ? ` "${s.text.slice(0, 60)}"` : ""}${s.keys ? ` ${s.keys.join("+")}` : ""}${s.to ? ` ${s.to.slice(0, 80)}` : ""}`;

/** A trace is usable when it is the current version and has at least one step. */
export const usableTrace = (t) => Boolean(t && t.v === TRACE_VERSION && Array.isArray(t.steps) && t.steps.length > 0 && t.steps.length <= MAX_TRACE_STEPS);

/**
 * One deterministic trace step: locate the element (role+name, text, attributes, CSS), apply the same approval policy
 * as the model path (c.inspect / c.execute are the executor's own), act, then check the post-condition (the URL changes when it changed in the recorded run).
 */
export async function runTraceStep(page, s, params, c) {
  const before = page.url();
  const fail = (reason) => ({ ok: false, reason, before });
  const act = async (a, label) => {
    const el = await c.inspect(page, a);
    const p = approvalFor(a, el, c.skill, []);
    const detail = `trace step ${c.index + 1}: ${label}`.slice(0, 300);
    if (p.approval === "human") {
      c.send({ type: "status", message: `Waiting for approval: ${p.reason}` });
      const asked = Date.now();
      const ok = await c.ask({ turn: 0, action: a, element: el, reason: p.reason, flags: p.flags, screenshot: (await page.screenshot({ type: "jpeg", quality: 70 })).toString("base64") });
      c.onHuman(Math.min(Date.now() - asked, 30_000));
      c.actions.push({ turn: 0, type: a.type, detail, approval: ok ? "human" : "none", checks: [], target: nameOf(el) || undefined, flags: p.flags });
      if (!ok) throw Object.assign(new Error(`Declined by a human: ${p.reason}`), { code: "declined" });
    } else c.actions.push({ turn: 0, type: a.type, detail, approval: "auto", checks: [], target: nameOf(el) || undefined });
    c.history.push(detail);
    await c.execute(page, a);
  };
  try {
    switch (s.action) {
      case "click": case "double_click": {
        const f = await locate(page, s.locator, params);
        if (!f) return fail(`element not found: ${describeTraceStep(s)}`);
        await f.locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        const box = await f.locator.boundingBox();
        if (!box) return fail(`element has no box: ${describeTraceStep(s)}`);
        await act({ type: s.action, x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), button: "left" }, `${s.action} ${s.locator.role || s.locator.tag} "${fillText(s.locator.name || s.locator.text, params).slice(0, 60)}" (by ${f.how})`);
        break;
      }
      case "type": {
        if (s.locator) {
          const f = await locate(page, s.locator, params, 3000);
          if (f) { await f.locator.focus().catch(() => {}); if (["input", "textarea"].includes(s.locator.tag)) await f.locator.fill("").catch(() => {}); }
        }
        const text = fillText(s.text, params);
        await act({ type: "type", text }, `type "${text.slice(0, 60)}"`);
        break;
      }
      case "keypress": await act({ type: "keypress", keys: s.keys }, `keypress ${(s.keys ?? []).join("+")}`); break;
      case "scroll": await act({ type: "scroll", x: Math.round(c.W / 2), y: Math.round(c.H / 2), scroll_x: s.scroll_x, scroll_y: s.scroll_y }, `scroll (${s.scroll_x},${s.scroll_y})`); break;
      case "scroll_to_text": {
        const text = fillText(s.text, params);
        const r = await page.evaluate(scrollToTextInPage, { text });
        if (!r.found) return fail(`text not on the page: "${text.slice(0, 80)}"`);
        c.actions.push({ turn: 0, type: "scroll_to_text", detail: `trace step ${c.index + 1}: scroll_to_text "${text.slice(0, 60)}"`, approval: "auto", checks: [] });
        break;
      }
      case "select_option": {
        const opt = fillText(s.option, params);
        const done = await c.selectOption(opt);
        if (!done) return fail(`no option "${opt.slice(0, 60)}"`);
        c.actions.push({ turn: 0, type: "select_option", detail: `trace step ${c.index + 1}: selected "${done}"`, approval: "auto", checks: [] });
        break;
      }
      case "navigate": {
        const url = fillUrl(s.to, params);
        if (!/^https?:/.test(url) || new URL(url).origin !== c.origin) return fail(`navigation off the skill's site: ${url.slice(0, 120)}`);
        c.actions.push({ turn: 0, type: "navigate", detail: `trace step ${c.index + 1}: ${url.slice(0, 280)}`, approval: "auto", checks: [] });
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        break;
      }
      default: return fail(`unknown trace action ${s.action}`);
    }
  } catch (e) {
    if (e.code === "declined") throw e;
    return fail(String(e.message ?? e).slice(0, 200));
  }
  // post-condition: the URL changes exactly when it changed in the recorded run
  if (s.changes_url) {
    const ok = await page.waitForURL((u) => u.toString() !== before, { timeout: 15_000 }).then(() => true, () => false);
    if (!ok) return fail(`expected the page to change after ${describeTraceStep(s)}`);
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  } else await page.waitForTimeout(300);
  return { ok: true, before, changed: page.url() !== before };
}

