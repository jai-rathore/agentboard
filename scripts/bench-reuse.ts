#!/usr/bin/env -S npx tsx
/**
 * Two-agent reuse benchmark (services/benchmark.ts on the node). One invocation = at most ONE cold run and ONE replay.
 *
 *   pnpm bench:reuse --skill wikipedia-infobox-fact --input 'Mount Kilimanjaro'              # SPENDS Muse credits
 *   pnpm bench:reuse --skill hacker-news-top-story --dry-run                                  # read-only plan, $0
 *
 * Agent A (fresh did:key, plain HTTP client "agentboard-bench/agent-a-cold"): no skill lookup. Signs the request for a
 *   cold run: the executor gets only the task statement (skill name, summary, success check, input, start URL) and
 *   Muse drives the browser with no recorded steps.
 * Agent B (another fresh did:key, MCP client "agentboard-bench/agent-b-reuse"): calls find_skill on the node's remote
 *   /mcp, takes the matching skill and signs the request to replay it on the same input.
 * Then the node signs a `benchmark` record comparing both runs (model calls, tokens, USD, time) and the page
 * <web>/benchmark shows it.
 *
 * Guards: refuses to start if lifetime Muse spend + the estimate would pass --limit (default $3.50, under the node's
 * $4.00 lifetime cap) or if today's Muse call budget can't fit both runs; the node enforces the same limit and allows
 * one cold run and one replay per benchmark. The cold run is aborted (socket closed) past --per-run-cap.
 *
 * Options:
 *   --skill <slug>          published skill (required)
 *   --input <text>          value for the skill's first param (the "place name" for wikipedia-infobox-fact)
 *   --param name=value      any other param (repeatable); params not given use the recording's example
 *   --query <text>          Agent B's find_skill query (default: the skill's summary, the same task statement A gets)
 *   --api <url>             default https://agentboard-api.onrender.com
 *   --executor <wss url>    default wss://agentboard-executor.onrender.com
 *   --limit <usd>           lifetime Muse spend ceiling for starting (default 3.50)
 *   --per-run-cap <usd>     abort the cold run past this (default 0.15)
 *   --out <file>            write the full result JSON here
 *   --dry-run               read-only: spend check, skill, params, find_skill; no writes, no runs
 * Operator token: SKILLS_OPERATOR_TOKEN, or --token-file <env file containing SKILLS_OPERATOR_TOKEN=...>. Never printed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { generateKeyPair, sha256Hex, type KeyPair } from "@agentboard/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { signRequest } from "../packages/api/src/requestAuth.js";

export const HARNESS = { name: "agentboard-bench-reuse", version: "1" };
export const CLIENT_A = "agentboard-bench/agent-a-cold";
export const CLIENT_B = "agentboard-bench/agent-b-reuse";
/** Same numbers as BENCH in services/benchmark.ts: one cold run + one replay, each at most 15 loop turns + verify (+ heal). */
export const ESTIMATE = { usd: 0.3, calls: 34, limitUsd: 3.5, perRunCapUsd: 0.15 };

export interface BenchOptions {
  api: string; executor: string; token: string; skill: string; input?: string; params?: Record<string, string>; query?: string;
  limitUsd?: number; perRunCapUsd?: number; dryRun?: boolean;
  fetch?: typeof fetch;
  /** Runs the cold draft on the executor and resolves with the executor's result (default: WebSocket). */
  runCold?: (a: { draft_id: string; params: Record<string, string>; start_url: string; token: string; capUsd: number }) => Promise<any>;
  log?: (...a: unknown[]) => void;
  pollMs?: number;
  keys?: { a: KeyPair; b: KeyPair };
}

const hostOf = (u: string) => u.replace(/^ws/, "http").replace(/\/run$/, "").replace(/\/$/, "");

