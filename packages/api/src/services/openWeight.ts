/**
 * Optional open-weight path: Meta's Muse Spark Open (default `meta-models/muse-spark-open`) on Baseten Model APIs,
 * through the OpenAI-compatible Chat Completions endpoint (https://inference.baseten.co/v1/chat/completions,
 * `Authorization: Bearer <BASETEN_API_KEY>`; Baseten also accepts `Api-Key <key>`).
 *
 * OFF by default. It runs only when LLM_OPEN_WEIGHT_ENABLED=true AND BASETEN_API_KEY is set, and only for the tasks in
 * OPEN_WEIGHT_TASKS (judge, verify, skill_write). Computer-use replay (the built-in computer tool) and self-healing
 * always stay on Muse Spark. Every failure (HTTP error, timeout, truncated or invalid JSON, cap reached) returns
 * null and the caller falls back to Muse Spark, with a log line.
 *
 * Guardrails kept from the Spark path: contributor models refused, output tokens clamped per call kind (reasoning
 * counts against them; Muse Spark Open always reasons), truncated answers (finish_reason "length") rejected, a
 * per-UTC-day call cap and a lifetime USD ceiling. Usage is recorded in muse_spend under kinds prefixed "open:" and is
 * excluded from the Meta spend totals and caps (Baseten spend is not Meta credit spend).
 *
 * Baseten does not support response_format/json_schema for Muse Spark Open, so the schema goes into the prompt and the
 * answer is checked here against the same flat schema before anyone trusts it.
 */
import type { Config, OpenWeightTask } from "../config.js";
import { openWeightActive } from "../config.js";
import type { Db } from "../db/index.js";
import type { JsonSchema, LlmProvider } from "./llm.js";

/** USD per 1M tokens for Muse Spark Open on Baseten (baseten.co/library/muse-spark-open). */
export const OPEN_WEIGHT_PRICE = { input: 1.25, cached: 0.15, output: 4.25 };
export const OPEN_WEIGHT_PROVIDER = "baseten";
export type OpenKind = "judge" | "verify" | "record";

export interface OpenDeps { cfg: Config; db: Db; fetchImpl: typeof fetch }
export interface OpenUsage { input_tokens: number; cached_tokens: number; output_tokens: number; reasoning_tokens: number; usd: number; provider: "baseten" }

const today = () => new Date().toISOString().slice(0, 10);

export function openCostOf(u: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } }): OpenUsage {
  const p = OPEN_WEIGHT_PRICE;
  const input = Math.max(0, Number(u.prompt_tokens) || 0), cached = Math.min(input, Math.max(0, Number(u.prompt_tokens_details?.cached_tokens) || 0));
  const output = Math.max(0, Number(u.completion_tokens) || 0);
  const usd = ((input - cached) * p.input + cached * p.cached + output * p.output) / 1e6;
  return { input_tokens: input, cached_tokens: cached, output_tokens: output, reasoning_tokens: Number(u.completion_tokens_details?.reasoning_tokens) || 0, usd, provider: "baseten" };
}

/** Reserve one open-weight call; false (never throws) when capped, so the caller falls back to Spark. */
async function reserveOpen(d: OpenDeps, kind: OpenKind): Promise<boolean> {
  if (d.cfg.openWeightDailyCallCap <= 0) return false;
  const total = Number((await d.db.query<any>(`SELECT COALESCE(SUM(cost_micro),0)::float8 AS c FROM muse_spend WHERE kind LIKE 'open:%'`)).rows[0]?.c ?? 0) / 1e6;
  if (total >= d.cfg.openWeightSpendCapUsd) { console.warn(`[open-weight] spend ceiling reached ($${total.toFixed(4)} of $${d.cfg.openWeightSpendCapUsd})`); return false; }
  const n = Number((await d.db.query<any>(`SELECT COALESCE(SUM(calls),0)::int AS n FROM muse_spend WHERE day = $1 AND kind LIKE 'open:%'`, [today()])).rows[0]?.n ?? 0);
  if (n >= d.cfg.openWeightDailyCallCap) { console.warn(`[open-weight] daily call cap (${d.cfg.openWeightDailyCallCap}) reached`); return false; }
  await d.db.query(`INSERT INTO muse_spend (day, kind, calls) VALUES ($1,$2,1) ON CONFLICT (day, kind) DO UPDATE SET calls = muse_spend.calls + 1`, [today(), `open:${kind}`]);
  return true;
}

