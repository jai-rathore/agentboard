/**
 * Agentboard Skills: "show it once, any MCP agent can reuse it".
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
import { isRetired, realityOf, realityRank } from "./reality";
import { createRecord, sha256Hex, effectiveRiskFlags, gatedSteps, publicReplaySafety, GATED_FLAGS, runVerified, isNoMatch, NO_MATCH_TIES, type SignedRecord } from "@agentboard/core";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { HttpError } from "../context.js";
import { appendToLog } from "./log.js";
import { museResponses, outputText, reasoningSummary, type MuseUsage, type MusePool } from "./muse.js";
import { siteKind, SITE_LABEL, replayCountsBySlug } from "./skillMetrics.js";
import { submitColdRun, benchmarkForJob } from "./benchmark.js";
import { recomputeKarma } from "./reputation.js";
import { hybridSkillSearch } from "./skillSearch.js";
import { DEFAULT_MATCHES, MAX_MATCHES, UNFILLED_INPUT_PENALTY, queryTerms, coverage, skillVocab, inputVocab, inputsUnfilled, matchScore, passesGate, selectMatches } from "./skillMatch.js";
import { trustCards } from "./trustCard.js";
import { cosine } from "./embeddings.js";

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
  /** Declared empty-result signal: the site's own "no results" wording. A run that ends on it, tied to its inputs, is "Verified: no hit" (outcome no_match). */
  empty_result: z.object({ text: z.string().min(6).max(200) }).optional(),
  /** Declared result signals: the site's own wording for a known answer that has no results row (FMCSA "… is INACTIVE in
   * the SAFER database" means INACTIVE). A replay that ends on one, tied to its inputs like a no-hit, returns its value. */
  result_signals: z.array(z.object({ text: z.string().min(6).max(200), value: z.string().min(1).max(100) })).max(5).optional(),
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

/** A verified run's concrete action trace (see services/executor/src/trace.mjs): what deterministic replay executes. */
const S = (n: number) => z.string().max(n);
const LocatorZ = z.object({ tag: S(40), role: S(40), name: S(220), text: S(220), css: S(320), attrs: z.record(z.string().max(40), S(140)).default({}), match: z.enum(["exact", "prefix"]).optional() });
/** How to read the answer off the final page without a model (see services/executor/src/trace.mjs). */
// "record": the results-table row whose plain cell holds the input (key, e.g. "{{license_number}}"); the value is its column col
const ExtractZ = z.object({ kind: z.enum(["row", "css", "record"]), label: S(200).optional(), offset: z.number().int().min(0).max(10).optional(), sub: S(120).optional(), css: S(320).optional(), key: S(200).optional(), col: z.number().int().min(0).max(40).optional(), regex: S(600).optional(), sample: S(300).optional() });
export const TraceStepZ = z.object({
  action: z.enum(["click", "double_click", "type", "keypress", "scroll", "scroll_to_text", "select_option", "navigate"]),
  url: S(520), changes_url: z.boolean().default(false),
  locator: LocatorZ.optional(), text: S(520).optional(), keys: z.array(S(40)).max(6).optional(),
  scroll_x: z.number().int().optional(), scroll_y: z.number().int().optional(), option: S(520).optional(), to: S(520).optional(),
});
export const TraceZ = z.object({
  v: z.literal(1), start_url: S(520), steps: z.array(TraceStepZ).max(60), // 0 steps: the answer is on the start page (with an extraction recipe)
  final: z.object({ url: S(520), viewport: z.array(S(60)).max(20), page: z.array(S(60)).max(20), title: z.array(S(60)).max(20) }),
  extract: ExtractZ.optional(),
  /** set when a verified run found no value to extract (the trace then verifies without one) */
  no_value: z.boolean().optional(),
});
export type Trace = z.infer<typeof TraceZ>;
const ReplayZ = z.object({
  mode: z.enum(["model", "trace", "trace+recovery"]), trace_source: S(120).nullable(), trace_steps: z.number().int().min(0).max(60), trace_steps_done: z.number().int().min(0).max(60),
  failed_step: z.number().int().nullable(), failed_reason: S(300).nullable(), verifier: z.enum(["model", "deterministic"]),
});

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
  trace: TraceZ.optional(),
  replay: ReplayZ.optional(),
  /** "no_match": the site said there are no results for exactly these inputs (the skill's declared empty_result), tied by URL, echoed field, search request or page text */
  outcome: z.enum(["value", "no_match"]).optional(),
  no_match: z.object({ signal: S(200), by: z.record(z.string().max(60), z.enum(NO_MATCH_TIES)), evidence: S(400) }).optional(),
  /** The value the run returned, read deterministically off the final page with the trace's extraction recipe. */
  answer: z.object({ value: S(300).nullable(), method: z.enum(["deterministic", "signal", "none"]),
    /** method "signal": the skill's declared result signal the page showed, and how each input is tied to that page */
    signal: z.object({ text: S(200), by: z.record(z.string().max(60), z.enum(NO_MATCH_TIES)) }).optional(), source: S(200).nullable(), verified_by: z.enum(["deterministic", "verifier"]), model_text: S(400).nullable().optional(),
    /** the executor's valueBinding check: is the value tied to the inputs (and a value it refused to return, if any) */
    binding: z.object({ ok: z.boolean(), checked: z.boolean(), by: z.record(z.string().max(60), z.enum(["url", "title", "row", ...NO_MATCH_TIES])), reason: S(300), rejected: S(300).optional() }).optional() }).optional(),
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

