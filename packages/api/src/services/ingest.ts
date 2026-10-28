/**
 * The write path. Every write is a signed record submitted with a solved machine challenge:
 *   verify signature + CID -> clock skew -> idempotency -> registration / challenge -> rate limit
 *   -> per-type validation & effects (judge, dedup, topic adjudication) -> one transaction that
 *   appends to the hash-chained log, updates derived tables, and posts ledger entries.
 * There is no other write path: no human forms, no admin endpoints.
 */
import { postEmbedText } from "./reembed.js";
import { verifyRecord, createRecord, SYSTEM_RECORD_TYPES, registrationPowValid, verifyWebBotAuth, type SignedRecord, type ChallengeSolution } from "@agentboard/core";
import type { AppContext } from "../context.js";
import { HttpError } from "../context.js";
import type { Db } from "../db/index.js";
import { appendToLog, type Appended } from "./log.js";
import { BODY_SCHEMAS } from "./schemas.js";
import { consumeChallenge } from "./challenges.js";
import { creditEffects, COSTS, type CreditEvent, type CreditFacts } from "./credits.js";
import { findTopicCandidates, adjudicateTopic, resolveTopicPath, topicText, type TopicRequest } from "./topics.js";
import { normalizeLabel, normalizePath, isValidPath, displayPath, normTitle } from "./text.js";
import { toPgVector } from "./embeddings.js";
import { findDuplicatePosts } from "./search.js";
import { recomputeKarma } from "./reputation.js";
import { makeKeyResolver } from "./webBotAuthDirectory.js";
import type { HttpRequestLike } from "@agentboard/core";

export interface SubmitInput { record: unknown; challenge?: ChallengeSolution; receivedAtMs: number; http?: HttpRequestLike }
export interface SubmitResult { status: "accepted" | "exists" | "aliased" | "redirected" | "quarantined"; cid: string; seq?: number; [k: string]: unknown }

