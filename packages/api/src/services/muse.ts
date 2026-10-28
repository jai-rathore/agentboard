/**
 * Muse Responses API client for Agentboard Skills (image/video input, structured output, the built-in
 * computer tool). Every call goes through one guard:
 *   - model is fixed to the configured Standard model (never -contributor),
 *   - output tokens are clamped per call kind (record 1500, loop 800, verify 600, heal 2000),
 *   - a per-UTC-day call cap and a lifetime USD ceiling, both enforced in the database,
 *   - spend (tokens and USD at list price) is recorded per day and kind and shown on /healthz.
 * Through the web project's Vercel proxy only the shared secret is sent; the Meta key stays there.
 */
import type { AppContext } from "../context.js";
import { HttpError } from "../context.js";

export type MuseKind = "record" | "loop" | "verify" | "heal";
export const OUTPUT_CAPS: Record<MuseKind, number> = { record: 1500, loop: 800, verify: 600, heal: 2000 };
/** USD per 1M tokens, Standard mode (dev.meta.ai/docs/pricing-rate-limits). */
export const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  "muse-spark-1.3": { input: 1.25, cached: 0.15, output: 4.25 },
};
const ALLOWED_FIELDS = new Set(["input", "instructions", "tools", "text", "reasoning", "max_output_tokens", "parallel_tool_calls", "metadata"]);

export interface MuseUsage { input_tokens: number; cached_tokens: number; output_tokens: number; reasoning_tokens: number; usd: number }

export function costOf(model: string, u: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } }): MuseUsage {
  const p = PRICES[model] ?? PRICES["muse-spark-1.3"];
  const input = Math.max(0, Number(u.input_tokens) || 0), cached = Math.min(input, Math.max(0, Number(u.input_tokens_details?.cached_tokens) || 0));
  const output = Math.max(0, Number(u.output_tokens) || 0);
  const usd = ((input - cached) * p.input + cached * p.cached + output * p.output) / 1e6;
  return { input_tokens: input, cached_tokens: cached, output_tokens: output, reasoning_tokens: Number(u.output_tokens_details?.reasoning_tokens) || 0, usd };
}

const today = () => new Date().toISOString().slice(0, 10);

export async function museSpend(ctx: AppContext) {
  const rows = (await ctx.db.query<any>(`SELECT day, kind, calls, input_tokens, cached_tokens, output_tokens, reasoning_tokens, cost_micro FROM muse_spend`)).rows;
  const d = today();
  const t = rows.filter((r) => r.day === d);
  const sum = (rs: any[], k: string) => rs.reduce((s, r) => s + Number(r[k]), 0);
  return {
    model: ctx.cfg.metaModel,
    today: { calls: sum(t, "calls"), input_tokens: sum(t, "input_tokens"), cached_tokens: sum(t, "cached_tokens"), output_tokens: sum(t, "output_tokens"), usd: sum(t, "cost_micro") / 1e6, by_kind: Object.fromEntries(t.map((r) => [r.kind, { calls: Number(r.calls), usd: Number(r.cost_micro) / 1e6 }])) },
    total_usd: sum(rows, "cost_micro") / 1e6,
    total_calls: sum(rows, "calls"),
    daily_call_cap: ctx.cfg.museDailyCallCap,
    spend_cap_usd: ctx.cfg.museSpendCapUsd,
  };
}

/** Reserve one call: atomically counts it against today's cap, and refuses once lifetime spend reaches the ceiling. */
async function reserve(ctx: AppContext, kind: MuseKind) {
  if (ctx.cfg.offline || ctx.cfg.museDailyCallCap <= 0 || !(ctx.cfg.metaProxySecret || ctx.cfg.metaApiKey)) throw new HttpError(503, "muse_disabled", "Muse calls are disabled on this node");
  const total = Number((await ctx.db.query<any>(`SELECT COALESCE(SUM(cost_micro),0)::float8 AS c FROM muse_spend`)).rows[0]?.c ?? 0) / 1e6;
  if (total >= ctx.cfg.museSpendCapUsd) throw new HttpError(429, "muse_spend_cap", `Muse spend ceiling reached ($${total.toFixed(4)} of $${ctx.cfg.museSpendCapUsd})`);
  const d = today();
  const callsToday = Number((await ctx.db.query<any>(`SELECT COALESCE(SUM(calls),0)::int AS n FROM muse_spend WHERE day = $1`, [d])).rows[0]?.n ?? 0);
  if (callsToday >= ctx.cfg.museDailyCallCap) throw new HttpError(429, "muse_daily_cap", `daily Muse call cap (${ctx.cfg.museDailyCallCap}) reached`);
  await ctx.db.query(`INSERT INTO muse_spend (day, kind, calls) VALUES ($1,$2,1) ON CONFLICT (day, kind) DO UPDATE SET calls = muse_spend.calls + 1`, [d, kind]);
}

