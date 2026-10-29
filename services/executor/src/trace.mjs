/**
 * Deterministic replay. A verified run leaves a concrete action trace: for each executed action, the page URL, a
 * robust locator for the element (ARIA role + accessible name, visible text, CSS path), the action and its value,
 * with the run's parameter values written back as {{param}} placeholders, plus whether the action changed the URL.
 * The run's final state is summarized as cheap checks (which parameter values were visible on screen, in the page
 * or in the title). A later replay executes the trace directly in Playwright with zero model calls; when a step's
 * locator or post-condition fails, the executor falls back to the model loop from that step (the self-heal).
 */
import { fill, approvalFor, nameOf } from "./policy.mjs";
import { scrollToTextInPage } from "./click.mjs";

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
  // URL forms of the values too: percent-encoded (Reykjav%C3%ADk), and spaces as "_" (wiki paths), "+" or "%20" (queries)
  for (const [k, v] of entries) {
    const forms = new Set([encodeURIComponent(String(v)), String(v).replace(/ /g, "_"), String(v).replace(/ /g, "+"), encodeURIComponent(String(v)).replace(/%20/g, "+"), encodeURIComponent(String(v).replace(/ /g, "_"))]);
    for (const e of forms) if (e !== String(v)) s = s.replace(new RegExp(esc(e), "gi"), `{{${k}}}`);
  }
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
  // viewport-recorded values are checked on the page: idle scrolls are dropped from saved traces
  one(final.viewport, `${texts.viewport}\n${texts.page}`, "on the page");
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
  // role + name first (a prefix match when the recorded name was a parameter plus stale text), then visible text,
  // then stable attributes; the CSS path is only the last resort.
  const lead = String(loc.name ?? "").match(/^(.*?\{\{\s*[a-z0-9_]+\s*\}\})/i)?.[1];
  const prefix = loc.role && (loc.match === "prefix" ? name : lead && lead.length < String(loc.name).length ? fillText(lead, params) : null);
  const prefixTry = prefix ? [["role+name-prefix", () => page.getByRole(loc.role, { name: new RegExp(`^\\s*${esc(prefix)}(\\s|$)`, "i") })]] : [];
  if (loc.match === "prefix") tries.push(...prefixTry);
  if (loc.role && name && loc.match !== "prefix") tries.push(["role+name", () => page.getByRole(loc.role, { name, exact: true })]);
  if (loc.match !== "prefix") tries.push(...prefixTry);
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
export const describeTraceStep = (s) => `${s.action}${s.locator ? ` ${s.locator.role || s.locator.tag} "${locLabel(s.locator, {})}"` : ""}${s.text ? ` "${s.text.slice(0, 60)}"` : ""}${s.keys ? ` ${s.keys.join("+")}` : ""}${s.to ? ` ${s.to.slice(0, 80)}` : ""}`;

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
        await act({ type: s.action, x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), button: "left" }, `${s.action} ${s.locator.role || s.locator.tag} "${locLabel(s.locator, params)}" (by ${f.how})`);
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


// ---------------------------------------------------------------- deterministic value return
/**
 * Extraction recipe: how to read the task's answer off the final page without a model.
 *   { kind: "row", label, offset, regex }  the table row (th) or dt whose label matches {{param}}/text, `offset` rows
 *                                         below it (infobox header rows like "Population" with the value one row down)
 *   { kind: "css", css, regex }            an element by CSS path (id-anchored when possible)
 * `regex` (optional) picks the value out of the element's text; `sample` is what the recording run read.
 */
export const VALUE_RE = {
  version: "v?\\d+(?:\\.\\d+)+(?:[-.+][0-9A-Za-z.]+)?",
  number: "[-−]?\\d[\\d,.]*\\d(?:\\s?(?:%|°[CF]?|km²|km2|sq mi|km|m|ft|mi|kg|lb|million|billion|[KMB])(?![A-Za-z]))?|\\d",
};