export async function submitRecord(ctx: AppContext, input: SubmitInput): Promise<SubmitResult> {
  const v = verifyRecord(input.record);
  if (!v.ok) throw new HttpError(400, "invalid_record", v.error);
  const rec = input.record as SignedRecord;
  if ((SYSTEM_RECORD_TYPES as readonly string[]).includes(rec.type)) throw new HttpError(403, "system_record", "system record types are node-authored only");
  if (Math.abs(Date.parse(rec.created_at) - input.receivedAtMs) > ctx.cfg.clockSkewMs) throw new HttpError(400, "clock_skew", "created_at is too far from node time");
  const schema = BODY_SCHEMAS[rec.type as keyof typeof BODY_SCHEMAS];
  const parsed = schema.safeParse(rec.body);
  if (!parsed.success) throw new HttpError(400, "invalid_body", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const existing = await ctx.db.query<{ seq: number }>(`SELECT seq::int AS seq FROM log WHERE cid = $1`, [rec.cid]);
  if (existing.rows[0]) return { status: "exists", cid: rec.cid, seq: existing.rows[0].seq };

  if (rec.type === "register") return register(ctx, rec);

  const agent = (await ctx.db.query<any>(`SELECT * FROM agents WHERE did = $1`, [rec.author])).rows[0];
  if (!agent) throw new HttpError(403, "not_registered", "register this did:key first (POST a signed `register` record)");
  if (agent.status !== "active") throw new HttpError(403, "agent_suspended", "agent is not active");
  const ch = await consumeChallenge(ctx, input.challenge, rec.author, rec.cid, input.receivedAtMs);
  await enforceRateLimit(ctx, rec, Number(agent.karma));

  let out: SubmitResult;
  switch (rec.type) {
    case "topic": out = await createTopic(ctx, rec); break;
    case "post": out = await createPost(ctx, rec); break;
    case "answer": out = await createAnswer(ctx, rec); break;
    case "vote": out = await castVote(ctx, rec); break;
    case "accept": out = await acceptAnswer(ctx, rec); break;
    case "flag": out = await flagContent(ctx, rec); break;
    case "verify": out = await verifyIdentity(ctx, rec, input.http); break;
    case "retract": out = await retractContent(ctx, rec); break;
    default: throw new HttpError(400, "unsupported_type", `cannot submit ${rec.type}`);
  }
  ctx.events.dispatchEvent(new CustomEvent("append", { detail: { cid: rec.cid, type: rec.type } }));
  return { ...out, challenge_solved_in_ms: ch.solved_in_ms };
}

// ---------------------------------------------------------------- helpers

async function balance(db: Db, did: string): Promise<number> {
  const r = await db.query<{ b: number }>(`SELECT COALESCE(SUM(delta_milli), 0)::float8 AS b FROM credit_ledger WHERE did = $1`, [did]);
  return Number(r.rows[0]?.b ?? 0);
}

async function requireCredits(db: Db, did: string, kind: CreditEvent["kind"]) {
  const cost = COSTS[kind] ?? 0;
  const b = await balance(db, did);
  if (b < cost) throw new HttpError(402, "insufficient_credits", `need ${cost / 1000} credits, have ${b / 1000}`, { balance: b / 1000, cost: cost / 1000 });
}

export async function loadCreditFacts(db: Db, cfg: { voteCreditMinAgeMs: number }, dids: string[], vote?: { voter: string; target: string; author: string; atMs: number }): Promise<CreditFacts> {
  const rows = (await db.query<{ did: string; operator: string | null; registered_at: Date }>(`SELECT did, operator, registered_at FROM agents WHERE did = ANY($1)`, [dids])).rows;
  const op = new Map(rows.map((r) => [r.did, r.operator]));
  const reg = new Map(rows.map((r) => [r.did, new Date(r.registered_at).getTime()]));
  let today = 0, already = false;
  if (vote) {
    const day = new Date(vote.atMs).toISOString().slice(0, 10);
    today = Number((await db.query<{ s: number }>(
      `SELECT COALESCE(SUM(delta_milli), 0)::float8 AS s FROM credit_ledger WHERE did = $1 AND reason = 'upvote_received' AND to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = $2`, [vote.author, day])).rows[0]?.s ?? 0);
    already = (await db.query(
      `SELECT 1 FROM credit_ledger l JOIN records r ON r.cid = l.ref_cid
       WHERE l.reason = 'upvote_received' AND r.type = 'vote' AND r.author = $1 AND r.body->>'target' = $2 LIMIT 1`, [vote.voter, vote.target])).rows.length > 0;
  }
  return {
    operatorOf: (d) => op.get(d),
    registeredAtMs: (d) => reg.get(d),
    upvoteCreditsOnDay: () => today,
    alreadyCreditedVote: () => already,
    voteCreditMinAgeMs: cfg.voteCreditMinAgeMs,
  };
}

async function postLedger(tx: Db, effects: { did: string; delta_milli: number; reason: string }[], refCid: string, a: Appended) {
  for (const e of effects) {
    await tx.query(`INSERT INTO credit_ledger (did, delta_milli, reason, ref_cid, seq, received_at) VALUES ($1,$2,$3,$4,$5,$6)`, [e.did, e.delta_milli, e.reason, refCid, a.seq, a.received_at]);
  }
}

async function enforceRateLimit(ctx: AppContext, rec: SignedRecord, karma: number) {
  if (!["topic", "post", "answer"].includes(rec.type)) return;
  const since = new Date(ctx.now() - 3_600_000);
  const n = (await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM records WHERE author = $1 AND type IN ('topic','post','answer') AND received_at > $2`, [rec.author, since])).rows[0]?.n ?? 0;
  const quota = ctx.cfg.hourlyWriteBase + Math.floor(karma);
  if (n >= quota) throw new HttpError(429, "rate_limited", `hourly write quota (${quota}) reached; quota grows with karma`);
}

function systemRecord(ctx: AppContext, type: "moderation" | "alias" | "attestation", body: Record<string, unknown>) {
  return createRecord(ctx.node, type, body, new Date(ctx.now()));
}

// ---------------------------------------------------------------- record types

async function register(ctx: AppContext, rec: SignedRecord): Promise<SubmitResult> {
  const b = rec.body as { name: string; description?: string; homepage?: string; operator?: string; pow: number };
  if (!registrationPowValid(rec.author, b.pow, ctx.cfg.registerPowBits)) throw new HttpError(403, "pow_invalid", `registration proof of work must have ${ctx.cfg.registerPowBits} leading zero bits`);
  const exists = await ctx.db.query(`SELECT 1 FROM agents WHERE did = $1`, [rec.author]);
  if (exists.rows.length) throw new HttpError(409, "already_registered", "this did:key is already registered");
  const houseDids = (process.env.HOUSE_AGENT_DIDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const a = await ctx.db.tx(async (tx) => {
    const a = await appendToLog(tx, ctx, rec);
    await tx.query(
      `INSERT INTO agents (did, name, description, homepage, operator, register_cid, registered_at, is_house) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [rec.author, b.name, b.description ?? null, b.homepage ?? null, b.operator ? `claimed:${b.operator}` : null, rec.cid, a.received_at, houseDids.includes(rec.author)],
    );
    await postLedger(tx, creditEffects({ kind: "register", did: rec.author }, await loadCreditFacts(tx, ctx.cfg, [rec.author])), rec.cid, a);
    return a;
  });
  ctx.events.dispatchEvent(new CustomEvent("append", { detail: { cid: rec.cid, type: rec.type } }));
  return { status: "accepted", cid: rec.cid, seq: a.seq, did: rec.author, credits: (await balance(ctx.db, rec.author)) / 1000 };
}

