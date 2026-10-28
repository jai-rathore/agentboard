/**
 * Agentboard Skills: "show it once, every agent can do it".
 *   record   : an mp4 or screenshots of a browser task -> Muse Spark (video/image understanding +
 *              structured output) -> a strict-JSON skill draft (params, steps, success check, risk flags).
 *   replay   : the executor service drives headless Chromium with Spark's built-in computer tool.
 *   publish  : after Spark verifies the final screenshot, the node signs a `skill` record (first
 *              success) and a `skill_run` record (every replay) into the hash-chained log, with
 *              content-addressed evidence (final screenshot, GIF) that anyone can fetch and hash.
 */
import { createRecord, sha256Hex, type SignedRecord } from "@agentboard/core";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { HttpError } from "../context.js";
import { appendToLog } from "./log.js";
import { museResponses, outputText, reasoningSummary, type MuseUsage } from "./muse.js";

export const ARTIFACT_MIME = ["video/mp4", "image/jpeg", "image/png", "image/gif"] as const;
export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
export const RISK_FLAGS = ["submits_form", "sends_message", "purchase", "deletes_data", "login_required", "personal_data", "none"] as const;
export const ACTIONS = ["navigate", "click", "type", "select", "scroll", "keypress", "wait"] as const;

/** Flat, strict JSON schema for Spark's structured output (no recursion). */
export const SKILL_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["name", "summary", "start_url_hint", "params", "steps", "success_check", "risk_flags"],
  properties: {
    name: { type: "string", description: "short imperative name, e.g. Create a helpdesk ticket" },
    summary: { type: "string" },
    start_url_hint: { type: "string", description: "URL or page the task starts on, as visible in the recording" },
    params: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "description", "example"], properties: { name: { type: "string", description: "snake_case" }, description: { type: "string" }, example: { type: "string" } } } },
    steps: { type: "array", items: { type: "object", additionalProperties: false, required: ["intent", "target", "action", "value"], properties: {
      intent: { type: "string" }, target: { type: "string", description: "visual description of the element" },
      action: { type: "string", enum: [...ACTIONS] }, value: { type: "string", description: "literal text, a {{param}} placeholder, or empty" } } } },
    success_check: { type: "string", description: "what must be visible on screen when the task succeeded" },
    risk_flags: { type: "array", items: { type: "string", enum: [...RISK_FLAGS] } },
  },
} as const;

export const SkillZ = z.object({
  name: z.string().min(1).max(120), summary: z.string().max(1000), start_url_hint: z.string().max(500),
  params: z.array(z.object({ name: z.string().min(1).max(60), description: z.string().max(300), example: z.string().max(300) })).max(20),
  steps: z.array(z.object({ intent: z.string().max(300), target: z.string().max(300), action: z.enum(ACTIONS), value: z.string().max(500) })).min(1).max(40),
  success_check: z.string().min(1).max(500),
  risk_flags: z.array(z.enum(RISK_FLAGS)).max(7),
});
export type Skill = z.infer<typeof SkillZ>;

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "skill";

// ---------------------------------------------------------------- artifacts (content-addressed)

export async function putArtifact(ctx: AppContext, bytes: Uint8Array, mime: string): Promise<{ sha256: string; size: number; mime: string }> {
  if (!(ARTIFACT_MIME as readonly string[]).includes(mime)) throw new HttpError(415, "unsupported_media", `allowed: ${ARTIFACT_MIME.join(", ")}`);
  if (bytes.length === 0 || bytes.length > MAX_ARTIFACT_BYTES) throw new HttpError(413, "artifact_size", `artifacts must be 1 byte to ${MAX_ARTIFACT_BYTES / 1048576} MB`);
  const sha = sha256Hex(bytes);
  await ctx.db.query(`INSERT INTO artifacts (sha256, mime, size, bytes) VALUES ($1,$2,$3,$4) ON CONFLICT (sha256) DO NOTHING`, [sha, mime, bytes.length, bytes]);
  return { sha256: sha, size: bytes.length, mime };
}

export async function getArtifact(ctx: AppContext, sha: string): Promise<{ mime: string; bytes: Uint8Array } | null> {
  if (!/^[0-9a-f]{64}$/.test(sha)) return null;
  const r = (await ctx.db.query<any>(`SELECT mime, bytes FROM artifacts WHERE sha256 = $1`, [sha])).rows[0];
  return r ? { mime: r.mime, bytes: new Uint8Array(r.bytes) } : null;
}

export const artifactUrl = (ctx: AppContext, sha: string) => `${ctx.cfg.publicBaseUrl}/v1/artifacts/${sha}`;

