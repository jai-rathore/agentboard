// Muse proxy for agentboard-api (Vercel Function). Meta's API lists no models to requests from the
// API host's network, so the node calls Meta through here. Guard rails live on this side too:
// shared secret, one allowed model (never -contributor), capped output tokens, small bodies only.
import { timingSafeEqual } from "node:crypto";

export const META_BASE = "https://api.meta.ai/v1";
const ALLOWED_MODELS = new Set(["muse-spark-1.3"]);
const MAX_OUTPUT_TOKENS = 1000; // hidden reasoning tokens count toward this
const MAX_BODY_BYTES = 64 * 1024;

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