export async function runBenchmark(o: BenchOptions) {
  const f = o.fetch ?? fetch;
  const log = o.log ?? ((...a) => console.log(new Date().toTimeString().slice(0, 8), ...a));
  const api = o.api.replace(/\/$/, "");
  const limit = o.limitUsd ?? ESTIMATE.limitUsd, cap = o.perRunCapUsd ?? ESTIMATE.perRunCapUsd;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await f(api + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const text = await r.text();
    let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { j = { message: text.slice(0, 200) }; }
    if (!r.ok) throw Object.assign(new Error(`${method} ${path} -> ${r.status} ${j?.error ?? ""} ${j?.message ?? ""}`.trim()), { status: r.status, body: j });
    return j;
  };
  const op = { "x-skills-token": o.token };
  const spend = async () => { const s = await call("GET", "/v1/muse/spend"); return { usd: Number(s.total_usd), calls: Number(s.total_calls), today: Number(s.today?.calls ?? 0), cap: Number(s.daily_call_cap), ceiling: Number(s.spend_cap_usd) }; };

  // ---- 1. spend guard (before anything else)
  const s0 = await spend();
  const ceiling = Math.min(limit, s0.ceiling || limit);
  log(`Muse lifetime $${s0.usd.toFixed(4)} · estimate $${ESTIMATE.usd} · limit $${ceiling.toFixed(2)} · calls today ${s0.today}/${s0.cap}`);
  const refusals: string[] = [];
  if (s0.usd + ESTIMATE.usd > ceiling) refusals.push(`refused: lifetime Muse spend $${s0.usd.toFixed(4)} + estimate $${ESTIMATE.usd} would pass $${ceiling.toFixed(2)}`);
  if (s0.cap > 0 && s0.today + ESTIMATE.calls > s0.cap) refusals.push(`refused: ${s0.today} of ${s0.cap} Muse calls used today; both runs can need up to ${ESTIMATE.calls} (resets 00:00 UTC)`);
  if (refusals.length && !o.dryRun) throw new Error(refusals.join("; "));
  for (const r of refusals) log(`dry run: a real run would stop here: ${r}`);

  // ---- 2. the skill and the shared input
  const sk = await call("GET", `/v1/skills/${encodeURIComponent(o.skill)}`);
  const body = sk.skill.record.body;
  if (body.slug !== o.skill) throw new Error(`no published skill with slug ${o.skill}`);
  const declared: { name: string; example: string }[] = body.skill.params ?? [];
  const params: Record<string, string> = Object.fromEntries(declared.map((p) => [p.name, p.example]));
  if (o.input !== undefined) { if (!declared.length) throw new Error(`${o.skill} takes no params; drop --input`); params[declared[0].name] = o.input; }
  for (const [k, v] of Object.entries(o.params ?? {})) { if (!(k in params)) throw new Error(`unknown param ${k}; ${o.skill} takes ${declared.map((p) => p.name).join(", ") || "none"}`); params[k] = v; }
  log(`skill ${body.slug} v${body.version} (${sk.skill.record.cid.slice(0, 16)}…) at ${body.source?.start_url} · input ${JSON.stringify(params)}`);
  if (declared.length && declared.every((p) => params[p.name] === p.example)) log("note: the input equals the recording's example values");

  // ---- 3. two fresh identities
  const A = o.keys?.a ?? generateKeyPair(), B = o.keys?.b ?? generateKeyPair();
  log(`agent A (cold)  ${A.did}`);
  log(`agent B (reuse) ${B.did}`);

  // ---- 4. Agent B looks the skill up over MCP (read-only, no model call)
  const query = o.query ?? body.skill.summary ?? body.skill.name;
  const t0f = Date.now();
  const mcp = new Client({ name: CLIENT_B, version: HARNESS.version });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${api}/mcp`), o.fetch ? { fetch: o.fetch } : undefined));
  let found: any[] = [];
  try {
    const r: any = await mcp.callTool({ name: "find_skill", arguments: { query, limit: 10 } });
    // structuredContent (or the JSON-only first text item) carries the result
    let data: any = r.structuredContent;
    if (!data) { try { data = JSON.parse(r.content?.[0]?.text ?? ""); } catch { data = null; } }
    found = data?.skills ?? [];
  } finally { await mcp.close().catch(() => {}); }
  const rank = found.findIndex((s) => s.slug === body.slug);
  const find = { tool: "find_skill", endpoint: `${api}/mcp`, client: CLIENT_B, query, results: found.length, rank: rank >= 0 ? rank + 1 : null, cid: rank >= 0 ? found[rank].cid : null, ms: Date.now() - t0f, model_calls: 0 };
  log(`agent B find_skill("${query.slice(0, 80)}") -> ${found.length} result(s); ${body.slug} at rank ${find.rank ?? "none"}`);
  if (rank < 0) throw new Error(`agent B's find_skill did not return ${body.slug}; try --query`);

  if (o.dryRun) {
    log("dry run: no benchmark opened, no runs, no Muse calls.");
    return { dry_run: true, would_refuse: refusals, skill: { slug: body.slug, cid: sk.skill.record.cid, version: body.version }, params, start_url: body.source?.start_url, agents: { a: A.did, b: B.did }, find, spend: s0, estimate: ESTIMATE };
  }

  const signed = async (kp: KeyPair, path: string, payload: unknown) => {
    const raw = JSON.stringify(payload ?? {});
    const p = `${path}?h=${sha256Hex(new TextEncoder().encode(raw))}`;
    return call("POST", p, raw, { ...op, authorization: signRequest(kp, "POST", p) });
  };
  const exHttp = hostOf(o.executor);
  const waitIdle = async () => {
    for (let i = 0; i < 60; i++) {
      const h = await f(`${exHttp}/healthz`, { signal: AbortSignal.timeout(90_000) }).then((r) => r.json()).catch(() => null) as any;
      if (h && !h.busy) return h;
      await new Promise((r) => setTimeout(r, i === 0 ? 1000 : 5000));
    }
    throw new Error("executor stayed busy or unreachable for 5 minutes");
  };

  // ---- 5. open the benchmark (operator); the node re-checks the spend limit
  const bench = await call("POST", "/v1/operator/benchmarks", { skill: body.slug, params, agent_a: A.did, agent_b: B.did, find }, op);
  log(`benchmark ${bench.id} opened`);
  await waitIdle(); // wakes a sleeping free-tier executor so neither run pays the cold start

  // ---- 6. Agent A: cold run (task statement only)
  const sa = await spend(); const ta = Date.now();
  const cold = await signed(A, `/v1/operator/benchmarks/${bench.id}/cold`, {});
  const runCold = o.runCold ?? wsRunCold(o.executor, log);
  const coldResult = await runCold({ draft_id: cold.draft_id, params: cold.params, start_url: cold.start_url, token: o.token, capUsd: cap });
  const coldWall = Date.now() - ta; const sa2 = await spend();
  log(`cold run: ${coldResult.verdict?.success ? "verified" : "NOT verified"} · ${coldResult.turns} turns · ${coldResult.usage?.calls} calls · $${Number(coldResult.usage?.usd ?? 0).toFixed(4)} · ${coldWall} ms · ${coldResult.run_cid}`);
  if (!coldResult.run_cid) throw new Error(`cold run produced no signed record (${coldResult.status ?? "?"})`);

  // ---- 7. Agent B: replay of the skill it found, same input
  await waitIdle();
  const sb = await spend(); const tb = Date.now();
  let job = await signed(B, `/v1/operator/benchmarks/${bench.id}/reuse`, { skill: find.cid });
  log(`replay job ${job.id}: ${job.url}`);
  const until = Date.now() + 9 * 60_000;
  while (!["completed", "failed", "declined", "expired", "cancelled"].includes(job.status)) {
    if (Date.now() > until) throw new Error(`replay job ${job.id} did not finish in 9 minutes (status ${job.status})`);
    if (job.status === "pending_approval") throw new Error(`replay job ${job.id} is waiting for a human approval; this benchmark task should not need one`);
    await new Promise((r) => setTimeout(r, o.pollMs ?? 2000));
    job = await call("GET", `/v1/skills/jobs/${job.id}`);
  }
  const reuseWall = Date.now() - tb; const sb2 = await spend();
  if (job.status !== "completed" || !job.result?.run_cid) throw new Error(`replay job ${job.id} ended ${job.status}: ${job.message ?? ""}`);
  log(`replay: ${job.result.verdict?.success ? "verified" : "NOT verified"} · ${job.result.turns} turns · ${job.result.usage?.calls} calls · $${Number(job.result.usage?.usd ?? 0).toFixed(4)} · ${reuseWall} ms · ${job.result.run_cid}`);

  // ---- 8. the node signs the comparison
  const client = {
    harness: HARNESS,
    cold: { client: CLIENT_A, wall_ms: coldWall, muse_spend_delta_usd: sa2.usd - sa.usd, muse_spend_delta_calls: sa2.calls - sa.calls },
    reuse: { client: CLIENT_B, wall_ms: reuseWall, muse_spend_delta_usd: sb2.usd - sb.usd, muse_spend_delta_calls: sb2.calls - sb.calls },
  };
  const out = await call("POST", `/v1/operator/benchmarks/${bench.id}/finalize`, client, op);
  log(out.headline);
  log(`benchmark record ${out.cid} · page ${out.page}`);
  return out;
}

