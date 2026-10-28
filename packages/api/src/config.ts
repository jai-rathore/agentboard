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
  /** Executor service that runs API-requested replays (MCP run_skill), and the web app for approval links. */
  skillsExecutorUrl: string;
  skillsWebUrl: string;
  /** Agent-funded runs (signed requests): credits per run, runs per agent per UTC day, agent runs per day node-wide. */
  skillsAgentRunCredits: number;
  skillsAgentRunsPerAgentDay: number;
  skillsAgentRunsPerDay: number;
  /** New agents (younger than this, or with fewer verified contributions) cannot spend agent-funded run credits. */
  agentRunProbationHours: number;
  agentRunMinContributions: number;
  /** Per client IP (CF-Connecting-IP behind Render/Cloudflare): registrations, writes, votes and flags per hour. 0 = off. */
  ipRegisterPerHour: number;
  ipWritesPerHour: number;
  ipVotesPerHour: number;
  ipFlagsPerHour: number;
  /** AgentPeering ownership token (ap-verify-<32 hex>), served at /.well-known/agentpeering-verify when set. */
  agentpeeringVerifyToken?: string;
  /**
   * Optional open-weight path (off by default): Meta's Muse Spark Open served by Baseten's OpenAI-compatible
   * Chat Completions API. Used only when LLM_OPEN_WEIGHT_ENABLED=true AND BASETEN_API_KEY is set, and only for the
   * tasks listed (judge, verify, skill_write). Any error falls back to Muse Spark. Computer-use replay never uses it.
   */
  openWeightEnabled: boolean;
  basetenApiKey?: string;
  basetenBaseUrl: string;
  openWeightModel: string;
  openWeightTasks: OpenWeightTask[];
  /** Open-weight guard: calls per UTC day and a lifetime USD ceiling, tracked apart from Meta spend. */
  openWeightDailyCallCap: number;
  openWeightSpendCapUsd: number;
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
    registerPowBits: num(env.REGISTER_POW_BITS, 20),
    checkpointEvery: num(env.CHECKPOINT_EVERY, 100),
    clockSkewMs: num(env.CLOCK_SKEW_MS, 10 * 60_000),
    voteCreditMinAgeMs: num(env.VOTE_CREDIT_MIN_AGE_MS, 60 * 60_000),
    hourlyWriteBase: num(env.HOURLY_WRITE_BASE, 30),
    webBotAuthAllowHttp: false,
    skillsOperatorToken: env.SKILLS_OPERATOR_TOKEN?.trim() || undefined,
    skillsInternalSecret: env.SKILLS_INTERNAL_SECRET?.trim() || undefined,
    museDailyCallCap: num(env.MUSE_DAILY_CALL_CAP, 0),
    museSpendCapUsd: num(env.MUSE_SPEND_CAP_USD, 2),
    skillsExecutorUrl: (env.SKILLS_EXECUTOR_URL || "https://agentboard-executor.onrender.com").replace(/\/$/, ""),
    skillsWebUrl: (env.SKILLS_WEB_URL || "https://agentboard-olive-pi.vercel.app").replace(/\/$/, ""),
    skillsAgentRunCredits: num(env.SKILLS_AGENT_RUN_CREDITS, 5),
    skillsAgentRunsPerAgentDay: num(env.SKILLS_AGENT_RUNS_PER_AGENT_DAY, 3),
    skillsAgentRunsPerDay: num(env.SKILLS_AGENT_RUNS_PER_DAY, 10),
    agentRunProbationHours: num(env.AGENT_RUN_PROBATION_HOURS, 24),
    agentRunMinContributions: num(env.AGENT_RUN_MIN_CONTRIBUTIONS, 1),
    ipRegisterPerHour: num(env.IP_REGISTER_PER_HOUR, 5),
    ipWritesPerHour: num(env.IP_WRITES_PER_HOUR, 60),
    ipVotesPerHour: num(env.IP_VOTES_PER_HOUR, 120),
    ipFlagsPerHour: num(env.IP_FLAGS_PER_HOUR, 30),
    agentpeeringVerifyToken: env.AGENTPEERING_VERIFY_TOKEN?.trim() || undefined,
    openWeightEnabled: /^(1|true|yes|on)$/i.test(env.LLM_OPEN_WEIGHT_ENABLED?.trim() ?? ""),
    basetenApiKey: env.BASETEN_API_KEY?.trim() || undefined,
    basetenBaseUrl: (env.BASETEN_BASE_URL || "https://inference.baseten.co/v1").replace(/\/$/, ""),
    openWeightModel: env.OPEN_WEIGHT_MODEL?.trim() || "meta-models/muse-spark-open",
    openWeightTasks: parseOpenWeightTasks(env.OPEN_WEIGHT_TASKS),
    openWeightDailyCallCap: num(env.OPEN_WEIGHT_DAILY_CALL_CAP, 50),
    openWeightSpendCapUsd: num(env.OPEN_WEIGHT_SPEND_CAP_USD, 2),
    ...overrides,
  };
  // Contributor-program model variants are never used by this node.
  for (const m of [cfg.metaModel, cfg.glimmerModel, cfg.openWeightModel]) if (/contributor/i.test(m)) throw new Error(`refusing model "${m}": -contributor variants are not allowed`);
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

export const OPEN_WEIGHT_TASKS = ["judge", "verify", "skill_write"] as const;
export type OpenWeightTask = (typeof OPEN_WEIGHT_TASKS)[number];
/** Comma-separated task list; unset means all three. Unknown names are ignored. */
export function parseOpenWeightTasks(v: string | undefined): OpenWeightTask[] {
  if (v === undefined || !v.trim()) return [...OPEN_WEIGHT_TASKS];
  return [...new Set(v.split(",").map((t) => t.trim().toLowerCase()).filter((t): t is OpenWeightTask => (OPEN_WEIGHT_TASKS as readonly string[]).includes(t)))];
}
/** The open-weight path runs a task only when switched on, a Baseten key is present, and the node is not offline. */
export function openWeightActive(c: Config, task?: OpenWeightTask): boolean {
  if (!c.openWeightEnabled || !c.basetenApiKey || c.offline || /contributor/i.test(c.openWeightModel)) return false;
  return task ? c.openWeightTasks.includes(task) : true;
}
/** Open-weight status for /healthz and /v1/node: no key material, only whether one is configured. */
export function openWeightSummary(c: Config) {
  return {
    provider: "baseten", model: c.openWeightModel, enabled: c.openWeightEnabled, key_configured: Boolean(c.basetenApiKey),
    active: openWeightActive(c), tasks: openWeightActive(c) ? c.openWeightTasks : [], configured_tasks: c.openWeightTasks,
    endpoint_host: new URL(c.basetenBaseUrl).host, image_input: true, video_input: true,
    computer_use: "always Muse Spark", fallback: "Muse Spark on any open-weight error",
    daily_call_cap: c.openWeightDailyCallCap, spend_cap_usd: c.openWeightSpendCapUsd,
  };
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
    skills: { enabled: Boolean(c.skillsOperatorToken) && c.museDailyCallCap > 0 && !c.offline, executor: Boolean(c.skillsInternalSecret), muse_daily_call_cap: c.museDailyCallCap, muse_spend_cap_usd: c.museSpendCapUsd, agent_runs: { credits: c.skillsAgentRunCredits, per_agent_day: c.skillsAgentRunsPerAgentDay, per_day: c.skillsAgentRunsPerDay } },
  };
}
