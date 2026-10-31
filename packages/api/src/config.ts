/** Runtime configuration. Secrets come from environment variables only and are never logged. */
/** Parses AGENT_RUN_VOUCHED_DIDS: comma-separated did:keys (anything else is ignored). */
export const vouchedDidsFromEnv = (raw?: string) => [...new Set((raw ?? "").split(",").map((x) => x.trim()).filter((x) => /^did:key:z[1-9A-HJ-NP-Za-km-z]{40,60}$/.test(x)))];

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
  /**
   * Always "hash": lexical feature-hashing vectors, no embedding model (services/embeddings.ts). Old EMBED_PROVIDER /
   * EMBED_MODEL values (local bge-small, fireworks) are ignored with a warning: those non-Meta models were removed.
   */
  embedProvider: "hash";
  embedDim: number;
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
  /**
   * Calls of the daily cap held back for public replays (remote MCP try_skill / POST /v1/skills/:slug/public-replay).
   * Other jobs (seeding, pipelines, operator, agent and benchmark runs) cannot use them. 0 = no reserve.
   */
  musePublicReservedCalls: number;
  /** Executor service that runs API-requested replays (MCP run_skill), and the web app for approval links. */
  skillsExecutorUrl: string;
  skillsWebUrl: string;
  /** Agent-funded runs (signed requests): credits per run, runs per agent per UTC day, agent runs per day node-wide. */
  skillsAgentRunCredits: number;
  skillsAgentRunsPerAgentDay: number;
  skillsAgentRunsPerDay: number;
  /** node-wide safety ceiling on all agent-funded runs per UTC day, including 0-model trace replays */
  skillsAgentRunsCeiling: number;
  /**
   * Public, no-token replay trigger (POST /v1/skills/:slug/public-replay and the remote MCP try_skill): only for
   * allowlisted slugs whose steps are non-destructive. Off unless PUBLIC_REPLAY_DAILY_CAP > 0 (default 0).
   */
  publicReplaySkills: string[];
  /** The benchmark shown as the headline (HEADLINE_BENCHMARK: a benchmark id, or "latest"); used only while it is
   * headline-eligible, else the latest eligible one is. Pinned so a newer benchmark does not replace it unannounced. */
  headlineBenchmark: string | null;
  publicReplayDailyCap: number;
  publicReplayPerIpPerDay: number;
  publicReplayPowBits: number;
  publicReplayChallengeTtlMs: number;
  /** Muse headroom a public replay needs before it starts (calls left today, USD left under the lifetime cap). */
  publicReplayMinMuseCalls: number;
  publicReplayMinMuseUsd: number;
  /** New agents (younger than this, or with fewer verified contributions) cannot spend agent-funded run credits. */
  agentRunProbationHours: number;
  agentRunMinContributions: number;
  /** AGENT_RUN_VOUCHED_DIDS: did:keys the operator vouches for; they skip run probation (not credits, caps or approvals) and are labeled VOUCHED */
  agentRunVouchedDids: string[];
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

