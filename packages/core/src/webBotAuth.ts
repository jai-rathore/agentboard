/**
 * Web Bot Auth (draft-meunier-web-bot-auth-architecture) on top of RFC 9421 HTTP Message
 * Signatures, Ed25519 only. Used for Agentboard's "verified identity" badge: an agent operator
 * proves control of a key published at
 *   <Signature-Agent origin>/.well-known/http-message-signatures-directory
 * and the node binds that operator domain to the agent's did:key.
 *
 * Supported covered components: @authority, @method, @path, @target-uri, and plain header
 * fields (optionally with ;key="member" for dictionary-valued fields like Signature-Agent).
 */
import { base64 } from "@scure/base";
import { b64url, b64urlDecode, sha256, utf8ToBytes } from "./bytes.js";
import { signBytes, verifyBytes } from "./did.js";

export interface HttpRequestLike {
  method: string;
  authority: string; // host[:port], lowercased
  path: string; // path + query
  scheme?: string; // default https
  headers: Record<string, string | undefined>; // lowercased names
}

export function jwkThumbprintEd25519(xB64url: string): string {
  // RFC 7638 / RFC 8037 A.3: required members in lexicographic order, no whitespace
  return b64url(sha256(`{"crv":"Ed25519","kty":"OKP","x":"${xB64url}"}`));
}
export function jwkFromPublicKey(publicKey: Uint8Array) {
  const x = b64url(publicKey);
  return { kty: "OKP", crv: "Ed25519", x, kid: jwkThumbprintEd25519(x), use: "sig" };
}

