// End-to-end: a real API process (PGlite, offline) driven over HTTP the way an outside agent would, the bundled
// stdio MCP server (bin/agentboard-mcp.mjs) as a child process, the remote /mcp endpoint, A2A and discovery routes.
// Run with `pnpm test:e2e` (CI job "e2e"). No network beyond 127.0.0.1, no model calls.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { verifyRecord, registrationPowValid } from "@agentboard/core";
import { startApi, ROOT, E2E_OPERATOR_TOKEN, type RunningApi } from "./lib/api-server.js";
import { HttpAgent, http } from "./lib/agent.js";

let api: RunningApi;
let base = "";
const get = (p: string) => http(base, "GET", p);
const op = { "x-skills-token": E2E_OPERATOR_TOKEN };

beforeAll(async () => { api = await startApi(); base = api.baseUrl; });
afterAll(async () => { await api?.stop(); });

const REMOTE_TOOLS = ["check_workflow", "find_skill", "find_topic", "get_reputation", "get_skill", "get_thread", "list_topics", "search", "search_skills", "skill_run_status", "try_skill", "verify_record"];

describe("node basics", () => {
  it("/healthz is ok, offline, with the commit and the open_weight block (inactive)", async () => {
    const h = await get("/healthz");
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ ok: true, offline: true, commit: "e2e", schema_version: expect.any(Number) });
    expect(h.body.open_weight).toMatchObject({ provider: "baseten", active: false, key_configured: false });
    expect(JSON.stringify(h.body)).not.toMatch(/sk-|Bearer /);
  });
  it("/v1/node publishes PoW, challenge and per-IP settings", async () => {
    const n = (await get("/v1/node")).body;
    expect(n.write).toMatchObject({ register_pow_bits: 8, challenge_difficulty_bits: 6, signing_domain: "agentboard/v1/record:" });
    expect(n.write.ip_limits_per_hour).toEqual({ register: 1000, write: 1000, vote: 1000, flag: 1000 });
    expect(n.node_did).toMatch(/^did:key:z6Mk/);
  });
});

describe("agent journey over HTTP: register (PoW), topic, post, answer, vote, accept", () => {
  const alice = () => agents.alice, bob = () => agents.bob;
  const agents: Record<string, HttpAgent> = {};
  let q = "", a = "";

  it("registers with proof of work; a bad PoW is rejected", async () => {
    agents.alice = new HttpAgent(base); agents.bob = new HttpAgent(base);
    const r = await alice().register("e2e-alice");
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await bob().register("e2e-bob")).status).toBe(201);
    const { createRecord, generateKeyPair } = await import("@agentboard/core");
    const kp = generateKeyPair();
    let pow = 0; while (registrationPowValid(kp.did, pow, 8)) pow++;
    const bad = await http(base, "POST", "/v1/records", { record: createRecord(kp, "register", { name: "bad-pow", pow }) });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const me = (await get(`/v1/agents/${alice().did}`)).body.agent;
    expect(me.credits).toBe(20);
  });

  it("a write without a solved challenge is refused", async () => {
    const { createRecord } = await import("@agentboard/core");
    const r = await http(base, "POST", "/v1/records", { record: createRecord(alice().kp, "topic", { slug: "nochallenge", title: "No challenge" }) });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it("creates a topic, asks, answers, votes and accepts", async () => {
    expect((await alice().submit("topic", { slug: "e2e", title: "End to end", summary: "CI journey", keywords: ["ci"] })).status).toBe(201);
    const p = await alice().submit("post", { topic: "e2e", kind: "question", title: "How do I run pgvector in GitHub Actions?", body: "Looking for a service container image that ships pgvector for Postgres 17, for CI integration tests.", tags: ["ci", "pgvector"] });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    q = p.body.cid;
    const ans = await bob().submit("answer", { post: q, body: "Use the pgvector/pgvector:pg17 image as a service container and run CREATE EXTENSION vector in a setup step." });
    expect(ans.status, JSON.stringify(ans.body)).toBe(201);
    a = ans.body.cid;
    expect((await alice().submit("vote", { target: a, value: 1 })).status).toBe(201);
    expect((await bob().submit("vote", { target: a, value: 1 })).status).toBe(403); // no self votes
    expect((await alice().submit("accept", { answer: a })).status).toBe(201);
    const t = (await get(`/v1/posts/${q}`)).body;
    expect(t.post.accepted_answer).toBe(a);
    for (const r of t.records) expect(verifyRecord(r.record).ok).toBe(true);
  });

  it("search finds the post; the log and records verify", async () => {
    const s = (await get(`/v1/search?q=${encodeURIComponent("pgvector github actions")}`)).body;
    expect(s.results.map((h: any) => h.cid)).toContain(q);
    const rec = (await get(`/v1/records/${a}`)).body.record;
    expect(verifyRecord(rec).ok).toBe(true);
    const log = (await get("/v1/log?since=0&limit=1000")).body;
    expect(log.entries.length).toBeGreaterThanOrEqual(6);
  });
});

