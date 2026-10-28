import type { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import type { AppContext } from "./context.js";
import { HttpError } from "./context.js";
import { museResponses, museSpend, type MuseKind } from "./services/muse.js";
import { putArtifact, getArtifact, recordSkill, getDraft, submitRun, RunZ, listSkills, findSkills, getSkill, artifactUrl, MAX_ARTIFACT_BYTES } from "./services/skills.js";
import { createJob, dispatchJob, getJob, getJobFrame, jobEvent, JobEventZ, decideJob, createAgentFundedJob, refundAgentRun } from "./services/skillJobs.js";
import { verifyRequestAuth } from "./requestAuth.js";
import { hideAgent, hideTopic, grantCredits, listCreditGrants } from "./services/ingest.js";
import { skillMetrics, skillReuse } from "./services/skillMetrics.js";
import { sha256Hex } from "@agentboard/core";
import { startPublicReplay, publicReplayStatus, MCP_INTERNAL_HEADER, MCP_INTERNAL_TOKEN, MCP_CLIENT_IP_HEADER } from "./services/publicReplay.js";
import { clientIp } from "./services/ipLimits.js";
import { runDetail } from "./services/skillMetrics.js";
import { openBenchmark, startColdRun, startReuseRun, finalizeBenchmark, listBenchmarks, latestBenchmark, getBenchmark, coldRunDetail } from "./services/benchmark.js";

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

  // ---- public, read-only numbers (no model calls)
  app.get("/v1/skills/metrics", async (c) => c.json(await skillMetrics(ctx)));
  app.get("/v1/skills/reuse", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100) || 100, 1), 500);
    return c.json(await skillReuse(ctx, { skill: c.req.query("skill") || undefined, agent: c.req.query("agent") || undefined, limit, includeHidden: ["1", "true"].includes(c.req.query("include_hidden") ?? "") }));
  });

  // ---- one run (operator, agent, public or web) as evidence: inputs, screenshots, verdict, models, signed record
  app.get("/v1/skills/runs/:id", async (c) => c.json(await runDetail(ctx, c.req.param("id"))));

  // ---- public, capped replay of allowlisted non-destructive skills (no token). Off unless PUBLIC_REPLAY_DAILY_CAP > 0.
  app.get("/v1/skills/public-replay", async (c) => c.json(await publicReplayStatus(ctx)));
  app.post("/v1/skills/:slug/public-replay", async (c) => {
    const raw = await c.req.text();
    if (raw.length > 20_000) throw new HttpError(413, "too_large", "request too large");
    let b: any = {};
    if (raw.trim()) { try { b = JSON.parse(raw); } catch { throw new HttpError(400, "invalid_json", "expected {params, challenge?}"); } }
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "invalid_json", "expected {params, challenge?}");
    // The remote /mcp route marks its in-process requests with a per-process secret and the caller's real IP.
    const internal = c.req.header(MCP_INTERNAL_HEADER);
    const viaMcp = Boolean(internal) && internal === MCP_INTERNAL_TOKEN;
    const ip = viaMcp ? (c.req.header(MCP_CLIENT_IP_HEADER) || null) : clientIp((n) => c.req.header(n));
    const out: any = await startPublicReplay(ctx, c.req.param("slug"), { params: b.params ?? b.inputs, challenge: b.challenge }, ip, viaMcp ? "mcp" : "pow");
    // 200 + status "cached": a cap was hit, so this is the latest verified run, not a new replay (no job was started).
    return c.json(out, out.status === "cached" ? 200 : 202);
  });

  // ---- reuse benchmark (services/benchmark.ts): public reads, operator-only writes (they spend Muse credits).
  app.get("/v1/benchmarks", async (c) => c.json(await listBenchmarks(ctx)));
  app.get("/v1/benchmarks/latest", async (c) => { const b = await latestBenchmark(ctx); return b ? c.json(b) : c.body(null, 204); });
  app.get("/v1/benchmarks/runs/:cid", async (c) => c.json(await coldRunDetail(ctx, c.req.param("cid"))));
  app.get("/v1/benchmarks/:ref", async (c) => c.json(await getBenchmark(ctx, c.req.param("ref"))));
  app.post("/v1/operator/benchmarks", async (c) => {
    operator(c.req.header("x-skills-token"));
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b.skill !== "string" || typeof b.agent_a !== "string" || typeof b.agent_b !== "string") throw new HttpError(400, "invalid_json", "expected {skill, params, agent_a, agent_b, find?}");
    return c.json(await openBenchmark(ctx, { skill: b.skill, params: b.params, agent_a: b.agent_a, agent_b: b.agent_b, find: b.find && typeof b.find === "object" ? b.find : undefined }), 201);
  });
  // Each run is started by its agent: operator token (funding) plus that agent's signed request over "?h=<sha256 of the body>".
  const signedBy = async (c: any) => {
    operator(c.req.header("x-skills-token"));
    const raw = await c.req.text();
    if (raw.length > 20_000) throw new HttpError(413, "too_large", "request too large");
    const u = new URL(c.req.url);
    const did = verifyRequestAuth(c.req.header("authorization"), "POST", u.pathname + u.search, ctx.now());
    if (!did) throw new HttpError(401, "unauthorized", "send the agent's signed request (Authorization: Agentboard ...)");
    if (u.searchParams.get("h") !== sha256Hex(new TextEncoder().encode(raw))) throw new HttpError(401, "body_hash", "h must be the sha256 of the request body");
    let b: any = {}; if (raw.trim()) { try { b = JSON.parse(raw); } catch { throw new HttpError(400, "invalid_json", "expected JSON"); } }
    return { did, b: b && typeof b === "object" ? b : {} };
  };
  app.post("/v1/operator/benchmarks/:id/cold", async (c) => { const { did } = await signedBy(c); return c.json(await startColdRun(ctx, c.req.param("id"), did), 201); });
  app.post("/v1/operator/benchmarks/:id/reuse", async (c) => { const { did, b } = await signedBy(c); return c.json(await startReuseRun(ctx, c.req.param("id"), did, typeof b.skill === "string" ? b.skill : ""), 202); });
  app.post("/v1/operator/benchmarks/:id/finalize", async (c) => {
    operator(c.req.header("x-skills-token"));
    const b = await c.req.json().catch(() => ({}));
    return c.json(await finalizeBenchmark(ctx, c.req.param("id"), b && typeof b === "object" ? b : {}), 201);
  });

  // ---- operator: hide a leftover test agent (node-signed moderation record in the log; nothing deleted)
  app.post("/v1/operator/agents/:did/hide", async (c) => {
    operator(c.req.header("x-skills-token"));
    const body = await c.req.json().catch(() => ({}));
    const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 300) : "hidden by the node operator";
    return c.json(await hideAgent(ctx, c.req.param("did"), reason), 201);
  });

  // ---- operator credit grant: a node-signed `credit_grant` record (1..200 credits, public reason) in the log
  app.post("/v1/operator/credits/grant", async (c) => {
    operator(c.req.header("x-skills-token"));
    const b = await c.req.json().catch(() => ({}));
    const did = typeof b?.did === "string" ? b.did.trim() : "";
    if (!did.startsWith("did:key:")) throw new HttpError(400, "did", "did must be the agent's did:key");
    const reason = typeof b?.reason === "string" ? b.reason.trim().slice(0, 300) : "";
    if (!reason) throw new HttpError(400, "reason", "a public reason is required");
    return c.json(await grantCredits(ctx, did, b?.amount, reason, { repeat: b?.repeat === true }), 201);
  });
  app.get("/v1/credits/grants", async (c) => c.json({ content_trust: "grant reasons are written by the node operator", grants: await listCreditGrants(ctx) }));

  app.post("/v1/operator/topics/:path/hide", async (c) => {
    operator(c.req.header("x-skills-token"));
    const body = await c.req.json().catch(() => ({}));
    const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 300) : "hidden by the node operator";
    return c.json(await hideTopic(ctx, decodeURIComponent(c.req.param("path")), reason), 201);
  });

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
  app.get("/v1/skills/find", async (c) => c.json({ skills: await findSkills(ctx, c.req.query("q") ?? "", Number(c.req.query("limit") ?? 5)) }));

  // ---- run a published skill through the executor (MCP run_skill). Auth: the operator token, or a signed
  // agent request (Authorization: Agentboard ..., over "POST /v1/skills/run?h=<sha256 of the body>") that
  // pays credits within daily quotas. Steps that submit/buy/send/delete always wait for a human on the
  // run page; the requester cannot approve them.
  app.post("/v1/skills/run", async (c) => {
    const raw = await c.req.text();
    if (raw.length > 20_000) throw new HttpError(413, "too_large", "request too large");
    let by: { requested_by: string; via: "operator" | "agent" };
    let charged = 0;
    const tok = c.req.header("x-skills-token");
    if (tok) { operator(tok); by = { requested_by: "operator", via: "operator" }; }
    else {
      const u = new URL(c.req.url);
      const did = verifyRequestAuth(c.req.header("authorization"), "POST", u.pathname + u.search, ctx.now());
      if (!did) throw new HttpError(401, "unauthorized", "send the operator token (x-skills-token) or a signed agent request");
      if (u.searchParams.get("h") !== sha256Hex(new TextEncoder().encode(raw))) throw new HttpError(401, "body_hash", "h must be the sha256 of the request body");
      by = { requested_by: did, via: "agent" };
    }
    if (!ctx.cfg.skillsInternalSecret) throw new HttpError(503, "executor_disabled", "no executor configured");
    let b: any; try { b = JSON.parse(raw); } catch { throw new HttpError(400, "invalid_json", "expected {skill, params}"); }
    if (typeof b?.skill !== "string") throw new HttpError(400, "skill", "skill (cid or slug) is required");
    const jobReq = { skill: b.skill, params: b.params, start_url: typeof b.start_url === "string" ? b.start_url : undefined };
    let job: { id: string };
    if (by.via === "agent") { const r = await createAgentFundedJob(ctx, by.requested_by, jobReq); job = r.job; charged = r.cost; }
    else job = await createJob(ctx, jobReq, by);
    try {
      await dispatchJob(ctx, job.id);
      return c.json(await getJob(ctx, job.id), 202);
    } catch (e) {
      if (charged) await refundAgentRun(ctx, by.requested_by, charged);
      throw e;
    }
  });
  app.get("/v1/skills/jobs/:id", async (c) => c.json(await getJob(ctx, c.req.param("id"))));
  app.get("/v1/skills/jobs/:id/frame", async (c) => c.body(await getJobFrame(ctx, c.req.param("id")) as unknown as ArrayBuffer, 200, { "content-type": "image/jpeg", "cache-control": "no-store", "x-content-type-options": "nosniff" }));
  app.post("/v1/skills/jobs/:id/decision", async (c) => {
    operator(c.req.header("x-skills-token"));
    const b = await c.req.json().catch(() => ({}));
    if (typeof b?.approval_id !== "string" || typeof b?.approve !== "boolean") throw new HttpError(400, "decision", "expected {approval_id, approve}");
    return c.json(await decideJob(ctx, c.req.param("id"), b.approval_id, b.approve));
  });
  app.get("/v1/skills", async (c) => c.json({ skills: await listSkills(ctx, c.req.query("q")) }));
  app.get("/v1/skills/:cid", async (c) => c.json(await getSkill(ctx, c.req.param("cid")))); // a cid or a slug (latest version)
  app.get("/v1/muse/spend", async (c) => c.json(await museSpend(ctx)));

  // ---- executor service (separate Render service): guarded Muse calls and finished runs
  app.post("/internal/muse/responses", async (c) => {
    internal(c.req.header("x-skills-secret"));
    const kind = c.req.header("x-muse-kind") as MuseKind;
    if (kind !== "loop" && kind !== "verify") throw new HttpError(400, "kind", "x-muse-kind must be loop or verify");
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new HttpError(400, "invalid_json", "expected a Responses API body");
    // Calls for a public replay (job via = 'public') are counted in the public try_skill bucket; the executor names the job.
    const jobId = c.req.header("x-skills-job");
    const pool = jobId && /^[0-9a-f-]{36}$/.test(jobId) && (await ctx.db.query<any>(`SELECT via FROM skill_jobs WHERE id = $1`, [jobId])).rows[0]?.via === "public" ? "public" : "default";
    const r = await museResponses(ctx, kind, body, 3, pool);
    return c.json({ response: r.response, usage: r.usage, model: r.model, ms: r.ms });
  });
  app.post("/internal/skills/runs", async (c) => {
    internal(c.req.header("x-skills-secret"));
    const parsed = RunZ.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_run", parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return c.json(await submitRun(ctx, parsed.data), 201);
  });
  app.get("/internal/skills/jobs/:id", async (c) => {
    internal(c.req.header("x-skills-secret"));
    return c.json(await getJob(ctx, c.req.param("id"), true));
  });
  app.post("/internal/skills/jobs/:id/events", async (c) => {
    internal(c.req.header("x-skills-secret"));
    const parsed = JobEventZ.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_event", parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return c.json(await jobEvent(ctx, c.req.param("id"), parsed.data));
  });
  app.post("/internal/skills/authorize", async (c) => {
    // The executor checks an operator token without holding it itself.
    internal(c.req.header("x-skills-secret"));
    const b = await c.req.json().catch(() => ({}));
    operator(typeof b?.token === "string" ? b.token : undefined);
    return c.json({ ok: true });
  });
}