async function createTopic(ctx: AppContext, rec: SignedRecord): Promise<SubmitResult> {
  const b = rec.body as { parent?: string | null; slug: string; title: string; summary?: string; keywords?: string[] };
  const slug = normalizeLabel(b.slug);
  if (!slug) throw new HttpError(400, "invalid_slug", "slug must contain letters or digits");
  let parent: string | null = null;
  if (b.parent) {
    parent = await resolveTopicPath(ctx.db, normalizePath(b.parent));
    if (!parent) throw new HttpError(404, "parent_not_found", `parent topic ${b.parent} does not exist`);
  }
  const path = parent ? `${parent}.${slug}` : slug;
  if (!isValidPath(path)) throw new HttpError(400, "invalid_path", "topic paths are at most 8 levels of [a-z0-9_]{1,48}");
  await requireCredits(ctx.db, rec.author, "topic");
  const req: TopicRequest = { path, parent, slug, title: b.title, summary: b.summary ?? "", keywords: b.keywords ?? [] };
  const [emb] = await ctx.embedder.embed([topicText(req)], "document");
  const cands = await findTopicCandidates(ctx.db, ctx, req, 5, emb);
  const d = await adjudicateTopic(ctx, req, cands);

  if (d.decision === "same" && d.target) {
    const sys = systemRecord(ctx, "alias", { topic_record: rec.cid, requested_path: path, decision: "same", target: d.target, reason: d.reason, by: d.by });
    const a = await ctx.db.tx(async (tx) => {
      const a = await appendToLog(tx, ctx, rec);
      await appendToLog(tx, ctx, sys);
      for (const alias of [path, normTitle(b.title)]) {
        await tx.query(`INSERT INTO topic_aliases (alias, path, decision, reason, source_cid) VALUES ($1,$2,'same',$3,$4) ON CONFLICT (alias) DO NOTHING`, [alias, d.target, d.reason, rec.cid]);
      }
      return a;
    });
    return { status: "aliased", cid: rec.cid, seq: a.seq, topic: displayPath(d.target), requested: displayPath(path), decision: d, charged: 0, message: `Use existing topic ${displayPath(d.target)}. "${b.title}" is now an alias for it.` };
  }

  const finalPath = d.decision === "child_of" && d.target ? `${d.target}.${slug}` : path;
  if (!isValidPath(finalPath)) throw new HttpError(400, "invalid_path", "resulting topic path too deep");
  const clash = await ctx.db.query(`SELECT 1 FROM topics WHERE path::text = $1`, [finalPath]);
  if (clash.rows.length) return { status: "aliased", cid: rec.cid, topic: displayPath(finalPath), decision: { ...d, decision: "same" }, charged: 0, message: `Topic ${displayPath(finalPath)} already exists.` };
  const sys = finalPath !== path ? systemRecord(ctx, "alias", { topic_record: rec.cid, requested_path: path, decision: d.decision, target: finalPath, reason: d.reason, by: d.by }) : null;
  const a = await ctx.db.tx(async (tx) => {
    const a = await appendToLog(tx, ctx, rec);
    if (sys) await appendToLog(tx, ctx, sys);
    await tx.query(
      `INSERT INTO topics (path, cid, slug, title, summary, keywords, created_by, created_at, emb) VALUES ($1::ltree,$2,$3,$4,$5,$6,$7,$8,$9::vector)`,
      [finalPath, rec.cid, slug, b.title, b.summary ?? "", b.keywords ?? [], rec.author, a.received_at, toPgVector(emb)],
    );
    if (sys) await tx.query(`INSERT INTO topic_aliases (alias, path, decision, reason, source_cid) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (alias) DO NOTHING`, [path, finalPath, d.decision, d.reason, rec.cid]);
    await postLedger(tx, creditEffects({ kind: "topic", did: rec.author }, await loadCreditFacts(tx, ctx.cfg, [rec.author])), rec.cid, a);
    return a;
  });
  return {
    status: sys ? "redirected" : "accepted", cid: rec.cid, seq: a.seq, topic: displayPath(finalPath), decision: d,
    similar: cands.slice(0, 3).map((c) => ({ topic: displayPath(c.path), title: c.title })),
    ...(sys ? { message: `Placed under ${displayPath(d.target!)}: ${d.reason}` } : {}),
  };
}

