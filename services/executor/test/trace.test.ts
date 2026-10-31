import { describe, it, expect, beforeAll, afterAll } from "vitest";
// @ts-expect-error plain ESM module without types
import { templ, fillUrl, finalChecks, checkFinal, traceStep, usableTrace, describeInPage, pageTextInPage, locate, runTraceStep, cleanSteps, locLabel, answerCandidates, deriveRecipeInPage, applyRecipeInPage, storeRecipe, fillRecipe, pickValue, regexFor } from "../src/trace.mjs";
// @ts-expect-error plain ESM module without types
import { INTERACTIVE, textTargetInPage, TEXT_FIELD } from "../src/click.mjs";
// @ts-expect-error plain ESM module without types
import { valueBinding as execBinding, missingInputs, describeMissing } from "../src/trace.mjs";
import { valueBinding as coreBinding } from "../../../packages/core/src/valueBinding";

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
    const final = { url: "u", viewport: [], page: [], title: [] };
    expect(usableTrace({ v: 1, steps: [{}], final })).toBe(true);
    expect(usableTrace({ v: 1, steps: [], final })).toBe(false);
    // the answer is on the start page (e.g. HN's top story): no steps, but a recipe to read it
    expect(usableTrace({ v: 1, steps: [], final, extract: { kind: "css", css: "a" } })).toBe(true);
    expect(usableTrace(null)).toBe(false);
  });
});

