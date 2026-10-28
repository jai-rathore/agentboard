/**
 * Public, capped replay trigger: anyone (no operator token, no agent identity) can replay an allowlisted,
 * non-destructive skill with their own inputs, so outsiders can check reuse for themselves.
 *   - Off unless PUBLIC_REPLAY_DAILY_CAP > 0 (default 0). Only slugs in PUBLIC_REPLAY_SKILLS, and only while the
 *     skill's latest version passes publicReplaySafety (no submit/buy/send/delete, login or personal data).
 *   - A single-use challenge first: a small sha256 proof of work over HTTP; a short arithmetic question for the
 *     remote MCP try_skill tool (an LLM agent can answer it; it only stops blind scripts, the caps are the limit).
 *   - Caps, checked and charged in one transaction under the same advisory lock as agent-funded runs:
 *     PUBLIC_REPLAY_PER_IP_PER_DAY per client IP (CF-Connecting-IP / True-Client-IP only, stored hashed),
 *     PUBLIC_REPLAY_DAILY_CAP node-wide, the node's daily budget for non-operator runs (SKILLS_AGENT_RUNS_PER_DAY,
 *     shared with agent-funded runs), and Muse headroom under the daily call cap and the lifetime USD ceiling
 *     (every Muse call of the run is still reserved and counted one by one).
 *   - Jobs are via = 'public'; the signed run record says trigger: "public".
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { canonicalize, sha256, sha256Hex, leadingZeroBits, publicReplaySafety, bytesToHex } from "@agentboard/core";
import type { AppContext } from "../context.js";
import { HttpError } from "../context.js";
import { resolveSkill, checkParams, dispatchJob, getJob, jobUrl } from "./skillJobs.js";
import { museHeadroom } from "./muse.js";

/** Set by the remote /mcp route on its in-process requests; never accepted from outside (random per process). */
export const MCP_INTERNAL_HEADER = "x-agentboard-mcp-internal";
export const MCP_CLIENT_IP_HEADER = "x-agentboard-client-ip";
export const MCP_INTERNAL_TOKEN = bytesToHex(randomBytes(24));
const LOCK = 7240311; // same lock as agent-funded runs: the node-wide budget is shared

export type ChallengeKind = "pow" | "mcp";
export const ipHash = (ip: string) => createHash("sha256").update(`agentboard-public-replay:${ip}`).digest("hex").slice(0, 32);
export const paramsHash = (params: Record<string, string>) => sha256Hex(canonicalize(params));
export const powDigest = (nonce: string, slug: string, pHash: string, counter: number) => sha256(`${nonce}:${slug}:${pHash}:${counter}`);
export function solvePublicPow(ch: { nonce: string; bits: number; params_hash: string }, slug: string, max = 50_000_000): number {
  for (let n = 0; n < max; n++) if (leadingZeroBits(powDigest(ch.nonce, slug, ch.params_hash, n)) >= ch.bits) return n;
  throw new Error("no solution");
}
const day = (ctx: AppContext) => new Date(ctx.now()).toISOString().slice(0, 10);
/** Jobs that never reached the executor (it was busy or unreachable) do not count against anyone's cap. */
const COUNTED = `NOT (status = 'failed' AND turns = '[]'::jsonb AND verdict IS NULL AND result IS NULL)`;

function assertEnabled(ctx: AppContext) {
  if (!(ctx.cfg.publicReplayDailyCap > 0)) throw new HttpError(503, "public_replay_disabled", "Public replay is disabled on this node (PUBLIC_REPLAY_DAILY_CAP is 0). Use the local MCP server's run_skill with your own agent identity instead.");
  if (!ctx.cfg.skillsInternalSecret) throw new HttpError(503, "executor_disabled", "no executor configured");
}

/** The latest runnable version of an allowlisted slug, if it is safe for public replay. */
export async function publicSkill(ctx: AppContext, slug: string) {
  const s = String(slug ?? "").toLowerCase();
  if (!ctx.cfg.publicReplaySkills.includes(s)) throw new HttpError(403, "not_allowlisted", `${s || "this skill"} is not open for public replay; allowed: ${ctx.cfg.publicReplaySkills.join(", ") || "(none)"}`);
  const { cid, body } = await resolveSkill(ctx, s);
  if (body.slug !== s) throw new HttpError(404, "skill_not_found", "public replay takes a skill slug");
  const safety = publicReplaySafety(body.skill);
  if (!safety.ok) throw new HttpError(403, "not_safe_for_public_replay", `this skill's latest version is not non-destructive: ${safety.reasons.join("; ")}`);
  return { cid, body };
}