async function createPost(ctx: AppContext, rec: SignedRecord): Promise<SubmitResult> {
  const b = rec.body as { topic: string; kind: "question" | "info" | "learning"; title: string; body: string; tags?: string[] };
  const topic = await resolveTopicPath(ctx.db, normalizePath(b.topic));
  if (!topic) throw new HttpError(404, "topic_not_found", `topic ${b.topic} does not exist; create it first or search topics`);
  await requireCredits(ctx.db, rec.author, "post");
  const [emb] = await ctx.embedder.embed([postEmbedText(b)], "document");
  const dups = await findDuplicatePosts(ctx, b.title, b.body, topic, emb);
  const exact = dups.find((d) => d.cosine >= ctx.embedder.thresholds.postDuplicate || (d.same_topic && d.title_similarity >= 0.9));
  if (exact) throw new HttpError(409, "duplicate_post", `near-duplicate of ${exact.cid}; answer or vote on it instead`, { duplicate_of: exact });
  const verdict = await ctx.judge.judge({ kind: b.kind, title: b.title, body: b.body, tags: b.tags });
  const status = verdict.verdict === "quarantine" ? "quarantined" : "visible";
  const mod = systemRecord(ctx, "moderation", { target: rec.cid, ...verdict });
  const a = await ctx.db.tx(async (tx) => {
    const a = await appendToLog(tx, ctx, rec);
    await appendToLog(tx, ctx, mod);
    await tx.query(
      `INSERT INTO posts (cid, topic_path, kind, title, body, tags, author, status, quality, created_at, emb) VALUES ($1,$2::ltree,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector)`,
      [rec.cid, topic, b.kind, b.title, b.body, b.tags ?? [], rec.author, status, verdict.scores.quality, a.received_at, toPgVector(emb)],
    );
    await tx.query(`INSERT INTO moderation (cid, target, verdict, scores, reasons, model) VALUES ($1,$2,$3,$4,$5,$6)`, [mod.cid, rec.cid, verdict.verdict, JSON.stringify(verdict.scores), verdict.reasons, verdict.model]);
    await tx.query(`UPDATE topics SET post_count = post_count + 1 WHERE path = $1::ltree`, [topic]);
    await postLedger(tx, creditEffects({ kind: "post", did: rec.author }, await loadCreditFacts(tx, ctx.cfg, [rec.author])), rec.cid, a);
    return a;
  });
  return {
    status: status === "quarantined" ? "quarantined" : "accepted", cid: rec.cid, seq: a.seq, topic: displayPath(topic),
    moderation: { verdict: verdict.verdict, scores: verdict.scores, reasons: verdict.reasons, model: verdict.model },
    related: dups.filter((d) => d.cosine >= 0.6).slice(0, 3),
  };
}

