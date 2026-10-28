/**
 * agentboard-keepwarm: a free Cloudflare Worker (cron every 5 minutes) that keeps the two free Render services awake
 * and checks the live MCP end to end, so a judge's first try_skill is not a 20-60 s cold start or a silent failure.
 *
 * Each run:
 *   1. GET <API>/healthz and, inside EXECUTOR_WARM_WINDOWS, GET <EXECUTOR>/healthz (pings only; no secrets).
 *   2. MCP probe on <API>/mcp (stateless JSON-RPC): initialize, tools/list (try_skill must be listed), find_skill.
 *      Every PROBE_TRY_EVERY_MIN minutes also try_skill's first step for PROBE_SLUG: that answers with a challenge
 *      question (or a cached verified run when a cap is hit) and starts no replay, so it spends no Muse calls.
 *   3. Writes the status JSON to KV (key "status", plus a short "history") and serves it at GET /status.json.
 *
 * Render free tier: 750 instance-hours per workspace per month, so two services awake 24/7 (~1,490 h) would run out.
 * The API is pinged in API_WARM_WINDOWS and the executor only in EXECUTOR_WARM_WINDOWS (both in America/Los_Angeles
 * hours, "6-24" means 06:00-23:59; "*" means always; "" means never). Outside its window the executor still wakes on
 * demand: the API pings it as soon as try_skill hands out a challenge.
 */

const DEFAULTS = {
  API_URL: "https://agentboard-api.onrender.com",
  EXECUTOR_URL: "https://agentboard-executor.onrender.com",
  API_WARM_WINDOWS: "6-24",
  EXECUTOR_WARM_WINDOWS: "10-14",
  PROBE_SLUG: "hacker-news-top-story",
  PROBE_PARAMS: "{}",
  PROBE_TRY_EVERY_MIN: "30",
  TIMEOUT_MS: "70000",
};
const HISTORY = 48;

export function cfg(env = {}) {
  const c = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (typeof env[k] === "string") c[k] = env[k];
  return c;
}

/** Hour (0-23) and minute in America/Los_Angeles. */
export function laTime(ms) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(ms));
  return { hour: Number(p.find((x) => x.type === "hour").value) % 24, minute: Number(p.find((x) => x.type === "minute").value) };
}

/** "8-23,0-1" style windows of LA hours, end exclusive; "*" is always, "" is never. */
export function inWindows(spec, hour) {
  const s = String(spec ?? "").trim();
  if (s === "*") return true;
  if (!s) return false;
  return s.split(",").some((part) => {
    const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(part);
    if (!m) return Number(part) === hour;
    const a = Number(m[1]), b = Number(m[2]);
    return a <= b ? hour >= a && hour < b : hour >= a || hour < b;
  });
}

async function timed(fetchImpl, url, init, timeoutMs) {
  const t0 = Date.now();
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return { status: res.status, ms: Date.now() - t0, text };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, error: String(e && e.name ? `${e.name}: ${e.message}` : e) };
  }
}

async function ping(fetchImpl, base, timeoutMs) {
  const r = await timed(fetchImpl, `${base}/healthz`, { headers: { "user-agent": "agentboard-keepwarm" } }, timeoutMs);
  let body = null; try { body = JSON.parse(r.text ?? ""); } catch {}
  const out = { ok: r.status === 200, status: r.status, ms: r.ms, ...(r.error ? { error: r.error } : {}) };
  if (body?.muse_spend) {
    const m = body.muse_spend;
    out.muse = { calls_today: m.today?.calls, daily_call_cap: m.daily_call_cap, public_reserve_left_today: m.public_reserve_left_today, calls_left_today: m.calls_left_today, total_usd: m.total_usd, spend_cap_usd: m.spend_cap_usd };
  }
  return out;
}

