import type { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import type { AppContext } from "./context.js";
import { HttpError } from "./context.js";
import { museResponses, museSpend, type MuseKind } from "./services/muse.js";
import { putArtifact, getArtifact, recordSkill, getDraft, submitRun, RunZ, listSkills, getSkill, artifactUrl, MAX_ARTIFACT_BYTES } from "./services/skills.js";

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** Agentboard Skills routes. Paid or state-changing ones need the operator token (humans) or the executor secret. */
export function mountSkills(app: Hono, ctx: AppContext) {
  const operator = (h: string | undefined) => {
    if (!ctx.cfg.skillsOperatorToken) throw new HttpError(503, "skills_disabled", "recording is not enabled on this node");
    if (!h || !same(h, ctx.cfg.skillsOperatorToken)) throw new HttpError(401, "unauthorized", "x-skills-token required");
  };
  const internal = (h: string | undefined) => {
    if (!ctx.cfg.skillsInternalSecret) throw new HttpError(503, "executor_disabled", "no executor configured");
    if (!h || !same(h, ctx.cfg.skillsInternalSecret)) throw new HttpError(401, "unauthorized", "executor secret required");
  };

  // ---- artifacts: content-addressed bytes; the sha256 is what signed records reference
  app.post("/v1/artifacts", async (c) => {
    operator(c.req.header("x-skills-token"));
    const mime = (c.req.header("content-type") ?? "").split(";")[0].trim();
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_ARTIFACT_BYTES) throw new HttpError(413, "artifact_size", "too large");
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const a = await putArtifact(ctx, bytes, mime);
    return c.json({ ...a, url: artifactUrl(ctx, a.sha256) }, 201);
  });
  app.get("/v1/artifacts/:sha", async (c) => {
    const a = await getArtifact(ctx, c.req.param("sha").replace(/\.(mp4|jpg|jpeg|png|gif)$/, ""));
    if (!a) throw new HttpError(404, "artifact_not_found", "no such artifact");
    return c.body(a.bytes as unknown as ArrayBuffer, 200, { "content-type": a.mime, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" });
  });

  // ---- record: Muse Spark turns a video or screenshots into a draft skill
  app.post("/v1/skills/record", async (c) => {
    operator(c.req.header("x-skills-token"));
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b !== "object") throw new HttpError(400, "invalid_json", "expected {video} or {frames}");
    const draft = await recordSkill(ctx, {
      video: typeof b.video === "string" ? b.video : undefined,
      frames: Array.isArray(b.frames) ? b.frames.filter((x: unknown) => typeof x === "string") : undefined,
      hint: typeof b.hint === "string" ? b.hint : undefined,
      start_url: typeof b.start_url === "string" && /^https?:\/\//.test(b.start_url) ? b.start_url : undefined,
      parent_slug: typeof b.parent_slug === "string" ? b.parent_slug : undefined,
    });
    return c.json(draft, 201);
  });
  app.get("/v1/skills/drafts/:id", async (c) => c.json(await getDraft(ctx, c.req.param("id"))));
  app.get("/v1/skills", async (c) => c.json({ skills: await listSkills(ctx, c.req.query("q")) }));
  app.get("/v1/skills/:cid", async (c) => c.json(await getSkill(ctx, c.req.param("cid"))));
  app.get("/v1/muse/spend", async (c) => c.json(await museSpend(ctx)));

  // ---- executor service (separate Render service): guarded Muse calls and finished runs
  app.post("/internal/muse/responses", async (c) => {
    internal(c.req.header("x-skills-secret"));
    const kind = c.req.header("x-muse-kind") as MuseKind;
    if (kind !== "loop" && kind !== "verify") throw new HttpError(400, "kind", "x-muse-kind must be loop or verify");
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new HttpError(400, "invalid_json", "expected a Responses API body");
    const r = await museResponses(ctx, kind, body);
    return c.json({ response: r.response, usage: r.usage, model: r.model, ms: r.ms });
  });
  app.post("/internal/skills/runs", async (c) => {
    internal(c.req.header("x-skills-secret"));
    const parsed = RunZ.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_run", parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return c.json(await submitRun(ctx, parsed.data), 201);
  });
  app.post("/internal/skills/authorize", async (c) => {
    // The executor checks an operator token without holding it itself.
    internal(c.req.header("x-skills-secret"));
    const b = await c.req.json().catch(() => ({}));
    operator(typeof b?.token === "string" ? b.token : undefined);
    return c.json({ ok: true });
  });
}
