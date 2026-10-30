// Agentboard Skills executor (separate Render free web service, Docker).
// One replay at a time: headless Chromium (lean flags, 960x600 JPEG) driven by Muse Spark's built-in
// computer tool, called through agentboard-api's guarded /internal/muse/responses (daily cap, USD ceiling,
// output caps). Frames, actions and approval requests stream to the web UI over a WebSocket; committing
// actions (submit, buy, send, delete) always wait for a human. Runs started through the API (MCP run_skill)
// arrive as jobs on POST /jobs: progress goes back to the API, and approvals wait for a human on the
// job page (operator token), never for the agent that asked. Spark verifies the final screenshot, and the run
// (final screenshot, GIF, action log) is posted back to the API, which signs it into the log.
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { chromium } from "playwright-core";
import { approvalFor, inspectInPage, taskText, describeAction, playwrightKey, fill, nameOf, LOOP_INSTRUCTIONS, VERIFY_SCHEMA, STEP_TOOL, FIND_TOOL } from "./policy.mjs";
import { makeGif } from "./gif.mjs";
import { scrollPlan } from "./scroll.mjs";
import { TRACE_VERSION, MAX_TRACE_STEPS, templ, fillUrl, fillText, describeInPage, pageTextInPage, finalChecks, checkFinal, traceStep, locate, describeTraceStep, usableTrace, runTraceStep, deriveRecipeInPage, applyRecipeInPage, answerCandidates, pickValue, storeRecipe, fillRecipe, cleanSteps, valueBinding, missingInputs, describeMissing } from "./trace.mjs";
import { probeInPage, scrollToTextInPage, snapPoint, INTERACTIVE, SNAP_RADIUS, addressBarUrl, isAddressBarKey } from "./click.mjs";

const PORT = Number(process.env.PORT || 10000);
const API = (process.env.AGENTBOARD_API || "https://agentboard-api.onrender.com").replace(/\/$/, "");
const SECRET = process.env.SKILLS_INTERNAL_SECRET || "";
const MAX_TURNS = Math.min(Number(process.env.MAX_TURNS || 15), 15);
const APPROVAL_WAIT_MS = 10 * 60_000;
const W = 960, H = 600;
const CHROMIUM_ARGS = ["--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu", "--disable-extensions", "--disable-background-networking", "--mute-audio", "--js-flags=--max-old-space-size=128", "--renderer-process-limit=1"];
const SELECT_TOOL = { type: "function", name: "select_option", description: "Choose an option in the native dropdown (<select>) that was just clicked or is focused. Use the visible option text.", parameters: { type: "object", properties: { option: { type: "string" } }, required: ["option"], additionalProperties: false } };

const stats = { started_at: new Date().toISOString(), runs: 0, succeeded: 0, failed: 0, busy: false, last: null };

async function api(path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-skills-secret": SECRET, ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.message || `API ${res.status}`), { status: res.status, code: j.error });
  return j;
}

const sameSecret = (h) => typeof h === "string" && SECRET.length > 0 && h.length === SECRET.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(SECRET));
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/jobs") {
    if (!sameSecret(req.headers["x-skills-secret"])) { res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" })); return; }
    let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 10_000) req.destroy(); });
    req.on("end", () => {
      let b; try { b = JSON.parse(raw); } catch { b = null; }
      if (!b?.job_id) { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "job_id required" })); return; }
      if (stats.busy) { res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: "busy", message: "another replay is running" })); return; }
      stats.busy = true;
      res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ accepted: b.job_id }));
      runJob(String(b.job_id)).finally(() => { stats.busy = false; });
    });
    return;
  }
  if (req.url === "/healthz" || req.url === "/") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ ok: true, service: "agentboard-executor", api: API, configured: Boolean(SECRET), max_turns: MAX_TURNS, viewport: `${W}x${H}`, rss_mb: Math.round(process.memoryUsage().rss / 1048576), ...stats }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, path: "/run", maxPayload: 64 * 1024 });
wss.on("connection", (ws) => {
  const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const pending = new Map();
  let started = false, aborted = false;
  ws.on("close", () => { aborted = true; for (const r of pending.values()) r(false); });
  ws.on("message", async (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === "approval" && pending.has(m.id)) { pending.get(m.id)(Boolean(m.approve)); pending.delete(m.id); return; }
    if (m.type !== "start" || started) return;
    started = true;
    if (stats.busy) { send({ type: "error", error: "busy", message: "Another replay is running (one session at a time). Try again in a minute." }); ws.close(); return; }
    stats.busy = true;
    try {
      await api("/internal/skills/authorize", { token: String(m.token || "") });
      const ask = (req) => new Promise((resolve) => {
        const id = Math.random().toString(36).slice(2);
        pending.set(id, resolve);
        send({ type: "approval_request", id, ...req });
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(false); } }, 120_000);
      });
      const result = await replay(m, send, ask, () => aborted);
      send({ type: "done", result });
    } catch (e) {
      send({ type: "error", error: e.code || "error", message: e.message });
    } finally {
      stats.busy = false;
      ws.close();
    }
  });
});

