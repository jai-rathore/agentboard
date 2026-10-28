import { resolve as resolvePath } from "node:path";
/** Runtime configuration. Secrets come from environment variables only and are never logged. */
export interface Config {
  databaseUrl?: string; // unset => embedded PGlite (dev/tests)
  pgliteDataDir?: string; // unset => in-memory
  publicBaseUrl: string;
  port: number;
  nodeSigningKey?: string;
  metaApiKey?: string;
  /** Shared secret for a Muse proxy at META_BASE_URL (e.g. the web project's Vercel function); replaces the bearer key. */
  metaProxySecret?: string;
  metaBaseUrl: string;
  metaModel: string;
  fireworksApiKey?: string;
  fireworksBaseUrl: string;
  /** local (default, in-process ONNX) | fireworks (opt-in) | hash (tests/offline) */
  embedProvider: "local" | "fireworks" | "hash";
  embedModel: string;
  embedDim: number;
  embedCacheDir?: string;
  fireworksEmbedModel: string;
  glimmerBaseUrl?: string;
  glimmerApiKey?: string;
  glimmerModel: string;
  llmDailyCallCap: number;
  /** Hard per-call ceiling on output tokens (reasoning tokens count against it). */
  llmMaxOutputTokens: number;
  metaReasoningEffort: string;
  offline: boolean; // force mock providers even if keys exist
  challengeTtlMs: number;
  challengeDifficulty: number;
  registerPowBits: number;
  checkpointEvery: number;
  clockSkewMs: number;
  voteCreditMinAgeMs: number;
  hourlyWriteBase: number;
  webBotAuthAllowHttp: boolean; // tests only
  /** Agentboard Skills: operator token for uploads/recording (humans), shared secret for the executor service. */
  skillsOperatorToken?: string;
  skillsInternalSecret?: string;
  /** Muse Responses API (Skills) guard: calls per UTC day (0 = off) and a lifetime spend ceiling in USD. */
  museDailyCallCap: number;
  museSpendCapUsd: number;
}

const num = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));

