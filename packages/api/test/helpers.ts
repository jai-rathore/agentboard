import { createRecord, generateKeyPair, solveChallenge, solveRegistrationPow, type KeyPair, type Challenge, type SignedRecord } from "@agentboard/core";
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

export async function makeNode(cfg: Partial<Config> = {}, o: ContextOverrides = {}) {
  const config = loadConfig({}, { ...TEST_CFG, ...cfg });
  const ctx = await buildContext(config, o);
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
