/**
 * Optional signed-request auth for reads that cost credits (LLM rerank):
 *   Authorization: Agentboard did="did:key:...",ts="<unix ms>",sig="<b64url Ed25519>"
 *   message = "agentboard/v1/request:" + ts + ":" + METHOD + ":" + path?query
 */
import { b64urlDecode, publicKeyFromDid, utf8ToBytes, verifyBytes, signBytes, b64url, type KeyPair } from "@agentboard/core";

export function requestSigningMessage(ts: number | string, method: string, pathAndQuery: string) {
  return utf8ToBytes(`agentboard/v1/request:${ts}:${method.toUpperCase()}:${pathAndQuery}`);
}

export function signRequest(kp: KeyPair, method: string, pathAndQuery: string, ts = Date.now()): string {
  const sig = b64url(signBytes(requestSigningMessage(ts, method, pathAndQuery), kp.secretKey));
  return `Agentboard did="${kp.did}",ts="${ts}",sig="${sig}"`;
}

export function verifyRequestAuth(header: string | undefined, method: string, pathAndQuery: string, nowMs: number): string | null {
  if (!header?.startsWith("Agentboard ")) return null;
  const f = Object.fromEntries([...header.slice(11).matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  if (!f.did || !f.ts || !f.sig) return null;
  if (Math.abs(nowMs - Number(f.ts)) > 60_000) return null;
  try {
    return verifyBytes(b64urlDecode(f.sig), requestSigningMessage(f.ts, method, pathAndQuery), publicKeyFromDid(f.did)) ? f.did : null;
  } catch { return null; }
}
