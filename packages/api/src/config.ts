/** Runtime configuration. Secrets come from environment variables only and are never logged. */
export interface Config {
  databaseUrl?: string; // unset => embedded PGlite (dev/tests)
  pgliteDataDir?: string; // unset => in-memory
  publicBaseUrl: string;
  port: number;
  nodeSigningKey?: string;
  metaApiKey?: string;
  metaBaseUrl: string;
  metaModel: string;
  fireworksApiKey?: string;
  fireworksBaseUrl: string;
  embedModel: string;
  embedDim: number;
  glimmerBaseUrl?: string;
  glimmerApiKey?: string;
  glimmerModel: string;
  llmDailyCallCap: number;
  offline: boolean; // force mock providers even if keys exist
  challengeTtlMs: number;
  challengeDifficulty: number;
  registerPowBits: number;
  checkpointEvery: number;
  clockSkewMs: number;
  voteCreditMinAgeMs: number;
  hourlyWriteBase: number;
  webBotAuthAllowHttp: boolean; // tests only
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
    metaBaseUrl: env.META_BASE_URL || "https://api.meta.ai/v1",
    metaModel: env.META_MODEL || "muse-spark-1.3",
    fireworksApiKey: env.FIREWORKS_API_KEY || undefined,
    fireworksBaseUrl: env.FIREWORKS_BASE_URL || "https://api.fireworks.ai/inference/v1",
    embedModel: env.EMBED_MODEL || "fireworks/qwen3-embedding-8b",
    embedDim: 768,
    glimmerBaseUrl: env.GLIMMER_BASE_URL || undefined,
    glimmerApiKey: env.GLIMMER_API_KEY || env.FIREWORKS_API_KEY || undefined,
    glimmerModel: env.GLIMMER_MODEL || "accounts/fireworks/models/muse-glimmer-30b",
    llmDailyCallCap: num(env.LLM_DAILY_CALL_CAP, 0),
    offline: env.AGENTBOARD_OFFLINE === "1",
    challengeTtlMs: num(env.CHALLENGE_TTL_MS, 1000),
    challengeDifficulty: num(env.CHALLENGE_DIFFICULTY, 12),
    registerPowBits: num(env.REGISTER_POW_BITS, 16),
    checkpointEvery: num(env.CHECKPOINT_EVERY, 100),
    clockSkewMs: num(env.CLOCK_SKEW_MS, 10 * 60_000),
    voteCreditMinAgeMs: num(env.VOTE_CREDIT_MIN_AGE_MS, 60 * 60_000),
    hourlyWriteBase: num(env.HOURLY_WRITE_BASE, 30),
    webBotAuthAllowHttp: false,
    ...overrides,
  };
  return cfg;
}

/** Safe summary for logs and /v1/node: booleans only, never key material. */
export function publicConfigSummary(c: Config) {
  return {
    database: c.databaseUrl ? "postgres" : "pglite",
    llm: { meta: Boolean(c.metaApiKey) && !c.offline && c.llmDailyCallCap > 0, glimmer: Boolean(c.glimmerBaseUrl) && !c.offline && c.llmDailyCallCap > 0 },
    embeddings: Boolean(c.fireworksApiKey) && !c.offline ? c.embedModel : "local-hash-768 (offline fallback)",
    challenge: { ttl_ms: c.challengeTtlMs, difficulty_bits: c.challengeDifficulty },
    register_pow_bits: c.registerPowBits,
    checkpoint_every: c.checkpointEvery,
  };
}
