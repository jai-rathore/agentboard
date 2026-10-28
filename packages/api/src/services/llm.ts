/**
 * OpenAI-compatible chat client for the Meta Model API (Muse Spark) and for any OpenAI-compatible
 * endpoint serving Muse Glimmer. Structured output uses `response_format: json_schema` with FLAT
 * schemas only (the Meta API rejects recursive schemas). Every call is gated by a hard daily cap
 * stored in the database (default 0 = no paid calls), and each call's output is clamped to
 * LLM_MAX_OUTPUT_TOKENS. Token usage is accumulated per day in llm_usage.
 * When unavailable, callers get `null` and use their deterministic fallback.
 */
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";

export interface JsonSchema { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false }

export interface LlmProvider {
  name: string;
  model: string;
  json<T>(opts: { system: string; user: string; schemaName: string; schema: JsonSchema; maxTokens?: number }): Promise<T | null>;
}

export class OpenAICompatProvider implements LlmProvider {
  constructor(
    public name: string,
    private baseUrl: string,
    private apiKey: string | undefined,
    public model: string,
    private budget: () => Promise<boolean>,
    private fetchImpl: typeof fetch = fetch,
    private extra: Record<string, unknown> = {},
    private maxOutputTokens = 500,
    private recordUsage: (u: { prompt_tokens?: number; completion_tokens?: number }) => Promise<void> = async () => {},
    private headers: Record<string, string> = {},
  ) {}

  async json<T>(o: { system: string; user: string; schemaName: string; schema: JsonSchema; maxTokens?: number }): Promise<T | null> {
    if (!(await this.budget())) return null;
    try {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers, ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "system", content: o.system }, { role: "user", content: o.user }],
          max_tokens: Math.min(o.maxTokens ?? this.maxOutputTokens, this.maxOutputTokens),
          temperature: 0,
          response_format: { type: "json_schema", json_schema: { name: o.schemaName, strict: true, schema: o.schema } },
          ...this.extra,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        // Short provider error for diagnosis; bearer-like tokens are scrubbed defensively.
        const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").replace(/(sk|key|bearer)[-_ ]?[A-Za-z0-9._-]{12,}/gi, "[redacted]").slice(0, 300);
        console.warn(`[llm:${this.name}] HTTP ${res.status} ${this.model} @ ${new URL(this.baseUrl).host}: ${detail}`);
        return null;
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string | null }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      if (data.usage) await this.recordUsage(data.usage).catch(() => {});
      const c = data.choices?.[0];
      // Reasoning tokens count against max_tokens; a truncated answer is not trusted.
      if (!c?.message?.content || c.finish_reason === "length") { console.warn(`[llm:${this.name}] no usable content (${c?.finish_reason ?? "none"})`); return null; }
      return JSON.parse(c.message.content) as T;
    } catch (e) {
      console.warn(`[llm:${this.name}] ${(e as Error).name}`);
      return null;
    }
  }
}

/** Atomically reserve one call against today's cap. */
export function dailyBudget(db: Db, cap: number): () => Promise<boolean> {
  return async () => {
    if (cap <= 0) return false;
    const day = new Date().toISOString().slice(0, 10);
    const r = await db.query<{ calls: number }>(
      `INSERT INTO llm_usage (day, calls) VALUES ($1, 1)
       ON CONFLICT (day) DO UPDATE SET calls = llm_usage.calls + 1 WHERE llm_usage.calls < $2
       RETURNING calls`,
      [day, cap],
    );
    return r.rows.length > 0;
  };
}

/** Adds token counts to today's usage row (the row exists: budget() reserved it). */
export function usageRecorder(db: Db): (u: { prompt_tokens?: number; completion_tokens?: number }) => Promise<void> {
  return async (u) => {
    const day = new Date().toISOString().slice(0, 10);
    await db.query(`UPDATE llm_usage SET input_tokens = input_tokens + $2, output_tokens = output_tokens + $3 WHERE day = $1`, [day, Math.max(0, Number(u.prompt_tokens) || 0), Math.max(0, Number(u.completion_tokens) || 0)]);
  };
}

export interface Llms { spark: LlmProvider | null; glimmer: LlmProvider | null }

export function createLlms(cfg: Config, db: Db): Llms {
  if (cfg.offline) return { spark: null, glimmer: null };
  const budget = dailyBudget(db, cfg.llmDailyCallCap);
  const usage = usageRecorder(db);
  return {
    // Through a proxy the Meta key stays on the proxy: only the shared secret is sent.
    spark: cfg.metaProxySecret
      ? new OpenAICompatProvider("muse-spark", cfg.metaBaseUrl, undefined, cfg.metaModel, budget, fetch, { reasoning_effort: cfg.metaReasoningEffort }, cfg.llmMaxOutputTokens, usage, { "x-agentboard-proxy-secret": cfg.metaProxySecret })
      : cfg.metaApiKey ? new OpenAICompatProvider("muse-spark", cfg.metaBaseUrl, cfg.metaApiKey, cfg.metaModel, budget, fetch, { reasoning_effort: cfg.metaReasoningEffort }, cfg.llmMaxOutputTokens, usage) : null,
    glimmer: cfg.glimmerBaseUrl ? new OpenAICompatProvider("muse-glimmer", cfg.glimmerBaseUrl, cfg.glimmerApiKey, cfg.glimmerModel, budget, fetch, {}, cfg.llmMaxOutputTokens, usage) : null,
  };
}