async function recordOpen(d: OpenDeps, kind: OpenKind, u: OpenUsage) {
  await d.db.query(
    `UPDATE muse_spend SET input_tokens = input_tokens + $3, cached_tokens = cached_tokens + $4, output_tokens = output_tokens + $5, reasoning_tokens = reasoning_tokens + $6, cost_micro = cost_micro + $7 WHERE day = $1 AND kind = $2`,
    [today(), `open:${kind}`, u.input_tokens, u.cached_tokens, u.output_tokens, u.reasoning_tokens, Math.round(u.usd * 1e6)],
  );
}

/** Open-weight usage (Baseten), kept apart from Meta spend. */
export async function openWeightSpend(d: { db: Db; cfg: Config }) {
  const rows = (await d.db.query<any>(`SELECT day, kind, calls, input_tokens, output_tokens, cost_micro FROM muse_spend WHERE kind LIKE 'open:%'`)).rows;
  const t = rows.filter((r) => r.day === today());
  const sum = (rs: any[], k: string) => rs.reduce((s, r) => s + Number(r[k]), 0);
  return {
    today: { calls: sum(t, "calls"), input_tokens: sum(t, "input_tokens"), output_tokens: sum(t, "output_tokens"), usd: sum(t, "cost_micro") / 1e6, by_kind: Object.fromEntries(t.map((r) => [String(r.kind).slice(5), { calls: Number(r.calls), usd: Number(r.cost_micro) / 1e6 }])) },
    total_usd: sum(rows, "cost_micro") / 1e6,
    total_calls: sum(rows, "calls"),
  };
}

/** Pull the JSON object out of a reply (models without structured output sometimes wrap it in a code fence). */
export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON object");
  return JSON.parse(t.slice(a, b + 1));
}

/** Checks a value against the flat JSON schemas used here (types, required keys, enums, no extra keys). */
export function matchesSchema(v: unknown, s: any): boolean {
  if (!s || typeof s !== "object") return true;
  if (Array.isArray(s.enum) && !s.enum.includes(v)) return false;
  switch (s.type) {
    case "object": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return false;
      const o = v as Record<string, unknown>;
      for (const k of s.required ?? []) if (!(k in o)) return false;
      if (s.additionalProperties === false) for (const k of Object.keys(o)) if (!(k in (s.properties ?? {}))) return false;
      return Object.entries(s.properties ?? {}).every(([k, ps]) => !(k in o) || matchesSchema(o[k], ps));
    }
    case "array": return Array.isArray(v) && v.every((x) => matchesSchema(x, s.items));
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "integer": return Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    default: return true;
  }
}

const schemaInstruction = (name: string, schema: unknown) =>
  `Answer with one JSON object only (no prose, no code fence) named "${name}" that matches this JSON schema exactly:\n${JSON.stringify(schema)}`;

export interface OpenCall { kind: OpenKind; task: OpenWeightTask; messages: any[]; schemaName: string; schema: unknown; maxTokens: number }
export interface OpenResult { text: string; value: unknown; usage: OpenUsage; model: string; ms: number }

