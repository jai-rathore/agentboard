/**
 * Agentboard Skills: "show it once, every agent can do it".
 *   record   : an mp4 or screenshots of a browser task -> Muse Spark (video/image understanding +
 *              structured output) -> a strict-JSON skill draft (params, steps, success check, risk flags).
 *   replay   : the executor service drives headless Chromium with Spark's built-in computer tool.
 *   publish  : after Spark verifies the final screenshot, the node signs a `skill` record (first
 *              success) and a `skill_run` record (every replay) into the hash-chained log, with
 *              content-addressed evidence (final screenshot, GIF) that anyone can fetch and hash.
 *   heal     : when a verified replay shows that steps no longer match the site (Spark reported a changed
 *              step, or the elements actually used no longer carry the recorded names), Spark rewrites the
 *              steps from what it saw and the node publishes a signed next version linked to the run.
 */
import { createRecord, sha256Hex, effectiveRiskFlags, gatedSteps, GATED_FLAGS, type SignedRecord } from "@agentboard/core";
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
    success_check: { type: "string", description: "what must be visible on screen when the task succeeded; param values only as {{param}}, no input-dependent text copied from the recording" },
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
  const duration = mime === "video/mp4" ? mp4DurationMs(bytes) : null;
  await ctx.db.query(`INSERT INTO artifacts (sha256, mime, size, bytes, duration_ms) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (sha256) DO NOTHING`, [sha, mime, bytes.length, bytes, duration]);
  return { sha256: sha, size: bytes.length, mime };
}

export async function getArtifact(ctx: AppContext, sha: string): Promise<{ mime: string; bytes: Uint8Array } | null> {
  if (!/^[0-9a-f]{64}$/.test(sha)) return null;
  const r = (await ctx.db.query<any>(`SELECT mime, bytes FROM artifacts WHERE sha256 = $1`, [sha])).rows[0];
  return r ? { mime: r.mime, bytes: new Uint8Array(r.bytes) } : null;
}

/** Duration of an mp4 from its movie header (mvhd), or null. */
export function mp4DurationMs(b: Uint8Array): number | null {
  for (let i = 4; i + 32 < b.length; i++) {
    if (b[i] !== 0x6d || b[i + 1] !== 0x76 || b[i + 2] !== 0x68 || b[i + 3] !== 0x64) continue; // "mvhd"
    const dv = new DataView(b.buffer, b.byteOffset + i + 4);
    const [ts, dur] = dv.getUint8(0) === 1 ? [dv.getUint32(20), Number(dv.getBigUint64(24))] : [dv.getUint32(12), dv.getUint32(16)];
    return ts > 0 && dur > 0 && dur < 2 ** 52 ? Math.round((dur * 1000) / ts) : null;
  }
  return null;
}

/** How long the human took in the source recording (mp4 only; screenshots have no clock). */
export async function recordingMs(ctx: AppContext, source: { video?: string | null }): Promise<number | null> {
  if (!source?.video) return null;
  const r = (await ctx.db.query<any>(`SELECT duration_ms FROM artifacts WHERE sha256 = $1`, [source.video])).rows[0];
  if (!r) return null;
  if (r.duration_ms != null) return Number(r.duration_ms);
  const a = await getArtifact(ctx, source.video);
  const d = a ? mp4DurationMs(a.bytes) : null;
  if (d != null) await ctx.db.query(`UPDATE artifacts SET duration_ms = $2 WHERE sha256 = $1`, [source.video, d]);
  return d;
}

/** Human time per run: one look and a click per approval. */
export const APPROVAL_HUMAN_MS = 5000;
export function timeSaved(recording: number | null, run: { duration_ms: number; actions: { approval: string }[] }) {
  const approvals = run.actions.filter((a) => a.approval === "human").length;
  const human = approvals * APPROVAL_HUMAN_MS;
  // Lead with human input: the agent does every click; a human only approves gated steps.
  // Wall-clock comparison is only meaningful (and only shown) when the agent beat the human recording.
  return {
    human_clicks: 0, human_approvals: approvals, recording_ms: recording, run_ms: run.duration_ms,
    agent_faster: recording != null && run.duration_ms < recording,
    human_ms: human, saved_ms: recording == null ? null : Math.max(0, recording - human),
  };
}

export const artifactUrl = (ctx: AppContext, sha: string) => `${ctx.cfg.publicBaseUrl}/v1/artifacts/${sha}`;

