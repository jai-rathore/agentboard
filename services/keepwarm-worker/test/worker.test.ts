// The keep-warm Worker, with a fake fetch and a fake KV: nothing leaves the process.
import { describe, it, expect } from "vitest";
// @ts-ignore plain JS Worker module
import worker, { inWindows, laTime, runOnce, probeMcp, cfg } from "../src/index.js";

const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const text = (t: string) => ({ result: { content: [{ type: "text", text: t }] } });
function fakeFetch(o: { tryText?: string; apiDown?: boolean; tools?: string[] } = {}) {
  const calls: string[] = [];
  const f = async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/healthz")) {
      calls.push(`GET ${new URL(u).host}`);
      if (o.apiDown && u.includes("api")) throw new TypeError("fetch failed");
      return ok({ ok: true, muse_spend: { today: { calls: 3 }, daily_call_cap: 400, public_reserve_left_today: 30, calls_left_today: { public: 397, other: 367 }, total_usd: 1, spend_cap_usd: 125 } });
    }
    const m = JSON.parse(String(init?.body));
    calls.push(m.params?.name ?? m.method);
    if (m.method === "initialize") return ok({ result: { serverInfo: { name: "agentboard" } } });
    if (m.method === "tools/list") return ok({ result: { tools: (o.tools ?? ["find_skill", "try_skill"]).map((name) => ({ name })) } });
    if (m.params.name === "find_skill") return ok(text('{"skills":[{"slug":"hacker-news-top-story"}]}'));
    return new Response(`event: message\ndata: ${JSON.stringify(text(o.tryText ?? "Step 1 of 2: What is 3 × 4 + 5?"))}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { f: f as unknown as typeof fetch, calls };
}
// 2026-10-28 11:00 PDT and 03:00 PDT
const NOON = Date.parse("2026-10-28T18:00:00Z"), NIGHT = Date.parse("2026-10-28T10:00:00Z");

describe("keep-warm windows", () => {
  it("parses LA-hour windows", () => {
    expect(inWindows("*", 3)).toBe(true);
    expect(inWindows("", 3)).toBe(false);
    expect(inWindows("6-24", 5)).toBe(false);
    expect(inWindows("6-24", 23)).toBe(true);
    expect(inWindows("22-2", 1)).toBe(true);
    expect(inWindows("22-2", 2)).toBe(false);
    expect(inWindows("9,10-12", 9)).toBe(true);
    expect(laTime(NOON)).toEqual({ hour: 11, minute: 0 });
  });
});

describe("runOnce", () => {
  it("pings both services in window and runs the MCP probe with the free first try_skill step", async () => {
    const { f, calls } = fakeFetch();
    const s = await runOnce({}, { fetchImpl: f, now: NOON });
    expect(s.ok).toBe(true);
    expect(calls).toEqual(expect.arrayContaining(["GET agentboard-api.onrender.com", "GET agentboard-executor.onrender.com", "initialize", "tools/list", "find_skill", "try_skill"]));
    expect(s.api.muse).toMatchObject({ daily_call_cap: 400, public_reserve_left_today: 30 });
    expect(s.mcp.steps.at(-1)).toMatchObject({ name: "try_skill", ok: true, mode: "challenge" });
  });

  it("a cached verified run is a healthy answer; an error is not", async () => {
    expect((await probeMcp(fakeFetch({ tryText: "CACHED VERIFIED RUN (not a new replay): ..." }).f, cfg({}), true)).ok).toBe(true);
    const bad = await probeMcp(fakeFetch({ tryText: "internal error" }).f, cfg({}), true);
    expect(bad.ok).toBe(false);
    expect(bad.steps.at(-1)).toMatchObject({ name: "try_skill", mode: "error" });
    expect((await probeMcp(fakeFetch({ tools: ["find_skill"] }).f, cfg({}), false)).ok).toBe(false);
  });

  it("skips try_skill off the half hour and the executor outside its window; at night nothing is pinged", async () => {
    const { f, calls } = fakeFetch();
    const s = await runOnce({ EXECUTOR_WARM_WINDOWS: "" }, { fetchImpl: f, now: NOON + 5 * 60_000 });
    expect(s.ok).toBe(true);
    expect(s.executor.skipped).toMatch(/on demand/);
    expect(calls).not.toContain("try_skill");
    const night = fakeFetch();
    const n = await runOnce({}, { fetchImpl: night.f, now: NIGHT });
    expect(night.calls).toEqual([]);
    expect(n).toMatchObject({ ok: true, api: { skipped: expect.any(String) }, mcp: { skipped: expect.any(String) } });
  });

  it("reports a down API", async () => {
    const s = await runOnce({}, { fetchImpl: fakeFetch({ apiDown: true }).f, now: NOON });
    expect(s.ok).toBe(false);
    expect(s.api).toMatchObject({ ok: false, status: 0 });
  });
});

describe("status JSON", () => {
  it("cron writes KV; GET /status.json serves it with history", async () => {
    const kv = new Map<string, string>();
    const env = { STATUS: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); } } };
    expect((await worker.fetch(new Request("https://w.test/status.json"), env)).status).toBe(503);
    const orig = globalThis.fetch;
    globalThis.fetch = fakeFetch().f;
    try {
      const waits: Promise<unknown>[] = [];
      await worker.scheduled({}, env, { waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    } finally { globalThis.fetch = orig; }
    const r = await worker.fetch(new Request("https://w.test/status.json"), env);
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    const j = await r.json();
    expect(j).toMatchObject({ stale: false, history: [expect.objectContaining({ at: j.checked_at })] });
    expect((await worker.fetch(new Request("https://w.test/nope"), env)).status).toBe(404);
  });
});