async function rpc(fetchImpl, base, id, method, params, timeoutMs) {
  const r = await timed(fetchImpl, `${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "agentboard-keepwarm" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }, timeoutMs);
  let msg = null;
  if (r.text) {
    try { msg = JSON.parse(r.text); } catch {
      const line = r.text.split("\n").find((l) => l.startsWith("data:")); // SSE framing
      if (line) try { msg = JSON.parse(line.slice(5)); } catch {}
    }
  }
  return { ...r, msg };
}

const toolText = (msg) => (msg?.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

/** initialize, tools/list, find_skill and (optionally) the first, free step of try_skill. */
export async function probeMcp(fetchImpl, c, withTry) {
  const t = Number(c.TIMEOUT_MS);
  const steps = [];
  const step = (name, r, ok, extra = {}) => { steps.push({ name, ok, status: r.status, ms: r.ms, ...(r.error ? { error: r.error } : {}), ...extra }); return ok; };
  const init = await rpc(fetchImpl, c.API_URL, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agentboard-keepwarm", version: "1" } }, t);
  if (!step("initialize", init, init.status === 200 && !!init.msg?.result?.serverInfo)) return { ok: false, steps };
  const list = await rpc(fetchImpl, c.API_URL, 2, "tools/list", {}, t);
  const names = (list.msg?.result?.tools ?? []).map((x) => x.name);
  if (!step("tools/list", list, names.includes("try_skill") && names.includes("find_skill"), { tools: names.length })) return { ok: false, steps };
  const find = await rpc(fetchImpl, c.API_URL, 3, "tools/call", { name: "find_skill", arguments: { query: "hacker news top story" } }, t);
  const ft = toolText(find.msg);
  if (!step("find_skill", find, find.status === 200 && !find.msg?.result?.isError && ft.includes(c.PROBE_SLUG))) return { ok: false, steps };
  if (withTry) {
    let params = {}; try { params = JSON.parse(c.PROBE_PARAMS); } catch {}
    const tr = await rpc(fetchImpl, c.API_URL, 4, "tools/call", { name: "try_skill", arguments: { slug: c.PROBE_SLUG, ...params } }, t);
    const tt = toolText(tr.msg);
    const mode = /^CACHED VERIFIED RUN/.test(tt) ? "cached" : /Step 1 of 2/.test(tt) ? "challenge" : "error";
    if (!step("try_skill", tr, tr.status === 200 && mode !== "error", { mode, ...(mode === "error" ? { text: tt.slice(0, 300) } : {}) })) return { ok: false, steps };
  }
  return { ok: true, steps };
}

export async function runOnce(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const c = cfg(env);
  const t = Number(c.TIMEOUT_MS);
  const { hour, minute } = laTime(now);
  const warmApi = inWindows(c.API_WARM_WINDOWS, hour), warmExec = inWindows(c.EXECUTOR_WARM_WINDOWS, hour);
  const every = Math.max(5, Number(c.PROBE_TRY_EVERY_MIN) || 30);
  const withTry = warmApi && Math.floor(minute / 5) % Math.round(every / 5) === 0;
  const [api, executor] = await Promise.all([
    warmApi ? ping(fetchImpl, c.API_URL, t) : Promise.resolve({ skipped: "outside API_WARM_WINDOWS" }),
    warmExec ? ping(fetchImpl, c.EXECUTOR_URL, t) : Promise.resolve({ skipped: "outside EXECUTOR_WARM_WINDOWS (wakes on demand)" }),
  ]);
  const mcp = warmApi ? await probeMcp(fetchImpl, c, withTry) : { skipped: "outside API_WARM_WINDOWS" };
  const ok = [api, executor, mcp].every((x) => x.skipped || x.ok);
  return { ok, checked_at: new Date(now).toISOString(), la_hour: hour, api, executor, mcp };
}

async function save(env, status) {
  if (!env.STATUS) return;
  let history = [];
  try { history = JSON.parse((await env.STATUS.get("history")) ?? "[]"); } catch {}
  history.unshift({ at: status.checked_at, ok: status.ok, api_ms: status.api.ms, executor_ms: status.executor.ms, mcp_ok: status.mcp.ok ?? null });
  await env.STATUS.put("status", JSON.stringify(status));
  await env.STATUS.put("history", JSON.stringify(history.slice(0, HISTORY)));
  if (status.ok) await env.STATUS.put("last_ok", status.checked_at);
}

const json = (v, status = 200) => new Response(JSON.stringify(v, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" } });

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => { await save(env, await runOnce(env)); })());
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/status.json") {
      const raw = env.STATUS ? await env.STATUS.get("status") : null;
      if (!raw) return json({ ok: null, message: "no run yet; the cron runs every 5 minutes" }, 503);
      const status = JSON.parse(raw);
      const history = JSON.parse((await env.STATUS.get("history")) ?? "[]");
      const last_ok = await env.STATUS.get("last_ok");
      const age_s = Math.round((Date.now() - Date.parse(status.checked_at)) / 1000);
      return json({ ...status, age_s, stale: age_s > 900, last_ok, history });
    }
    return json({ error: "not_found", see: "/status.json" }, 404);
  },
};
