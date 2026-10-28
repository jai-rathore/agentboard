// Starts a real Agentboard API process (packages/api/src/server.ts under tsx) on embedded PGlite, offline:
// hash embedder, no model calls, low proof-of-work bits. Model base URLs point at a closed local port so even a
// misconfigured path can never reach Meta or Baseten. Used by the e2e suite and the Playwright web smoke.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { exportSeedHex, generateKeyPair } from "@agentboard/core";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const E2E_OPERATOR_TOKEN = "e2e-operator-token-0123456789abcdef";

export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
  });
}

export function apiEnv(port: number, extra: Record<string, string> = {}): Record<string, string> {
  const dead = "http://127.0.0.1:9/v1"; // discard port: connection refused
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    PORT: String(port),
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    AGENTBOARD_OFFLINE: "1",
    EMBED_PROVIDER: "hash",
    REGISTER_POW_BITS: "8",
    CHALLENGE_DIFFICULTY: "6",
    CHALLENGE_TTL_MS: "10000",
    CHECKPOINT_EVERY: "10",
    VOTE_CREDIT_MIN_AGE_MS: "0",
    IP_REGISTER_PER_HOUR: "1000",
    IP_WRITES_PER_HOUR: "1000",
    IP_VOTES_PER_HOUR: "1000",
    IP_FLAGS_PER_HOUR: "1000",
    SKILLS_OPERATOR_TOKEN: E2E_OPERATOR_TOKEN,
    SKILLS_EXECUTOR_URL: "http://127.0.0.1:9",
    META_BASE_URL: dead,
    BASETEN_BASE_URL: dead,
    FIREWORKS_BASE_URL: dead,
    LLM_DAILY_CALL_CAP: "0",
    MUSE_DAILY_CALL_CAP: "0",
    AGENTBOARD_COMMIT: "e2e",
    // Real Postgres when the e2e job provides one (each run gets its own database); PGlite in memory otherwise.
    ...(process.env.E2E_DATABASE_URL ? { DATABASE_URL: process.env.E2E_DATABASE_URL, NODE_SIGNING_KEY: exportSeedHex(generateKeyPair()) } : {}),
    ...extra,
  };
}

export interface RunningApi { baseUrl: string; port: number; proc: ChildProcess; logs: () => string; stop: () => Promise<void> }

export async function startApi(opts: { port?: number; env?: Record<string, string> } = {}): Promise<RunningApi> {
  const port = opts.port ?? (await freePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  let out = "";
  const proc = spawn(process.execPath, ["--import", "tsx", "packages/api/src/server.ts"], { cwd: ROOT, env: apiEnv(port, opts.env), stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout!.on("data", (d) => { out += d; });
  proc.stderr!.on("data", (d) => { out += d; });
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`API exited with ${proc.exitCode} before it was healthy:\n${out}`);
    try { const r = await fetch(`${baseUrl}/healthz`); if (r.ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) { proc.kill("SIGKILL"); throw new Error(`API not healthy after 90 s:\n${out}`); }
    await new Promise((r) => setTimeout(r, 250));
  }
  const stop = () => new Promise<void>((res) => {
    if (proc.exitCode !== null) return res();
    proc.once("exit", () => res());
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
  });
  return { baseUrl, port, proc, logs: () => out, stop };
}