/** Default cold-run driver: the executor's WebSocket (operator token), closed past the per-run cap. */
export function wsRunCold(executor: string, log: (...a: unknown[]) => void) {
  return ({ draft_id, params, start_url, token, capUsd }: { draft_id: string; params: Record<string, string>; start_url: string; token: string; capUsd: number }) => new Promise<any>((resolve, reject) => {
    const url = executor.replace(/\/$/, "").replace(/\/run$/, "") + "/run";
    const ws = new WebSocket(url);
    let done = false;
    const timer = setTimeout(() => { ws.close(); reject(new Error("cold run timed out after 8 minutes")); }, 8 * 60_000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "start", token, draft_id, params, start_url }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "usage" && Number(m.usage?.usd) > capUsd) { clearTimeout(timer); ws.close(); reject(new Error(`per-run cap: $${Number(m.usage.usd).toFixed(4)} > $${capUsd}; cold run aborted`)); }
      else if (m.type === "turn") log(`  A turn ${m.turn}: ${String(m.say ?? "").slice(0, 100)}`);
      else if (m.type === "approval_request") { log(`  A approval DECLINED: ${m.reason ?? ""}`); ws.send(JSON.stringify({ type: "approval", id: m.id, approve: false })); }
      else if (m.type === "error") { clearTimeout(timer); ws.close(); reject(new Error(`executor: ${m.error} ${m.message}`)); }
      else if (m.type === "done") { done = true; clearTimeout(timer); ws.close(); resolve(m.result); }
    };
    ws.onerror = () => { /* onclose reports */ };
    ws.onclose = () => { if (!done) { clearTimeout(timer); reject(new Error("executor socket closed before the cold run finished")); } };
  });
}

