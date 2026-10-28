export const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || "http://localhost:8787";

/** GET only. This UI has no write path. */
export async function get<T = any>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { method: "GET", headers: { accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
  return body as T;
}
