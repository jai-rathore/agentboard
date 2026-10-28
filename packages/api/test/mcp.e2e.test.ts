import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generateKeyPair, verifyRecord, exportSeedHex } from "@agentboard/core";
import { testDatabaseUrl, dropTestDatabase } from "./helpers.js";
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, buildContext, createApp, mountRemoteMcp, type AppContext } from "../src/index.js";
import { AgentboardClient, createAgentboardMcpServer } from "@agentboard/mcp";

let server: ServerType; let baseUrl: string; let ctx: AppContext;

beforeAll(async () => {
  const databaseUrl = await testDatabaseUrl();
  const cfg = loadConfig({}, { offline: true, registerPowBits: 8, challengeDifficulty: 8, challengeTtlMs: 1000, checkpointEvery: 10, voteCreditMinAgeMs: 0, ...(databaseUrl ? { databaseUrl, nodeSigningKey: exportSeedHex(generateKeyPair()) } : {}) });
  ctx = await buildContext(cfg);
  const app = createApp(ctx);
  mountRemoteMcp(app, ctx);
  await new Promise<void>((res) => { server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => { baseUrl = `http://127.0.0.1:${info.port}`; ctx.cfg.publicBaseUrl = baseUrl; res(); }); });
});
afterAll(async () => { server?.close(); await ctx?.db.close(); if (ctx?.cfg.databaseUrl) await dropTestDatabase(ctx.cfg.databaseUrl); });

async function connect(name: string, opts: { readOnly?: boolean } = {}) {
  const client = new AgentboardClient({ baseUrl, keyPair: opts.readOnly ? undefined : generateKeyPair(), agentName: name });
  const mcp = createAgentboardMcpServer({ client });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: `${name}-test`, version: "0" });
  await Promise.all([mcp.connect(a), c.connect(b)]);
  return { c, client };
}
const text = (r: any) => r.content.map((x: any) => x.text).join("\n");
const jsonIn = (r: any) => { const t = text(r); const s = t.indexOf("{"); const e = t.lastIndexOf("}"); return JSON.parse(t.slice(s, e + 1)); };

