import { describe, it, expect, beforeAll, afterAll } from "vitest";
// @ts-expect-error plain ESM module without types
import { templ, fillUrl, finalChecks, checkFinal, traceStep, usableTrace, describeInPage, pageTextInPage, locate, runTraceStep } from "../src/trace.mjs";
// @ts-expect-error plain ESM module without types
import { INTERACTIVE } from "../src/click.mjs";

const params = { search_query: "Reykjavík", target_field: "Population" };

describe("trace: parameter templating", () => {
  it("writes parameter values back as {{param}}, URL-encoded forms included, and fills them again", () => {
    expect(templ("https://en.wikipedia.org/wiki/Reykjav%C3%ADk", params)).toBe("https://en.wikipedia.org/wiki/{{search_query}}");
    expect(templ("Reykjavík population", params)).toBe("{{search_query}} {{target_field}}"); // case-insensitive
    expect(templ("https://en.wikipedia.org/wiki/Mount_Everest", { q: "Mount Everest" })).toBe("https://en.wikipedia.org/wiki/{{q}}");
    expect(templ("https://w.test/w/index.php?search=Mount+Everest&x=1", { q: "Mount Everest" })).toBe("https://w.test/w/index.php?search={{q}}&x=1");
    expect(checkFinal({ url: "https://en.wikipedia.org/wiki/{{q}}", viewport: ["q"], page: [], title: [] }, { viewport: "New York City", page: "", title: "" }, { q: "New York City" }, "https://en.wikipedia.org/wiki/New_York_City").ok).toBe(true);
    expect(templ("ab", { x: "a" })).toBe("ab"); // 1-char values are not templated
    expect(fillUrl("https://en.wikipedia.org/wiki/{{search_query}}", { search_query: "São Paulo" })).toBe("https://en.wikipedia.org/wiki/S%C3%A3o%20Paulo");
  });

  it("builds steps for each action type with a templated locator", () => {
    const loc = { tag: "a", role: "link", name: "Reykjavík", text: "Reykjavík", css: "#mw-content-text > a", attrs: {} };
    expect(traceStep({ type: "click", x: 1, y: 2 }, { url: "https://x.test/?q=Reykjav%C3%ADk", params, loc })).toEqual({ url: "https://x.test/?q={{search_query}}", action: "click", locator: { ...loc, name: "{{search_query}}", text: "{{search_query}}" } });
    expect(traceStep({ type: "click", x: 1, y: 2 }, { url: "u", params, loc: null })).toBeNull();
    expect(traceStep({ type: "type", text: "Reykjavík" }, { url: "u", params })).toMatchObject({ action: "type", text: "{{search_query}}" });
    expect(traceStep({ type: "keypress", keys: ["Enter"] }, { url: "u", params })).toMatchObject({ action: "keypress", keys: ["Enter"] });
    expect(traceStep({ type: "scroll", scroll_y: 4.6 }, { url: "u", params })).toMatchObject({ action: "scroll", scroll_x: 0, scroll_y: 5 });
    expect(traceStep({ type: "navigate", url: "https://x.test/wiki/Reykjav%C3%ADk" }, { url: "u", params })).toMatchObject({ to: "https://x.test/wiki/{{search_query}}" });
    expect(usableTrace({ v: 1, steps: [{}] })).toBe(true);
    expect(usableTrace({ v: 1, steps: [] })).toBe(false);
    expect(usableTrace(null)).toBe(false);
  });
});