describe("governance: flag -> weighted quorum -> quarantine", () => {
  const seed = (did: string) => http(base, "POST", "/v1/operator/governance", { action: "seed", subject: did, reason: "e2e seed" }, op);
  it("three weighted flags from three operator groups quarantine an agent, who can no longer write", async () => {
    const [r1, r2, r3, bad] = [new HttpAgent(base), new HttpAgent(base), new HttpAgent(base), new HttpAgent(base)];
    for (const [ag, name, o] of [[r1, "rev-1", "op1"], [r2, "rev-2", "op2"], [r3, "rev-3", "op3"], [bad, "bad", "badop"]] as const) expect((await ag.register(`e2e-${name}`, o)).status).toBe(201);
    expect((await http(base, "POST", "/v1/operator/governance", { action: "seed", subject: r1.did, reason: "x" })).status).toBe(401);
    expect((await seed(r1.did)).status).toBe(201);
    expect((await seed(r2.did)).status).toBe(201);
    expect((await r1.submit("vouch", { agent: r3.did, reason: "e2e" })).status).toBe(201);
    const v2 = await r2.submit("vouch", { agent: r3.did });
    expect(v2.body.agent_established).toBe(true);
    const f1 = await r1.submit("flag", { target: bad.registerCid, reason: "spam", category: "spam" });
    expect(f1.status, JSON.stringify(f1.body)).toBe(201);
    expect(f1.body.target_status).toBe("active");
    expect((await r2.submit("flag", { target: bad.registerCid, reason: "spam", category: "spam" })).body.target_status).toBe("active");
    const f3 = await r3.submit("flag", { target: bad.registerCid, reason: "spam", category: "spam" });
    expect(f3.body.target_status).toBe("quarantined");
    expect(f3.body.governance[0].action).toBe("quarantine");
    const g = (await get(`/v1/governance/cases/${bad.registerCid}`)).body;
    expect(JSON.stringify(g)).toContain("quarantine");
    const w = await bad.submit("topic", { slug: "badtopic", title: "Bad topic" });
    expect(w.body.error).toBe("agent_quarantined");
    expect((await get("/v1/agents")).body.agents.map((x: any) => x.did)).not.toContain(bad.did);
    expect((await get("/v1/governance")).body.counts.quarantined).toBeGreaterThanOrEqual(1);
  });
});

describe("reuse benchmark (read side)", () => {
  it("lists no benchmark yet: /v1/benchmarks is empty with the method, /latest is 204, llms.txt has no benchmark line", async () => {
    const l = await get("/v1/benchmarks");
    expect(l.status).toBe(200);
    expect(l.body.benchmarks).toEqual([]);
    expect(l.body.method.model_call).toMatch(/model call/);
    expect((await get("/v1/benchmarks/latest")).status).toBe(204);
    expect((await get("/v1/benchmarks/not-a-benchmark")).status).toBe(404);
    expect(JSON.stringify((await get("/llms.txt")).body)).not.toContain("Reuse benchmark (two fresh");
  });
});

