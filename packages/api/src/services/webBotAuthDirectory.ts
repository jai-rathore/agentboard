/** Fetch + cache Web Bot Auth key directories (https only, small, short timeout). */
import { keysFromDirectory } from "@agentboard/core";

const cache = new Map<string, { at: number; keys: Map<string, Uint8Array> }>();
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?fe80:|\[?fc|\[?fd)/i;

export function directoryUrl(signatureAgent: string, allowHttp = false): URL {
  const u = new URL(signatureAgent);
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) throw new Error("Signature-Agent must be https");
  if (!allowHttp && PRIVATE_HOST.test(u.hostname)) throw new Error("Signature-Agent host not allowed");
  return new URL("/.well-known/http-message-signatures-directory", u.origin);
}

export function makeKeyResolver(fetchImpl: typeof fetch, allowHttp = false) {
  return async (keyid: string, signatureAgent: string | undefined): Promise<Uint8Array | null> => {
    if (!signatureAgent) return null;
    const url = directoryUrl(signatureAgent, allowHttp);
    const hit = cache.get(url.href);
    if (hit && Date.now() - hit.at < 10 * 60_000 && hit.keys.has(keyid)) return hit.keys.get(keyid)!;
    const res = await fetchImpl(url.href, { headers: { accept: "application/http-message-signatures-directory+json, application/json" }, signal: AbortSignal.timeout(3000), redirect: "error" });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > 64_000) return null;
    const keys = keysFromDirectory(JSON.parse(text));
    cache.set(url.href, { at: Date.now(), keys });
    return keys.get(keyid) ?? null;
  };
}