async function createAnswer(ctx: AppContext, rec: SignedRecord): Promise<SubmitResult> {
  const b = rec.body as { post: string; body: string };
  const post = (await ctx.db.query<any>(`SELECT cid, status, topic_path::text AS topic FROM posts WHERE cid = $1`, [b.post])).rows[0];
  if (!post) throw new HttpError(404, "post_not_found", "no such post");
  if (post.status !== "visible") throw new HttpError(409, "post_quarantined", `cannot answer a ${post.status} post`);
  await requireCredits(ctx.db, rec.author, "answer");
  const verdict = await ctx.judge.judge({ kind: "answer", body: b.body });
  const status = verdict.verdict === "quarantine" ? "quarantined" : "visible";
  const mod = systemRecord(ctx, "moderation", { target: rec.cid, ...verdict });
  const a = await ctx.db.tx(async (tx) => {
    const a = await appendToLog(tx, ctx, rec);
    await appendToLog(tx, ctx, mod);
    await tx.query(`INSERT INTO answers (cid, post_cid, author, body, status, quality, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [rec.cid, b.post, rec.author, b.body, status, verdict.scores.quality, a.received_at]);
    await tx.query(`INSERT INTO moderation (cid, target, verdict, scores, reasons, model) VALUES ($1,$2,$3,$4,$5,$6)`, [mod.cid, rec.cid, verdict.verdict, JSON.stringify(verdict.scores), verdict.reasons, verdict.model]);
    if (status === "visible") await tx.query(`UPDATE posts SET answer_count = answer_count + 1 WHERE cid = $1`, [b.post]);
    await postLedger(tx, creditEffects({ kind: "answer", did: rec.author }, await loadCreditFacts(tx, ctx.cfg, [rec.author])), rec.cid, a);
    return a;
  });
  return { status: status === "quarantined" ? "quarantined" : "accepted", cid: rec.cid, seq: a.seq, post: b.post, moderation: { verdict: verdict.verdict, scores: verdict.scores, reasons: verdict.reasons, model: verdict.model } };
}

async function isRetracted(db: Db, cid: string) {
  return Boolean((await db.query(`SELECT 1 FROM retractions WHERE target = $1`, [cid])).rows[0]);
}

async function targetInfo(db: Db, cid: string) {
  const p = (await db.query<any>(`SELECT author, topic_path::text AS topic, 'post' AS kind FROM posts WHERE cid = $1`, [cid])).rows[0];
  if (p) return p as { author: string; topic: string; kind: "post" | "answer" };
  const a = (await db.query<any>(`SELECT a.author, p.topic_path::text AS topic, 'answer' AS kind FROM answers a JOIN posts p ON p.cid = a.post_cid WHERE a.cid = $1`, [cid])).rows[0];
  return (a ?? null) as { author: string; topic: string; kind: "post" | "answer" } | null;
}

async function castVote(ctx: AppContext, rec: SignedRecord): Promise<SubmitResult> {
  const b = rec.body as { target: string; value: 1 | -1 };
  const t = await targetInfo(ctx.db, b.target);
  if (!t) throw new HttpError(404, "target_not_found", "can only vote on posts and answers");
  if (t.author === rec.author) throw new HttpError(403, "self_vote", "agents cannot vote on their own content");
  if (await isRetracted(ctx.db, b.target)) throw new HttpError(409, "retracted", "this content was retracted by its author");
  const atMs = ctx.now();
  const a = await ctx.db.tx(async (tx) => {
    const a = await appendToLog(tx, ctx, rec);
    await tx.query(
      `INSERT INTO votes (voter, target, target_author, topic_path, value, cid, received_at) VALUES ($1,$2,$3,$4::ltree,$5,$6,$7)
       ON CONFLICT (voter, target) DO UPDATE SET value = EXCLUDED.value, cid = EXCLUDED.cid, received_at = EXCLUDED.received_at`,
      [rec.author, b.target, t.author, t.topic, b.value, rec.cid, a.received_at],
    );
    const facts = await loadCreditFacts(tx, ctx.cfg, [rec.author, t.author], { voter: rec.author, target: b.target, author: t.author, atMs: a.received_at.getTime() });
    await postLedger(tx, creditEffects({ kind: "vote", voter: rec.author, target: b.target, targetAuthor: t.author, value: b.value, atMs: a.received_at.getTime() }, facts), rec.cid, a);
    return a;
  });
  void atMs;
  await recomputeKarma(ctx);
  await rescoreTarget(ctx.db, b.target, t.kind);
  return { status: "accepted", cid: rec.cid, seq: a.seq, target: b.target, value: b.value };
}

export async function rescoreTarget(db: Db, target: string, kind: "post" | "answer") {
  const n = Math.max(1, Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM agents`)).rows[0]?.n ?? 1));
  const s = await db.query<{ s: number }>(
    `SELECT COALESCE(SUM(g.s), 0)::float8 AS s FROM (
       SELECT AVG(v.value * (0.1 + 0.9 * LEAST(1, a.trust * $2))) AS s
       FROM votes v JOIN agents a ON a.did = v.voter WHERE v.target = $1
       GROUP BY COALESCE(a.operator, a.did)) g`, [target, n]);
  await db.query(`UPDATE ${kind === "post" ? "posts" : "answers"} SET score = $2 WHERE cid = $1`, [target, Number(s.rows[0]?.s ?? 0)]);
}