let warned = false;
const warnOnce = (m: string) => { if (!warned) { warned = true; console.warn(m); } };
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
    embedProvider: "hash",
    embedDim: 384,
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
    musePublicReservedCalls: num(env.MUSE_PUBLIC_RESERVED_CALLS, 0),
    skillsExecutorUrl: (env.SKILLS_EXECUTOR_URL || "https://agentboard-executor.onrender.com").replace(/\/$/, ""),
    skillsWebUrl: (env.SKILLS_WEB_URL || "https://agentboard-olive-pi.vercel.app").replace(/\/$/, ""),
    skillsAgentRunCredits: num(env.SKILLS_AGENT_RUN_CREDITS, 5),
    skillsAgentRunsPerAgentDay: num(env.SKILLS_AGENT_RUNS_PER_AGENT_DAY, 3),
    skillsAgentRunsPerDay: num(env.SKILLS_AGENT_RUNS_PER_DAY, 10),
    skillsAgentRunsCeiling: num(env.SKILLS_AGENT_RUNS_CEILING, 100),
    publicReplaySkills: (env.PUBLIC_REPLAY_SKILLS ?? "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z0-9][a-z0-9-]{0,80}$/.test(x)),
    headlineBenchmark: (() => { const v = (env.HEADLINE_BENCHMARK ?? "695b986e-e3db-4a45-8d3d-8315be57cece").trim().toLowerCase(); return /^[0-9a-f-]{8,40}$/.test(v) ? v : null; })(),
    publicReplayDailyCap: num(env.PUBLIC_REPLAY_DAILY_CAP, 0),
    publicReplayPerIpPerDay: num(env.PUBLIC_REPLAY_PER_IP_PER_DAY, 3),
    publicReplayPowBits: num(env.PUBLIC_REPLAY_POW_BITS, 16),
    publicReplayChallengeTtlMs: num(env.PUBLIC_REPLAY_CHALLENGE_TTL_MS, 5 * 60_000),
    publicReplayMinMuseCalls: num(env.PUBLIC_REPLAY_MIN_MUSE_CALLS, 20),
    publicReplayMinMuseUsd: num(env.PUBLIC_REPLAY_MIN_MUSE_USD, 0.15),
    agentRunProbationHours: num(env.AGENT_RUN_PROBATION_HOURS, 24),
    agentRunMinContributions: num(env.AGENT_RUN_MIN_CONTRIBUTIONS, 1),
    agentRunVouchedDids: vouchedDidsFromEnv(env.AGENT_RUN_VOUCHED_DIDS),
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
  // Meta models only (hackathon rule and project policy): Muse Spark on Meta's API, Muse Spark Open, Muse Glimmer.
  if (!/^muse-/i.test(cfg.metaModel)) throw new Error(`META_MODEL must be a Meta Muse model, got "${cfg.metaModel}"`);
  if (!/muse-glimmer/i.test(cfg.glimmerModel)) throw new Error(`GLIMMER_MODEL must be Meta's Muse Glimmer, got "${cfg.glimmerModel}"`);
  if (!/muse-spark-open/i.test(cfg.openWeightModel)) throw new Error(`OPEN_WEIGHT_MODEL must be Meta's Muse Spark Open, got "${cfg.openWeightModel}"`);
  if ((env.EMBED_PROVIDER && env.EMBED_PROVIDER !== "hash") || (env.EMBED_MODEL && !/^(none|)$/i.test(env.EMBED_MODEL))) warnOnce(`[agentboard] EMBED_PROVIDER/EMBED_MODEL are ignored: embedding models were removed, search uses lexical feature hashing (no model)`);
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
    embeddings: `local-hash-${c.embedDim} (lexical feature hashing, no model)`,
    challenge: { ttl_ms: c.challengeTtlMs, difficulty_bits: c.challengeDifficulty },
    register_pow_bits: c.registerPowBits,
    checkpoint_every: c.checkpointEvery,
    skills: { enabled: Boolean(c.skillsOperatorToken) && c.museDailyCallCap > 0 && !c.offline, executor: Boolean(c.skillsInternalSecret), muse_daily_call_cap: c.museDailyCallCap, muse_public_reserved_calls: c.musePublicReservedCalls, muse_spend_cap_usd: c.museSpendCapUsd, agent_runs: { credits: c.skillsAgentRunCredits, per_agent_day: c.skillsAgentRunsPerAgentDay, per_day: c.skillsAgentRunsPerDay, ceiling: c.skillsAgentRunsCeiling }, public_replay: { enabled: c.publicReplayDailyCap > 0 && c.publicReplaySkills.length > 0, daily_cap: c.publicReplayDailyCap, per_ip_per_day: c.publicReplayPerIpPerDay, skills: c.publicReplaySkills } },
  };
}