/** A run requested through the API (MCP run_skill). Progress and approvals go through the job record. */
async function runJob(id) {
  let chain = Promise.resolve();
  const post = (ev) => { chain = chain.then(() => api(`/internal/skills/jobs/${id}/events`, ev).catch((e) => console.error(`[job ${id}] event`, e.message))); return chain; };
  let lastFrameAt = 0;
  const send = (m) => {
    if (m.type === "frame") { if (Date.now() - lastFrameAt > 1200 || m.label === "final") { lastFrameAt = Date.now(); post({ frame_b64: m.jpeg }); } }
    else if (m.type === "status") post({ message: m.message });
    else if (m.type === "turn") post({ turn: { turn: m.turn, say: m.say, actions: m.actions, fn: m.fn, ms: m.ms, usd: m.usage?.usd ?? 0, model: m.model, capability: m.capability } });
    else if (m.type === "verdict") post({ verdict: { success: m.success, evidence: m.evidence, model: m.model, capability: m.capability } });
    else if (m.type === "healing") post({ message: m.message });
  };
  const ask = async (req) => {
    const aid = crypto.randomUUID();
    await post({ status: "pending_approval", approval: { id: aid, turn: req.turn, reason: req.reason, flags: req.flags, action: req.action, element: req.element }, frame_b64: req.screenshot });
    const until = Date.now() + APPROVAL_WAIT_MS;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2000));
      const j = await api(`/internal/skills/jobs/${id}`).catch(() => null);
      if (j?.decision?.id === aid) { await post({ status: "running", approval: null, message: j.decision.approve ? "Approved by a human, continuing" : "Declined by a human" }); return Boolean(j.decision.approve); }
      if (j?.status === "cancelled") break;
    }
    throw Object.assign(new Error(`No human approved "${req.reason}" within ${APPROVAL_WAIT_MS / 60000} minutes`), { code: "expired" });
  };
  try {
    const job = await api(`/internal/skills/jobs/${id}`);
    await post({ status: "running", message: "Executor picked up the run" });
    const result = await replay({ skill_cid: job.skill_cid, start_url: job.start_url, params: job.params, job_id: id }, send, ask, () => false);
    await post({ status: "completed", result });
  } catch (e) {
    await post({ status: e.code === "declined" ? "declined" : e.code === "expired" ? "expired" : "failed", message: `${e.code || "error"}: ${e.message}`.slice(0, 500) });
  }
  await chain;
}

/** An input that names the value's row stays a final check even when the page text missed it (a page still streaming in):
 *  a published trace whose final checks lost the input would fail every later replay ("showed none of the parameter values"). */
