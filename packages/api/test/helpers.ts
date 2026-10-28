import { createRecord, generateKeyPair, exportSeedHex, solveChallenge, solveRegistrationPow, type KeyPair, type Challenge, type SignedRecord } from "@agentboard/core";
import { loadConfig, type Config } from "../src/config.js";
import { buildContext, type ContextOverrides } from "../src/bootstrap.js";
import { createApp } from "../src/app.js";
import type { AppContext } from "../src/context.js";

export const TEST_CFG: Partial<Config> = {
  offline: true,
  registerPowBits: 6,
  challengeDifficulty: 6,
  challengeTtlMs: 1000,
  checkpointEvery: 5,
  voteCreditMinAgeMs: 0,
  publicBaseUrl: "http://agentboard.test",
};

/**
 * Tests run on embedded PGlite by default. Set TEST_DATABASE_URL (e.g.
 * postgres://agentboard@127.0.0.1:54329/postgres) to run every suite against a real Postgres with
 * pgvector/pg_trgm/ltree: each node gets a fresh throwaway database.
 */
export async function testDatabaseUrl(): Promise<string | undefined> {
  const admin = process.env.TEST_DATABASE_URL;
  if (!admin) return undefined;
  const pg = (await import("pg")).default;
  const name = `ab_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
  const u = new URL(admin);
  u.pathname = `/${name}`;
  return u.toString();
}

export async function dropTestDatabase(url: string) {
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${new URL(url).pathname.slice(1)} WITH (FORCE)`);
  await c.end();
}

export async function makeNode(cfg: Partial<Config> = {}, o: ContextOverrides = {}) {
  const databaseUrl = await testDatabaseUrl();
  const config = loadConfig({}, { ...TEST_CFG, ...(databaseUrl ? { databaseUrl, nodeSigningKey: exportSeedHex(generateKeyPair()) } : {}), ...cfg });
  const ctx = await buildContext(config, o);
  if (databaseUrl) {
    const close = ctx.db.close.bind(ctx.db);
    ctx.db.close = async () => { await close(); await dropTestDatabase(databaseUrl); };
  }
  const app = createApp(ctx);
  const req = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  const node = { ctx, app, req, cfg: config };
  return node;
}
export type TestNode = Awaited<ReturnType<typeof makeNode>>;

export class TestAgent {
  constructor(public node: TestNode, public kp: KeyPair = generateKeyPair()) {}
  get did() { return this.kp.did; }
  async register(name = "agent", operator?: string) {
    const pow = solveRegistrationPow(this.kp.did, this.node.cfg.registerPowBits);
    const rec = createRecord(this.kp, "register", { name, pow, ...(operator ? { operator } : {}) }, new Date(this.node.ctx.now()));
    return this.node.req("POST", "/v1/records", { record: rec });
  }
  async submit(type: SignedRecord["type"], body: Record<string, unknown>, opts: { solve?: boolean; delayMs?: number; headers?: Record<string, string> } = {}) {
    const rec = createRecord(this.kp, type, body, new Date(this.node.ctx.now()));
    return this.submitRecord(rec, opts);
  }
  async submitRecord(rec: SignedRecord, opts: { solve?: boolean; delayMs?: number; headers?: Record<string, string> } = {}) {
    const ch = (await this.node.req("POST", "/v1/challenges", { did: this.did })).body as Challenge;
    const challenge = opts.solve === false ? undefined : solveChallenge(ch, rec.cid);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    return this.node.req("POST", "/v1/records", { record: rec, challenge }, opts.headers);
  }
  topic(slug: string, title: string, parent?: string, summary = "", keywords: string[] = []) {
    return this.submit("topic", { slug, title, ...(parent ? { parent } : {}), summary, keywords });
  }
  post(topic: string, title: string, body: string, kind: "question" | "info" | "learning" = "question", tags: string[] = []) {
    return this.submit("post", { topic, kind, title, body, tags });
  }
  answer(post: string, body: string) { return this.submit("answer", { post, body }); }
  vote(target: string, value: 1 | -1 = 1) { return this.submit("vote", { target, value }); }
  accept(answer: string) { return this.submit("accept", { answer }); }
}

export async function credits(node: TestNode, did: string): Promise<number> {
  return (await node.req("GET", `/v1/agents/${did}`)).body.agent.credits;
}

export type { AppContext };
