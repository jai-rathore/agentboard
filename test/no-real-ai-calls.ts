// Vitest setup file (vitest.config.ts setupFiles): tests must never reach a real paid model API.
// A test once leaked a real request to api.meta.ai with a fake key. Every outbound request to a blocked host
// through fetch, http(s).request or http(s).get throws and is recorded; the afterEach hook then fails the test
// that made it, even if the code under test swallowed the error (LLM callers fall back on errors).
// Tests inject a fake fetchImpl instead; a fake that never calls the global fetch is unaffected.
import http from "node:http";
import https from "node:https";
import { afterEach, expect } from "vitest";

export const BLOCKED_AI_HOSTS = [
  "api.meta.ai",
  "meta.ai",
  "inference.baseten.co",
  "baseten.co",
  "api.fireworks.ai",
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
];

const blocked = (host: string | undefined | null) => {
  if (!host) return false;
  const h = host.toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  return BLOCKED_AI_HOSTS.some((b) => h === b || h.endsWith(`.${b}`));
};

// Shared across module instances (the guard self-test drains it after deliberately tripping the guard).
const violations: string[] = ((globalThis as any).__abNoRealAiViolations ??= []);
const fail = (url: string): never => {
  violations.push(url);
  throw new Error(`[no-real-ai-calls] blocked a real network call to ${url} from a test. Inject a fake fetchImpl instead.`);
};

const hostOf = (input: unknown): { host?: string; href: string } => {
  try {
    if (typeof input === "string") { const u = new URL(input); return { host: u.hostname, href: u.href }; }
    if (input instanceof URL) return { host: input.hostname, href: input.href };
    if (input && typeof input === "object" && "url" in input && typeof (input as Request).url === "string") {
      const u = new URL((input as Request).url); return { host: u.hostname, href: u.href };
    }
  } catch { /* relative or invalid: not a remote call */ }
  return { href: String(input) };
};

const g = globalThis as typeof globalThis & { __abNoRealAi?: boolean };
if (!g.__abNoRealAi) {
  g.__abNoRealAi = true;
  const realFetch = globalThis.fetch;
  if (realFetch) {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const { host, href } = hostOf(input);
      if (blocked(host)) fail(href);
      return realFetch(input, init);
    }) as typeof fetch;
  }
  for (const mod of [http, https] as const) {
    const proto = mod === https ? "https:" : "http:";
    for (const fn of ["request", "get"] as const) {
      const orig = (mod as any)[fn];
      (mod as any)[fn] = function (this: unknown, ...args: any[]) {
        const a = args[0];
        let host: string | undefined; let href = "";
        if (typeof a === "string" || a instanceof URL) ({ host, href } = hostOf(a));
        else if (a && typeof a === "object") { host = a.hostname ?? a.host; href = `${proto}//${host ?? ""}${a.path ?? ""}`; }
        if (blocked(host)) fail(href);
        return orig.apply(this, args);
      };
    }
  }
}

afterEach(() => {
  if (violations.length === 0) return;
  const seen = violations.splice(0);
  expect.fail(`[no-real-ai-calls] this test tried to call a real model API: ${seen.join(", ")}`);
});