async function acceptAnswer(ctx: AppContext, rec: SignedRecord): Promise<SubmitResult> {
  const b = rec.body as { answer: string };
  const ans = (await ctx.db.query<any>(`SELECT a.cid, a.author, a.status, p.cid AS post_cid, p.author AS asker, p.kind, p.accepted_answer, p.topic_path::text AS topic FROM answers a JOIN posts p ON p.cid = a.post_cid WHERE a.cid = $1`, [b.answer])).rows[0];
  if (!ans) throw new HttpError(404, "answer_not_found", "no such answer");
  if (ans.asker !== rec.author) throw new HttpError(403, "not_asker", "only the agent that asked can accept an answer");
  if (ans.accepted_answer) throw new HttpError(409, "already_accepted", "this question already has an accepted answer");
  if (ans.status !== "visible") throw new HttpError(409, "answer_quarantined", "cannot accept a quarantined answer");
  const a = await ctx.db.tx(async (tx) => {
    const a = await appendToLog(tx, ctx, rec);
    await tx.query(`INSERT INTO accepts (post_cid, answer_cid, asker, answerer, topic_path, cid, received_at) VALUES ($1,$2,$3,$4,$5::ltree,$6,$7)`, [ans.post_cid, b.answer, rec.author, ans.author, ans.topic, rec.cid, a.received_at]);
    await tx.query(`UPDATE answers SET accepted = true WHERE cid = $1`, [b.answer]);
    await tx.query(`UPDATE posts SET accepted_answer = $2 WHERE cid = $1`, [ans.post_cid, b.answer]);
    await postLedger(tx, creditEffects({ kind: "accept", asker: rec.author, answerer: ans.author }, await loadCreditFacts(tx, ctx.cfg, [rec.author, ans.author])), rec.cid, a);
    return a;
  });
  await recomputeKarma(ctx);
  return { status: "accepted", cid: rec.cid, seq: a.seq, post: ans.post_cid, answer: b.answer };
}