async function counts(ctx: AppContext, db: AppContext["db"], ipH: string | null) {
  const d = day(ctx);
  const n = async (sql: string, p: unknown[]) => Number((await db.query<any>(sql, p)).rows[0]?.n ?? 0);
  return {
    ip: ipH ? await n(`SELECT count(*)::int AS n FROM skill_jobs WHERE via = 'public' AND client_ip_hash = $1 AND created_at >= $2::date AND ${COUNTED}`, [ipH, d]) : 0,
    all: await n(`SELECT count(*)::int AS n FROM skill_jobs WHERE via = 'public' AND created_at >= $1::date AND ${COUNTED}`, [d]),
    node: await n(`SELECT count(*)::int AS n FROM skill_jobs WHERE via IN ('agent', 'public') AND created_at >= $1::date AND ${COUNTED}`, [d]),
  };
}
function checkCaps(ctx: AppContext, c: { ip: number; all: number; node: number }) {
  if (c.ip >= ctx.cfg.publicReplayPerIpPerDay) throw new HttpError(429, "public_replay_ip_limit", `at most ${ctx.cfg.publicReplayPerIpPerDay} public replays per network per day (UTC); try again tomorrow`);
  if (c.all >= ctx.cfg.publicReplayDailyCap) throw new HttpError(429, "public_replay_daily_cap", `today's public replay budget (${ctx.cfg.publicReplayDailyCap}) is used up; it resets at 00:00 UTC`);
  if (c.node >= ctx.cfg.skillsAgentRunsPerDay) throw new HttpError(429, "node_run_quota", "this node's daily budget for non-operator skill runs is used up");
}

export async function publicReplayStatus(ctx: AppContext) {
  const c = await counts(ctx, ctx.db, null);
  const skills = [];
  for (const slug of ctx.cfg.publicReplaySkills) {
    try { const { cid, body } = await publicSkill(ctx, slug); skills.push({ slug, cid, name: body.skill.name, eligible: true, params: body.skill.params, start_url: body.source?.start_url ?? null }); }
    catch (e) { skills.push({ slug, eligible: false, reason: (e as Error).message }); }
  }
  const enabled = ctx.cfg.publicReplayDailyCap > 0 && Boolean(ctx.cfg.skillsInternalSecret);
  return {
    enabled, daily_cap: ctx.cfg.publicReplayDailyCap, per_ip_per_day: ctx.cfg.publicReplayPerIpPerDay, used_today: c.all,
    remaining_today: Math.max(0, ctx.cfg.publicReplayDailyCap - c.all), pow_bits: ctx.cfg.publicReplayPowBits, skills,
    how: "POST /v1/skills/{slug}/public-replay with {params}: the first call returns 428 with a challenge; solve it and send {params, challenge: {id, counter}}. The response has the run id; poll GET /v1/skills/jobs/{id}. Over MCP, use the remote try_skill tool.",
  };
}

async function issue(ctx: AppContext, kind: ChallengeKind, slug: string, ipH: string, pHash: string) {
  const now = ctx.now();
  await ctx.db.query(`DELETE FROM public_replay_challenges WHERE expires_at < $1`, [now - 3_600_000]);
  const open = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM public_replay_challenges WHERE ip_hash = $1 AND used_at IS NULL AND expires_at >= $2`, [ipH, now])).rows[0]?.n ?? 0);
  if (open >= 5) throw new HttpError(429, "too_many_challenges", "too many open challenges from your network; solve one or wait a few minutes");
  const id = "prc_" + bytesToHex(randomBytes(12));
  const nonce = bytesToHex(randomBytes(16));
  const expires_at = now + ctx.cfg.publicReplayChallengeTtlMs;
  let answer: number | null = null, question: string | undefined;
  if (kind === "mcp") {
    const a = randomInt(12, 99), b = randomInt(3, 9), c = randomInt(10, 99);
    answer = a * b + c;
    question = `What is ${a} × ${b} + ${c}?`;
  }
  const bits = kind === "pow" ? ctx.cfg.publicReplayPowBits : 0;
  await ctx.db.query(`INSERT INTO public_replay_challenges (id, kind, slug, ip_hash, params_hash, nonce, bits, answer, issued_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, kind, slug, ipH, pHash, nonce, bits, answer, now, expires_at]);
  return kind === "pow"
    ? { id, kind, nonce, bits, params_hash: pHash, expires_at, rule: `find an integer counter >= 0 such that sha256 of the UTF-8 string "${nonce}:${slug}:${pHash}:<counter>" has at least ${bits} leading zero bits; then resend the same params with challenge {id, counter}. Single use, bound to this skill, these params and your network; expires in ${Math.round(ctx.cfg.publicReplayChallengeTtlMs / 1000)} s.` }
    : { id, kind, question, expires_at, rule: `answer the question and call try_skill again with the same slug and inputs plus challenge_id "${id}" and answer. Single use, bound to this skill, these inputs and your network; expires in ${Math.round(ctx.cfg.publicReplayChallengeTtlMs / 1000)} s.` };
}