/** Runs in the page: find the element showing one of `candidates` (values from the model's answer) and describe how to read it. */
export function deriveRecipeInPage({ candidates, labels }) {
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const low = (s) => norm(s).toLowerCase();
  const cssPath = (el) => {
    const path = [];
    for (let n = el; n && n.nodeType === 1 && path.length < 6; n = n.parentElement) {
      if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) { path.unshift(`#${n.id}`); break; }
      const t = n.tagName.toLowerCase(), sibs = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      path.unshift(sibs.length > 1 ? `${t}:nth-of-type(${sibs.indexOf(n) + 1})` : t);
    }
    return path.join(" > ");
  };
  const els = [...document.body.querySelectorAll("td, dd, th, dt, span, i, b, strong, em, p, li, h1, h2, h3, h4, h5, h6, a, div, code, time, small")];
  for (const c of candidates) {
    const cl = low(c);
    if (cl.length < 1) continue;
    let best = null;
    for (const el of els) {
      const t = low(el.innerText || el.textContent);
      if (!t || t.length > 300 || !t.includes(cl)) continue;
      if (!best || t.length < best.t.length) best = { el, t };
    }
    if (!best) continue;
    const el = best.el;
    const cell = el.closest("td, dd");
    if (cell) {
      if (cell.tagName === "DD") {
        let dt = cell.previousElementSibling; while (dt && dt.tagName !== "DT") dt = dt.previousElementSibling;
        if (dt) return { kind: "row", label: norm(dt.innerText).slice(0, 200), offset: 0, sample: norm(cell.innerText).slice(0, 300), candidate: c };
      } else {
        // walk up the table from the value's row to the nearest row whose th names one of the labels (a param), else the own th
        const row = cell.closest("tr"), rows = row ? [...row.closest("table")?.querySelectorAll("tr") ?? []] : [];
        const i = rows.indexOf(row);
        for (let k = 0; i >= 0 && k <= Math.min(i, 8); k++) {
          const th = rows[i - k].querySelector("th");
          if (th && labels.some((l) => low(th.innerText).includes(low(l)))) return { kind: "row", label: norm(th.innerText).slice(0, 200), offset: k, sample: norm(cell.innerText).slice(0, 300), candidate: c };
        }
        const own = row?.querySelector("th");
        if (own) return { kind: "row", label: norm(own.innerText).slice(0, 200), offset: 0, sample: norm(cell.innerText).slice(0, 300), candidate: c };
      }
    }
    return { kind: "css", css: cssPath(el), sample: norm(el.innerText).slice(0, 300), candidate: c };
  }
  return null;
}

/** Runs in the page: apply a (filled) recipe; returns the element's text or null. */
export function applyRecipeInPage({ recipe, scroll }) {
  const show = (el) => { if (scroll && el) el.scrollIntoView({ block: "center", inline: "nearest" }); };
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const low = (s) => norm(s).toLowerCase();
  if (recipe.kind === "css") { const el = document.querySelector(recipe.css); show(el); return el ? norm(el.innerText || el.textContent).slice(0, 1000) : null; }
  if (recipe.kind === "row") {
    const want = low(recipe.label);
    const pick = (list) => list.find((x) => low(x.innerText) === want) ?? list.find((x) => low(x.innerText).startsWith(want)) ?? list.find((x) => low(x.innerText).includes(want));
    const th = pick([...document.querySelectorAll("th")]);
    if (th) {
      const rows = [...th.closest("table").querySelectorAll("tr")], i = rows.indexOf(th.closest("tr"));
      // the recorded offset first; a header row without a value cell looks a few rows further (infobox sub-rows)
      const tryRows = [i + (recipe.offset || 0), i, i + 1, i + 2, i + 3].filter((k, x, a) => k >= i && a.indexOf(k) === x);
      for (const k of tryRows) { const td = rows[k]?.querySelector("td"); if (td && norm(td.innerText)) { show(td); return norm(td.innerText).slice(0, 1000); } }
    }
    const dt = pick([...document.querySelectorAll("dt")]);
    if (dt) { let dd = dt.nextElementSibling; while (dd && dd.tagName !== "DD") dd = dd.nextElementSibling; if (dd) { show(dd); return norm(dd.innerText).slice(0, 1000); } }
  }
  return null;
}

/** Values worth looking for in a model's answer: **bold** spans, versions, numbers (longest first), minus the inputs. */
export function answerCandidates(answer, params = {}) {
  const a = String(answer ?? "");
  const out = [];
  for (const m of a.matchAll(/\*\*([^*]{1,120})\*\*/g)) out.push(m[1].trim());
  for (const m of a.matchAll(new RegExp(VALUE_RE.version, "g"))) out.push(m[0]);
  for (const m of a.matchAll(/\d[\d,]*(?:\.\d+)?/g)) if (m[0].replace(/\D/g, "").length >= 2) out.push(m[0]);
  const inputs = Object.values(params).map((v) => String(v).toLowerCase());
  const seen = new Set();
  return out.map((s) => s.replace(/[.,;:]+$/, "").trim()).filter((s) => s.length >= 1 && !inputs.includes(s.toLowerCase()) && !seen.has(s) && seen.add(s))
    .sort((x, y) => Number(/\d/.test(y)) - Number(/\d/.test(x)) || y.length - x.length).slice(0, 12);
}