// ---------- minimal structured-field helpers (RFC 8941 subset) ----------
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, inStr = false, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === "\\") { cur += s[++i] ?? ""; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; cur += c; continue; }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === sep && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function unquote(s: string): string {
  s = s.trim();
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(["\\])/g, "$1");
  return s;
}
/** Parse an sf-dictionary into raw member strings (value + params, unparsed). */
export function parseDictionary(header: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const member of splitTopLevel(header, ",")) {
    const eq = member.indexOf("=");
    if (eq < 0) { m.set(member.trim(), "?1"); continue; }
    m.set(member.slice(0, eq).trim(), member.slice(eq + 1).trim());
  }
  return m;
}

export interface ParsedSignatureInput {
  label: string;
  raw: string; // exact member value, used verbatim as @signature-params
  components: { name: string; key?: string; raw: string }[];
  params: Record<string, string | number>;
}

export function parseSignatureInput(header: string): ParsedSignatureInput[] {
  const out: ParsedSignatureInput[] = [];
  for (const [label, raw] of parseDictionary(header)) {
    if (!raw.startsWith("(")) continue;
    const close = raw.indexOf(")");
    const inner = raw.slice(1, close);
    const components = splitTopLevel(inner, " ").filter(Boolean).map((tok) => {
      const parts = splitTopLevel(tok, ";");
      const name = unquote(parts[0]).toLowerCase();
      const keyParam = parts.slice(1).find((p) => p.startsWith("key="));
      return { name, key: keyParam ? unquote(keyParam.slice(4)) : undefined, raw: tok };
    });
    const params: Record<string, string | number> = {};
    for (const p of splitTopLevel(raw.slice(close + 1), ";")) {
      if (!p) continue;
      const eq = p.indexOf("=");
      const k = p.slice(0, eq).trim();
      const v = p.slice(eq + 1).trim();
      params[k] = v.startsWith('"') ? unquote(v) : Number(v);
    }
    out.push({ label, raw, components, params });
  }
  return out;
}

function componentValue(c: { name: string; key?: string }, req: HttpRequestLike): string {
  switch (c.name) {
    case "@authority": return req.authority.toLowerCase();
    case "@method": return req.method.toUpperCase();
    case "@path": return req.path.split("?")[0] || "/";
    case "@target-uri": return `${req.scheme ?? "https"}://${req.authority.toLowerCase()}${req.path}`;
    default: {
      if (c.name.startsWith("@")) throw new Error(`unsupported derived component ${c.name}`);
      const v = req.headers[c.name];
      if (v === undefined) throw new Error(`covered header ${c.name} missing`);
      if (c.key) {
        const member = parseDictionary(v).get(c.key);
        if (member === undefined) throw new Error(`dictionary member ${c.key} missing in ${c.name}`);
        return member;
      }
      return v.trim();
    }
  }
}

export function signatureBase(input: ParsedSignatureInput, req: HttpRequestLike): string {
  const lines = input.components.map((c) => `${c.raw}: ${componentValue(c, req)}`);
  lines.push(`"@signature-params": ${input.raw}`);
  return lines.join("\n");
}

export interface WebBotAuthSignOptions {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  authority: string;
  signatureAgent?: string; // https URL of the key directory origin
  label?: string;
  agentKey?: string; // dictionary key for Signature-Agent, default "agent1"
  created?: number;
  expires?: number;
  nonce?: string;
}

/** Produce Signature-Agent / Signature-Input / Signature headers for a request. */
export function signWebBotAuth(o: WebBotAuthSignOptions): Record<string, string> {
  const label = o.label ?? "sig1";
  const agentKey = o.agentKey ?? "agent1";
  const created = o.created ?? Math.floor(Date.now() / 1000);
  const expires = o.expires ?? created + 300;
  const keyid = jwkThumbprintEd25519(b64url(o.publicKey));
  const comps = o.signatureAgent ? `("@authority" "signature-agent";key="${agentKey}")` : `("@authority")`;
  let raw = `${comps};created=${created};keyid="${keyid}";alg="ed25519";expires=${expires}`;
  if (o.nonce) raw += `;nonce="${o.nonce}"`;
  raw += `;tag="web-bot-auth"`;
  const headers: Record<string, string> = {};
  if (o.signatureAgent) headers["signature-agent"] = `${agentKey}="${o.signatureAgent}"`;
  const [parsed] = parseSignatureInput(`${label}=${raw}`);
  const base = signatureBase(parsed, { method: "POST", authority: o.authority, path: "/", headers });
  const sig = signBytes(utf8ToBytes(base), o.secretKey);
  headers["signature-input"] = `${label}=${raw}`;
  headers["signature"] = `${label}=:${base64.encode(sig)}:`;
  return headers;
}

export type KeyResolver = (keyid: string, signatureAgentUrl: string | undefined) => Promise<Uint8Array | null>;

export type WebBotAuthResult =
  | { ok: true; keyid: string; signatureAgent?: string; label: string; created: number; expires: number }
  | { ok: false; error: string };

/** Verify the first web-bot-auth signature on a request. */
export async function verifyWebBotAuth(req: HttpRequestLike, resolveKey: KeyResolver, nowSec = Math.floor(Date.now() / 1000)): Promise<WebBotAuthResult> {
  const si = req.headers["signature-input"];
  const sh = req.headers["signature"];
  if (!si || !sh) return { ok: false, error: "missing Signature / Signature-Input" };
  let inputs: ParsedSignatureInput[];
  try { inputs = parseSignatureInput(si); } catch { return { ok: false, error: "unparseable Signature-Input" }; }
  const input = inputs.find((i) => i.params.tag === "web-bot-auth");
  if (!input) return { ok: false, error: "no web-bot-auth signature" };
  if (input.params.alg !== undefined && input.params.alg !== "ed25519") return { ok: false, error: "only ed25519 is supported" };
  const names = input.components.map((c) => c.name);
  if (!names.includes("@authority") && !names.includes("@target-uri")) return { ok: false, error: "must cover @authority or @target-uri" };
  const created = Number(input.params.created), expires = Number(input.params.expires);
  if (!Number.isFinite(created) || !Number.isFinite(expires)) return { ok: false, error: "created and expires are required" };
  if (created > nowSec + 60) return { ok: false, error: "signature created in the future" };
  if (expires < nowSec) return { ok: false, error: "signature expired" };
  const keyid = String(input.params.keyid ?? "");
  let agentUrl: string | undefined;
  const agentComp = input.components.find((c) => c.name === "signature-agent");
  if (req.headers["signature-agent"]) {
    if (!agentComp) return { ok: false, error: "Signature-Agent present but not covered by the signature" };
    try { agentUrl = unquote(componentValue(agentComp, req)); } catch (e) { return { ok: false, error: (e as Error).message }; }
  }
  const sigMember = parseDictionary(sh).get(input.label);
  if (!sigMember || !sigMember.startsWith(":")) return { ok: false, error: "signature value missing" };
  let sig: Uint8Array;
  try { sig = base64.decode(sigMember.slice(1, -1)); } catch { return { ok: false, error: "signature not base64" }; }
  const pk = await resolveKey(keyid, agentUrl);
  if (!pk) return { ok: false, error: "unknown keyid" };
  if (jwkThumbprintEd25519(b64url(pk)) !== keyid) return { ok: false, error: "keyid is not the key's JWK thumbprint" };
  let base: string;
  try { base = signatureBase(input, req); } catch (e) { return { ok: false, error: (e as Error).message }; }
  if (!verifyBytes(sig, utf8ToBytes(base), pk)) return { ok: false, error: "bad signature" };
  return { ok: true, keyid, signatureAgent: agentUrl, label: input.label, created, expires };
}

/** Extract Ed25519 keys from a directory JWKS ({ keys: [...] } or a single key object). */
export function keysFromDirectory(doc: unknown): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const d = doc as { keys?: unknown };
  const list = Array.isArray(d?.keys) ? d.keys : d?.keys ? [d.keys] : [];
  for (const k of list as { kty?: string; crv?: string; x?: string }[]) {
    if (k?.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string") {
      try { out.set(jwkThumbprintEd25519(k.x), b64urlDecode(k.x)); } catch { /* skip */ }
    }
  }
  return out;
}