describe("trace: hygiene and value helpers", () => {
  it("drops scrolls, no-op clicks and repeats; keeps only the parameter of a stale link name", () => {
    const link = { tag: "a", role: "link", name: "{{q}} 8.1.4 Full-stack web application framework.", text: "{{q}} 8.1.4 Full-stack", css: "main > a", attrs: {} };
    const box = { tag: "input", role: "searchbox", name: "Search", text: "", css: "#s", attrs: { id: "s" } };
    const out = cleanSteps([
      { url: "u", action: "scroll", scroll_x: 0, scroll_y: 5, changes_url: false },
      { url: "u", action: "click", locator: { tag: "div", role: "", name: "", text: "", css: "div", attrs: {} }, changes_url: false },
      { url: "u", action: "click", locator: box, changes_url: false },
      { url: "u", action: "click", locator: box, changes_url: false },
      { url: "u", action: "type", text: "{{q}}", locator: box, changes_url: false },
      { url: "u", action: "keypress", keys: ["Enter"], changes_url: true },
      { url: "u", action: "click", locator: link, changes_url: true },
    ]);
    expect(out.map((x: any) => x.action)).toEqual(["click", "type", "keypress", "click"]);
    expect(out[3].locator).toMatchObject({ name: "{{q}}", text: "{{q}}", match: "prefix", css: "main > a" });
    expect(locLabel(out[3].locator, { q: "sinatra" })).toBe("sinatra");
    expect(locLabel(link, { q: "sinatra" })).toBe("sinatra");
  });
  it("finds value candidates in an answer and generalizes their regex", () => {
    expect(answerCandidates("Latest version: **4.2.1** (released October 10)", { gem_name: "sinatra" })[0]).toBe("4.2.1");
    expect(regexFor("4.2.1")).toMatch(/\\d\+/);
    expect(pickValue("Version 4.2.1 · MIT", { kind: "css", regex: regexFor("8.1.4") })).toBe("4.2.1");
    // a date answer is read whole ("Last accounts made up to 28 February 2026"), not as its day number
    expect(pickValue("31 December 2025", { kind: "css", regex: regexFor("28 February 2026") })).toBe("31 December 2025");
    expect(pickValue("made up to 31 March 2026", { kind: "css", regex: regexFor("28 February 2026") })).toBe("31 March 2026");
    expect(regexFor("1,234")).toBe(regexFor("12"));
    expect(regexFor("Last accounts made up to 31 December 2025")).toBe(regexFor("1 May 2020"));
    expect(answerCandidates("Accounts section shows Last accounts made up to 31 December 2025 (next: 31 December 2026)").slice(0, 2)).toEqual(["31 December 2025", "31 December 2026"]);
    expect(storeRecipe({ kind: "row", label: "Born", offset: 0, sample: "14 March 1879", candidate: "14 March 1879" }, { target_field: "Born" }).regex).toBe(regexFor("12")); // input-named row: any value kind
    expect(storeRecipe({ kind: "css", css: "p > strong", sample: "28 February 2026", candidate: "28 February 2026" }, { company_number: "00445790" }).regex).toBe(regexFor("1 May 2020"));
    expect(pickValue("717,710 (city)", { kind: "row", regex: regexFor("139,875") })).toBe("717,710");
    expect(pickValue("8,848.86 m (29,031.7 ft) Ranked 1st", { kind: "row", regex: regexFor("8,848.86 m (29,031.7 ft)") })).toBe("8,848.86 m");
    expect(pickValue("Python", { kind: "css" })).toBe("Python");
  });
  it("puts a quoted title first and ignores version-like digits inside a word (Qwen3.5)", () => {
    const c = answerCandidates('The top story is "Qwen3.5 runs on a laptop" with 812 points.', {});
    expect(c[0]).toBe("Qwen3.5 runs on a laptop");
    expect(c).not.toContain("3.5");
    expect(answerCandidates("serde v1.0.229", { crate_name: "serde" })[0]).toMatch(/^v?1\.0\.229$/);
  });
  it("skips a bold label that repeats the asked field", () => {
    expect(answerCandidates("**Population (2022 census)**\n- Capital and autonomous city: **3,121,707**", { search_query: "Buenos Aires", target_field: "Population" })[0]).toBe("3,121,707");
    expect(answerCandidates("- **Special capital region:** 11,010,514\n- **Metro**: 34,540,000", { search_query: "Jakarta", target_field: "Population" })[0]).toBe("11,010,514");
  });
  it("forgets a side sub-row (Metro) unless the field asks for it", () => {
    const r = { kind: "row", label: "Population (2024)", offset: 4, sub: "Metro", candidate: "6,125,583", sample: "6,125,583" };
    expect(storeRecipe(r, { target_field: "Population" })).toMatchObject({ label: "{{target_field}}", offset: 0 });
    expect(storeRecipe(r, { target_field: "Population" })).not.toHaveProperty("sub");
    expect(storeRecipe({ ...r, label: "Metro population" }, { target_field: "Metro population" })).toMatchObject({ sub: "Metro", offset: 4 });
  });
  it("never waits for a URL change after a step that cannot navigate", () => {
    const out = cleanSteps([{ url: "u", action: "scroll_to_text", text: "{{f}}", changes_url: true }, { url: "u", action: "type", text: "x", locator: { tag: "input", role: "searchbox", name: "S", text: "", css: "input", attrs: {} }, changes_url: true }]);
    expect(out.map((x: any) => x.changes_url)).toEqual([false, false]);
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
  // a rates table (x-rates): rows labeled by their first cell; Euro is the first row
  "/table/": () => `<title>Exchange Rates table</title><table><thead><tr><th>US Dollar</th><th>1.00 USD</th><th>inv. 1.00 USD</th></tr></thead><tbody><tr><td>Euro</td><td><a href="/e">0.895817</a></td><td>1.116299</td></tr><tr><td>British Pound</td><td><a href="/g">0.741203</a></td><td>1.349159</td></tr><tr><td>Japanese Yen</td><td><a href="/j">157.869642</a></td><td>0.006334</td></tr></tbody></table>`,
  "/wiki": (_q, path) => { const t = decodeURIComponent(path.slice(6)); const pop = t === "Oslo" ? "717,710" : "139,875"; return `<title>${t} - Wiki</title><h1>${t}</h1><table class="infobox"><tr><th>Country</th><td>Somewhere</td></tr><tr><th colspan="2">Population (${t === "Oslo" ? 2024 : 2023})</th></tr><tr><th>• City</th><td>${pop}</td></tr><tr><th>• Density</th><td>1,500/km2 (3,900/sq mi)</td></tr><tr><th>• Urban</th><td>${t === "Oslo" ? "1,064,235" : "200,000"}</td></tr><tr><th>• Metro</th><td>${t === "Oslo" ? "1,588,457" : "250,000"}</td></tr><tr><th>Elevation</th><td>12 m</td></tr></table><p>Population figures are estimates.</p>`; },
};
// varied infoboxes (from real Wikipedia layouts): label variants, dates, plain sections, bullet sub-rows, text fields
pages["/fact"] = (_q, path) => ({
  "/fact/Peak": `<table class="infobox"><tr><th colspan="2">Highest point</th></tr><tr><th>Elevation</th><td>8,848.86 m (29,031.7 ft)[note 2] Ranked 1st</td></tr><tr><th>Prominence</th><td>8,848.86 m Ranked 1st</td></tr></table>`,
  "/fact/Fuji": `<table class="infobox"><tr><th colspan="2">Highest point</th></tr><tr><th>Prominence</th><td>3,776 m (12,388 ft)[1] Ranked 35th</td></tr><tr><th>Country</th><td>Japan</td></tr></table><p>Its elevation is often quoted.</p><table><tr><td>Elevation</td><td>9 m</td></tr></table>`,
  "/fact/Metro": `<table class="infobox"><tr><th>Area</th><td>Seoul Metropolitan</td></tr><tr><th colspan="2">Area[3]</th></tr><tr><th> • Special metropolitan city</th><td>605.21 km2 (233.67 sq mi)</td></tr><tr><th>Elevation</th><td>38 m (125 ft)</td></tr><tr><th>Highest elevation (Bukhansan)</th><td>836.5 m (2,744 ft)</td></tr><tr><th colspan="2">Population (Q1 2026)[4]</th></tr><tr><th> • Special metropolitan city</th><td>9,579,449</td></tr><tr><th> • Metro</th><td>26,037,000</td></tr><tr><th> • Metro density</th><td>2,053/km2 (5,320/sq mi)</td></tr></table>`,
  "/fact/Town": `<table class="infobox"><tr><th>Population</th><td>Metropolitan France</td></tr><tr><th>Population (Jan 2026[4])</th><td>2,047,602</td></tr><tr><th>Highest elevation[5]</th><td>2,017 m (6,617 ft)</td></tr></table>`,
  "/fact/Tower": `<table class="infobox"><tr><th colspan="2">Height</th></tr><tr><th>Architectural</th><td>300 m (984 ft)[2]</td></tr><tr><th>Tip</th><td>330 m (1,083 ft)</td></tr><tr><th>Opened:</th><td>30 June 1894; 132 years ago</td></tr></table>`,
  "/fact/Person": `<table class="infobox"><tr><th>Born</th><td>Maria Salomea Skłodowska 7 November 1867 Warsaw</td></tr><tr><th>Founded</th><td>April 1, 1976 (50 years ago), in Los Altos</td></tr><tr><th>Nationality</th><td>Polish; French</td></tr><tr><th colspan="2">Discharge</th></tr><tr><th> • average</th><td>2,757 m3/sec[7]</td></tr></table>`,
}[path] ?? "nf");
async function newPage() {
  const page = await (await browser.newContext({ viewport: { width: 960, height: 600 } })).newPage();
  await page.route("**/*", (route: any) => {
    const u = new URL(route.request().url());
    const key = u.pathname.startsWith("/wiki/") ? "/wiki" : u.pathname.startsWith("/fact/") ? "/fact" : u.pathname;
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
    // the extraction recipe: where the model's answer ("**139,875**") is on the page, as a row under the {{f}} header
    const derived = await p.evaluate(deriveRecipeInPage, { candidates: answerCandidates("The population is **139,875**.", { ...P1, f: "Population" }), labels: ["Reykjavík", "Population"] });
    const recipe = storeRecipe(derived, { ...P1, f: "Population" });
    expect(recipe).toMatchObject({ kind: "row", label: "{{f}}", offset: 1, sample: "139,875" });

    // replay on a new input: zero model calls, every step located and its post-condition met
    const r = await newPage();
    const P2 = { q: "Oslo" };
    const c = ctx();
    for (const [i, s] of steps.entries()) expect(await runTraceStep(r, s, P2, { ...c, index: i })).toMatchObject({ ok: true });
    expect(new URL(r.url()).pathname).toBe("/wiki/Oslo");
    expect(await runTraceStep(r, { url: "x", action: "scroll_to_text", text: "{{f}}", changes_url: false }, { ...P2, f: "Population" }, c)).toMatchObject({ ok: true });
    expect(await runTraceStep(r, { url: "x", action: "scroll_to_text", text: "Area code", changes_url: false }, P2, c)).toMatchObject({ ok: false });
    expect(checkFinal(final, await r.evaluate(pageTextInPage), { ...P2, target_field: "Population" }, r.url())).toMatchObject({ ok: true });
    expect(c.actions.every((a: any) => a.turn === 0)).toBe(true);
    // zero-call value return on the new input (the header says 2024 here, 2023 in the recording)
    expect(pickValue(await r.evaluate(applyRecipeInPage, { recipe: fillRecipe(recipe, { ...P2, f: "Population" }) }), recipe)).toBe("717,710");
    expect(await r.evaluate(applyRecipeInPage, { recipe: { kind: "row", label: "Area", offset: 0 } })).toBeNull();
    // city vs metro: "Population" is the City figure even with an old Metro recipe; "Metro population" is the Metro row
    const metro = { kind: "row", label: "{{f}}", offset: 4, sub: "Metro", regex: regexFor("139,875") };
    expect(pickValue(await r.evaluate(applyRecipeInPage, { recipe: fillRecipe(metro, { f: "Population" }) }), metro)).toBe("717,710");
    expect(pickValue(await r.evaluate(applyRecipeInPage, { recipe: fillRecipe(metro, { f: "Metro population" }) }), metro)).toBe("1,588,457");
    expect(pickValue(await r.evaluate(applyRecipeInPage, { recipe: fillRecipe(metro, { f: "Urban population" }) }), metro)).toBe("1,064,235");
    // a recipe recorded on a page where the value sat on the label's own row still finds it under a header row
    expect(pickValue(await r.evaluate(applyRecipeInPage, { recipe: { kind: "row", label: "Population", offset: 0 } }), { kind: "row", regex: regexFor("139,875") })).toBe("717,710");
    expect(pickValue(await r.evaluate(applyRecipeInPage, { recipe: { kind: "row", label: "Elevation", offset: 0, regex: regexFor("12 m") } }), { kind: "row", regex: regexFor("12 m") })).toBe("12 m");
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

describe("a start URL that names params", () => {
  it("is filled per run (URL-encoded) and written back as the template", async () => {
    const { fillUrl, templ } = await import("../src/trace.mjs");
    const tpl = "https://pypi.org/project/{{package}}/";
    expect(fillUrl(tpl, { package: "requests" })).toBe("https://pypi.org/project/requests/");
    expect(fillUrl(tpl, { package: "a b" })).toBe("https://pypi.org/project/a%20b/");
    expect(templ(fillUrl(tpl, { package: "flask" }), { package: "flask" })).toBe(tpl);
  });
});

describe("value binding: a returned value must be tied to the run's inputs (same as @agentboard/core)", () => {
  const cases: any[] = [
    // x-rates: the recorded first-row cell on a page that is the same for every currency: never tied to the input
    { params: { target_currency: "Japanese Yen" }, value: "0.895817", finalUrlTemplate: "https://www.x-rates.com/table/?from=USD&amount=1", finalUrl: "https://www.x-rates.com/table/?from=USD&amount=1", rowLabel: null },
    { params: { target_currency: "Japanese Yen" }, value: "157.869642", finalUrlTemplate: "https://www.x-rates.com/table/?from=USD&amount=1", rowLabel: "Japanese Yen" },
    { params: { target_currency: "Japanese Yen" }, value: "0.89", rowLabel: "Euro" },
    // per-input pages (PyPI, crates, Go, HN search): the final URL names the input
    { params: { package: "numpy" }, value: "2.5.4", finalUrlTemplate: "https://pypi.org/project/{{package}}/#history" },
    { params: { module_path: "github.com/spf13/cobra" }, value: "v1.10.2", finalUrl: "https://pkg.go.dev/github.com%2Fspf13%2Fcobra" },
    { params: { search_query: "Mount Everest", target_field: "Elevation" }, value: "8,848.86 m", finalUrl: "https://en.wikipedia.org/wiki/Mount_Everest", rowLabel: "Elevation" },
    { params: { search_query: "Mount Everest", target_field: "Elevation" }, value: "9,600,000", finalUrl: "https://en.wikipedia.org/wiki/Mount_Everest", rowLabel: "Area › Total" },
    { params: { search_query: "NYC", target_field: "Population" }, value: "8,478,072", finalUrl: "https://en.wikipedia.org/wiki/New_York_City", rowLabel: "Population (2024) › City", titleParams: ["search_query"] },
    { params: { search_query: "Seoul", target_field: "Metro population" }, value: "26,037,000", finalUrl: "https://en.wikipedia.org/wiki/Seoul", rowLabel: "Population › Metro" },
    { params: { q: "x" }, value: "1" }, // 1-char values are not bound
    { params: { a: "Oslo" }, value: null },
  ];
  it("binds every parameter by page URL, page title or row label, else refuses the value", () => {
    const r = cases.map((c) => execBinding(c));
    expect(r.map((x: any) => x.ok)).toEqual([false, true, false, true, true, true, false, true, true, true, true]);
    expect(r[0].reason).toMatch(/not tied to target_currency "Japanese Yen".*fixed element/);
    expect(r[6].missing).toEqual(["target_field"]);
    expect(r[1].by).toEqual({ target_currency: "row" });
    expect(r[7].by).toEqual({ search_query: "title", target_field: "row" });
    expect(r[10].checked).toBe(false);
    for (const c of cases) expect(execBinding(c)).toEqual(coreBinding(c));
  });

  it("fills a URL template: whole-URL params as is, path params keep '/', query params fully encoded; query params are checked", () => {
    expect(fillUrl("{{repository_url}}", { repository_url: "https://github.com/microsoft/playwright" })).toBe("https://github.com/microsoft/playwright");
    expect(fillUrl("https://pkg.go.dev/{{module_path}}", { module_path: "golang.org/x/net" })).toBe("https://pkg.go.dev/golang.org/x/net");
    expect(fillUrl("https://hn.algolia.com/?query={{q}}&type=story", { q: "a/b c" })).toBe("https://hn.algolia.com/?query=a%2Fb%20c&type=story");
    const final = { url: "https://hn.algolia.com/?query={{q}}&type=story", viewport: ["q"], page: [], title: [] };
    expect(checkFinal(final, { viewport: "postgres", page: "", title: "" }, { q: "postgres" }, "https://hn.algolia.com/?query=postgres&type=story").ok).toBe(true);
    expect(checkFinal(final, { viewport: "postgres", page: "", title: "" }, { q: "postgres" }, "https://hn.algolia.com/?query=sqlite&type=story").ok).toBe(false);
  });
});

describe.skipIf(!chromium)("value binding in headless Chromium: a rates table (x-rates)", () => {
  it("reads the row labeled with the input, not the recorded first row, for Japanese Yen and British Pound", async () => {
    if (!browser) return;
    const p = await newPage();
    await p.goto(SITE + "/table/?from=USD&amount=1");
    // learning: the verifier quoted 157.869642 for Japanese Yen -> a row recipe labeled with the input
    const derived = await p.evaluate(deriveRecipeInPage, { candidates: ["157.869642"], labels: ["Japanese Yen"] });
    const recipe = storeRecipe(derived, { target_currency: "Japanese Yen" });
    expect(recipe).toMatchObject({ kind: "row", label: "{{target_currency}}", offset: 0 });
    for (const [cur, want] of [["Japanese Yen", "157.869642"], ["British Pound", "0.741203"], ["Euro", "0.895817"]]) {
      const got = await p.evaluate(applyRecipeInPage, { recipe: fillRecipe(recipe, { target_currency: cur }), withLabel: true });
      expect(pickValue(got.text, recipe)).toBe(want);
      expect(got.label).toBe(cur);
      expect(execBinding({ params: { target_currency: cur }, value: want, finalUrl: p.url(), rowLabel: got.label }).ok).toBe(true);
    }
    // the old recipe (the recorded first-row cell) returns the Euro rate for any input: refused
    const old = { kind: "css", css: "table > tbody > tr:nth-of-type(1) > td:nth-of-type(2)", regex: "v?\\d+(?:\\.\\d+)+" };
    const stale = pickValue(await p.evaluate(applyRecipeInPage, { recipe: old }), old);
    expect(stale).toBe("0.895817");
    expect(execBinding({ params: { target_currency: "Japanese Yen" }, value: stale, finalUrl: p.url(), rowLabel: null }).ok).toBe(false);
  });
});

describe("fail fast: an input that is not on the page ends the run unverified, with no model recovery", () => {
  it("flags only inputs a step must find on the page (not typed text), and row labels", () => {
    const text = "US Dollar Exchange Rates Table Euro 0.895817 British Pound 0.741203 Japanese Yen 157.869642";
    const scroll = { action: "scroll_to_text", text: "{{target_currency}}" };
    expect(missingInputs(scroll, { target_currency: "Klingon" }, text)).toEqual([{ param: "target_currency", value: "Klingon" }]);
    expect(missingInputs(scroll, { target_currency: "japanese  yen" }, text)).toEqual([]); // case and spacing do not matter
    expect(missingInputs({ action: "type", text: "{{target_currency}}" }, { target_currency: "Klingon" }, text)).toEqual([]);
    expect(missingInputs({ action: "navigate", to: "https://x.test/{{q}}" }, { q: "Klingon" }, text)).toEqual([]);
    expect(missingInputs({ action: "click", locator: { name: "{{q}}", text: "" } }, { q: "Oslo" }, "No results")).toEqual([{ param: "q", value: "Oslo" }]);
    expect(missingInputs({ action: "click", locator: { name: "Search", text: "" } }, { q: "Oslo" }, "No results")).toEqual([]); // drift, not a missing input
    expect(missingInputs({ kind: "row", label: "{{target_currency}}", offset: 0 }, { target_currency: "Klingon" }, text)).toHaveLength(1);
    expect(missingInputs({ kind: "row", label: "{{target_currency}}", offset: 0 }, { target_currency: "Euro" }, text)).toEqual([]);
    expect(describeMissing([{ param: "target_currency", value: "Klingon" }])).toBe('target_currency "Klingon"');
  });
});

describe.skipIf(!chromium)("fail fast in headless Chromium (x-rates)", () => {
  it("a scroll_to_text step for Klingon fails and the input is reported missing; Japanese Yen replays", async () => {
    if (!browser) return;
    const p = await newPage();
    await p.goto(SITE + "/table/?from=USD&amount=1");
    const step = { url: SITE + "/table/?from=USD&amount=1", action: "scroll_to_text", text: "{{target_currency}}", changes_url: false };
    expect(await runTraceStep(p, step, { target_currency: "Japanese Yen" }, ctx())).toMatchObject({ ok: true });
    const bad = await runTraceStep(p, step, { target_currency: "Klingon" }, ctx());
    expect(bad.ok).toBe(false);
    const text = await p.evaluate(() => document.body.innerText);
    expect(missingInputs(step, { target_currency: "Klingon" }, text)).toEqual([{ param: "target_currency", value: "Klingon" }]);
    // layout drift: the label IS on the page but the recorded element is gone -> not fail-fast (the model recovers)
    expect(missingInputs({ action: "click", locator: { name: "{{target_currency}}", text: "" } }, { target_currency: "Euro" }, text)).toEqual([]);
  }, 30000);
});

describe("infobox rows: label variants, dates, sections, honest misses", () => {
  it("reads the row the field names across real infobox layouts, and says when there is none", async () => {
    if (!browser) return;
    const p = await newPage();
    const recipe = { kind: "row", label: "{{f}}", offset: 1, sub: "City", regex: regexFor("9,600,000") };
    const read = async (path: string, f: string) => { await p.goto(SITE + path); const r = await p.evaluate(applyRecipeInPage, { recipe: fillRecipe(recipe, { f }), withLabel: true }); return r ? { value: pickValue(r.text, recipe), label: r.label } : null; };
    const probe = async (path: string, f: string) => { await p.goto(SITE + path); return p.evaluate(applyRecipeInPage, { recipe: { ...fillRecipe(recipe, { f }), probe: true } }); };
    expect(await read("/fact/Peak", "Elevation")).toEqual({ value: "8,848.86 m", label: "Elevation" });
    expect(await read("/fact/Peak", "elevation")).toMatchObject({ value: "8,848.86 m" });
    // a section header with plain rows: its first row, labeled as such (not the side figure "Prominence ... 1st")
    expect(await read("/fact/Peak", "Highest point")).toEqual({ value: "8,848.86 m", label: "Highest point › Elevation" });
    // no Elevation row in the fact box: no value (another table or the prose never stands in), and the probe says so
    expect(await read("/fact/Fuji", "Elevation")).toBeNull();
    expect(await probe("/fact/Fuji", "Elevation")).toEqual({ found: false, label: null });
    expect(await probe("/fact/Peak", "Elevation")).toEqual({ found: true, label: "Elevation" });
    // a text field
    expect(await read("/fact/Fuji", "Country")).toEqual({ value: "Japan", label: "Country" });
    // the hero: the city row under "Population (Q1 2026)", the metro row only when asked
    expect(await read("/fact/Metro", "Population")).toEqual({ value: "9,579,449", label: "Population (Q1 2026) › Special metropolitan city" });
    expect(await read("/fact/Metro", "Metro population")).toEqual({ value: "26,037,000", label: "Population (Q1 2026) › Metro" });
    expect(await read("/fact/Metro", "Population (Q1 2026)")).toMatchObject({ value: "9,579,449" });
    // exact "Elevation" beats "Highest elevation"; "Highest elevation (Bukhansan)" when asked; a header with figures beats a text row
    expect(await read("/fact/Metro", "Elevation")).toEqual({ value: "38 m", label: "Elevation" });
    expect(await read("/fact/Metro", "Highest elevation")).toEqual({ value: "836.5 m", label: "Highest elevation (Bukhansan)" });
    expect(await read("/fact/Metro", "Area")).toEqual({ value: "605.21 km2", label: "Area › Special metropolitan city" });
    // "Population (Jan 2026[4])" with its own value beats a text row labeled "Population"; "Elevation" finds "Highest elevation[5]"
    expect(await read("/fact/Town", "Population")).toEqual({ value: "2,047,602", label: "Population (Jan 2026)" });
    expect(await read("/fact/Town", "Elevation")).toEqual({ value: "2,017 m", label: "Highest elevation" });
    expect(await read("/fact/Tower", "Height")).toEqual({ value: "300 m", label: "Height › Architectural" });
    // dates are read whole; a trailing colon on the label is ignored; a unit is a whole unit
    expect(await read("/fact/Tower", "Opened")).toEqual({ value: "30 June 1894", label: "Opened:" });
    expect(await read("/fact/Person", "Born")).toMatchObject({ value: "7 November 1867" });
    expect(await read("/fact/Person", "Founded")).toMatchObject({ value: "April 1, 1976" });
    expect(await read("/fact/Person", "Nationality")).toMatchObject({ value: "Polish" });
    expect(await read("/fact/Person", "Discharge")).toEqual({ value: "2,757", label: "Discharge › average" });
  }, 30000);
  it("checks the final page with an input that names the value's row", () => {
    const final = { url: "https://w.test/wiki/{{q}}", viewport: ["q", "f"], page: [], title: ["q"] };
    const texts = { viewport: "Seoul Population Metro 26,037,000", page: "", title: "Seoul - Wikipedia" };
    expect(checkFinal(final, texts, { q: "Seoul", f: "Metro population" }, "https://w.test/wiki/Seoul").ok).toBe(false);
    expect(checkFinal(final, texts, { q: "Seoul", f: "Metro population" }, "https://w.test/wiki/Seoul", { rowBound: ["f"], rowLabel: "Population › Metro" })).toMatchObject({ ok: true });
    // a trace published while the page was still streaming in lost the input from its final checks: the row still counts
    const thin = { url: "https://x.test/table/", viewport: [], page: [], title: [] };
    expect(checkFinal(thin, { viewport: "", page: "", title: "" }, { c: "Indian Rupee" }, "https://x.test/table/").ok).toBe(false);
    expect(checkFinal(thin, { viewport: "", page: "", title: "" }, { c: "Indian Rupee" }, "https://x.test/table/", { rowBound: ["c"], rowLabel: "Indian Rupee" })).toMatchObject({ ok: true });
  });
});

describe.skipIf(!chromium)("record recipes: a results-table row the input names (license search, sanctions list) and keyed record pages", () => {
  const results = (rows: string[][]) => `<table><tr><td><h2>Search results</h2><table id="r"><tr><th>License Type</th><th>Name</th><th>License Number</th><th>Status/Expires</th></tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table></td></tr></table>`;
  it("learns the row by its input cell and reads the same column for another input; no row means a fail-fast miss", async () => {
    if (!browser) return;
    const p = await newPage();
    await p.setContent(results([["Certified Building Contractor", "CALDEVILLA, MARK", "CBC1263400 Cert Building", "Current, Active 08/31/2028"], ["Certified Electrical", "ARCTIC AIR", "EC13008544 Cert Electrical", "Null and Void, 08/31/2020"]]));
    const derived = await p.evaluate(deriveRecipeInPage, { candidates: ["Current, Active 08/31/2028"], labels: ["CBC1263400"] });
    const recipe = storeRecipe(derived, { license_number: "CBC1263400" });
    expect(recipe).toMatchObject({ kind: "record", key: "{{license_number}}", col: 3 });
    for (const [lic, want, label] of [["CBC1263400", "Current, Active 08/31/2028", "CBC1263400 Cert Building"], ["EC13008544", "Null and Void, 08/31/2020", "EC13008544 Cert Electrical"]]) {
      const got = await p.evaluate(applyRecipeInPage, { recipe: fillRecipe(recipe, { license_number: lic }), withLabel: true });
      expect(got).toEqual({ text: want, label });
      expect(execBinding({ params: { license_number: lic }, value: want, finalUrl: "https://example.test/wl11.asp?mode=2", rowLabel: got.label }).ok).toBe(true);
    }
    expect(await p.evaluate(applyRecipeInPage, { recipe: fillRecipe(recipe, { license_number: "CGC9999999" }) })).toBeNull();
    expect(missingInputs(recipe, { license_number: "CGC9999999" }, "Search results CBC1263400")).toEqual([{ param: "license_number", value: "CGC9999999" }]);
    // a listed name matches its row by whole words ("AEROCARIBBEAN" in "AEROCARIBBEAN AIRLINES"), never a layout cell around the table
    await p.setContent(`<table><tr><td>AEROCARIBBEAN search page<table><tr><th>Name</th><th>Type</th><th>Program(s)</th></tr><tr><td>AEROCARIBBEAN AIRLINES</td><td>Entity</td><td>CUBA</td></tr></table></td></tr></table>`);
    const o = storeRecipe(await p.evaluate(deriveRecipeInPage, { candidates: ["CUBA"], labels: ["AEROCARIBBEAN"] }), { name: "AEROCARIBBEAN" });
    expect(o).toMatchObject({ kind: "record", key: "{{name}}", col: 2 });
    expect(await p.evaluate(applyRecipeInPage, { recipe: fillRecipe(o, { name: "aerocaribbean" }), withLabel: true })).toEqual({ text: "CUBA", label: "AEROCARIBBEAN AIRLINES" });
  });
  it("a labeled row on a record page is tied to the input shown as a whole cell of the same table", async () => {
    if (!browser) return;
    const p = await newPage();
    const page = (dot: string, st: string) => `<table><tr><th>USDOT Number:</th><td>${dot}</td></tr><tr><th>Operating Authority Status:</th><td>${st}</td></tr></table>`;
    await p.setContent(page("53467", "AUTHORIZED FOR Property"));
    const r = storeRecipe(await p.evaluate(deriveRecipeInPage, { candidates: ["AUTHORIZED FOR Property"], labels: ["53467"] }), { usdot_number: "53467" });
    expect(r).toMatchObject({ kind: "row", label: "Operating Authority Status:", key: "{{usdot_number}}" });
    await p.setContent(page("264184", "NOT AUTHORIZED"));
    const got = await p.evaluate(applyRecipeInPage, { recipe: fillRecipe(r, { usdot_number: "264184" }), withLabel: true });
    expect(got.text).toBe("NOT AUTHORIZED");
    expect(execBinding({ params: { usdot_number: "264184" }, value: got.text, finalUrl: "https://example.test/query.asp", rowLabel: got.label }).ok).toBe(true);
    // another record's page: the key is not there, so nothing is returned
    expect(await p.evaluate(applyRecipeInPage, { recipe: fillRecipe(r, { usdot_number: "999" }) })).toBeNull();
  });
});

describe.skipIf(!chromium)("click then type: a click that lands on a dropdown moves to the nearest text field", () => {
  it("retargets a click on a <select> 25 px above a text box, leaves a direct hit alone", async () => {
    if (!browser) return;
    const p = await browser.newPage({ viewport: { width: 960, height: 600 } });
    await p.setContent(`<div style="position:absolute;left:300px;top:100px"><select id="t" style="width:200px;height:19px;display:block"><option>All</option><option>Entity</option></select><input id="n" style="width:200px;height:21px;margin-top:6px;display:block"></div>`);
    const sel = await p.evaluate(() => { const r = document.querySelector("#t")!.getBoundingClientRect(); return { x: r.left + 50, y: r.top + 9 }; });
    const t = await p.evaluate(textTargetInPage, { ...sel, r: 40, sel: TEXT_FIELD });
    expect(t).toMatchObject({ from: "select" });
    expect(await p.evaluate(({ x, y }) => (document.elementFromPoint(x, y) as HTMLElement).id, t!)).toBe("n");
    const on = await p.evaluate(() => { const r = document.querySelector("#n")!.getBoundingClientRect(); return { x: r.left + 5, y: r.top + 5 }; });
    expect(await p.evaluate(textTargetInPage, { ...on, r: 40, sel: TEXT_FIELD })).toBeNull();
    await p.close();
  });
});

describe("verified negative: a declared empty-result signal tied to the input", async () => {
  const { noMatchCheck, textFieldValuesInPage } = await import("../src/trace.mjs");
  const SIG = "Your search has not returned any results";
  const OFAC = "Lookup Results: 0 Found\nName\tAddress\tType\tProgram(s)\tList\tScore\n\nYour search has not returned any results.\n";
  it("OFAC: the wording plus the name echoed in the search field is a verified no hit", () => {
    expect(noMatchCheck({ signal: SIG, params: { name: "TOYOTA MOTOR CORPORATION" }, pageText: OFAC, url: "https://sanctionssearch.ofac.treas.gov/", fields: ["TOYOTA MOTOR CORPORATION", "100"], request: null })).toMatchObject({ ok: true, by: { name: "field" } });
  });
  it("Florida: the wording plus the license number in the POST that loaded the page", () => {
    const fl = "LICENSEE SEARCH OPTIONS\nThere were no records found matching the search criteria. If you suspect unlicensed activity";
    expect(noMatchCheck({ signal: "There were no records found matching the search criteria", params: { license_number: "CBC0000001" }, pageText: fl, url: "https://www.myfloridalicense.com/wl11.asp?mode=2&search=LicNbr", fields: [], request: { url: "https://www.myfloridalicense.com/wl11.asp?mode=2&search=LicNbr", post: "hSID=&hSearchType=LicNbr&LicNbr=CBC0000001&Search1=Search" } })).toMatchObject({ ok: true, by: { license_number: "query" } });
  });
  it("is not a no hit without the wording, or when the page is not tied to the input (a stale or different query)", () => {
    expect(noMatchCheck({ signal: SIG, params: { name: "TOYOTA" }, pageText: "Lookup Results: 1 Found\nTOYOTA", url: "https://x.test/", fields: ["TOYOTA"], request: null }).ok).toBe(false);
    expect(noMatchCheck({ signal: SIG, params: { name: "TOYOTA MOTOR CORPORATION" }, pageText: OFAC, url: "https://x.test/", fields: ["SOMEONE ELSE"], request: { url: "https://x.test/", post: "q=SOMEONE+ELSE" } })).toMatchObject({ ok: false });
    expect(noMatchCheck({ signal: "", params: { name: "X Y" }, pageText: OFAC, url: "", fields: [], request: null }).ok).toBe(false);
  });
  it.skipIf(!chromium)("reads visible text-field values (a postback keeps the query in its box)", async () => {
    if (!browser) return;
    const p = await browser.newPage();
    await p.setContent(`<form><input id="n" value="TOYOTA MOTOR CORPORATION"><input type="hidden" value="secret"><input value=""></form>`);
    expect(await p.evaluate(textFieldValuesInPage)).toEqual(["TOYOTA MOTOR CORPORATION"]);
    await p.close();
  });
});