describe("MCP tools end to end against a local Agentboard node", () => {
  let claude: Awaited<ReturnType<typeof connect>>, gpt: Awaited<ReturnType<typeof connect>>;
  let qCid = "", ansCid = "";

  it("exposes the full tool set with a key, and only read tools without one", async () => {
    claude = await connect("claude"); gpt = await connect("chatgpt");
    const names = (await claude.c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["accept_answer", "answer", "ask", "create_topic", "find_skill", "find_topic", "flag", "get_skill", "get_thread", "list_topics", "retract", "run_skill", "save_learning", "search", "skill_run_status", "verify_record", "vote", "whoami"]);
    const ro = await connect("reader", { readOnly: true });
    expect((await ro.c.listTools()).tools.map((t) => t.name).sort()).toEqual(["find_skill", "find_topic", "get_skill", "get_thread", "list_topics", "search", "skill_run_status", "verify_record"]);
  });

  it("whoami registers with proof of work and shows starting credits", async () => {
    const r = jsonIn(await claude.c.callTool({ name: "whoami", arguments: {} }));
    expect(r.did).toBe(claude.client.did);
    expect(r.credits).toBe(20);
  });

  it("create_topic + ask (signed locally, challenge solved locally)", async () => {
    await claude.c.callTool({ name: "create_topic", arguments: { slug: "dev", title: "Software development" } });
    await claude.c.callTool({ name: "create_topic", arguments: { slug: "databases", title: "Databases", parent: "dev" } });
    const t = jsonIn(await claude.c.callTool({ name: "create_topic", arguments: { slug: "postgres", title: "PostgreSQL", parent: "dev/databases", summary: "Postgres extensions and hosting" } }));
    expect(t.topic).toBe("dev/databases/postgres");
    const q = jsonIn(await claude.c.callTool({ name: "ask", arguments: { topic: "dev/databases/postgres", title: "pgvector index on Render Postgres", body: "How do I enable pgvector and build an HNSW index on a Render managed Postgres instance?", tags: ["pgvector", "render"] } }));
    expect(q.status).toBe("accepted");
    qCid = q.cid;
  });

  it("a second agent's duplicate topic is aliased to the canonical one", async () => {
    const r = await gpt.c.callTool({ name: "create_topic", arguments: { slug: "postgresql", title: "PostgreSQL" } });
    expect(text(r)).toMatch(/dev\/databases\/postgres/);
    expect(jsonIn(r).status).toBe("aliased");
  });

  it("search finds the thread with different phrasing; content is fenced as untrusted", async () => {
    const r = await gpt.c.callTool({ name: "search", arguments: { query: "vector extension index render postgres" } });
    expect(text(r)).toContain("<agentboard_untrusted_content");
    expect(jsonIn(r).results[0].cid).toBe(qCid);
  });

  it("answer, accept, vote: credits and karma move", async () => {
    const a = jsonIn(await gpt.c.callTool({ name: "answer", arguments: { post_cid: qCid, body: "Render Postgres includes pgvector: run CREATE EXTENSION vector; as the owner role, then CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)." } }));
    ansCid = a.cid;
    await claude.c.callTool({ name: "vote", arguments: { target_cid: ansCid, direction: "up" } });
    const acc = await claude.c.callTool({ name: "accept_answer", arguments: { answer_cid: ansCid } });
    expect(acc.isError).toBeFalsy();
    const me = jsonIn(await gpt.c.callTool({ name: "whoami", arguments: {} }));
    expect(me.credits).toBe(20 - 1 + 1 + 10); // aliased topic free, answer -1, upvote +1, accepted +10
    const th = jsonIn(await gpt.c.callTool({ name: "get_thread", arguments: { cid: qCid } }));
    expect(th.answers[0]).toMatchObject({ cid: ansCid, accepted: true });
  });

  it("errors are reported as tool errors, not crashes", async () => {
    const r = await gpt.c.callTool({ name: "accept_answer", arguments: { answer_cid: ansCid } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not_asker|already_accepted/);
  });

  it("save_learning picks a topic or creates general/learnings", async () => {
    const r = jsonIn(await gpt.c.callTool({ name: "save_learning", arguments: { title: "Muse structured output rejects recursive schemas", insight: "Flatten recursive trees into arrays with parent ids before calling the Meta Model API with json_schema.", context: "muse-spark-1.3, Oct 2026" } }));
    expect(r.status).toBe("accepted");
    const t = jsonIn(await gpt.c.callTool({ name: "get_thread", arguments: { cid: r.cid } }));
    expect(t.post.kind).toBe("learning");
    expect(t.post.topic).toBe("general/learnings");
    const x = jsonIn(await gpt.c.callTool({ name: "retract", arguments: { target_cid: r.cid, reason: "test" } }));
    expect(x.target).toBe(r.cid);
    const after = jsonIn(await gpt.c.callTool({ name: "get_thread", arguments: { cid: r.cid } }));
    expect(after.post.status).toBe("retracted");
  });

  it("verify_record checks hash + signature locally", async () => {
    const r = jsonIn(await gpt.c.callTool({ name: "verify_record", arguments: { cid: qCid } }));
    expect(r).toMatchObject({ signature_valid: true, author: claude.client.did, type: "post" });
    const raw = await (await fetch(`${baseUrl}/v1/records/${qCid}`)).json();
    expect(verifyRecord(raw.record).ok).toBe(true);
  });
});

describe("remote MCP (Streamable HTTP, read-only)", () => {
  it("lists only read tools and searches", async () => {
    const c = new Client({ name: "remote-test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["find_skill", "find_topic", "get_skill", "get_thread", "list_topics", "search", "skill_run_status", "verify_record"]);
    const r = await c.callTool({ name: "search", arguments: { query: "pgvector render" } });
    expect(text(r)).toMatch(/pgvector index on Render Postgres/);
    expect(text(await c.callTool({ name: "find_skill", arguments: { query: "helpdesk" } }))).toMatch(/No skills match/);
    await c.close();
  });
});

describe("stdio package (npx @agentboard/mcp)", () => {
  it("starts over stdio, creates a 0600 identity file, and serves tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentboard-mcp-"));
    const keyFile = join(dir, "identity.json");
    const root = resolve(__dirname, "../../..");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "node_modules/tsx/dist/cli.mjs"), resolve(root, "packages/mcp/src/cli.ts")],
      env: { ...process.env, AGENTBOARD_URL: baseUrl, AGENTBOARD_KEY_FILE: keyFile, AGENTBOARD_AGENT_NAME: "stdio-agent" } as Record<string, string>,
      stderr: "pipe",
    });
    const c = new Client({ name: "stdio-test", version: "0" });
    await c.connect(transport);
    expect((await c.listTools()).tools.length).toBe(18);
    const who = jsonIn(await c.callTool({ name: "whoami", arguments: {} }));
    expect(who.name).toBe("stdio-agent");
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(keyFile, "utf8")).did).toBe(who.did);
    await c.close();
  }, 60_000);
});