// ---------------------------------------------------------------- record: video/screenshots -> skill draft

export const RECORD_PROMPT = `This is a recording of a person doing a task in a web browser (a screen recording, or screenshots in order).
Turn it into a reusable skill that another agent can replay with different values:
- params: every user-specific value typed or chosen (emails, names, text, options), as snake_case names with the recorded value as the example.
- steps: one per user action, in order. "target" describes the element visually (label, placeholder, color, position) so it can be found on a fresh screenshot. Use {{param}} placeholders in "value".
- success_check: what is visibly on screen once the task has succeeded (be specific, mention the param values that should appear).
- risk_flags: submits_form, sends_message, purchase, deletes_data, login_required, personal_data (or none).`;

export interface RecordInput { video?: string; frames?: string[]; hint?: string; start_url?: string; parent_slug?: string }

export async function recordSkill(ctx: AppContext, input: RecordInput) {
  const frames = input.frames ?? [];
  if (!input.video && !frames.length) throw new HttpError(400, "no_source", "send a video artifact or screenshot artifacts");
  if (frames.length > 24) throw new HttpError(400, "too_many_frames", "at most 24 screenshots");
  const content: any[] = [{ type: "input_text", text: RECORD_PROMPT + (input.hint ? `\nThe person describes the task as: ${input.hint.slice(0, 300)}` : "") + (input.start_url ? `\nThe task starts at ${input.start_url}.` : "") }];
  let capability: string;
  if (input.video && !frames.length) {
    const a = await getArtifact(ctx, input.video);
    if (!a || a.mime !== "video/mp4") throw new HttpError(404, "video_not_found", "no such mp4 artifact");
    // Small clips go inline (the proxy accepts ~4 MB bodies); larger ones by URL, fetched by Meta from this node.
    content.push(a.bytes.length <= 2_800_000
      ? { type: "input_video", video_url: `data:video/mp4;base64,${Buffer.from(a.bytes).toString("base64")}` }
      : { type: "input_video", video_url: artifactUrl(ctx, input.video) });
    capability = "video understanding + structured output";
  } else {
    // Screenshots, or frames the browser sampled from a long video (2 fps, 640 px); the video itself stays the display source.
    if (input.video && !(await getArtifact(ctx, input.video))) throw new HttpError(404, "video_not_found", "no such mp4 artifact");
    let total = 0;
    for (const sha of frames) {
      const a = await getArtifact(ctx, sha);
      if (!a || !a.mime.startsWith("image/")) throw new HttpError(404, "frame_not_found", `no such image artifact ${sha.slice(0, 12)}`);
      total += a.bytes.length;
      if (total > 2_800_000) throw new HttpError(413, "frames_too_large", "screenshots exceed ~2.8 MB in total; downscale to 640-960 px JPEG");
      content.push({ type: "input_image", image_url: `data:${a.mime};base64,${Buffer.from(a.bytes).toString("base64")}` });
    }
    capability = "image understanding + structured output";
  }
  const r = await museResponses(ctx, "record", {
    input: [{ role: "user", content }],
    reasoning: { effort: "low", summary: "auto" },
    text: { format: { type: "json_schema", name: "skill", strict: true, schema: SKILL_SCHEMA } },
  });
  if (r.response.status === "incomplete") throw new HttpError(502, "muse_incomplete", `Muse stopped early (${r.response.incomplete_details?.reason ?? "unknown"})`);
  let skill: Skill;
  try { skill = SkillZ.parse(JSON.parse(outputText(r.response))); } catch (e) { throw new HttpError(502, "muse_bad_skill", `Muse returned an unusable skill: ${(e as Error).message.slice(0, 200)}`); }
  const id = crypto.randomUUID();
  const source = { video: input.video ?? null, frames, start_url: input.start_url ?? null, hint: input.hint ?? null };
  const usage = { ...r.usage, ms: r.ms };
  const summary = reasoningSummary(r.response) || null;
  await ctx.db.query(`INSERT INTO skill_drafts (id, source, skill, reasoning_summary, model, capability, usage, parent_slug) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, JSON.stringify(source), JSON.stringify(skill), summary, r.model, capability, JSON.stringify(usage), input.parent_slug ?? null]);
  return { id, skill, source, reasoning_summary: summary, model: r.model, capability, usage };
}

export async function getDraft(ctx: AppContext, id: string) {
  const d = (await ctx.db.query<any>(`SELECT * FROM skill_drafts WHERE id = $1`, [id])).rows[0];
  if (!d) throw new HttpError(404, "draft_not_found", "no such skill draft");
  const j = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
  return { id: d.id, created_at: d.created_at, status: d.status, source: j(d.source), skill: j(d.skill) as Skill, reasoning_summary: d.reasoning_summary, model: d.model, capability: d.capability, usage: j(d.usage), parent_slug: d.parent_slug, published_cid: d.published_cid, runs: j(d.runs) };
}

// ---------------------------------------------------------------- runs -> signed records

export const RunZ = z.object({
  draft_id: z.string().uuid().optional(),
  skill_cid: z.string().max(120).optional(),
  start_url: z.string().url().max(500),
  params: z.record(z.string(), z.string().max(500)),
  success: z.boolean(),
  verdict: z.object({ success: z.boolean(), evidence: z.string().max(1500), model: z.string(), capability: z.string() }),
  turns: z.number().int().min(0).max(30),
  actions: z.array(z.object({ turn: z.number().int(), type: z.string().max(20), detail: z.string().max(300), approval: z.enum(["auto", "human", "none"]), checks: z.array(z.string().max(80)).max(5) })).max(200),
  usage: z.object({ calls: z.number().int(), input_tokens: z.number(), cached_tokens: z.number(), output_tokens: z.number(), usd: z.number() }),
  model: z.string().max(60),
  final_jpeg_b64: z.string().max(3_000_000),
  gif_b64: z.string().max(12_000_000).optional(),
  executor: z.object({ name: z.string().max(80), chromium: z.string().max(80), viewport: z.string().max(20) }),
  duration_ms: z.number().int(),
});
export type RunInput = z.infer<typeof RunZ>;

const sysRecord = (ctx: AppContext, type: "skill" | "skill_run", body: Record<string, unknown>) => createRecord(ctx.node, type, body, new Date(ctx.now()));
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * Store a finished replay. A successful replay of an unpublished draft publishes the skill (signed
 * `skill` record, next version of its slug) followed by the signed `skill_run`. Replays of a published
 * skill add a `skill_run` (success or failure: the log is honest). Failed draft replays stay on the draft.
 */
export async function submitRun(ctx: AppContext, run: RunInput) {
  if (!run.draft_id === !run.skill_cid) throw new HttpError(400, "target", "send exactly one of draft_id or skill_cid");
  if (run.success !== run.verdict.success) throw new HttpError(400, "verdict", "success must match the Muse verdict");
  const final = await putArtifact(ctx, Buffer.from(run.final_jpeg_b64, "base64"), "image/jpeg");
  const gif = run.gif_b64 ? await putArtifact(ctx, Buffer.from(run.gif_b64, "base64"), "image/gif") : null;
  const runSummary = {
    params: run.params, start_url: run.start_url, success: run.success, turns: run.turns, duration_ms: run.duration_ms,
    verdict: { success: run.verdict.success, evidence: run.verdict.evidence, model: run.verdict.model, capability: run.verdict.capability },
    loop: { model: run.model, capability: "computer use (built-in computer tool) + image understanding" },
    actions: run.actions,
    evidence: { final_screenshot: final.sha256, gif: gif?.sha256 ?? null },
    usage: { ...run.usage, usd: round6(run.usage.usd) },
    executor: run.executor,
  };

  let skillCid = run.skill_cid;
  let published: SignedRecord | null = null;
  if (run.draft_id) {
    const d = await getDraft(ctx, run.draft_id);
    if (d.published_cid) skillCid = d.published_cid;
    else if (!run.success) {
      await ctx.db.query(`UPDATE skill_drafts SET runs = runs || $2::jsonb WHERE id = $1`, [d.id, JSON.stringify([{ ...runSummary, at: new Date(ctx.now()).toISOString() }])]);
      return { status: "draft_run_failed", draft_id: d.id, evidence: runSummary.evidence };
    } else {
      const slug = d.parent_slug ? slugify(d.parent_slug) : slugify(d.skill.name);
      const prev = (await ctx.db.query<any>(`SELECT cid, version FROM skills WHERE slug = $1 ORDER BY version DESC LIMIT 1`, [slug])).rows[0];
      const body = {
        slug, version: (prev?.version ?? 0) + 1, prev: prev?.cid ?? null,
        skill: d.skill,
        source: { video: d.source.video, frames: d.source.frames, start_url: run.start_url },
        recorder: { model: d.model, capability: d.capability, reasoning_summary: d.reasoning_summary, usage: { ...d.usage, usd: round6(d.usage.usd ?? 0) } },
        draft: d.id,
      };
      published = sysRecord(ctx, "skill", body);
    }
  }
  if (!skillCid && !published) throw new HttpError(400, "target", "nothing to attach the run to");
  if (skillCid && !published && !(await ctx.db.query(`SELECT 1 FROM skills WHERE cid = $1`, [skillCid])).rows[0]) throw new HttpError(404, "skill_not_found", "no such skill");
  const runRec = sysRecord(ctx, "skill_run", { skill: published?.cid ?? skillCid!, ...runSummary });
  const out = await ctx.db.tx(async (tx) => {
    let skillSeq: number | undefined;
    if (published) {
      const b = published.body as any;
      skillSeq = (await appendToLog(tx, ctx, published)).seq;
      await tx.query(`INSERT INTO skills (cid, slug, version, prev_cid, name, summary, created_at, draft_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [published.cid, b.slug, b.version, b.prev, b.skill.name, b.skill.summary, published.created_at, b.draft]);
      await tx.query(`UPDATE skill_drafts SET status = 'published', published_cid = $2 WHERE id = $1`, [b.draft, published.cid]);
    }
    const a = await appendToLog(tx, ctx, runRec);
    await tx.query(`INSERT INTO skill_runs (cid, skill_cid, success, created_at) VALUES ($1,$2,$3,$4)`, [runRec.cid, published?.cid ?? skillCid, run.success, runRec.created_at]);
    return { skillSeq, runSeq: a.seq };
  });
  for (const r of [published, runRec]) if (r) ctx.events.dispatchEvent(new CustomEvent("append", { detail: { cid: r.cid, type: r.type } }));
  return { status: published ? "published" : "run_recorded", skill_cid: published?.cid ?? skillCid, skill_seq: out.skillSeq, run_cid: runRec.cid, run_seq: out.runSeq, evidence: runSummary.evidence };
}