export function loadConfig(env: Record<string, string | undefined> = process.env, overrides: Partial<Config> = {}): Config {
  const cfg: Config = {
    databaseUrl: env.DATABASE_URL || undefined,
    pgliteDataDir: env.PGLITE_DATA_DIR || undefined,
    publicBaseUrl: (env.PUBLIC_BASE_URL || "http://localhost:8787").replace(/\/$/, ""),
    port: num(env.PORT, 8787),
    nodeSigningKey: env.NODE_SIGNING_KEY || undefined,
    metaApiKey: env.META_API_KEY || undefined,
    metaProxySecret: env.META_PROXY_SECRET?.trim() || undefined,
    metaBaseUrl: env.META_BASE_URL || "https://api.meta.ai/v1",
    metaModel: env.META_MODEL || "muse-spark-1.3",
    fireworksApiKey: env.FIREWORKS_API_KEY || undefined,
    fireworksBaseUrl: env.FIREWORKS_BASE_URL || "https://api.fireworks.ai/inference/v1",
    embedProvider: (env.EMBED_PROVIDER || "local") as Config["embedProvider"],
    embedModel: env.EMBED_MODEL || "Xenova/bge-small-en-v1.5",
    embedDim: 384,
    embedCacheDir: resolvePath(env.EMBED_CACHE_DIR || ".models"),
    fireworksEmbedModel: env.FIREWORKS_EMBED_MODEL || "fireworks/qwen3-embedding-8b",
    glimmerBaseUrl: env.GLIMMER_BASE_URL || undefined,
    glimmerApiKey: env.GLIMMER_API_KEY || env.FIREWORKS_API_KEY || undefined,
    glimmerModel: env.GLIMMER_MODEL || "accounts/fireworks/models/muse-glimmer-30b",
    llmDailyCallCap: num(env.LLM_DAILY_CALL_CAP, 0),
    llmMaxOutputTokens: num(env.LLM_MAX_OUTPUT_TOKENS, 1000),
    metaReasoningEffort: env.META_REASONING_EFFORT || "minimal",
    offline: env.AGENTBOARD_OFFLINE === "1",
    challengeTtlMs: num(env.CHALLENGE_TTL_MS, 1000),
    challengeDifficulty: num(env.CHALLENGE_DIFFICULTY, 12),
    registerPowBits: num(env.REGISTER_POW_BITS, 16),
    checkpointEvery: num(env.CHECKPOINT_EVERY, 100),
    clockSkewMs: num(env.CLOCK_SKEW_MS, 10 * 60_000),
    voteCreditMinAgeMs: num(env.VOTE_CREDIT_MIN_AGE_MS, 60 * 60_000),
    hourlyWriteBase: num(env.HOURLY_WRITE_BASE, 30),
    webBotAuthAllowHttp: false,
    skillsOperatorToken: env.SKILLS_OPERATOR_TOKEN?.trim() || undefined,
    skillsInternalSecret: env.SKILLS_INTERNAL_SECRET?.trim() || undefined,
    museDailyCallCap: num(env.MUSE_DAILY_CALL_CAP, 0),
    museSpendCapUsd: num(env.MUSE_SPEND_CAP_USD, 2),
    ...overrides,
  };
  // Contributor-program model variants are never used by this node.
  for (const m of [cfg.metaModel, cfg.glimmerModel]) if (/contributor/i.test(m)) throw new Error(`refusing model "${m}": -contributor variants are not allowed`);
  if (!["local", "fireworks", "hash"].includes(cfg.embedProvider)) throw new Error(`EMBED_PROVIDER must be local, fireworks or hash`);
  if (!(cfg.llmMaxOutputTokens > 0)) throw new Error("LLM_MAX_OUTPUT_TOKENS must be positive");
  for (const [k, v] of [["SKILLS_OPERATOR_TOKEN", cfg.skillsOperatorToken], ["SKILLS_INTERNAL_SECRET", cfg.skillsInternalSecret]] as const) if (v && v.length < 24) throw new Error(`${k} must be at least 24 characters`);
  if (cfg.metaProxySecret) {
    if (cfg.metaProxySecret.length < 32) throw new Error("META_PROXY_SECRET must be at least 32 characters");
    const u = new URL(cfg.metaBaseUrl);
    if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) throw new Error("META_PROXY_SECRET requires an https META_BASE_URL");
    if (u.hostname === "api.meta.ai") throw new Error("META_PROXY_SECRET is for a proxy; META_BASE_URL points at Meta directly");
  }
  return cfg;
}

/** Safe summary for logs and /v1/node: booleans only, never key material. */
export function publicConfigSummary(c: Config) {
  return {
    database: c.databaseUrl ? "postgres" : "pglite",
    llm: { daily_call_cap: c.llmDailyCallCap, max_output_tokens: c.llmMaxOutputTokens, meta: Boolean(c.metaApiKey || c.metaProxySecret) && !c.offline && c.llmDailyCallCap > 0, meta_via: c.metaProxySecret ? new URL(c.metaBaseUrl).host : null, glimmer: Boolean(c.glimmerBaseUrl) && !c.offline && c.llmDailyCallCap > 0 },
    embeddings: c.offline || c.embedProvider === "hash" ? `local-hash-${c.embedDim} (offline fallback)` : c.embedProvider === "fireworks" ? c.fireworksEmbedModel : `${c.embedModel} (in-process)`,
    challenge: { ttl_ms: c.challengeTtlMs, difficulty_bits: c.challengeDifficulty },
    register_pow_bits: c.registerPowBits,
    checkpoint_every: c.checkpointEvery,
    skills: { enabled: Boolean(c.skillsOperatorToken) && c.museDailyCallCap > 0 && !c.offline, executor: Boolean(c.skillsInternalSecret), muse_daily_call_cap: c.museDailyCallCap, muse_spend_cap_usd: c.museSpendCapUsd },
  };
}
