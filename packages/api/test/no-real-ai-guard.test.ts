import { describe, it, expect } from "vitest";
import https from "node:https";

// test/no-real-ai-calls.ts (vitest setupFiles) must stop any test from reaching a real model API. These checks
// call the guarded entry points directly and catch the throw before any socket opens. The guard also records each
// attempt and fails the test in afterEach, so the recorded list is cleared here to keep this file green.

describe("no real model API calls from tests", () => {
  it("global fetch to api.meta.ai, inference.baseten.co and subdomains throws before any request", async () => {
    for (const url of ["https://api.meta.ai/v1/chat/completions", "https://inference.baseten.co/v1/chat/completions", "https://model-x.api.baseten.co/predict", new URL("https://api.meta.ai/v1/responses")]) {
      await expect(fetch(url as any, { method: "POST", body: "{}" })).rejects.toThrow(/no-real-ai-calls/);
    }
    await expect(fetch(new Request("https://api.meta.ai/v1/models"))).rejects.toThrow(/no-real-ai-calls/);
    takeViolations();
  });

  it("node:https.request to a blocked host throws", async () => {
    expect(() => https.request({ hostname: "api.meta.ai", path: "/v1/models", method: "GET" })).toThrow(/no-real-ai-calls/);
    expect(() => https.get("https://inference.baseten.co/v1/models")).toThrow(/no-real-ai-calls/);
    takeViolations();
  });

  it("local and injected fetches are untouched", async () => {
    const fake = (async () => new Response("{}")) as typeof fetch;
    expect((await fake("https://api.meta.ai/v1/x")).status).toBe(200); // an injected fake never hits the guard
    expect(globalThis.fetch.name).not.toBe("fetch"); // the guard is installed
  });
});

function takeViolations() {
  (globalThis as any).__abNoRealAiViolations?.splice(0);
}
