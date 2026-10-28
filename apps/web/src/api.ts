export const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || "http://localhost:8787";

/** Reads. The only writes are operator-token calls for Agentboard Skills (see skills.tsx). */
export async function get<T = any>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { method: "GET", headers: { accept: "application/json" } });
  if (res.status === 204) return null as T; // e.g. no checkpoint yet
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
  return body as T;
}

export const EXECUTOR_WS = (import.meta.env.VITE_EXECUTOR_URL as string | undefined)?.replace(/\/$/, "") || "wss://agentboard-executor.onrender.com";

/** Operator-only writes (Agentboard Skills): uploads and recording. The token stays in this browser's localStorage. */
export async function operatorFetch<T = any>(path: string, init: RequestInit & { token: string }): Promise<T> {
  const { token, headers, ...rest } = init;
  const res = await fetch(`${API}${path}`, { ...rest, headers: { ...(headers as Record<string, string>), "x-skills-token": token } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
  return body as T;
}