// ---------------------------------------------------------------- record: video/screenshots -> skill draft

export const RECORD_PROMPT = `This is a recording of a person doing a task in a web browser (a screen recording, or screenshots in order).
Turn it into a reusable skill that another agent can replay with different values:
- params: every user-specific value typed or chosen (emails, names, text, options), as snake_case names with the recorded value as the example.
- steps: one per user action, in order. "target" describes the element visually (label, placeholder, color, position) so it can be found on a fresh screenshot. Use {{param}} placeholders in "value".
- success_check: what is visibly on screen once the task has succeeded (be specific, mention the param values that should appear). It is checked on replays with DIFFERENT param values, so write every param value as its {{param}} placeholder, and never copy text that depends on the inputs (a discount label, a price, a total, a computed status, a search result title) from the recording; describe it generically instead (e.g. 'a discount line for {{coupon_code}} and a reduced total', not 'Code BEANS10 applied: 10% off').
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
  return { id: d.id, created_at: d.created_at, status: d.status, source: j(d.source), skill: j(d.skill) as Skill, reasoning_summary: d.reasoning_summary, model: d.model, capability: d.capability, usage: j(d.usage), parent_slug: d.parent_slug, published_cid: d.published_cid, runs: j(d.runs) };
}

// ---------------------------------------------------------------- runs -> signed records

export const RunZ = z.object({
  draft_id: z.string().uuid().optional(),
  skill_cid: z.string().max(120).optional(),
  job_id: z.string().uuid().optional(),
  step_changes: z.array(z.object({ step: z.number().int().min(1).max(40), observed: z.string().max(300), turn: z.number().int() })).max(40).default([]),
  human_ms: z.number().int().min(0).optional(),
  start_url: z.string().url().max(500),
  params: z.record(z.string(), z.string().max(500)),
  success: z.boolean(),
  verdict: z.object({ success: z.boolean(), evidence: z.string().max(1500), model: z.string(), capability: z.string() }),
  turns: z.number().int().min(0).max(30),
  actions: z.array(z.object({ turn: z.number().int(), type: z.string().max(20), detail: z.string().max(300), approval: z.enum(["auto", "human", "none"]), checks: z.array(z.string().max(80)).max(5), target: z.string().max(120).optional(), flags: z.array(z.string().max(40)).max(4).optional() })).max(200),
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
const j = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);

// ---------------------------------------------------------------- self-healing

/**
 * Steps whose recorded target no longer matches anything the replay actually used: the accessible names
 * of the elements clicked or typed into (labels, button text) must appear in the step's description.
 */
export function staleSteps(skill: Skill, actions: { target?: string }[]): number[] {
  const names = [...new Set(actions.map((a) => (a.target ?? "").toLowerCase().trim()).filter((n) => n.length >= 3))];
  if (!names.length) return [];
  const out: number[] = [];
  skill.steps.forEach((s, i) => {
    if (!["click", "type", "select"].includes(s.action)) return;
    const text = `${s.intent} ${s.target}`.toLowerCase();
    if (!names.some((n) => text.includes(n))) out.push(i + 1);
  });
  return out;
}

export const HEAL_PROMPT = `A recorded browser skill was just replayed and the result was verified, but some of its steps no longer match the website (it was redesigned: labels, button text or positions changed).
Rewrite the skill so each step describes the site as it is NOW, using the replay's evidence: the elements the agent actually used (their visible names), the agent's own notes about changed steps, and the final screenshot.
Return the full new "steps" list and the "success_check". Rules: use exactly the same {{param}} placeholders (params cannot change); change the success check only if the visible confirmation changed (keep {{param}} placeholders and never copy input-dependent text such as prices, totals or labels into it); update targets (label text, button text, position, color), intents and order as needed. Be concise.
List every change in "changes" (1-based step number in the NEW list, the field, before, after, and a short reason). If nothing needs to change, return the steps unchanged and an empty "changes" list.`;

const HEAL_SCHEMA = {
  type: "object", additionalProperties: false, required: ["steps", "success_check", "changes"],
  properties: {
    steps: SKILL_SCHEMA.properties.steps,
    success_check: SKILL_SCHEMA.properties.success_check,
    changes: { type: "array", items: { type: "object", additionalProperties: false, required: ["step", "field", "before", "after", "reason"], properties: { step: { type: "integer" }, field: { type: "string" }, before: { type: "string" }, after: { type: "string" }, reason: { type: "string" } } } },
  },
} as const;
const ChangeZ = z.object({ step: z.number().int(), field: z.string().max(40), before: z.string().max(400), after: z.string().max(400), reason: z.string().max(400) });

export async function healSkill(ctx: AppContext, skill: Skill, run: RunInput, stale: number[]) {
  const observed = run.actions.filter((a) => a.turn >= 0).map((a) => `turn ${a.turn}: ${a.type} ${a.detail}${a.target ? ` [element: "${a.target}"]` : ""}`).join("\n").slice(0, 6000);
  const notes = run.step_changes.map((c) => `step ${c.step}: ${c.observed}`).join("\n") || "(none)";
  const r = await museResponses(ctx, "heal", {
    input: [{ role: "user", content: [
      { type: "input_text", text: `${HEAL_PROMPT}\n\nCurrent skill JSON:\n${JSON.stringify(skill)}\n\nSteps whose targets did not match the elements used: ${stale.join(", ") || "(none detected)"}\nAgent's notes about changed steps:\n${notes}\n\nWhat the agent actually did (in order):\n${observed}\n\nFinal screenshot of the successful replay:` },
      { type: "input_image", image_url: `data:image/jpeg;base64,${run.final_jpeg_b64}` },
    ] }],
    // minimal effort: "low" spent the whole output budget on reasoning in testing
    reasoning: { effort: "minimal", summary: "auto" },
    text: { format: { type: "json_schema", name: "healed_skill", strict: true, schema: HEAL_SCHEMA } },
  });
  if (r.response.status === "incomplete") throw new HttpError(502, "muse_incomplete", `Muse stopped early while healing (${r.response.incomplete_details?.reason ?? "unknown"})`);
  let out: { skill: Skill; changes: z.infer<typeof ChangeZ>[] };
  try {
    const raw = JSON.parse(outputText(r.response));
    // Params, name, summary and risk flags are kept from the verified skill: healing only rewrites steps.
    out = { skill: SkillZ.parse({ ...skill, steps: raw.steps, success_check: raw.success_check }), changes: z.array(ChangeZ).max(60).parse(raw.changes) };
  } catch (e) { throw new HttpError(502, "muse_bad_heal", `Muse returned an unusable healed skill (${r.usage.output_tokens} output tokens, ${r.usage.reasoning_tokens} reasoning): ${(e as Error).message.slice(0, 200)}`); }
  const placeholders = (x: Skill) => [...new Set(x.steps.flatMap((st) => [...st.value.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((m) => m[1])))].sort().join(",");
  if (placeholders(out.skill) !== placeholders(skill)) throw new HttpError(502, "heal_changed_params", "the healed steps use different {{params}}; not published");
  const same = JSON.stringify(out.skill.steps) === JSON.stringify(skill.steps) && out.skill.success_check === skill.success_check;
  return { ...out, unchanged: same || !out.changes.length, model: r.model, capability: "self-healing: image understanding + structured output", reasoning_summary: reasoningSummary(r.response) || null, usage: { ...r.usage, usd: round6(r.usage.usd), ms: r.ms } };
}