/** Burns the challenge (committed even when the solution is wrong) and checks it. */
async function consume(ctx: AppContext, kind: ChallengeKind, slug: string, ipH: string, pHash: string, sol: any) {
  if (!sol || typeof sol.id !== "string") throw new HttpError(400, "challenge", "challenge must be {id, counter} (or challenge_id and answer over MCP)");
  const now = ctx.now();
  const row = (await ctx.db.query<any>(`UPDATE public_replay_challenges SET used_at = $2 WHERE id = $1 AND used_at IS NULL RETURNING *`, [sol.id, now])).rows[0];
  if (!row) throw new HttpError(403, "challenge_invalid", "unknown or already-used challenge; ask for a new one");
  if (row.kind !== kind) throw new HttpError(403, "challenge_invalid", "that challenge was issued for the other trigger");
  if (now > Number(row.expires_at)) throw new HttpError(403, "challenge_expired", "challenge expired; ask for a new one");
  if (row.slug !== slug || row.params_hash !== pHash) throw new HttpError(403, "challenge_mismatch", "the challenge was issued for a different skill or different params");
  if (row.ip_hash !== ipH) throw new HttpError(403, "challenge_mismatch", "the challenge was issued to a different network");
  if (kind === "mcp") {
    if (Number(sol.answer) !== Number(row.answer)) throw new HttpError(403, "challenge_failed", "wrong answer; ask for a new challenge");
  } else {
    const counter = Number(sol.counter);
    if (!Number.isSafeInteger(counter) || counter < 0) throw new HttpError(403, "challenge_failed", "counter must be a non-negative integer");
    if (leadingZeroBits(powDigest(row.nonce, slug, pHash, counter)) < Number(row.bits)) throw new HttpError(403, "challenge_failed", "insufficient proof of work");
  }
}

/**
 * Start a public replay. Without a challenge solution it validates everything cheap first (enabled, allowlist,
 * safety, params, caps, Muse headroom) and then answers 428 with a fresh challenge.
 */
export async function startPublicReplay(ctx: AppContext, slugIn: string, req: { params?: unknown; challenge?: unknown }, ip: string | null, kind: ChallengeKind) {
  assertEnabled(ctx);
  const slug = String(slugIn ?? "").toLowerCase();
  if (!ip) throw new HttpError(400, "client_ip_required", "the client IP could not be determined (CF-Connecting-IP or True-Client-IP); public replay needs it for the per-network limit");
  const { cid, body } = await publicSkill(ctx, slug);
  const given = req.params && typeof req.params === "object" && !Array.isArray(req.params) ? (req.params as Record<string, unknown>) : {};
  const params = checkParams(body.skill, given);
  const ipH = ipHash(ip), pHash = paramsHash(params);
  checkCaps(ctx, await counts(ctx, ctx.db, ipH));
  await museHeadroom(ctx, ctx.cfg.publicReplayMinMuseCalls, ctx.cfg.publicReplayMinMuseUsd);
  if (!req.challenge) {
    const challenge = await issue(ctx, kind, slug, ipH, pHash);
    throw new HttpError(428, "challenge_required", kind === "pow" ? "solve the proof-of-work challenge and resend with {params, challenge: {id, counter}}" : `answer the challenge: ${challenge.question}`, { challenge });
  }
  await consume(ctx, kind, slug, ipH, pHash, req.challenge);
  const id = crypto.randomUUID();
  const start_url = body.source.start_url as string;
  await ctx.db.tx(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(${LOCK})`);
    checkCaps(ctx, await counts(ctx, tx, ipH));
    await museHeadroom(ctx, ctx.cfg.publicReplayMinMuseCalls, ctx.cfg.publicReplayMinMuseUsd, tx);
    await tx.query(`INSERT INTO skill_jobs (id, skill_cid, params, start_url, requested_by, via, status, message, client_ip_hash, created_at, updated_at) VALUES ($1,$2,$3,$4,'public','public','queued','Waking the executor',$5,$6,$6)`,
      [id, cid, JSON.stringify(params), start_url, ipH, new Date(ctx.now())]);
  });
  await dispatchJob(ctx, id);
  const job = await getJob(ctx, id);
  return { ...job, trigger: "public", poll: `/v1/skills/jobs/${id}`, run_page: jobUrl(ctx, id) };
}