// ---------------------------------------------------------------- reads

export async function listSkills(ctx: AppContext, q?: string) {
  const like = q?.trim() ? `%${q.trim().toLowerCase()}%` : null;
  const rows = (await ctx.db.query<any>(`
    SELECT s.cid, s.slug, s.version, s.name, s.summary, s.created_at,
      (SELECT count(*)::int FROM skill_runs r JOIN skills v ON v.cid = r.skill_cid WHERE v.slug = s.slug AND r.success) AS verified_runs,
      (SELECT count(*)::int FROM skill_runs r JOIN skills v ON v.cid = r.skill_cid WHERE v.slug = s.slug) AS runs
    FROM skills s
    WHERE s.version = (SELECT max(version) FROM skills x WHERE x.slug = s.slug)
      AND ($1::text IS NULL OR lower(s.name || ' ' || s.summary || ' ' || s.slug) LIKE $1)
    ORDER BY s.created_at DESC LIMIT 100`, [like])).rows;
  return rows;
}

export async function getSkill(ctx: AppContext, cid: string) {
  const s = (await ctx.db.query<any>(`SELECT * FROM skills WHERE cid = $1`, [cid])).rows[0];
  if (!s) throw new HttpError(404, "skill_not_found", "no such skill");
  const rec = async (c: string) => (await ctx.db.query<any>(`SELECT r.cid, r.type, r.author, r.created_at, r.body_text, r.sig, l.seq::int AS seq, l.prev_hash, l.entry_hash FROM records r JOIN log l ON l.cid = r.cid WHERE r.cid = $1`, [c])).rows[0];
  const toRecord = (r: any) => ({ seq: r.seq, log: { prev_hash: r.prev_hash, entry_hash: r.entry_hash }, record: { v: 1, type: r.type, author: r.author, created_at: r.created_at, body: JSON.parse(r.body_text), cid: r.cid, sig: r.sig } });
  const versions = (await ctx.db.query<any>(`SELECT cid, version, created_at, name FROM skills WHERE slug = $1 ORDER BY version DESC`, [s.slug])).rows;
  const runCids = (await ctx.db.query<any>(`SELECT cid FROM skill_runs WHERE skill_cid = $1 ORDER BY created_at DESC LIMIT 50`, [cid])).rows.map((r) => r.cid);
  const runs = [];
  for (const c of runCids) runs.push(toRecord(await rec(c)));
  const allVerified = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM skill_runs r JOIN skills v ON v.cid = r.skill_cid WHERE v.slug = $1 AND r.success`, [s.slug])).rows[0]?.n ?? 0);
  return {
    skill: toRecord(await rec(cid)),
    slug: s.slug, version: s.version, latest_version: versions[0]?.version ?? s.version,
    versions, runs,
    badge: { verified: runs.some((r: any) => r.record.body.success), replayed: runs.length, verified_runs_this_version: runs.filter((r: any) => r.record.body.success).length, verified_runs_all_versions: allVerified },
    node: ctx.node.did,
  };
}

export type { MuseUsage };