// ---------------------------------------------------------------- runs -> signed records

/**
 * Store a finished replay. A successful replay of an unpublished draft publishes the skill (signed
 * `skill` record, next version of its slug) followed by the signed `skill_run`. Replays of a published
 * skill add a `skill_run` (success or failure: the log is honest); a verified replay that shows drift
 * heals the skill into a signed next version. Failed draft replays stay on the draft.
 */
export async function submitRun(ctx: AppContext, run: RunInput) {
  if (!run.draft_id === !run.skill_cid) throw new HttpError(400, "target", "send exactly one of draft_id or skill_cid");
  if (run.success !== run.verdict.success) throw new HttpError(400, "verdict", "success must match the Muse verdict");
  const final = await putArtifact(ctx, Buffer.from(run.final_jpeg_b64, "base64"), "image/jpeg");
  const gif = run.gif_b64 ? await putArtifact(ctx, Buffer.from(run.gif_b64, "base64"), "image/gif") : null;

  let skillCid = run.skill_cid;
  let published: SignedRecord | null = null;
  let source: { video?: string | null } = {};
  let current: { body: any; latest: boolean } | null = null;
  if (run.draft_id) {
    const d = await getDraft(ctx, run.draft_id);
    source = d.source;
    if (d.published_cid) skillCid = d.published_cid;
    else if (!run.success) {
      const t = timeSaved(await recordingMs(ctx, source), run);
      await ctx.db.query(`UPDATE skill_drafts SET runs = runs || $2::jsonb WHERE id = $1`, [d.id, JSON.stringify([{ params: run.params, success: false, verdict: run.verdict, turns: run.turns, time: t, evidence: { final_screenshot: final.sha256, gif: gif?.sha256 ?? null }, usage: run.usage, at: new Date(ctx.now()).toISOString() }])]);
      return { status: "draft_run_failed", draft_id: d.id, evidence: { final_screenshot: final.sha256, gif: gif?.sha256 ?? null }, time: t };
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
  if (skillCid && !published) {
    const row = (await ctx.db.query<any>(`SELECT s.slug, s.version, r.body_text FROM skills s JOIN records r ON r.cid = s.cid WHERE s.cid = $1`, [skillCid])).rows[0];
    if (!row) throw new HttpError(404, "skill_not_found", "no such skill");
    const latest = (await ctx.db.query<any>(`SELECT max(version)::int AS v FROM skills WHERE slug = $1`, [row.slug])).rows[0].v;
    current = { body: JSON.parse(row.body_text), latest: latest === row.version };
    source = current.body.source;
  }
  const time = timeSaved(await recordingMs(ctx, source), run);
  const job = run.job_id ? (await ctx.db.query<any>(`SELECT id, via, requested_by FROM skill_jobs WHERE id = $1`, [run.job_id])).rows[0] : null;
  const requestedBy = job ? (job.via === "agent" ? { via: "agent", agent: job.requested_by, job: job.id } : { via: "operator", job: job.id }) : { via: "web" };

  // ---- drift: verified replays of a published skill whose steps no longer match the site
  const stale = current && run.success ? [...new Set([...staleSteps(current.body.skill, run.actions), ...run.step_changes.map((c) => c.step)])].sort((a, b) => a - b) : [];
  let heal: Awaited<ReturnType<typeof healSkill>> | null = null;
  let healError: string | null = null;
  if (stale.length && current?.latest) {
    try { heal = await healSkill(ctx, current.body.skill, run, stale); } catch (e) { healError = (e as Error).message.slice(0, 300); console.warn(`[skills] heal failed: ${healError}`); }
  }

  const runSummary = {
    params: run.params, start_url: run.start_url, success: run.success, turns: run.turns, duration_ms: run.duration_ms,
    verdict: { success: run.verdict.success, evidence: run.verdict.evidence, model: run.verdict.model, capability: run.verdict.capability },
    loop: { model: run.model === ctx.cfg.openWeightModel ? ctx.cfg.metaModel : run.model, capability: "computer use (built-in computer tool) + image understanding" },
    actions: run.actions,
    evidence: { final_screenshot: final.sha256, gif: gif?.sha256 ?? null },
    usage: { ...run.usage, usd: round6(run.usage.usd + (heal?.usage.usd ?? 0)) },
    time,
    ...(current ? { drift: { stale_steps: stale, reported: run.step_changes, healed: Boolean(heal && !heal.unchanged), ...(healError ? { error: healError } : {}) } } : {}),
    executor: run.executor,
    requested_by: requestedBy,
  };
  const runRec = sysRecord(ctx, "skill_run", { skill: published?.cid ?? skillCid!, ...runSummary });
  let healed: SignedRecord | null = null;
  if (heal && !heal.unchanged && current) {
    const b = current.body;
    healed = sysRecord(ctx, "skill", {
      slug: b.slug, version: b.version + 1, prev: skillCid,
      skill: heal.skill,
      source: b.source,
      recorder: b.recorder,
      healed_from: { skill: skillCid, run: runRec.cid, stale_steps: stale, reported: run.step_changes, changes: heal.changes, model: heal.model, capability: heal.capability, reasoning_summary: heal.reasoning_summary, usage: heal.usage },
      draft: b.draft ?? null,
    });
  }
  const out = await ctx.db.tx(async (tx) => {
    let skillSeq: number | undefined, healedSeq: number | undefined;
    if (published) {
      const b = published.body as any;
      skillSeq = (await appendToLog(tx, ctx, published)).seq;
      await tx.query(`INSERT INTO skills (cid, slug, version, prev_cid, name, summary, created_at, draft_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [published.cid, b.slug, b.version, b.prev, b.skill.name, b.skill.summary, published.created_at, b.draft]);
      await tx.query(`UPDATE skill_drafts SET status = 'published', published_cid = $2 WHERE id = $1`, [b.draft, published.cid]);
    }
    const a = await appendToLog(tx, ctx, runRec);
    await tx.query(`INSERT INTO skill_runs (cid, skill_cid, success, created_at) VALUES ($1,$2,$3,$4)`, [runRec.cid, published?.cid ?? skillCid, run.success, runRec.created_at]);
    if (healed) {
      const b = healed.body as any;
      healedSeq = (await appendToLog(tx, ctx, healed)).seq;
      await tx.query(`INSERT INTO skills (cid, slug, version, prev_cid, name, summary, created_at, draft_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [healed.cid, b.slug, b.version, b.prev, b.skill.name, b.skill.summary, healed.created_at, b.draft]);
    }
    return { skillSeq, runSeq: a.seq, healedSeq };
  });
  for (const r of [published, runRec, healed]) if (r) ctx.events.dispatchEvent(new CustomEvent("append", { detail: { cid: r.cid, type: r.type } }));
  return {
    status: published ? "published" : healed ? "healed" : "run_recorded", skill_cid: published?.cid ?? skillCid, skill_seq: out.skillSeq, run_cid: runRec.cid, run_seq: out.runSeq,
    evidence: runSummary.evidence, time,
    ...(current ? { drift: runSummary.drift } : {}),
    ...(healed ? { healed: { cid: healed.cid, seq: out.healedSeq, version: (healed.body as any).version, changes: heal!.changes } } : {}),
  };
}

// ---------------------------------------------------------------- reads

const latestSkillsSql = `
    SELECT s.cid, s.slug, s.version, s.name, s.summary, s.created_at,
      (SELECT count(*)::int FROM skill_runs r JOIN skills v ON v.cid = r.skill_cid WHERE v.slug = s.slug AND r.success) AS verified_runs,
      (SELECT count(*)::int FROM skill_runs r JOIN skills v ON v.cid = r.skill_cid WHERE v.slug = s.slug) AS runs
    FROM skills s
    WHERE s.version = (SELECT max(version) FROM skills x WHERE x.slug = s.slug)`;

export async function listSkills(ctx: AppContext, q?: string) {
  const like = q?.trim() ? `%${q.trim().toLowerCase()}%` : null;
  return (await ctx.db.query<any>(`${latestSkillsSql}
      AND ($1::text IS NULL OR lower(s.name || ' ' || s.summary || ' ' || s.slug) LIKE $1)
    ORDER BY s.created_at DESC LIMIT 100`, [like])).rows;
}

const STOP = new Set(["a", "an", "the", "to", "for", "of", "on", "in", "and", "or", "my", "with", "how", "do", "i"]);
/** Agent-facing search (MCP find_skill): word-overlap ranking over latest versions, with what a caller needs to run one. */
export async function findSkills(ctx: AppContext, q: string, limit = 5) {
  const words = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
  const rows = (await ctx.db.query<any>(`${latestSkillsSql} ORDER BY s.created_at DESC LIMIT 200`)).rows;
  const scored = [];
  for (const r of rows) {
    const body = JSON.parse((await ctx.db.query<any>(`SELECT body_text FROM records WHERE cid = $1`, [r.cid])).rows[0].body_text);
    const hay = `${r.name} ${r.summary} ${r.slug} ${body.skill.steps.map((s: any) => s.intent).join(" ")} ${body.source?.start_url ?? ""}`.toLowerCase();
    const score = words.length ? words.filter((w) => hay.includes(w)).length / words.length : 1;
    if (score > 0) scored.push({ r, body, score });
  }
  scored.sort((a, b) => b.score - a.score || b.r.verified_runs - a.r.verified_runs);
  const out = [];
  for (const { r, body, score } of scored.slice(0, Math.min(10, limit))) {
    const rec = await recordingMs(ctx, body.source);
    out.push({
      cid: r.cid, slug: r.slug, version: r.version, name: r.name, summary: r.summary, match: Math.round(score * 100) / 100,
      params: body.skill.params, start_url: body.source?.start_url ?? null, success_check: body.skill.success_check,
      risk_flags: effectiveRiskFlags(body.skill), approval_required_steps: gatedSteps(body.skill).map((g) => ({ step: g.index + 1, intent: body.skill.steps[g.index].intent, flags: g.flags })),
      verified_runs: r.verified_runs, runs: r.runs, recording_ms: rec, healed: Boolean(body.healed_from),
      url: `${ctx.cfg.skillsWebUrl}/s/${r.cid}`,
    });
  }
  return out;
}

/** A skill by cid, or by slug (its latest version). */
export async function getSkill(ctx: AppContext, cidOrSlug: string) {
  const s = (await ctx.db.query<any>(`SELECT * FROM skills WHERE cid = $1`, [cidOrSlug])).rows[0]
    ?? (await ctx.db.query<any>(`SELECT * FROM skills WHERE slug = $1 ORDER BY version DESC LIMIT 1`, [cidOrSlug])).rows[0];
  if (!s) throw new HttpError(404, "skill_not_found", "no such skill");
  const cid: string = s.cid;
  const rec = async (c: string) => (await ctx.db.query<any>(`SELECT r.cid, r.type, r.author, r.created_at, r.body_text, r.sig, l.seq::int AS seq, l.prev_hash, l.entry_hash FROM records r JOIN log l ON l.cid = r.cid WHERE r.cid = $1`, [c])).rows[0];
  const toRecord = (r: any) => ({ seq: r.seq, log: { prev_hash: r.prev_hash, entry_hash: r.entry_hash }, record: { v: 1, type: r.type, author: r.author, created_at: r.created_at, body: JSON.parse(r.body_text), cid: r.cid, sig: r.sig } });
  const versions = (await ctx.db.query<any>(`SELECT cid, version, created_at, name FROM skills WHERE slug = $1 ORDER BY version DESC`, [s.slug])).rows;
  const runCids = (await ctx.db.query<any>(`SELECT cid FROM skill_runs WHERE skill_cid = $1 ORDER BY created_at DESC LIMIT 50`, [cid])).rows.map((r) => r.cid);
  const runs = [];
  for (const c of runCids) runs.push(toRecord(await rec(c)));
  const all = (await ctx.db.query<any>(`SELECT count(*)::int AS n, count(*) FILTER (WHERE r.success)::int AS v FROM skill_runs r JOIN skills v ON v.cid = r.skill_cid WHERE v.slug = $1`, [s.slug])).rows[0];
  const allVerified = Number(all?.v ?? 0), allRuns = Number(all?.n ?? 0);
  const skill = toRecord(await rec(cid));
  const body = skill.record.body;
  const prev = s.prev_cid ? (await rec(s.prev_cid)) : null;
  // A healed version is first verified by the run that healed it.
  const healRun = body.healed_from?.run ? await rec(body.healed_from.run) : null;
  const recording = await recordingMs(ctx, body.source);
  const verifiedRuns = runs.filter((r: any) => r.record.body.success);
  const savedTotal = recording == null ? null : verifiedRuns.reduce((t: number, r: any) => t + (r.record.body.time?.saved_ms ?? Math.max(0, recording - APPROVAL_HUMAN_MS * r.record.body.actions.filter((a: any) => a.approval === "human").length)), 0);
  const fastest = verifiedRuns.length ? Math.min(...verifiedRuns.map((r: any) => Number(r.record.body.time?.run_ms ?? r.record.body.duration_ms))) : null;
  return {
    skill,
    slug: s.slug, version: s.version, latest_version: versions[0]?.version ?? s.version, latest_cid: versions[0]?.cid ?? cid,
    versions, runs,
    prev_skill: prev ? { cid: prev.cid, version: JSON.parse(prev.body_text).version, skill: JSON.parse(prev.body_text).skill } : null,
    heal_run: healRun ? toRecord(healRun) : null,
    safety: { risk_flags: effectiveRiskFlags(body.skill), declared_flags: body.skill.risk_flags, approval_required_steps: gatedSteps(body.skill).map((g) => ({ step: g.index + 1, flags: g.flags })), gated_flags: GATED_FLAGS },
    time: { human_clicks: 0, approvals_per_run: gatedSteps(body.skill).length, recording_ms: recording, fastest_run_ms: fastest, agent_faster: recording != null && fastest != null && fastest < recording, approval_human_ms: APPROVAL_HUMAN_MS, verified_runs: verifiedRuns.length, saved_total_ms: savedTotal },
    badge: { verified: verifiedRuns.length > 0 || Boolean(healRun && JSON.parse(healRun.body_text).success), replayed: runs.length, runs_this_version: runs.length, verified_runs_this_version: verifiedRuns.length, runs_all_versions: allRuns, verified_runs_all_versions: allVerified, versions: versions.length, healed: Boolean(body.healed_from) },
    node: ctx.node.did,
  };
}

export type { MuseUsage };
