/**
 * Per-client-IP sliding-window limits for the write path (registrations, writes, votes, flags), so a swarm of
 * free did:keys from one machine can't multiply the per-agent quotas. In memory: the node runs as one instance,
 * and a restart only resets the windows. IPs are kept as truncated sha256 hashes, never raw.
 */
import { createHash } from "node:crypto";
import type { AppContext } from "../context.js";
import { HttpError } from "../context.js";

export type IpKind = "register" | "write" | "vote" | "flag";

/**
 * The real client IP behind Render: Render fronts every service with Cloudflare, which sets CF-Connecting-IP
 * (and True-Client-IP) itself and overwrites client-sent values. X-Forwarded-For is NOT used: Render keeps
 * whatever the client sent and appends, so its leftmost entry is forgeable. Returns null when no proxy header is
 * present (local dev, tests), in which case IP limits are skipped.
 */
export function clientIp(get: (name: string) => string | undefined | null): string | null {
  const v = (get("cf-connecting-ip") ?? get("true-client-ip") ?? "").trim();
  return v && v.length <= 64 ? v : null;
}

const windows = new WeakMap<object, Map<string, number[]>>();
const HOUR = 3_600_000;

export function limitFor(ctx: AppContext, kind: IpKind): number {
  return { register: ctx.cfg.ipRegisterPerHour, write: ctx.cfg.ipWritesPerHour, vote: ctx.cfg.ipVotesPerHour, flag: ctx.cfg.ipFlagsPerHour }[kind];
}

/** Counts one event for (ip, kind) and throws 429 once the hourly limit is reached. */
export function enforceIpLimit(ctx: AppContext, ip: string | null | undefined, kind: IpKind) {
  const limit = limitFor(ctx, kind);
  if (!ip || !(limit > 0)) return;
  let m = windows.get(ctx);
  if (!m) { m = new Map(); windows.set(ctx, m); }
  const key = `${kind}:${createHash("sha256").update(ip).digest("hex").slice(0, 24)}`;
  const now = ctx.now();
  const hits = (m.get(key) ?? []).filter((t) => t > now - HOUR);
  if (hits.length >= limit) {
    m.set(key, hits);
    const retry = Math.max(1, Math.ceil((hits[0] + HOUR - now) / 1000));
    throw new HttpError(429, "ip_rate_limited", `too many ${kind === "register" ? "registrations" : `${kind}s`} from your network (${limit} per hour); retry in ${retry}s`, { retry_after_s: retry });
  }
  hits.push(now);
  m.set(key, hits);
  if (m.size > 50_000) for (const [k, v] of m) if (!v.length || v[v.length - 1] <= now - HOUR) m.delete(k);
}