describe("trace: deterministic final check", () => {
  const final = finalChecks({ viewport: "Reykjavík Population 139,875", page: "…", title: "Reykjavík - Wikipedia" }, params, "https://en.wikipedia.org/wiki/Reykjav%C3%ADk");
  it("records where the parameter values showed and the templated final URL", () => {
    expect(final).toEqual({ url: "https://en.wikipedia.org/wiki/{{search_query}}", viewport: ["search_query", "target_field"], page: [], title: ["search_query"] });
  });
  it("passes on the same page for a new input, fails on a different page or missing value", () => {
    const p2 = { search_query: "Oslo", target_field: "Population" };
    expect(checkFinal(final, { viewport: "Oslo … Population 717,710", page: "", title: "Oslo - Wikipedia" }, p2, "https://en.wikipedia.org/wiki/Oslo").ok).toBe(true);
    expect(checkFinal(final, { viewport: "Oslo … Population", page: "", title: "Search results - Wikipedia" }, p2, "https://en.wikipedia.org/wiki/Oslo")).toMatchObject({ ok: false });
    expect(checkFinal(final, { viewport: "Oslo Population", page: "", title: "Oslo" }, p2, "https://en.wikipedia.org/w/index.php?search=Oslo").ok).toBe(false);
    expect(checkFinal(null, { viewport: "", page: "", title: "" }, p2, "x").ok).toBe(false);
    expect(checkFinal({ url: "", viewport: [], page: [], title: [] }, { viewport: "", page: "", title: "" }, p2, "x").ok).toBe(false);
  });
});

// A real headless Chromium run of a trace against local pages: record on one input, replay on another with no model.
let chromium: any = null;
try { chromium = (await import("playwright-core")).chromium; } catch {}
let browser: any = null;
beforeAll(async () => { try { browser = await chromium?.launch(); } catch { browser = null; } });
afterAll(async () => { await browser?.close(); });