const keepRowInputs = (f, rowBound) => { for (const k of rowBound ?? []) if (![...f.viewport, ...f.page].includes(k)) f.viewport.push(k); return f; };
/** The extraction recipe is a row named by an input ("{{target_field}}"); the scroll step names the same input. */
const inputsIn = (t) => [...String(t ?? "").matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((x) => x[1]);
const rowNamesInputs = (rc) => Boolean(rc && rc.kind === "row" && inputsIn(rc.label).length);
const rowNamesInputsOf = (step, rc) => rowNamesInputs(rc) && inputsIn(step.text).length > 0 && inputsIn(step.text).every((k) => inputsIn(rc.label).includes(k));

async function loadTarget(m) {
  if (m.draft_id) { const d = await api(`/v1/skills/drafts/${encodeURIComponent(m.draft_id)}`); return { skill: d.skill, start_url: m.start_url || d.source.start_url || d.skill.start_url_hint, target: { draft_id: d.id } }; }
  if (m.skill_cid) { const s = await api(`/v1/skills/${encodeURIComponent(m.skill_cid)}`); const b = s.skill.record.body; return { skill: b.skill, start_url: m.start_url || b.source.start_url, target: { skill_cid: m.skill_cid }, trace: m.no_trace ? null : s.trace ?? null }; }
  throw Object.assign(new Error("send draft_id or skill_cid"), { code: "target" });
}

async function replay(m, send, ask, isAborted) {
  const t0 = Date.now();
  const { skill, start_url: startTpl, target, trace } = await loadTarget(m);
  const params = Object.fromEntries(skill.params.map((p) => [p.name, String(m.params?.[p.name] ?? p.example)]));
  // a start URL may name params ("https://pypi.org/project/{{package}}/"): filled (URL-encoded) per run; the template is what gets published
  const start_url = fillUrl(startTpl, params);
  if (!/^https?:\/\//.test(start_url || "")) throw Object.assign(new Error("the skill needs an http(s) start URL"), { code: "start_url" });
  const usage = { calls: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0, usd: 0 };
  // Names the API job on each Muse call, so the API can count public replays in their reserved daily bucket.
  const jobHeader = m.job_id ? { "x-skills-job": String(m.job_id) } : {};
  const addUsage = (u) => { usage.calls++; for (const k of ["input_tokens", "cached_tokens", "output_tokens", "usd"]) usage[k] += u[k] || 0; send({ type: "usage", usage }); };
  const actions = [], history = [], gifFrames = [], stepChanges = [];
  let humanMs = 0;
  const origin = new URL(start_url).origin;
  stats.runs++;
  // a fresh Chromium per run: the executor runs it with --single-process (memory), where closing a context ends the
  // browser, so a warm browser cannot be shared between runs
  send({ type: "status", message: `Launching Chromium for "${skill.name}"`, params, start_url });
  const tLaunch = Date.now();
  const browser = await chromium.launch({ args: CHROMIUM_ARGS });
  const launchMs = Date.now() - tLaunch;
  let context = null;
  try {
    context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    // Stay on the skill's site: top-level navigations to another origin are blocked.
    // a deterministic replay needs the DOM, not the pictures: images, media and web fonts are skipped (the executor's
    // CPU is small; decoding them was most of a trace step). The model loop (and a recovery) gets the full page.
    const lean = { on: usableTrace(trace) };
    await page.route("**/*", (route) => {
      const r = route.request();
      if (lean.on && ["image", "media", "font"].includes(r.resourceType())) return route.abort("blockedbyclient");
      if (r.isNavigationRequest() && r.frame() === page.mainFrame() && new URL(r.url()).origin !== origin) { actions.push({ turn: -1, type: "blocked", detail: `navigation to ${new URL(r.url()).origin} blocked (off-site)`, approval: "none", checks: [] }); return route.abort("blockedbyclient"); }
      return route.continue();
    });
    // a known trace only needs the DOM (each step waits for its own element); the model needs the page fully painted
    const startResp = await page.goto(start_url, { waitUntil: usableTrace(trace) ? "domcontentloaded" : "load", timeout: 45_000 });
    actions.push({ turn: 0, type: "navigate", detail: start_url.slice(0, 300), approval: "auto", checks: [] });
    // fail fast (no model calls) when this run's inputs are not on the site: a start URL built from an input that does
    // not exist (HTTP 4xx), or a trace step / extraction row that must find an input that is nowhere on the page
    let failFast = null;
    const pageText = async () => (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")) || "";
    if (/\{\{\s*[a-z0-9_]+\s*\}\}/i.test(startTpl) && startResp && startResp.status() >= 400 && startResp.status() < 500) failFast = `there is no page for these inputs (HTTP ${startResp.status()} at ${start_url.slice(0, 200)})`;
    let lastSelect = null, finalMessage = "", turn = 0, addressBar = false;
    const shoot = async (label) => {
      const jpg = await page.screenshot({ type: "jpeg", quality: 70 });
      send({ type: "frame", turn, label, jpeg: jpg.toString("base64") });
      return jpg;
    };
    // ---- trace capture: every executed action becomes a step of this run's trace (kept only if the run verifies)
    const recorded = [];
    const closePrev = () => { const prev = recorded[recorded.length - 1]; if (prev && prev.changes_url === undefined) prev.changes_url = page.url() !== prev._before; };
    const rec = (step) => { if (!step || recorded.length >= MAX_TRACE_STEPS) return; closePrev(); step._before = page.url(); recorded.push(step); };
    const describeAt = (a, focused) => page.evaluate(describeInPage, { x: a.x ?? 0, y: a.y ?? 0, focused, sel: INTERACTIVE }).catch(() => null);
    const selectOption = (o) => page.evaluate((o) => {
      const el = document.activeElement?.tagName === "SELECT" ? document.activeElement : window.__abLastSelect;
      if (!el) return null;
      const match = [...el.options].find((x) => x.text.trim().toLowerCase() === o.trim().toLowerCase()) ?? [...el.options].find((x) => x.text.toLowerCase().includes(o.trim().toLowerCase()));
      if (!match) return null;
      el.value = match.value; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
      return match.text;
    }, o);

    // ---- deterministic replay: run the stored trace with no model calls; fall back to the model from the first failing step
    const replayInfo = { mode: "model", trace_source: trace?.source ?? null, trace_steps: 0, trace_steps_done: 0, failed_step: null, failed_reason: null, verifier: "model" };
    if (usableTrace(trace) || failFast) { replayInfo.mode = "trace"; replayInfo.trace_steps = trace?.steps?.length ?? 0; }
    if (usableTrace(trace) && !failFast) {
      send({ type: "status", message: `Replaying the recorded trace (${trace.steps.length} steps, no model calls)` });
      const tTrace = Date.now(), stepMs = [];
      for (let i = 0; i < trace.steps.length; i++) {
        const s = trace.steps[i], tStep = Date.now();
        if (isAborted()) throw Object.assign(new Error("viewer disconnected"), { code: "aborted" });
        const r = await runTraceStep(page, s, params, { origin, skill, ask, send, actions, history, index: i, W, H, selectOption, inspect, execute, onHuman: (ms) => { humanMs += ms; } });
        // a scroll_to_text only positions the page (locators scroll their element into view, values are read from the
        // DOM): text it cannot scroll to is not a failure when the extraction row it points at is named by the same input
        // ("Metro population" is the "Metro" sub-row of "Population"); the row lookup decides, with no model call
        if (!r.ok && s.action === "scroll_to_text" && (!missingInputs(s, params, await pageText()).length || rowNamesInputsOf(s, trace.extract))) {
          send({ type: "status", message: `Trace step ${i + 1}: no text "${fillText(s.text, params).slice(0, 60)}" to scroll to; the value is read from its row` });
          replayInfo.trace_steps_done = i + 1; stepMs.push(Date.now() - tStep);
          continue;
        }
        if (!r.ok) {
          replayInfo.failed_step = i + 1; replayInfo.failed_reason = r.reason.slice(0, 300);
          const missing = missingInputs(s, params, await pageText());
          if (missing.length) { failFast = `${describeMissing(missing)} is not on the page (trace step ${i + 1})`; break; }
          lean.on = false; replayInfo.mode = "trace+recovery"; break;
        }
        rec({ ...structuredClone(s), changes_url: undefined });
        recorded[recorded.length - 1]._before = r.before; recorded[recorded.length - 1].changes_url = r.changed;
        replayInfo.trace_steps_done = i + 1; stepMs.push(Date.now() - tStep);
        // no mid-trace screenshots: the run's evidence is the final screenshot (and the signed action log)
      }
      send({ type: "status", message: `Trace replayed in ${Date.now() - tTrace} ms (${stepMs.length ? `steps ${stepMs.join(", ")} ms; ` : ""}page open ${tTrace - t0} ms after the run started, Chromium launch ${launchMs} ms)` });
      if (replayInfo.mode === "trace+recovery") {
        history.push(`Recorded trace: steps 1-${replayInfo.trace_steps_done} were done without the model; step ${replayInfo.failed_step} (${describeTraceStep(trace.steps[replayInfo.failed_step - 1])}) failed: ${replayInfo.failed_reason}. Continue the task from the current screen.`);
        send({ type: "status", message: `Trace step ${replayInfo.failed_step} failed (${replayInfo.failed_reason.slice(0, 120)}); recovering with the model` });
      }
    }
    for (turn = 1; replayInfo.mode !== "trace" && turn <= MAX_TURNS; turn++) {
      if (isAborted()) throw Object.assign(new Error("viewer disconnected"), { code: "aborted" });
      const jpg = await shoot("before");
      if (gifFrames.length < 16) gifFrames.push(await page.screenshot({ type: "png" }));
      const note = lastSelect ? `\nThe dropdown you clicked is a native <select> currently set to "${lastSelect.value}" with options: ${lastSelect.options.join(", ")}. Use select_option.` : "";
      const input = [{ role: "user", content: [
        { type: "input_text", text: `${taskText(skill, params)}\n\nDone so far:\n${history.slice(-12).join("\n") || "(nothing yet)"}${note}\n\nCurrent screenshot (turn ${turn} of ${MAX_TURNS}):` },
        { type: "input_image", image_url: `data:image/jpeg;base64,${jpg.toString("base64")}` },
      ] }];
      const r = await api("/internal/muse/responses", { instructions: LOOP_INSTRUCTIONS, tools: [{ type: "computer" }, SELECT_TOOL, STEP_TOOL, FIND_TOOL], reasoning: { effort: "minimal" }, max_output_tokens: 800, input }, { "x-muse-kind": "loop", ...jobHeader });
      addUsage(r.usage);
      const out = r.response.output ?? [];
      const say = out.filter((o) => o.type === "message").flatMap((o) => o.content ?? []).map((c) => c.text ?? "").join(" ").trim();
      const call = out.find((o) => o.type === "computer_call");
      const fns = out.filter((o) => o.type === "function_call");
      const fn = fns.find((o) => o.name === "select_option");
      for (const f of fns.filter((o) => o.name === "report_step_change")) {
        let a = {}; try { a = JSON.parse(f.arguments || "{}"); } catch {}
        const step = Number(a.step), observed = String(a.observed ?? "").slice(0, 300);
        if (step >= 1 && step <= skill.steps.length && observed && !stepChanges.some((c) => c.step === step)) {
          stepChanges.push({ step, observed, turn });
          history.push(`turn ${turn}: noted that step ${step} changed: ${observed.slice(0, 120)}`);
          send({ type: "status", message: `Spark noticed step ${step} changed: ${observed.slice(0, 120)}` });
        }
      }
      send({ type: "turn", turn, model: r.model, capability: "computer use (built-in computer tool) + image understanding", say, actions: call?.actions ?? [], fn: fns.length ? { name: fns.map((f) => f.name).join("+"), arguments: fns.map((f) => f.arguments).join(" ") } : null, ms: r.ms, usage: r.usage });
      if (!call && !fns.length) { finalMessage = say; history.push(`turn ${turn}: finished: ${say.slice(0, 200)}`); break; }
      if (say) history.push(`turn ${turn}: ${say.slice(0, 160)}`);
      lastSelect = null;
      if (fn) {
        let opt = ""; try { opt = JSON.parse(fn.arguments || "{}").option ?? ""; } catch {}
        const done = await selectOption(opt);
        if (done) rec(traceStep({ type: "select_option" }, { url: page.url(), params, option: done }));
        const selName = await page.evaluate(() => { const el = document.activeElement?.tagName === "SELECT" ? document.activeElement : window.__abLastSelect; if (!el) return ""; const l = el.labels?.[0] ?? el.closest("label"); return (l?.innerText ?? el.getAttribute("aria-label") ?? "").split("\n")[0].trim().slice(0, 80); }).catch(() => "");
        actions.push({ turn, type: "select_option", detail: done ? `selected "${done}"` : `no option "${opt.slice(0, 60)}"`, approval: "auto", checks: [], target: selName || undefined });
        history.push(`turn ${turn}: select_option "${opt}" -> ${done ? "ok" : "not found"}`);
      }
      for (const f of fns.filter((o) => o.name === "scroll_to_text")) {
        let q = ""; try { q = String(JSON.parse(f.arguments || "{}").text ?? ""); } catch {}
        const r = await page.evaluate(scrollToTextInPage, { text: q }).catch(() => ({ found: false }));
        if (r.found) rec(traceStep({ type: "scroll_to_text", text: q }, { url: page.url(), params }));
        actions.push({ turn, type: "scroll_to_text", detail: `scroll_to_text "${q.slice(0, 60)}" -> ${r.found ? `found on ${r.tag}` : "not found"}`, approval: "auto", checks: [] });
        history.push(`turn ${turn}: scroll_to_text "${q.slice(0, 60)}" -> ${r.found ? "scrolled into view" : "not found on this page"}`);
      }
      const checks = (call?.pending_safety_checks ?? []).map((c) => c.code);
      for (const a of call?.actions ?? []) {
        // Snap near-miss clicks onto the nearest link/button (see click.mjs) before the policy inspects the target.
        if ((a.type === "click" || a.type === "double_click") && Number.isFinite(a.x) && Number.isFinite(a.y)) {
          const snap = snapPoint(a.x, a.y, await page.evaluate(probeInPage, { x: a.x, y: a.y, r: SNAP_RADIUS, sel: INTERACTIVE }).catch(() => null));
          if (snap) { a.x = snap.x; a.y = snap.y; history.push(`turn ${turn}: click at (${snap.from.x},${snap.from.y}) was ${snap.px}px off a ${snap.tag}; clicked its center (${snap.x},${snap.y})`); }
        }
        // Headless Chromium has no address bar: Ctrl/Cmd+L then a same-site URL becomes a navigation.
        if (a.type === "keypress" && isAddressBarKey(a.keys)) { addressBar = true; actions.push({ turn, type: "keypress", detail: `keypress ${(a.keys ?? []).join("+")} (address bar)`, approval: "auto", checks: [] }); continue; }
        if (addressBar && a.type === "type") {
          addressBar = false;
          const url = addressBarUrl(a.text, origin);
          if (url) {
            rec(traceStep({ type: "navigate", url }, { url: page.url(), params }));
            actions.push({ turn, type: "navigate", detail: url.slice(0, 300), approval: "auto", checks: [] });
            history.push(`turn ${turn}: navigate ${url}`);
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((e) => history.push(`turn ${turn}: navigation failed: ${String(e.message).slice(0, 100)}`));
            continue;
          }
          history.push(`turn ${turn}: address bar: "${String(a.text).slice(0, 80)}" is not a URL on ${origin}; ignored`);
          continue;
        }
        if (a.type !== "type" && a.type !== "wait") addressBar = false;
        const el = await inspect(page, a);
        const p = approvalFor(a, el, skill, checks);
        const detail = `${describeAction(a)}${el ? ` on ${el.tag} "${(nameOf(el) || el.value || "").slice(0, 40)}"` : ""}`.slice(0, 300);
        const target = nameOf(el) || undefined;
        if (p.approval === "human") {
          send({ type: "status", message: `Waiting for approval: ${p.reason}` });
          const asked = Date.now();
          const ok = await ask({ turn, action: a, element: el, reason: p.reason, flags: p.flags, screenshot: (await page.screenshot({ type: "jpeg", quality: 70 })).toString("base64") });
          humanMs += Math.min(Date.now() - asked, 30_000);
          actions.push({ turn, type: a.type, detail, approval: ok ? "human" : "none", checks: checks.slice(0, 5), target, flags: p.flags });
          if (!ok) throw Object.assign(new Error(`Declined by a human: ${p.reason}`), { code: "declined" });
        } else actions.push({ turn, type: a.type, detail, approval: "auto", checks: checks.slice(0, 5), target });
        history.push(`turn ${turn}: ${describeAction(a)}${el ? ` on ${el.tag} "${(nameOf(el) || el.value || "").slice(0, 40)}"` : ""}`);
        if (a.type !== "wait" && a.type !== "move" && a.type !== "screenshot") rec(traceStep(a, { url: page.url(), params, loc: a.type === "click" || a.type === "double_click" ? await describeAt(a, false) : a.type === "type" ? await describeAt(a, true) : null }));
        await execute(page, a);
        if (el?.tag === "select") lastSelect = el;
        await page.waitForTimeout(250);
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    }
    // ---- verify: Spark reads the final screenshot against the success check
    const check = fill(skill.success_check, params);
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    closePrev();
    const tFinal = Date.now();
    // a replayed trace reads the final page as soon as its DOM is parsed; a page that streams its table in (x-rates with a
    // 0-step trace) may not show the row yet: wait (up to 5 s) until the recipe finds its value or the page has loaded
    if (replayInfo.mode === "trace" && !failFast && trace?.extract) {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        const got = await page.evaluate(applyRecipeInPage, { recipe: fillRecipe(trace.extract, params), scroll: false }).catch(() => null);
        if (got != null && pickValue(got, trace.extract) != null) break;
        if ((await page.evaluate(() => document.readyState).catch(() => "complete")) === "complete") break;
        await page.waitForTimeout(200);
      }
    }
    const texts = await page.evaluate(pageTextInPage).catch(() => ({ viewport: "", page: "", title: "" }));
    // ---- deterministic value return: read the answer off the page with the trace's extraction recipe
    const extractWith = async (recipe) => (recipe ? pickValue(await page.evaluate(applyRecipeInPage, { recipe: fillRecipe(recipe, params), scroll: false }).catch(() => null), recipe) : null);
    // an operator run with relearn: true learns the recipe again from the verifier's answer (the old one is the fallback)
    let recipe = m.relearn ? null : (trace?.extract ?? null), value = await extractWith(recipe);
    // a value must be tied to this run's inputs (see valueBinding): the final page is specific to each parameter, or the
    // value comes from the row whose label names it. A fixed recorded element on a shared page (the first row of a rates
    // table) is never returned for another input.
    const rowLabelOf = async (rc) => (rc?.kind === "row" ? ((await page.evaluate(applyRecipeInPage, { recipe: fillRecipe(rc, params), scroll: false, withLabel: true }).catch(() => null))?.label ?? fillText(rc.label, params)) : null);
    const bindingOf = async (rc, val) => valueBinding({ params, value: val, finalUrlTemplate: templ(page.url(), params), finalUrl: page.url(), rowLabel: await rowLabelOf(rc), titleParams: finalChecks(texts, params, page.url()).title });
    let unboundNote = null, rowBound = [];
    // a row named by an input ({{target_field}}): when this page has no such row, or its value is not tied to the inputs,
    // no model can return it either, so the run is not verified right away (0 calls) instead of asking the verifier
    const inputRow = replayInfo.mode === "trace" && rowNamesInputs(recipe);
    if (recipe && value != null) {
      const b = await bindingOf(recipe, value);
      if (!b.ok) { unboundNote = b.reason; send({ type: "status", message: `Not returning "${value}": ${b.reason}` }); if (inputRow && !failFast) failFast = `the "${fillText(recipe.label, params)}" value found is not tied to the inputs (${b.reason})`; recipe = null; value = null; }
      else rowBound = Object.entries(b.by).filter(([, how]) => how === "row").map(([k]) => k);
    }
    if (!failFast && !unboundNote && recipe && value == null && replayInfo.mode === "trace") {
      const missing = missingInputs(recipe, params, texts.page);
      if (missing.length) failFast = `${describeMissing(missing)} is not on the page (no "${fillText(recipe.label, params)}" row)`;
      else if (inputRow) {
        const probe = await page.evaluate(applyRecipeInPage, { recipe: { ...fillRecipe(recipe, params), probe: true }, scroll: false }).catch(() => null);
        failFast = probe?.found ? `the "${probe.label}" row has no value on this page` : `this page has no "${fillText(recipe.label, params)}" row`;
      }
    }
    if (!unboundNote && recipe && value == null) { send({ type: "status", message: `The extraction recipe found no value on this page (${recipe.kind}${recipe.label ? ` "${fillText(recipe.label, params)}"` : ""})` }); recipe = null; }
    // the final screenshot shows the extracted value (scrolled into view) for the record and any verifier call
    if (value != null) await page.evaluate(applyRecipeInPage, { recipe: fillRecipe(recipe, params), scroll: true }).catch(() => {});
    const finalJpg = await shoot("final");
    // a zero-model replay has no turns to animate: its evidence is the final screenshot (no GIF to encode)
    if (replayInfo.mode !== "trace") gifFrames.push(await page.screenshot({ type: "png" }));
    let det = null;
    if (failFast) {
      replayInfo.fail_fast = failFast.slice(0, 300);
      send({ type: "status", message: `Not verified: ${failFast}. No model recovery: the input is not on the site` });
    } else if (replayInfo.mode === "trace") {
      det = checkFinal(trace.final, texts, params, page.url(), { rowBound, rowLabel: rowBound.length ? await rowLabelOf(recipe) : null });
      if (det.ok && trace.extract && value == null) det = { ok: false, checks: det.checks, reason: unboundNote ? `the recorded value is not tied to the inputs (${unboundNote})` : "the value could not be extracted" };
      // no recipe yet: one verifier call quotes the value, and this run learns where it is on the page (next replays: 0 calls)
      // (an operator run with relearn: true retries learning on a trace marked no_value)
      if (det.ok && !trace.extract && (!trace.no_value || m.relearn)) det = { ok: false, checks: det.checks, reason: "no extraction recipe yet" };
      if (det.ok && value != null) det.checks.push(`returned value "${value}" read from ${trace.extract.kind === "row" ? `the "${fillText(trace.extract.label, params)}" row` : "the recorded element"}`);
      if (det.ok) replayInfo.verifier = "deterministic";
      else send({ type: "status", message: `Deterministic check inconclusive (${det.reason}); asking the verifier` });
    }
    const detVerdict = (o) => ({ model: "deterministic", usage: null, response: { output: [{ type: "message", content: [{ text: JSON.stringify(o) }] }] } });
    const v = failFast ? detVerdict({ success: false, evidence: `Not verified: ${failFast}. Final URL ${page.url().slice(0, 200)}.` })
      : det?.ok ? detVerdict({ success: true, evidence: `Deterministic checks of the recorded trace passed: ${det.checks.join("; ")}. Final URL ${page.url().slice(0, 200)}.` }) : await api("/internal/muse/responses", {
      reasoning: { effort: "minimal" }, max_output_tokens: 600,
      text: { format: { type: "json_schema", name: "verdict", strict: true, schema: VERIFY_SCHEMA } },
      input: [{ role: "user", content: [{ type: "input_text", text: `Success check: ${check}\nExpected parameters: ${JSON.stringify(params)}\nFinal page URL (the browser address bar, which the screenshot does not show): ${page.url().slice(0, 300)}\nDoes this final browser screenshot satisfy the success check? Only judge what is visible in the screenshot and that URL (an input carried only in the URL, such as an ID in the path, counts as shown). In evidence, quote the exact value the task asks for as it is shown; in value, give only that value (no label).` }, { type: "input_image", image_url: `data:image/jpeg;base64,${finalJpg.toString("base64")}` }] }],
    }, { "x-muse-kind": "verify", ...jobHeader });
    if (v.usage) addUsage(v.usage);
    let verdict = { success: false, evidence: "verifier returned no verdict" };
    try { verdict = JSON.parse((v.response.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []).map((c) => c.text ?? "").join("")); } catch {}
    const verdictFull = { success: Boolean(verdict.success), evidence: String(verdict.evidence ?? "").slice(0, 1500), model: v.model, capability: failFast ? "deterministic: the input is not on the site (no model call)" : det?.ok ? "deterministic: trace post-conditions and final-page checks (no model call)" : "image understanding + structured output" };
    // No recipe yet (a model run, or an old trace): find the answer the model or verifier quoted on the page and keep how to read it.
    if (verdictFull.success && value == null) {
      // the verifier's own value first (a version or number inside it before the whole text), then what the answers quote
      const vv = String(verdict.value ?? "").trim().slice(0, 200);
      const isInput = Object.values(params).some((x) => String(x).trim().toLowerCase() === vv.toLowerCase());
      const vvParts = vv && !isInput ? [...answerCandidates(vv, params).filter((x) => /\d/.test(x) && x !== vv), vv] : [];
      const derived = await page.evaluate(deriveRecipeInPage, { candidates: [...new Set([...vvParts, ...answerCandidates(`${finalMessage}\n${verdictFull.evidence}`, params)])].slice(0, 14), labels: Object.values(params).filter((x) => String(x).length >= 2) }).catch(() => null);
      const stored = storeRecipe(derived, params);
      const got = await extractWith(stored);
      if (stored && got != null) { const b = await bindingOf(stored, got); if (b.ok) { recipe = stored; value = got; } else { unboundNote = b.reason; send({ type: "status", message: `Not keeping the value "${got}": ${b.reason}` }); } }
    }
    if (value == null && m.relearn && trace?.extract) { const got = await extractWith(trace.extract); if (got != null && (await bindingOf(trace.extract, got)).ok) { recipe = trace.extract; value = got; } }
    const binding = await bindingOf(recipe, value);
    // no_value only when the model's answer quoted no value at all (else learning is retried on the next replay)
    const noValue = value == null && (verdictFull.model === "deterministic" ? Boolean(trace?.no_value) && !m.relearn : answerCandidates(`${finalMessage}\n${verdictFull.evidence}`, params).length === 0);
    // the label of the row the value was actually read from (not the recipe's sub-row hint)
    const matched = value != null && recipe.kind === "row" ? await page.evaluate(applyRecipeInPage, { recipe: fillRecipe(recipe, params), scroll: false, withLabel: true }).catch(() => null) : null;
    const rowLabel = (matched?.label || fillText(recipe?.label ?? "", params)).slice(0, 120);
    const answer = { value, method: value == null ? "none" : "deterministic", source: value == null ? null : recipe.kind === "row" ? `infobox/table row "${rowLabel}"` : `element ${String(recipe.css).slice(0, 100)}`, verified_by: verdictFull.model === "deterministic" ? "deterministic" : "verifier", model_text: finalMessage ? finalMessage.slice(0, 400) : null, binding: { ok: binding.ok, checked: binding.checked, by: binding.by, reason: binding.reason.slice(0, 300), ...(unboundNote ? { rejected: unboundNote.slice(0, 300) } : {}) } };
    // The trace of this run, kept only when it verified: it is what the next replay executes without the model.
    const steps = cleanSteps(recorded.map(({ _before, ...s }) => ({ ...s, changes_url: Boolean(s.changes_url) })));
    const runTrace = verdictFull.success && (steps.length || recipe) ? { v: TRACE_VERSION, start_url: templ(start_url, params), steps, final: keepRowInputs(finalChecks(texts, params, page.url()), [...rowBound, ...Object.entries(binding.by ?? {}).filter(([, how]) => how === "row").map(([k]) => k)]), ...(recipe ? { extract: recipe } : noValue ? { no_value: true } : {}) } : null;
    if (replayInfo.mode === "trace" && !failFast) send({ type: "status", message: `Final page read, value extracted and checked in ${Date.now() - tFinal} ms` });
    send({ type: "verdict", ...verdictFull, final_message: finalMessage, value });
    const gif = gifFrames.length ? makeGif(gifFrames) : null;
    const run = {
      ...target, ...(m.job_id ? { job_id: m.job_id } : {}), start_url: /\{\{\s*[a-z0-9_]+\s*\}\}/i.test(startTpl) ? startTpl : start_url, params, success: verdictFull.success, step_changes: stepChanges, human_ms: humanMs, verdict: verdictFull, turns: replayInfo.mode === "trace" ? 0 : Math.min(turn, MAX_TURNS), actions: actions.slice(0, 200), usage, model: replayInfo.mode === "trace" ? "none (recorded trace)" : v.model,
      ...(runTrace ? { trace: runTrace } : {}), ...(target.skill_cid ? { replay: replayInfo } : {}), answer,
      final_jpeg_b64: finalJpg.toString("base64"), ...(gif ? { gif_b64: gif.toString("base64") } : {}),
      executor: { name: "agentboard-executor", chromium: `headless-shell ${browser.version()}`, viewport: `${W}x${H}` }, duration_ms: Date.now() - t0,
    };
    if (verdictFull.success && target.skill_cid) send({ type: "status", message: "Verified. Checking whether the skill's steps still match the site…" });
    const published = await api("/internal/skills/runs", run);
    if (published.healed) send({ type: "healing", message: `Self-healed: published v${published.healed.version} with ${published.healed.changes.length} step change(s)`, healed: published.healed });
    else if (verdictFull.success && target.skill_cid) send({ type: "healing", message: published.drift?.stale_steps?.length || published.drift?.reported?.length ? "Verified, but the site drifted and the skill could not be healed automatically" : "Verified: the skill's steps still match the site" });
    verdictFull.success ? stats.succeeded++ : stats.failed++;
    stats.last = { at: new Date().toISOString(), success: verdictFull.success, turns: run.turns, usd: Math.round(usage.usd * 1e6) / 1e6 };
    return { ...published, verdict: verdictFull, turns: run.turns, usage, duration_ms: run.duration_ms, replay: run.replay ?? null, answer, value };
  } catch (e) {
    stats.failed++;
    throw e;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** What is under the pointer (or focused, for keys): used by the approval policy and the select_option helper. */
async function inspect(page, a) {
  return page.evaluate(inspectInPage, { a });
}

async function execute(page, a) {
  switch (a.type) {
    case "click": return page.mouse.click(a.x, a.y, { button: a.button === "right" ? "right" : a.button === "wheel" ? "middle" : "left" });
    case "double_click": return page.mouse.dblclick(a.x, a.y);
    case "type": return page.keyboard.type(String(a.text ?? ""), { delay: 8 });
    case "keypress": return page.keyboard.press(playwrightKey(a.keys));
    case "scroll": { const sp = scrollPlan(a, W, H); await page.mouse.move(sp.x, sp.y); return page.mouse.wheel(sp.dx, sp.dy); }
    case "move": return page.mouse.move(a.x, a.y);
    case "drag": { const [s, ...rest] = a.path ?? []; if (!s) return; await page.mouse.move(s.x, s.y); await page.mouse.down(); for (const p of rest) await page.mouse.move(p.x, p.y); return page.mouse.up(); }
    case "wait": return page.waitForTimeout(1000);
    default: return;
  }
}

server.listen(PORT, () => console.log(`[executor] listening on :${PORT}, api ${API}, configured ${Boolean(SECRET)}`));