/** One guarded open-weight call. Returns null on any failure (the caller falls back to Spark). Never throws. */
export async function openWeightJson(d: OpenDeps, c: OpenCall): Promise<OpenResult | null> {
  const model = d.cfg.openWeightModel;
  if (!openWeightActive(d.cfg, c.task) || /contributor/i.test(model)) return null;
  try {
    if (!(await reserveOpen(d, c.kind))) return null;
    const messages = [{ role: "system", content: schemaInstruction(c.schemaName, c.schema) }, ...c.messages];
    const t0 = Date.now();
    const res = await d.fetchImpl(`${d.cfg.basetenBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${d.cfg.basetenApiKey}` },
      // Muse Spark Open always reasons; "low" is its lightest effort. Reasoning tokens count against max_tokens.
      body: JSON.stringify({ model, messages, max_tokens: Math.max(1, c.maxTokens), reasoning_effort: "low", stream: false }),
      signal: AbortSignal.timeout(c.kind === "judge" ? 20_000 : 85_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").replace(/(sk|key|bearer)[-_ ]?[A-Za-z0-9._-]{12,}/gi, "[redacted]").slice(0, 200);
      console.warn(`[open-weight] ${c.kind} HTTP ${res.status} ${model}: ${detail}; falling back to Muse Spark`);
      return null;
    }
    const data = (await res.json()) as any;
    const usage = openCostOf(data?.usage ?? {});
    await recordOpen(d, c.kind, usage).catch(() => {});
    const ch = data?.choices?.[0];
    const text = ch?.message?.content;
    if (typeof text !== "string" || !text.trim() || ch.finish_reason === "length") {
      console.warn(`[open-weight] ${c.kind} no usable content (${ch?.finish_reason ?? "none"}; completion ${usage.output_tokens}, reasoning ${usage.reasoning_tokens}); falling back to Muse Spark`);
      return null;
    }
    let value: unknown;
    try { value = extractJson(text); } catch { console.warn(`[open-weight] ${c.kind} answer is not JSON; falling back to Muse Spark`); return null; }
    if (!matchesSchema(value, c.schema)) { console.warn(`[open-weight] ${c.kind} answer does not match the ${c.schemaName} schema; falling back to Muse Spark`); return null; }
    return { text: JSON.stringify(value), value, usage, model, ms: Date.now() - t0 };
  } catch (e) {
    console.warn(`[open-weight] ${c.kind} ${(e as Error).name}; falling back to Muse Spark`);
    return null;
  }
}

/**
 * Translate a Responses API body (as built for Spark) into Chat Completions messages. Returns null when the body
 * uses anything the open-weight path does not take over (tools, i.e. computer use, or a non-JSON-schema format).
 */
export function responsesToChat(body: Record<string, any>): { messages: any[]; schemaName: string; schema: unknown } | null {
  if (Array.isArray(body.tools) && body.tools.length) return null;
  const fmt = body.text?.format;
  if (!fmt || fmt.type !== "json_schema" || !fmt.schema) return null;
  const messages: any[] = [];
  if (typeof body.instructions === "string" && body.instructions) messages.push({ role: "system", content: body.instructions });
  const items = typeof body.input === "string" ? [{ role: "user", content: body.input }] : Array.isArray(body.input) ? body.input : null;
  if (!items) return null;
  for (const it of items) {
    if (!it || typeof it !== "object" || !["user", "system", "developer"].includes(it.role)) return null;
    if (typeof it.content === "string") { messages.push({ role: it.role === "developer" ? "system" : it.role, content: it.content }); continue; }
    if (!Array.isArray(it.content)) return null;
    const parts: any[] = [];
    for (const p of it.content) {
      if (p?.type === "input_text") parts.push({ type: "text", text: String(p.text ?? "") });
      else if (p?.type === "input_image" && typeof p.image_url === "string") parts.push({ type: "image_url", image_url: { url: p.image_url } });
      else if (p?.type === "input_video" && typeof p.video_url === "string") parts.push({ type: "video_url", video_url: { url: p.video_url } });
      else return null;
    }
    messages.push({ role: it.role === "developer" ? "system" : it.role, content: parts });
  }
  return { messages, schemaName: String(fmt.name ?? "answer"), schema: fmt.schema };
}

/** Judge provider for the open-weight path (prompted JSON, checked against the schema locally). */
export class OpenWeightJudgeProvider implements LlmProvider {
  name = "muse-open";
  constructor(private d: OpenDeps) {}
  get model() { return this.d.cfg.openWeightModel; }
  async json<T>(o: { system: string; user: string; schemaName: string; schema: JsonSchema; maxTokens?: number }): Promise<T | null> {
    const r = await openWeightJson(this.d, {
      kind: "judge", task: "judge", schemaName: o.schemaName, schema: o.schema,
      messages: [{ role: "system", content: o.system }, { role: "user", content: o.user }],
      maxTokens: Math.min(o.maxTokens ?? this.d.cfg.llmMaxOutputTokens, this.d.cfg.llmMaxOutputTokens),
    });
    return r ? (r.value as T) : null;
  }
}