const SITE = "https://site.test";
const pages: Record<string, (q: URLSearchParams, path: string) => string> = {
  "/": () => `<title>Home</title><form action="/search"><input type="search" name="q" aria-label="Search the wiki"><button>Search</button></form><p>Welcome</p>`,
  "/search": (q) => `<title>Search</title><h1>Results</h1><ul><li><a href="/wiki/Noise">Noise article</a></li><li><a href="/wiki/${encodeURIComponent(q.get("q") ?? "")}">${q.get("q")}</a></li></ul>`,
  "/wiki": (_q, path) => { const t = decodeURIComponent(path.slice(6)); return `<title>${t} - Wiki</title><h1>${t}</h1><table><tr><th>Population</th><td>123</td></tr></table>`; },
};
async function newPage() {
  const page = await (await browser.newContext({ viewport: { width: 960, height: 600 } })).newPage();
  await page.route("**/*", (route: any) => {
    const u = new URL(route.request().url());
    const key = u.pathname.startsWith("/wiki/") ? "/wiki" : u.pathname;
    const f = pages[key];
    return f ? route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset=utf-8>${f(u.searchParams, u.pathname)}` }) : route.fulfill({ status: 404, body: "nf" });
  });
  await page.goto(SITE + "/");
  return page;
}
const execute = async (page: any, a: any) => {
  if (a.type === "click") await page.mouse.click(a.x, a.y);
  else if (a.type === "type") await page.keyboard.type(a.text);
  else if (a.type === "keypress") for (const k of a.keys) await page.keyboard.press(k === "ENTER" ? "Enter" : k);
};
const inspect = async (page: any, a: any) => (a.type === "click" ? page.evaluate(({ x, y }: any) => { const e = document.elementFromPoint(x, y); return e ? { tag: e.tagName.toLowerCase(), text: (e as HTMLElement).innerText } : null; }, a) : null);
const ctx = (extra: any = {}) => ({ origin: SITE, skill: { steps: [{ intent: "search", target: "search box", action: "type", value: "{{q}}" }] }, ask: async () => true, send: () => {}, actions: [] as any[], history: [] as string[], index: 0, W: 960, H: 600, selectOption: async () => null, inspect, execute, onHuman: () => {}, ...extra });

describe.skipIf(!chromium)("trace: replay in headless Chromium with no model", () => {
  it("records a trace on one input and replays it on another; a missing element fails the step for recovery", async () => {
    if (!browser) return;
    // "record": what the executor captures while the model drives (locator under the pointer, before the action)
    const p = await newPage();
    const P1 = { q: "Reykjavík" }, steps: any[] = [];
    const box = await p.getByRole("searchbox").boundingBox();
    const at = { x: box.x + 10, y: box.y + 5 };
    steps.push({ ...traceStep({ type: "click", ...at }, { url: p.url(), params: P1, loc: await p.evaluate(describeInPage, { ...at, focused: false, sel: INTERACTIVE }) }), changes_url: false });
    await p.mouse.click(at.x, at.y);
    steps.push({ ...traceStep({ type: "type", text: "Reykjavík" }, { url: p.url(), params: P1, loc: await p.evaluate(describeInPage, { x: 0, y: 0, focused: true, sel: INTERACTIVE }) }), changes_url: false });
    await p.keyboard.type("Reykjavík");
    steps.push({ ...traceStep({ type: "keypress", keys: ["Enter"] }, { url: p.url(), params: P1 }), changes_url: true });
    await Promise.all([p.waitForURL(/search/), p.keyboard.press("Enter")]);
    const link = await p.getByRole("link", { name: "Reykjavík" }).boundingBox();
    const at2 = { x: link.x + 5, y: link.y + 5 };
    steps.push({ ...traceStep({ type: "click", ...at2 }, { url: p.url(), params: P1, loc: await p.evaluate(describeInPage, { ...at2, focused: false, sel: INTERACTIVE }) }), changes_url: true });
    await Promise.all([p.waitForURL(/wiki/), p.mouse.click(at2.x, at2.y)]);
    const final = finalChecks(await p.evaluate(pageTextInPage), { ...P1, target_field: "Population" }, p.url());
    expect(steps[0].locator).toMatchObject({ role: "searchbox", name: "Search the wiki" });
    expect(steps[3].locator).toMatchObject({ role: "link", name: "{{q}}" });

    // replay on a new input: zero model calls, every step located and its post-condition met
    const r = await newPage();
    const P2 = { q: "Oslo" };
    const c = ctx();
    for (const [i, s] of steps.entries()) expect(await runTraceStep(r, s, P2, { ...c, index: i })).toMatchObject({ ok: true });
    expect(new URL(r.url()).pathname).toBe("/wiki/Oslo");
    expect(await runTraceStep(r, { url: "x", action: "scroll_to_text", text: "{{f}}", changes_url: false }, { ...P2, f: "Population" }, c)).toMatchObject({ ok: true });
    expect(await runTraceStep(r, { url: "x", action: "scroll_to_text", text: "Elevation", changes_url: false }, P2, c)).toMatchObject({ ok: false });
    expect(checkFinal(final, await r.evaluate(pageTextInPage), { ...P2, target_field: "Population" }, r.url())).toMatchObject({ ok: true });
    expect(c.actions.every((a: any) => a.turn === 0)).toBe(true);
    expect(await locate(r, { tag: "a", role: "link", name: "Nope", text: "Nope", css: "#nope", attrs: {} }, P2, 300)).toBeNull();
    // a recorded name with extra text after the parameter still finds the element by its leading part
    expect(await locate(r, { tag: "h1", role: "heading", name: "{{q}} 8.1.4 Full-stack web application framework", text: "", css: "#nope", attrs: {} }, P2, 300)).toMatchObject({ how: "role+name-prefix" });

    // the site changed: the result link is gone -> the step fails with a reason, so the model recovers from there
    const q = await newPage();
    pages["/search"] = () => `<title>Search</title><p>No results</p>`;
    for (const s of steps.slice(0, 3)) expect((await runTraceStep(q, s, P2, ctx())).ok).toBe(true);
    const bad = await runTraceStep(q, steps[3], P2, ctx());
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/element not found: click link "\{\{q\}\}"/);
  }, 60000);
});