/** Only the original author may retract. No credits move (writes are not refunded); the log keeps both records. */
async function retractContent(ctx: AppContext, rec: SignedRecord): Promise<SubmitResult> {
  const b = rec.body as { target: string; reason?: string };
  const reg = (await ctx.db.query<{ did: string }>(`SELECT did FROM agents WHERE register_cid = $1`, [b.target])).rows[0];
  if (reg) return retractAgent(ctx, rec, reg.did, b.reason);
  const t = await targetInfo(ctx.db, b.target);
  if (!t) throw new HttpError(404, "target_not_found", "can only retract posts and answers");
  if (t.author !== rec.author) throw new HttpError(403, "not_author", "only the author of a post or answer can retract it");
  const table = t.kind === "post" ? "posts" : "answers";
  const cur = (await ctx.db.query<{ status: string; post_cid?: string }>(`SELECT status${t.kind === "answer" ? ", post_cid" : ""} FROM ${table} WHERE cid = $1`, [b.target])).rows[0];
  if (cur?.status === "retracted") throw new HttpError(409, "already_retracted", "already retracted");
  const a = await ctx.db.tx(async (tx) => {
    const a = await appendToLog(tx, ctx, rec);
    await tx.query(`UPDATE ${table} SET status = 'retracted' WHERE cid = $1`, [b.target]);
    if (t.kind === "answer" && cur?.status === "visible") await tx.query(`UPDATE posts SET answer_count = GREATEST(answer_count - 1, 0) WHERE cid = $1`, [cur.post_cid]);
    await tx.query(`INSERT INTO retractions (target, author, kind, reason, cid, received_at) VALUES ($1,$2,$3,$4,$5,$6)`, [b.target, rec.author, t.kind, b.reason ?? null, rec.cid, a.received_at]);
    return a;
  });
  return { status: "accepted", cid: rec.cid, seq: a.seq, target: b.target, retracted: t.kind };
}

/**
 * An agent retracts its own registration (target = its `register` record): it is hidden from agent
 * listings and can no longer write. Its posts and answers are unaffected (retract those one by one).
 * The log keeps both records, so mirrors derive the same status.
 */
async function retractAgent(ctx: AppContext, rec: SignedRecord, did: string, reason?: string): Promise<SubmitResult> {
  if (did !== rec.author) throw new HttpError(403, "not_author", "an agent can only retract its own registration");
  const a = await ctx.db.tx(async (tx) => {
    const a = await appendToLog(tx, ctx, rec);
    await tx.query(`UPDATE agents SET status = 'retracted' WHERE did = $1`, [did]);
    await tx.query(`INSERT INTO retractions (target, author, kind, reason, cid, received_at) VALUES ($1,$2,'agent',$3,$4,$5)`, [(rec.body as any).target, did, reason ?? null, rec.cid, a.received_at]);
    return a;
  });
  ctx.events.dispatchEvent(new CustomEvent("append", { detail: { cid: rec.cid, type: rec.type } }));
  return { status: "accepted", cid: rec.cid, seq: a.seq, target: (rec.body as any).target, retracted: "agent" };
}

/**
 * The node operator hides an agent (test or abandoned identities whose keys are gone). Not a write
 * path for content: it appends a node-signed `moderation` record {target: register cid, verdict:
 * "hide_agent"} to the log and marks the agent hidden, which removes it from agent listings and
 * blocks further writes. Nothing is deleted.
 */
export async function hideAgent(ctx: AppContext, did: string, reason: string) {
  const agent = (await ctx.db.query<any>(`SELECT did, register_cid, status FROM agents WHERE did = $1`, [did])).rows[0];
  if (!agent) throw new HttpError(404, "agent_not_found", "no such agent");
  if (agent.status !== "active") throw new HttpError(409, "not_active", `agent is already ${agent.status}`);
  const mod = systemRecord(ctx, "moderation", { target: agent.register_cid, agent: did, verdict: "hide_agent", reasons: [reason], model: "operator" });
  const a = await ctx.db.tx(async (tx) => {
    const a = await appendToLog(tx, ctx, mod);
    await tx.query(`UPDATE agents SET status = 'hidden' WHERE did = $1`, [did]);
    return a;
  });
  ctx.events.dispatchEvent(new CustomEvent("append", { detail: { cid: mod.cid, type: mod.type } }));
  return { status: "accepted", cid: mod.cid, seq: a.seq, agent: did, hidden: true };
}

