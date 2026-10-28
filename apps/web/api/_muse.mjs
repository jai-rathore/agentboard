// Muse proxy for agentboard-api (Vercel Function). Meta's API lists no models to requests from the
// API host's network, so the node calls Meta through here. Guard rails live on this side too:
// shared secret, one allowed model (never -contributor), capped output tokens, small bodies only.
import { timingSafeEqual } from "node:crypto";

export const META_BASE = "https://api.meta.ai/v1";
const ALLOWED_MODELS = new Set(["muse-spark-1.3"]);
const MAX_OUTPUT_TOKENS = 1000; // hidden reasoning tokens count toward this
const MAX_BODY_BYTES = 64 * 1024;
// Responses API (Agentboard Skills): screenshots and short videos travel inline, so bodies are larger.
// Vercel rejects request bodies over 4.5 MB before this code runs; videos go by URL instead.
const MAX_RESPONSES_BODY_BYTES = 4_200_000;
/** Output ceilings by call kind (x-muse-kind header); reasoning tokens count toward them. */
export const RESPONSES_OUTPUT_CAPS = { record: 1500, loop: 800, verify: 600, heal: 2000 };
const ALLOWED_RESPONSES_FIELDS = new Set(["model", "input", "instructions", "tools", "text", "reasoning", "max_output_tokens", "parallel_tool_calls", "metadata", "truncation"]);

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function authorize(request) {
  const want = process.env.AGENTBOARD_PROXY_SECRET || "";
  const got = request.headers.get("x-agentboard-proxy-secret") || "";
  if (want.length < 32 || !process.env.META_API_KEY) return json(503, { error: "proxy_not_configured" });
  const a = Buffer.from(got), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return json(401, { error: "unauthorized" });
  return null;
}

export async function listModels() {
  const r = await fetch(`${META_BASE}/models`, { headers: { authorization: `Bearer ${process.env.META_API_KEY}` } });
  const j = await r.json().catch(() => ({}));
  // ids only: nothing else from the upstream response is passed through
  return json(r.status, { ids: (j.data ?? []).map((m) => m.id), error: j.error?.code ?? null });
}

export async function chat(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: "body_too_large" });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: "invalid_json" }); }
  if (!ALLOWED_MODELS.has(body.model) || /contributor/i.test(String(body.model))) return json(400, { error: "model_not_allowed" });
  if (body.stream) return json(400, { error: "stream_not_supported" });
  body.max_tokens = Math.min(Number(body.max_tokens) || MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);
  delete body.max_completion_tokens;
  delete body.n;
  const r = await fetch(`${META_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.META_API_KEY}` },
    body: JSON.stringify(body),
  });
  return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** Validate and clamp a Responses API body. Returns { body } or { error }. Pure, for tests. */
export function sanitizeResponsesBody(body, kind) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_body" };
  const model = String(body.model ?? "");
  if (!ALLOWED_MODELS.has(model) || /contributor/i.test(model)) return { error: "model_not_allowed" };
  for (const k of Object.keys(body)) {
    // store/stream may be sent only as false (both are forced off below)
    if ((k === "store" || k === "stream") && body[k] === false) continue;
    if (!ALLOWED_RESPONSES_FIELDS.has(k)) return { error: `field_not_allowed:${k}` };
  }
  // Only the built-in computer tool and our own function tools: no web_search (billed per query), no MCP.
  for (const t of body.tools ?? []) if (!t || (t.type !== "computer" && t.type !== "function")) return { error: "tool_not_allowed" };
  const cap = RESPONSES_OUTPUT_CAPS[kind] ?? RESPONSES_OUTPUT_CAPS.loop;
  return { body: { ...body, max_output_tokens: Math.min(Number(body.max_output_tokens) || cap, cap), store: false, stream: false } };
}

export async function responses(request) {
  const raw = await request.text();
  if (raw.length > MAX_RESPONSES_BODY_BYTES) return json(413, { error: "body_too_large" });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: "invalid_json" }); }
  const s = sanitizeResponsesBody(body, request.headers.get("x-muse-kind") || "loop");
  if (s.error) return json(400, { error: s.error });
  const r = await fetch(`${META_BASE}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.META_API_KEY}` },
    body: JSON.stringify(s.body),
  });
  return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