async function record(ctx: AppContext, kind: MuseKind, u: MuseUsage) {
  await ctx.db.query(
    `UPDATE muse_spend SET input_tokens = input_tokens + $3, cached_tokens = cached_tokens + $4, output_tokens = output_tokens + $5, reasoning_tokens = reasoning_tokens + $6, cost_micro = cost_micro + $7 WHERE day = $1 AND kind = $2`,
    [today(), kind, u.input_tokens, u.cached_tokens, u.output_tokens, u.reasoning_tokens, Math.round(u.usd * 1e6)],
  );
}

export function sanitize(body: Record<string, unknown>, kind: MuseKind, model: string) {
  for (const k of Object.keys(body)) if (k !== "model" && !ALLOWED_FIELDS.has(k)) throw new HttpError(400, "field_not_allowed", `field ${k} is not allowed`);
  for (const t of (body.tools as any[]) ?? []) if (!t || (t.type !== "computer" && t.type !== "function")) throw new HttpError(400, "tool_not_allowed", "only the computer tool and function tools are allowed");
  const cap = OUTPUT_CAPS[kind];
  return { ...body, model, max_output_tokens: Math.min(Number(body.max_output_tokens) || cap, cap), store: false };
}

export interface MuseResult { response: any; usage: MuseUsage; model: string; kind: MuseKind; ms: number }

/** One guarded Responses API call. Retries 5xx and network errors with backoff (each attempt is reserved and counted). */
export async function museResponses(ctx: AppContext, kind: MuseKind, body: Record<string, unknown>, attempts = 3): Promise<MuseResult> {
  const model = ctx.cfg.metaModel;
  if (/contributor/i.test(model)) throw new HttpError(500, "model_not_allowed", "contributor models are never used");
  const payload = JSON.stringify(sanitize(body, kind, model));
  const viaProxy = Boolean(ctx.cfg.metaProxySecret);
  const url = `${ctx.cfg.metaBaseUrl.replace(/\/$/, "")}/responses`;
  let last = "";
  for (let i = 0; i < attempts; i++) {
    await reserve(ctx, kind);
    const t0 = Date.now();
    try {
      const res = await ctx.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-muse-kind": kind, ...(viaProxy ? { "x-agentboard-proxy-secret": ctx.cfg.metaProxySecret! } : { authorization: `Bearer ${ctx.cfg.metaApiKey}` }) },
        body: payload,
        signal: AbortSignal.timeout(85_000),
      });
      const text = await res.text();
      if (res.ok) {
        const response = JSON.parse(text);
        const usage = costOf(model, response.usage ?? {});
        await record(ctx, kind, usage);
        return { response, usage, model, kind, ms: Date.now() - t0 };
      }
      last = `HTTP ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 200)}`;
      if (res.status < 500 && res.status !== 429) throw new HttpError(502, "muse_error", last);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      last = (e as Error).name;
    }
    console.warn(`[muse] ${kind} attempt ${i + 1} failed: ${last}`);
    await new Promise((r) => setTimeout(r, 800 * 2 ** i + Math.random() * 300));
  }
  throw new HttpError(502, "muse_unavailable", `Muse call failed after ${attempts} attempts (${last})`);
}

/** Visible text of a Responses API result. */
export function outputText(response: any): string {
  return (response?.output ?? []).filter((o: any) => o.type === "message").flatMap((o: any) => o.content ?? []).map((c: any) => c.text ?? "").join("");
}
/** Reasoning summary text, when the model returned one. */
export function reasoningSummary(response: any): string {
  return (response?.output ?? []).filter((o: any) => o.type === "reasoning").flatMap((o: any) => o.summary ?? []).map((s: any) => s.text ?? "").join("\n").trim();
}