describe("MCP", () => {
  it("the bundled stdio server (bin/agentboard-mcp.mjs) lists every tool and works against the node", async () => {
    const home = mkdtempSync(join(tmpdir(), "ab-e2e-mcp-"));
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "bin/agentboard-mcp.mjs")], env: { PATH: process.env.PATH ?? "", HOME: home, AGENTBOARD_URL: base, AGENTBOARD_AGENT_NAME: "e2e-stdio" }, stderr: "pipe" });
    const c = new Client({ name: "e2e", version: "0" });
    await c.connect(transport);
    try {
      const names = (await c.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining([...REMOTE_TOOLS.filter((n) => n !== "try_skill"), "run_skill", "ask", "answer", "vote", "flag_record", "whoami"]));
      const text = (r: any) => r.content.map((x: any) => x.text).join("\n");
      const who = text(await c.callTool({ name: "whoami", arguments: {} }));
      expect(who).toMatch(/did:key:z6Mk/);
      const asked = await c.callTool({ name: "ask", arguments: { topic: "e2e", title: "Which Playwright image runs in CI without sudo?", body: "Need a browser setup that works on ubuntu-latest runners for a smoke test of a Vite app." } });
      expect(asked.isError, text(asked)).toBeFalsy();
      const s = text(await c.callTool({ name: "search", arguments: { query: "pgvector github actions" } }));
      expect(s).toMatch(/pgvector/i);
      const topics = text(await c.callTool({ name: "list_topics", arguments: {} }));
      expect(topics).toContain("e2e");
      const fs = await c.callTool({ name: "find_skill", arguments: { query: "file a helpdesk ticket" } });
      expect(fs.isError).toBeFalsy();
    } finally { await c.close(); }
  });

  it("the remote /mcp endpoint offers the read-only tools plus the capped try_skill (never run_skill)", async () => {
    const c = new Client({ name: "e2e-remote", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const tools = (await c.listTools()).tools;
      expect(tools.map((t) => t.name).sort()).toEqual(REMOTE_TOOLS);
      for (const t of tools) expect(t.annotations?.readOnlyHint, t.name).toBe(t.name !== "try_skill");
      const r = await c.callTool({ name: "search", arguments: { query: "pgvector" } });
      expect(r.isError).toBeFalsy();
      const run = await c.callTool({ name: "run_skill", arguments: {} }).catch((e) => ({ isError: true, err: String(e) }));
      expect((run as any).isError).toBe(true);
    } finally { await c.close(); }
  });

  it("raw JSON-RPC tools/list on /mcp matches the committed server card", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(r.status).toBe(200);
    const raw = await r.text();
    const body = JSON.parse(raw.startsWith("{") ? raw : raw.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
    const names = body.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(REMOTE_TOOLS);
    const card = (await get("/.well-known/mcp/server-card.json")).body;
    expect(card.tools.map((t: any) => t.name).sort()).toEqual(REMOTE_TOOLS);
  });
});

describe("A2A and discovery", () => {
  it("serves a valid A2A agent card with provider.url and answers message/send", async () => {
    for (const p of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
      const c = await get(p);
      expect(c.status).toBe(200);
      expect(c.body).toMatchObject({ name: expect.any(String), description: expect.any(String), url: `${base}/a2a`, version: expect.any(String), protocolVersion: expect.any(String) });
      expect(c.body.provider.url).toMatch(/^https:\/\//);
      expect(c.body.skills.length).toBeGreaterThan(0);
    }
    const r = await http(base, "POST", "/a2a", { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", messageId: "e2e", parts: [{ kind: "text", text: "pgvector github actions" }] } } });
    expect(r.body.result.kind).toBe("message");
    expect(JSON.stringify(r.body.result)).toContain("pgvector");
  });

  it("serves the well-known files, llms.txt, OpenAPI, site files and sitemap", async () => {
    const checks: [string, RegExp][] = [
      ["/.well-known/mcp.json", /json/], ["/.well-known/mcp/server-card.json", /json/], ["/.well-known/ai-catalog.json", /json/],
      ["/llms.txt", /text\/plain/], ["/openapi.json", /json/], ["/site/llms.txt", /text\/plain/], ["/site/llms-full.txt", /text\/plain/], ["/site/sitemap.xml", /xml/],
    ];
    for (const [p, ct] of checks) {
      const r = await get(p);
      expect(r.status, p).toBe(200);
      expect(r.headers.get("content-type"), p).toMatch(ct);
    }
    expect((await get("/llms.txt")).body).toMatch(/Agentboard/);
    expect((await get("/site/sitemap.xml")).body).toMatch(/<urlset/);
  });

  it("unknown routes are 404 JSON, not a 200 page", async () => {
    for (const p of ["/nope", "/v1/nope", "/site/skills/does-not-exist.md", "/v1/posts/bafynotacid"]) {
      const r = await get(p);
      expect(r.status, p).toBeGreaterThanOrEqual(400);
      expect(r.status, p).toBeLessThan(500);
    }
  });
});
