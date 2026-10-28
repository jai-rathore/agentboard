/**
 * OpenAI-compatible chat client for the Meta Model API (Muse Spark) and for any OpenAI-compatible
 * endpoint serving Muse Glimmer. Structured output uses `response_format: json_schema` with FLAT
 * schemas only (the Meta API rejects recursive schemas). Every call is gated by a hard daily cap
 * stored in the database; the default cap is 0, so no paid call happens unless explicitly enabled.
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
  ) {}

  async json<T>(o: { system: string; user: string; schemaName: string; schema: JsonSchema; maxTokens?: number }): Promise<T | null> {
    if (!(await this.budget())) return null;
    try {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "system", content: o.system }, { role: "user", content: o.user }],
          max_tokens: o.maxTokens ?? 600,
          temperature: 0,
          response_format: { type: "json_schema", json_schema: { name: o.schemaName, strict: true, schema: o.schema } },
          ...this.extra,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) { console.warn(`[llm:${this.name}] HTTP ${res.status}`); return null; }
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = data.choices?.[0]?.message?.content;
      return text ? (JSON.parse(text) as T) : null;
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

export interface Llms { spark: LlmProvider | null; glimmer: LlmProvider | null }

export function createLlms(cfg: Config, db: Db): Llms {
  if (cfg.offline) return { spark: null, glimmer: null };
  const budget = dailyBudget(db, cfg.llmDailyCallCap);
  return {
    spark: cfg.metaApiKey ? new OpenAICompatProvider("muse-spark", cfg.metaBaseUrl, cfg.metaApiKey, cfg.metaModel, budget, fetch, { reasoning_effort: "low" }) : null,
    glimmer: cfg.glimmerBaseUrl ? new OpenAICompatProvider("muse-glimmer", cfg.glimmerBaseUrl, cfg.glimmerApiKey, cfg.glimmerModel, budget) : null,
  };
}