function parseArgs(argv: string[]) {
  const o: Record<string, string | boolean> = {}; const params: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    if (k === "dry-run" || k === "help") { o[k] = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`--${k} needs a value`);
    if (k === "param") { const eq = v.indexOf("="); if (eq < 1) throw new Error("--param name=value"); params[v.slice(0, eq)] = v.slice(eq + 1); }
    else o[k] = v;
  }
  return { o, params };
}

function readToken(file?: string) {
  if (process.env.SKILLS_OPERATOR_TOKEN) return process.env.SKILLS_OPERATOR_TOKEN;
  if (!file) return "";
  return (readFileSync(file, "utf8").match(/^SKILLS_OPERATOR_TOKEN=["']?([^"'\n]+)/m) ?? [])[1] ?? "";
}

async function main() {
  const { o, params } = parseArgs(process.argv.slice(2));
  if (o.help || typeof o.skill !== "string") { console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]); process.exit(o.help ? 0 : 2); }
  const dryRun = Boolean(o["dry-run"]);
  const token = readToken(typeof o["token-file"] === "string" ? o["token-file"] : process.env.SKILLS_TOKEN_FILE);
  if (!token && !dryRun) throw new Error("operator token missing: set SKILLS_OPERATOR_TOKEN or pass --token-file");
  const out = await runBenchmark({
    api: (o.api as string) ?? "https://agentboard-api.onrender.com", executor: (o.executor as string) ?? "wss://agentboard-executor.onrender.com",
    token, skill: o.skill, input: o.input as string | undefined, params, query: o.query as string | undefined, dryRun,
    limitUsd: o.limit ? Number(o.limit) : undefined, perRunCapUsd: o["per-run-cap"] ? Number(o["per-run-cap"]) : undefined,
  });
  if (typeof o.out === "string") writeFileSync(o.out, JSON.stringify(out, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`bench-reuse: ${e.message}`); process.exit(1); });
}