export async function healSkill(ctx: AppContext, skill: Skill, run: RunInput, stale: number[], pool: MusePool = "default") {
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
  }, 3, pool);
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
  if (run.draft_id) {
    // a reuse-benchmark cold run (task statement only): signed as a benchmark_run, never publishes a skill
    const d0 = await getDraft(ctx, run.draft_id);
    if (d0.status === "bench_cold" || d0.status === "bench_cold_done") return submitColdRun(ctx, d0, run);
  }
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
  // Who triggered the run: an agent paying credits, the public capped trigger, the operator (token), or the web replay panel.
  // Reuse-benchmark replays name the benchmark and the agent that asked (operator-funded; not an agent-funded run).
  const requestedBy = job ? (job.via === "agent" ? { via: "agent", agent: job.requested_by, job: job.id } : job.via === "benchmark" ? { via: "benchmark", agent: job.requested_by, job: job.id, benchmark: await benchmarkForJob(ctx, job.id) } : job.via === "public" ? { via: "public", job: job.id } : { via: "operator", job: job.id }) : { via: "web" };

  // ---- drift: verified replays of a published skill whose steps no longer match the site
  // Deterministic replays never call the model to heal: a trace that ran clean needs nothing, and a trace that failed
  // and was recovered by the model is healed below by publishing the recovered run's trace (no extra model call).
  const traceMode = run.replay?.mode === "trace" || run.replay?.mode === "trace+recovery";
  const stale = current && run.success && run.outcome !== "no_match" && run.answer?.method !== "signal" && !traceMode ? [...new Set([...staleSteps(current.body.skill, run.actions), ...run.step_changes.map((c) => c.step)])].sort((a, b) => a - b) : [];
  let heal: Awaited<ReturnType<typeof healSkill>> | null = null;
  let healError: string | null = null;
  if (stale.length && current?.latest) {
    try { heal = await healSkill(ctx, current.body.skill, run, stale, job?.via === "public" ? "public" : "default"); } catch (e) { healError = (e as Error).message.slice(0, 300); console.warn(`[skills] heal failed: ${healError}`); }
  }

  // a value read from a declared result signal must be one this skill version declares (text and value)
  if (run.answer?.method === "signal") {
    const sig = run.answer.signal, decl = (current?.body?.skill?.result_signals ?? []) as { text: string; value: string }[];
    if (!sig || !run.success || !decl.some((d) => d.text === sig.text && d.value === run.answer!.value)) throw new HttpError(400, "undeclared_signal", "a signal answer must match one of the skill's declared result_signals");
  }
  const runSummary = {
    params: run.params, start_url: run.start_url, success: run.success, turns: run.turns, duration_ms: run.duration_ms,
    verdict: { success: run.verdict.success, evidence: run.verdict.evidence, model: run.verdict.model, capability: run.verdict.capability },
    loop: { model: run.model === ctx.cfg.openWeightModel ? ctx.cfg.metaModel : run.model, capability: "computer use (built-in computer tool) + image understanding" },
    actions: run.actions,
    evidence: { final_screenshot: final.sha256, gif: gif?.sha256 ?? null },
    usage: { ...run.usage, usd: round6(run.usage.usd + (heal?.usage.usd ?? 0)) },
    time,
    ...(current ? { drift: { stale_steps: stale, reported: run.step_changes, healed: Boolean(heal && !heal.unchanged) || Boolean(current?.latest && run.success && run.trace && run.replay?.mode === "trace+recovery"), ...(healError ? { error: healError } : {}) } } : {}),
    executor: run.executor,
    requested_by: requestedBy,
    trigger: requestedBy.via,
    ...(run.replay ? { replay: run.replay } : {}),
    ...(run.answer ? { answer: run.answer } : {}),
    ...(run.outcome === "no_match" && run.no_match ? { outcome: "no_match", no_match: run.no_match } : {}),
    ...(run.success && run.trace && run.outcome !== "no_match" && run.answer?.method !== "signal" ? { trace: run.trace } : {}),
  };
  const runRec = sysRecord(ctx, "skill_run", { skill: published?.cid ?? skillCid!, ...runSummary });
  let healed: SignedRecord | null = null;
  const traceHeal = Boolean(current?.latest && run.success && run.trace && run.outcome !== "no_match" && run.answer?.method !== "signal" && run.replay?.mode === "trace+recovery");
  if (traceHeal && current) {
    // Trace self-heal: the stored trace failed at a step, the model recovered and the run verified. Publish the next
    // version with the same steps and the recovered run's trace, so the next replay is deterministic again.
    const b = current.body, failed = run.replay!.failed_step ?? 0;
    healed = sysRecord(ctx, "skill", {
      slug: b.slug, version: b.version + 1, prev: skillCid,
      skill: b.skill, source: b.source, recorder: b.recorder, trace: run.trace,
      healed_from: { kind: "trace", skill: skillCid, run: runRec.cid, stale_steps: failed ? [failed] : [], reported: [], failed_reason: run.replay!.failed_reason,
        changes: [{ step: failed, field: "trace", before: `trace step ${failed} of ${run.replay!.trace_steps}`, after: `re-recorded from the verified recovery run (${run.trace!.steps.length} steps)`, reason: String(run.replay!.failed_reason ?? "").slice(0, 400) }],
        model: "none (trace re-recorded from the verified run)", capability: "self-healing: the recovered run's action trace replaces the failed one", reasoning_summary: null, usage: { calls: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, usd: 0, ms: 0 } },
      draft: b.draft ?? null,
    });
  } else if (heal && !heal.unchanged && current) {
    const b = current.body;
    healed = sysRecord(ctx, "skill", {
      slug: b.slug, version: b.version + 1, prev: skillCid,
      skill: heal.skill,
      source: b.source,
      recorder: b.recorder,
      ...(run.success && run.trace ? { trace: run.trace } : {}),
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
    await tx.query(`INSERT INTO skill_runs (cid, skill_cid, success, created_at) VALUES ($1,$2,$3,$4)`, [runRec.cid, published?.cid ?? skillCid, runVerified(runRec.body), runRec.created_at]); // success column = verified
    if (healed) {
      const b = healed.body as any;
      healedSeq = (await appendToLog(tx, ctx, healed)).seq;
      await tx.query(`INSERT INTO skills (cid, slug, version, prev_cid, name, summary, created_at, draft_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [healed.cid, b.slug, b.version, b.prev, b.skill.name, b.skill.summary, healed.created_at, b.draft]);
    }
    return { skillSeq, runSeq: a.seq, healedSeq };
  });
  for (const r of [published, runRec, healed]) if (r) ctx.events.dispatchEvent(new CustomEvent("append", { detail: { cid: r.cid, type: r.type } }));
  // A verified replay requested by an identity can endorse whoever's work it reused (services/wins.ts reuseEdges).
  if (run.success && "agent" in requestedBy && requestedBy.agent) await recomputeKarma(ctx).catch((e) => console.warn(`[skills] karma recompute failed: ${(e as Error).message}`));
  return {
    status: published ? "published" : healed ? "healed" : "run_recorded", skill_cid: published?.cid ?? skillCid, skill_seq: out.skillSeq, run_cid: runRec.cid, run_seq: out.runSeq,
    evidence: runSummary.evidence, time,
    ...(current ? { drift: runSummary.drift } : {}),
    ...(healed ? { healed: { cid: healed.cid, seq: out.healedSeq, version: (healed.body as any).version, changes: (healed.body as any).healed_from.changes, kind: (healed.body as any).healed_from.kind ?? "model" } } : {}),
  };
}

// ---------------------------------------------------------------- reads

const latestSkillsSql = `
    SELECT s.cid, s.slug, s.version, s.name, s.summary, s.created_at,
      (SELECT count(*)::int FROM skill_runs r JOIN skills v ON v.cid = r.skill_cid WHERE v.slug = s.slug AND r.success) AS verified_runs,
      (SELECT count(*)::int FROM skill_runs r JOIN skills v ON v.cid = r.skill_cid WHERE v.slug = s.slug) AS runs
    FROM skills s
    WHERE s.status = 'active' AND NOT EXISTS (SELECT 1 FROM agents g WHERE g.did = s.proposer AND g.status IN ('quarantined', 'suspended'))
      AND s.version = (SELECT max(version) FROM skills x WHERE x.slug = s.slug AND x.status = 'active')`;

/**
 * Whether try_skill / public replay will accept this slug: public replay on, the slug allowlisted, and its latest
 * version safe for public replay (the same checks publicSkill applies). `latest` is the latest version's skill.
 */
export function publicReplayable(ctx: AppContext, slug: string, latest: { risk_flags?: string[]; steps: any[] } | null | undefined): boolean {
  return ctx.cfg.publicReplayDailyCap > 0 && ctx.cfg.publicReplaySkills.includes(slug) && Boolean(latest) && publicReplaySafety(latest!).ok;
}

/** Real-site vs Agentboard demo (mock) site, from where the skill starts, plus replay counts that leave out publishing runs. */
async function withSite(ctx: AppContext, rows: any[]) {
  const counts = await replayCountsBySlug(ctx);
  const out = [];
  for (const r of rows) {
    const body = JSON.parse((await ctx.db.query<any>(`SELECT body_text FROM records WHERE cid = $1`, [r.cid])).rows[0].body_text);
    const kind = siteKind(ctx, body.source?.start_url);
    const c = counts.get(r.slug) ?? { replays: 0, verified_replays: 0, new_input_replays: 0 };
    out.push({ ...r, site_kind: kind, site_label: SITE_LABEL[kind], start_url: body.source?.start_url ?? null, ...c, public_replay: publicReplayable(ctx, r.slug, body.skill) });
  }
  return out;
}

export async function listSkills(ctx: AppContext, q?: string) {
  const like = q?.trim() ? `%${q.trim().toLowerCase()}%` : null;
  const rows = await withSite(ctx, (await ctx.db.query<any>(`${latestSkillsSql}
      AND ($1::text IS NULL OR lower(s.name || ' ' || s.summary || ' ' || s.slug) LIKE $1)
    ORDER BY s.created_at DESC LIMIT 100`, [like])).rows);
  // painful real-site tasks first (docs/REALITY_CHECK.md), then the rest of the real sites, easy lookups, demo (mock)
  // sites; newest first within each group
  return rows.filter((r) => !isRetired(r.slug)).map((r, i) => ({ r: { ...r, reality: realityOf(r.slug, r.site_kind) }, i })).sort((a, b) => realityRank(a.r.slug, a.r.site_kind) - realityRank(b.r.slug, b.r.site_kind) || a.i - b.i).map((x) => x.r);
}

/** Ranking prior (added to the match score, never to the gate): real sites a little ahead of Agentboard's demo (mock) sites. */
export const REAL_SITE_BOOST = 0.05;
/** Ranking only: how much the fused retrieval rank (RRF relative to the best hit, 0..1) adds to the match score. */
export const RRF_WEIGHT = 0.15;
/**
 * find_skill: hybrid retrieval (services/skillSearch.ts: FTS + pg_trgm on name and summary + bge-small embeddings over
 * name, summary, params and steps, fused with RRF) over the latest active version of each skill, plus any skill whose
 * own words or verified inputs cover the query. Then the confidence gate (skillMatch.ts): an absolute match score
 * (cosine + 0.3 x the share of the query's words found in the skill or its verified inputs), DEFAULT_MATCHES (3) results unless the caller asks for up to MAX_MATCHES (5), and [] when nothing clears it, so an off-domain task gets an explicit no-match. Each result carries a
 * trust card (trustCard.ts) computed from the signed records. An empty query lists the latest skills (no gate).
 */
export async function findSkills(ctx: AppContext, q: string, limit = DEFAULT_MATCHES, opts: { trust?: boolean } = {}) {
  const query = q.trim().slice(0, 300);
  let picked: { cid: string; score: number; cos: number | null; cov: number; ranks?: Record<string, number> }[];
  // retired slugs (reality.ts) keep their signed history but are never listed or found
  const latest = (await ctx.db.query<any>(`SELECT l.*, rec.body_text FROM (${latestSkillsSql}) l JOIN records rec ON rec.cid = l.cid`)).rows.filter((r) => !isRetired(r.slug));
  const byCid = new Map(latest.map((r) => [r.cid, { r, body: JSON.parse(r.body_text) }]));
  if (!query) picked = latest.sort((a, b) => realityRank(a.slug, siteKind(ctx, JSON.parse(a.body_text).source?.start_url)) - realityRank(b.slug, siteKind(ctx, JSON.parse(b.body_text).source?.start_url)) || +new Date(b.created_at) - +new Date(a.created_at)).slice(0, 10).map((r) => ({ cid: r.cid, score: 1, cos: null, cov: 0 }));
  else {
    const n = Math.min(MAX_MATCHES, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_MATCHES));
    const terms = queryTerms(query);
    // the inputs of each skill's verified runs (any version): a task phrased by its inputs ("population of Seoul") is covered
    const inputs = new Map<string, Set<string>>();
    for (const row of (await ctx.db.query<any>(`SELECT v.slug, rec.body->'params' AS p FROM skill_runs sr JOIN skills v ON v.cid = sr.skill_cid JOIN records rec ON rec.cid = sr.cid WHERE sr.success`)).rows) {
      inputs.set(row.slug, inputVocab(Object.values(row.p ?? {}), inputs.get(row.slug)));
    }
    const cov = new Map(latest.map((r) => { const b = byCid.get(r.cid)!.body; return [r.cid, coverage(terms, skillVocab({ slug: r.slug, name: r.name, summary: r.summary, params: b.skill?.params, start_url: b.source?.start_url }), inputs.get(r.slug) ?? new Set())]; }));
    const hits = await hybridSkillSearch(ctx, query, `SELECT cid FROM (${latestSkillsSql}) l`, { filter: false });
    const hit = new Map(hits.map((h) => [h.cid, h]));
    // candidates: the retrieval hits plus skills that cover at least half of the query's words (their cosine computed here)
    const extra = latest.filter((r) => !hit.has(r.cid) && (cov.get(r.cid) ?? 0) >= 0.5).map((r) => r.cid);
    const extraCos = new Map<string, number | null>();
    if (extra.length) {
      const qvec = await ctx.embedder.embed([query], "query").then((v) => v[0]).catch(() => null);
      for (const e of (await ctx.db.query<any>(`SELECT cid, emb::text AS emb FROM skills WHERE cid = ANY($1)`, [extra])).rows) extraCos.set(e.cid, qvec && e.emb ? cosine(qvec, JSON.parse(e.emb)) : null);
    }
    const topRrf = hits[0]?.rrf || 1;
    const cands = [...hits.map((h) => ({ cid: h.cid, cos: h.cos, rel: h.rrf / topRrf, ranks: h.ranks as Record<string, number> | undefined })), ...extra.map((cid) => ({ cid, cos: extraCos.get(cid) ?? null, rel: 0, ranks: { terms: 1 } as Record<string, number> | undefined }))].flatMap((c) => {
      const x = byCid.get(c.cid);
      if (!x) return [];
      const mock = siteKind(ctx, x.body.source?.start_url) === "mock";
      const cv = cov.get(c.cid) ?? 0;
      const score = matchScore(c.cos, cv);
      const unfilled = inputsUnfilled(terms, { slug: x.r.slug, name: x.r.name, summary: x.r.summary, params: x.body.skill?.params, start_url: x.body.source?.start_url });
      return [{ ...c, cov: cv, score, unfilled, noInputs: !(x.body.skill?.params ?? []).length, rank: score + RRF_WEIGHT * c.rel + (mock ? 0 : REAL_SITE_BOOST) + 0.02 * Math.tanh(Number(x.r.verified_runs) / 5) }];
    });
    // the query gives no input value and a skill that needs none also matches: skills that would need one rank below it
    if (cands.some((c) => c.noInputs && passesGate(c.cos, c.cov, ctx.embedder.thresholds))) for (const c of cands) if (c.unfilled) c.rank -= UNFILLED_INPUT_PENALTY;
    picked = selectMatches(cands, ctx.embedder.thresholds, n);
  }
  if (!picked.length) return [];
  const counts = await replayCountsBySlug(ctx);
  const cards = opts.trust === false ? new Map() : await trustCards(ctx, picked.map((p) => ({ slug: byCid.get(p.cid)!.r.slug, name: byCid.get(p.cid)!.r.name, body: byCid.get(p.cid)!.body })));
  const out = [];
  for (const { cid, score, cos, cov: cv, ranks } of picked) {
    const { r, body } = byCid.get(cid)!;
    const rec = await recordingMs(ctx, body.source);
    out.push({
      cid: r.cid, slug: r.slug, version: r.version, name: r.name, summary: r.summary,
      ...(query ? { match: Math.round(score * 100) / 100, match_detail: { semantic: cos == null ? null : Math.round(cos * 100) / 100, term_coverage: Math.round(cv * 100) / 100 }, ...(ranks ? { matched_by: Object.keys(ranks) } : {}) } : {}),
      params: body.skill.params, start_url: body.source?.start_url ?? null, success_check: body.skill.success_check,
      risk_flags: effectiveRiskFlags(body.skill), approval_required_steps: gatedSteps(body.skill).map((g) => ({ step: g.index + 1, intent: body.skill.steps[g.index].intent, flags: g.flags })),
      site_kind: siteKind(ctx, body.source?.start_url), site_label: SITE_LABEL[siteKind(ctx, body.source?.start_url)], reality: realityOf(r.slug, siteKind(ctx, body.source?.start_url)),
      verified_runs: r.verified_runs, runs: r.runs, ...(counts.get(r.slug) ?? { replays: 0, verified_replays: 0, new_input_replays: 0 }), recording_ms: rec, healed: Boolean(body.healed_from),
      public_replay: publicReplayable(ctx, r.slug, body.skill),
      url: `${ctx.cfg.skillsWebUrl}/s/${r.cid}`,
      ...(cards.has(r.slug) ? { trust: cards.get(r.slug) } : {}),
    });
  }
  return out;
}

/**
 * skill_runs.success means verified (runVerified: the run passed its checks AND its value is tied to its inputs).
 * Runs recorded before value binding existed may say success with an unbound value: mark those not verified.
 * Idempotent; runs on boot.
 */
export async function reconcileRunVerified(db: AppContext["db"]): Promise<number> {
  const rows = (await db.query<any>(`SELECT sr.cid, r.body_text FROM skill_runs sr JOIN records r ON r.cid = sr.cid WHERE sr.success`)).rows;
  const bad = rows.filter((r) => !runVerified(JSON.parse(r.body_text))).map((r) => r.cid);
  if (bad.length) await db.query(`UPDATE skill_runs SET success = false WHERE cid = ANY($1)`, [bad]);
  return bad.length;
}

/** A skill by cid, or by slug (its latest version). */
export async function getSkill(ctx: AppContext, cidOrSlug: string) {
  const s = (await ctx.db.query<any>(`SELECT * FROM skills WHERE cid = $1`, [cidOrSlug])).rows[0]
    ?? (await ctx.db.query<any>(`SELECT * FROM skills WHERE slug = $1 ORDER BY version DESC LIMIT 1`, [cidOrSlug])).rows[0];
  if (!s) throw new HttpError(404, "skill_not_found", "no such skill");
  const cid: string = s.cid;
  const rec = async (c: string) => (await ctx.db.query<any>(`SELECT r.cid, r.type, r.author, r.created_at, r.body_text, r.sig, l.seq::int AS seq, l.prev_hash, l.entry_hash FROM records r JOIN log l ON l.cid = r.cid WHERE r.cid = $1`, [c])).rows[0];
  const toRecord = (r: any) => { const body = JSON.parse(r.body_text); return { seq: r.seq, log: { prev_hash: r.prev_hash, entry_hash: r.entry_hash }, ...(r.type === "skill_run" ? { verified: runVerified(body) } : {}), record: { v: 1, type: r.type, author: r.author, created_at: r.created_at, body, cid: r.cid, sig: r.sig } }; };
  const versions = (await ctx.db.query<any>(`SELECT cid, version, created_at, name FROM skills WHERE slug = $1 ORDER BY version DESC`, [s.slug])).rows;
  const runs = (await ctx.db.query<any>(`SELECT r.cid, r.type, r.author, r.created_at, r.body_text, r.sig, l.seq::int AS seq, l.prev_hash, l.entry_hash
    FROM skill_runs sr JOIN records r ON r.cid = sr.cid JOIN log l ON l.cid = r.cid WHERE sr.skill_cid = $1 ORDER BY sr.created_at DESC LIMIT 50`, [cid])).rows.map(toRecord);
  const all = (await ctx.db.query<any>(`SELECT count(*)::int AS n, count(*) FILTER (WHERE r.success)::int AS v FROM skill_runs r JOIN skills v ON v.cid = r.skill_cid WHERE v.slug = $1`, [s.slug])).rows[0];
  const allVerified = Number(all?.v ?? 0), allRuns = Number(all?.n ?? 0);
  const skill = toRecord(await rec(cid));
  const body = skill.record.body;
  const prev = s.prev_cid ? (await rec(s.prev_cid)) : null;
  // A healed version is first verified by the run that healed it.
  const healRun = body.healed_from?.run ? await rec(body.healed_from.run) : null;
  const recording = await recordingMs(ctx, body.source);
  // verified = success AND a returned value tied to the run's inputs (runVerified): a run that read a fixed recorded
  // element for another input is not verified, and its trace is never replayed
  const verifiedRuns = runs.filter((r: any) => runVerified(r.record.body));
  const savedTotal = recording == null ? null : verifiedRuns.reduce((t: number, r: any) => t + (r.record.body.time?.saved_ms ?? Math.max(0, recording - APPROVAL_HUMAN_MS * r.record.body.actions.filter((a: any) => a.approval === "human").length)), 0);
  const fastest = verifiedRuns.length ? Math.min(...verifiedRuns.map((r: any) => Number(r.record.body.time?.run_ms ?? r.record.body.duration_ms))) : null;
  // Deterministic replay: the newest verified run of this version that carries a trace, else a trace-healed version's own.
  const traceRun = verifiedRuns.find((r: any) => r.record.body.trace && !isNoMatch(r.record.body)); // a no-hit page is never the trace to replay
  // (a version published by a heal also inherits the trace of the verified run that healed it)
  const healTrace = healRun ? JSON.parse(healRun.body_text).trace : null;
  const trace = traceRun ? { ...traceRun.record.body.trace, source: `run:${traceRun.record.cid}` } : body.trace ? { ...body.trace, source: `skill:${cid}` } : healTrace?.v ? { ...healTrace, source: `run:${healRun.cid}` } : null;
  return {
    skill,
    trace,
    slug: s.slug, version: s.version, latest_version: versions[0]?.version ?? s.version, latest_cid: versions[0]?.cid ?? cid,
    versions, runs,
    prev_skill: prev ? { cid: prev.cid, version: JSON.parse(prev.body_text).version, skill: JSON.parse(prev.body_text).skill } : null,
    heal_run: healRun ? toRecord(healRun) : null,
    safety: { risk_flags: effectiveRiskFlags(body.skill), declared_flags: body.skill.risk_flags, approval_required_steps: gatedSteps(body.skill).map((g) => ({ step: g.index + 1, flags: g.flags })), gated_flags: GATED_FLAGS },
    time: { human_clicks: 0, approvals_per_run: gatedSteps(body.skill).length, recording_ms: recording, fastest_run_ms: fastest, agent_faster: recording != null && fastest != null && fastest < recording, approval_human_ms: APPROVAL_HUMAN_MS, verified_runs: verifiedRuns.length, saved_total_ms: savedTotal },
    site_kind: siteKind(ctx, body.source?.start_url), site_label: SITE_LABEL[siteKind(ctx, body.source?.start_url)],
    reuse: (await replayCountsBySlug(ctx)).get(s.slug) ?? { replays: 0, verified_replays: 0, new_input_replays: 0 },
    public_replay: publicReplayable(ctx, s.slug, versions[0]?.cid && versions[0].cid !== cid ? JSON.parse((await rec(versions[0].cid))?.body_text ?? "null")?.skill : body.skill),
    badge: { verified: verifiedRuns.length > 0 || Boolean(healRun && JSON.parse(healRun.body_text).success), replayed: runs.length, runs_this_version: runs.length, verified_runs_this_version: verifiedRuns.length, runs_all_versions: allRuns, verified_runs_all_versions: allVerified, versions: versions.length, healed: Boolean(body.healed_from) },
    // trust card (all versions of the slug, like find_skill's)
    trust: (await trustCards(ctx, [{ slug: s.slug, name: s.name, body }])).get(s.slug) ?? null,
    node: ctx.node.did,
  };
}

export type { MuseUsage };

/**
 * Declare a skill's empty-result signal (operator only): publishes the next version with the same steps and the same
 * replay trace, plus skill.empty_result = { text }: the site's own "no results" wording. From then on a replay that ends
 * on that wording, tied to its inputs (URL, echoed search field, the search request, or page text), is signed as
 * outcome "no_match" (Verified: no hit) instead of "not verified". No model call.
 */
export async function declareEmptyResult(ctx: AppContext, slug: string, text: string) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length < 6 || t.length > 200) throw new HttpError(400, "invalid_empty_result", "empty_result text: the site's exact no-results wording, 6-200 characters");
  const r = await amendSkill(ctx, slug, (sk) => (sk.empty_result?.text === t ? null : { ...sk, empty_result: { text: t } }), { change: "declared empty-result signal", empty_result: { text: t } });
  return { ...r, empty_result: { text: t } };
}

/**
 * Declare a result signal (operator only): the site's own wording for a known answer that has no results row, and the
 * value it means (FMCSA "is INACTIVE in the SAFER database" -> INACTIVE). Publishes the next version with the same trace.
 * A replay that ends on that wording, tied to every input like a no-hit, returns the value with 0 model calls.
 */
export async function declareResultSignal(ctx: AppContext, slug: string, text: string, value: string) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim(), v = String(value ?? "").replace(/\s+/g, " ").trim();
  if (t.length < 6 || t.length > 200) throw new HttpError(400, "invalid_result_signal", "text: the site's exact wording, 6-200 characters");
  if (!v || v.length > 100) throw new HttpError(400, "invalid_result_signal", "value: what that wording means, 1-100 characters");
  const r = await amendSkill(ctx, slug, (sk) => {
    const cur = (sk.result_signals ?? []) as { text: string; value: string }[];
    if (cur.some((x) => x.text === t && x.value === v)) return null;
    const next = [...cur.filter((x) => x.text !== t), { text: t, value: v }];
    if (next.length > 5) throw new HttpError(400, "too_many_signals", "at most 5 result signals");
    return { ...sk, result_signals: next };
  }, { change: "declared result signal", result_signal: { text: t, value: v } });
  return { ...r, result_signal: { text: t, value: v } };
}

/** Publish the next version of the latest skill with amended skill fields, the same steps and the same replay trace. */
async function amendSkill(ctx: AppContext, slug: string, edit: (sk: any) => any | null, note: Record<string, unknown>) {
  const cur: any = await getSkill(ctx, slug);
  const curCid: string = cur.skill.record.cid;
  if (curCid !== cur.latest_cid) throw new HttpError(409, "not_latest", "declare on the latest version");
  const b = cur.skill.record.body;
  const edited = edit(b.skill);
  if (!edited) return { unchanged: true, cid: curCid, version: b.version as number };
  const { source: _src, ...trace } = cur.trace ?? {};
  const rec = sysRecord(ctx, "skill", {
    slug: b.slug, version: b.version + 1, prev: curCid,
    skill: SkillZ.parse(edited), source: b.source, recorder: b.recorder,
    ...(cur.trace ? { trace: TraceZ.parse(trace) } : {}),
    amended_from: { skill: curCid, ...note, trace_from: cur.trace?.source ?? null, by: "operator", model: "none", usage: { calls: 0, usd: 0 } },
    draft: b.draft ?? null,
  });
  const seq = await ctx.db.tx(async (tx) => {
    const s = (await appendToLog(tx, ctx, rec)).seq;
    await tx.query(`INSERT INTO skills (cid, slug, version, prev_cid, name, summary, created_at, draft_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [rec.cid, b.slug, b.version + 1, curCid, b.skill.name, b.skill.summary, rec.created_at, b.draft ?? null]);
    return s;
  });
  return { unchanged: false, cid: rec.cid, version: (b.version + 1) as number, seq };
}