/** The value regex for a sample: versions and numbers are generalized; other text is returned whole. */
export function regexFor(candidate) {
  const c = String(candidate ?? "").trim();
  if (new RegExp(`^${VALUE_RE.version}$`).test(c)) return VALUE_RE.version;
  if (/^[-−]?\d[\d,.]*$/.test(c)) return VALUE_RE.number;
  const m = c.match(new RegExp(`^(${VALUE_RE.number})`));
  if (m && /\d/.test(c)) return VALUE_RE.number;
  return null;
}

/** The value from an element's text with a recipe's regex. */
export function pickValue(text, recipe) {
  if (text == null) return null;
  const t = String(text).replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (!recipe.regex) return t.slice(0, 300);
  const m = t.match(new RegExp(recipe.regex));
  return m ? m[0].trim().replace(/[.,;:]+$/, "").slice(0, 300) : null;
}

/** Template a derived recipe for storage (labels that are inputs become {{param}}). */
export function storeRecipe(r, params) {
  if (!r) return null;
  const regex = regexFor(r.candidate);
  // a label that names an input keeps only the placeholder ("{{target_field}}", not "{{target_field}} (2023)[2]"): matched as a prefix
  const label = r.kind === "row" ? (templ(r.label, params).match(/\{\{\s*[a-z0-9_]+\s*\}\}/i)?.[0] ?? templ(r.label, params)) : "";
  return { kind: r.kind, ...(r.kind === "row" ? { label: label.slice(0, 200), offset: Math.max(0, Math.min(10, r.offset | 0)) } : { css: String(r.css).slice(0, 320) }), ...(regex ? { regex } : {}), sample: String(r.sample ?? "").slice(0, 300) };
}
export const fillRecipe = (r, params) => (r.kind === "row" ? { ...r, label: fillText(r.label, params) } : r);

// ---------------------------------------------------------------- trace hygiene
const placeholderLead = (name) => String(name ?? "").match(/^(\s*\{\{\s*[a-z0-9_]+\s*\}\})/i)?.[1]?.trim();
/** Normalize a locator: a name that is a parameter plus stale extra text ("{{q}} 8.1.4 Full-stack…") keeps only the parameter, matched as a prefix. */
export function cleanLocator(l) {
  if (!l) return l;
  const lead = placeholderLead(l.name);
  if (lead && lead.length < String(l.name).trim().length) return { ...l, name: lead, text: placeholderLead(l.text) ?? lead, match: "prefix" };
  return l;
}
const meaningfulLoc = (l) => Boolean(l && (l.role || l.name || l.attrs?.id || l.attrs?.name));
const sameStep = (a, b) => a.action === b.action && JSON.stringify(a.locator ?? null) === JSON.stringify(b.locator ?? null) && a.text === b.text && JSON.stringify(a.keys ?? null) === JSON.stringify(b.keys ?? null) && a.to === b.to;
/**
 * Clean a trace before saving: drop scrolls (locators scroll their element into view and values are read from the
 * DOM), clicks on nothing interactive that changed nothing, and repeated identical steps; normalize locators.
 */
export function cleanSteps(steps) {
  const out = [];
  for (const s0 of steps) {
    const s = s0.locator ? { ...s0, locator: cleanLocator(s0.locator) } : { ...s0 };
    if (s.action === "scroll") continue;
    if ((s.action === "click" || s.action === "double_click") && !s.changes_url && !meaningfulLoc(s.locator)) continue;
    const prev = out[out.length - 1];
    if (prev && !prev.changes_url && sameStep(prev, s)) { prev.changes_url = prev.changes_url || s.changes_url; continue; }
    out.push(s);
  }
  return out;
}
/** Human label for a locator in logs: the filled parameter or accessible name, never stale recorded text. */
export const locLabel = (l, params) => fillText(l?.match === "prefix" ? l.name : placeholderLead(l?.name) ?? (l?.name || l?.text || l?.css || ""), params).slice(0, 60);