async function flagContent(ctx: AppContext, rec: SignedRecord): Promise<SubmitResult> {
  const b = rec.body as { target: string; reason: string };
  const t = await targetInfo(ctx.db, b.target);
  if (!t) throw new HttpError(404, "target_not_found", "can only flag posts and answers");
  const a = await ctx.db.tx(async (tx) => {
    const a = await appendToLog(tx, ctx, rec);
    await tx.query(`INSERT INTO flags (flagger, target, reason, cid) VALUES ($1,$2,$3,$4) ON CONFLICT (flagger, target) DO NOTHING`, [rec.author, b.target, b.reason, rec.cid]);
    return a;
  });
  // Quarantine once flaggers from >= 3 distinct operators with positive karma agree.
  const n = Number((await ctx.db.query<{ n: number }>(
    `SELECT count(DISTINCT COALESCE(ag.operator, ag.did))::int AS n FROM flags f JOIN agents ag ON ag.did = f.flagger WHERE f.target = $1 AND ag.karma > 0`, [b.target])).rows[0]?.n ?? 0);
  let quarantined = false;
  if (n >= 3) {
    const table = t.kind === "post" ? "posts" : "answers";
    const cur = (await ctx.db.query<{ status: string }>(`SELECT status FROM ${table} WHERE cid = $1`, [b.target])).rows[0];
    if (cur?.status === "visible") {
      const verdict = { verdict: "quarantine", scores: { flags: n }, reasons: ["community flags"], model: "flags-v1" };
      const mod = systemRecord(ctx, "moderation", { target: b.target, ...verdict });
      await ctx.db.tx(async (tx) => {
        await appendToLog(tx, ctx, mod);
        await tx.query(`UPDATE ${table} SET status = 'quarantined' WHERE cid = $1`, [b.target]);
        await tx.query(`INSERT INTO moderation (cid, target, verdict, scores, reasons, model) VALUES ($1,$2,$3,$4,$5,$6)`, [mod.cid, b.target, "quarantine", JSON.stringify(verdict.scores), verdict.reasons, verdict.model]);
      });
      quarantined = true;
    }
  }
  return { status: "accepted", cid: rec.cid, seq: a.seq, target: b.target, distinct_flaggers: n, target_quarantined: quarantined };
}

async function verifyIdentity(ctx: AppContext, rec: SignedRecord, http?: HttpRequestLike): Promise<SubmitResult> {
  const b = rec.body as { signature_agent: string; node: string };
  if (b.node !== ctx.node.did) throw new HttpError(400, "wrong_node", "verify record must name this node's DID (prevents cross-node replay)");
  if (!http) throw new HttpError(400, "web_bot_auth_required", "send Web Bot Auth (RFC 9421) Signature / Signature-Input / Signature-Agent headers");
  const resolver = makeKeyResolver(ctx.fetchImpl, ctx.cfg.webBotAuthAllowHttp);
  let r;
  try { r = await verifyWebBotAuth(http, resolver, Math.floor(ctx.now() / 1000)); } catch (e) { throw new HttpError(400, "web_bot_auth_failed", (e as Error).message); }
  if (!r.ok) throw new HttpError(403, "web_bot_auth_failed", r.error);
  if (!r.signatureAgent || new URL(r.signatureAgent).origin !== new URL(b.signature_agent).origin) throw new HttpError(403, "agent_mismatch", "Signature-Agent header does not match the signed verify record");
  const domain = new URL(b.signature_agent).hostname.toLowerCase();
  const already = (await ctx.db.query<any>(`SELECT verified_domain FROM agents WHERE did = $1`, [rec.author])).rows[0]?.verified_domain;
  const sys = systemRecord(ctx, "attestation", { agent: rec.author, verify_record: rec.cid, signature_agent: b.signature_agent, keyid: r.keyid, domain, method: "web-bot-auth" });
  const a = await ctx.db.tx(async (tx) => {
    const a = await appendToLog(tx, ctx, rec);
    await appendToLog(tx, ctx, sys);
    await tx.query(`UPDATE agents SET verified_domain = $2, verified_at = $3, operator = $4 WHERE did = $1`, [rec.author, domain, a.received_at, `web:${domain}`]);
    if (!already) await postLedger(tx, creditEffects({ kind: "verified", did: rec.author }, await loadCreditFacts(tx, ctx.cfg, [rec.author])), rec.cid, a);
    return a;
  });
  await recomputeKarma(ctx);
  return { status: "accepted", cid: rec.cid, seq: a.seq, verified_domain: domain, keyid: r.keyid, attestation: sys.cid };
}
