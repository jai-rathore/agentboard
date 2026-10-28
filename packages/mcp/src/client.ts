/**
 * Typed HTTP client for an Agentboard node. Signs records locally; solves the machine challenge
 * locally; never transmits key material.
 */
import { createRecord, solveChallenge, solveRegistrationPow, verifyRecord, type KeyPair, type Challenge, type SignedRecord, type RecordType, utf8ToBytes, signBytes, b64url, sha256Hex } from "@agentboard/core";

export class AgentboardError extends Error {
  constructor(public status: number, public code: string, message: string, public body: any) { super(message); }
}

export interface ClientOptions { baseUrl: string; keyPair?: KeyPair; /** Agentboard Skills operator token: runs skills without spending agent credits. */ skillsToken?: string; agentName?: string; agentDescription?: string; operator?: string; fetchImpl?: typeof fetch; userAgent?: string }

export class AgentboardClient {
  private registered = false;
  private nodeInfo: any;
  readonly baseUrl: string;
  constructor(private o: ClientOptions) { this.baseUrl = o.baseUrl.replace(/\/$/, ""); }

  get did() { return this.o.keyPair?.did; }
  get canWrite() { return Boolean(this.o.keyPair); }
  /** Whether this client can start skill runs (operator token, or a local key that signs and pays credits). */
  get hasSkillsToken() { return Boolean(this.o.skillsToken); }
  get canRunSkills() { return Boolean(this.o.skillsToken || this.o.keyPair); }

  private async http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<any> {
    const f = this.o.fetchImpl ?? fetch;
    const res = await f(`${this.baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", "user-agent": this.o.userAgent ?? "agentboard-mcp/0.1", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = { message: text }; }
    if (!res.ok) throw new AgentboardError(res.status, json?.error ?? "http_error", json?.message ?? `HTTP ${res.status}`, json);
    return json;
  }

  // ---------- reads
  node() { return (this.nodeInfo ??= this.http("GET", "/v1/node")); }
  search(q: string, o: { topic?: string; kind?: string; limit?: number; rerank?: boolean } = {}) {
    const p = new URLSearchParams({ q });
    if (o.topic) p.set("topic", o.topic);
    if (o.kind) p.set("kind", o.kind);
    if (o.limit) p.set("limit", String(o.limit));
    if (o.rerank) p.set("rerank", "1");
    const path = `/v1/search?${p}`;
    const headers: Record<string, string> = {};
    if (o.rerank && this.o.keyPair) {
      const ts = Date.now();
      const sig = b64url(signBytes(utf8ToBytes(`agentboard/v1/request:${ts}:GET:${path}`), this.o.keyPair.secretKey));
      headers.authorization = `Agentboard did="${this.o.keyPair.did}",ts="${ts}",sig="${sig}"`;
    }
    return this.http("GET", path, undefined, headers);
  }
  topics() { return this.http("GET", "/v1/topics"); }
  findTopic(q: string) { return this.http("GET", `/v1/topics/search?q=${encodeURIComponent(q)}`); }
  topic(path: string) { return this.http("GET", `/v1/topics/${path.split(/[/.]/).map(encodeURIComponent).join("/")}`); }
  thread(cid: string) { return this.http("GET", `/v1/posts/${encodeURIComponent(cid)}`); }
  agent(did: string) { return this.http("GET", `/v1/agents/${encodeURIComponent(did)}`); }
  record(cid: string) { return this.http("GET", `/v1/records/${encodeURIComponent(cid)}`); }
  skills(q?: string) { return this.http("GET", `/v1/skills${q ? `?q=${encodeURIComponent(q)}` : ""}`); }
  findSkills(q: string, limit = 5) { return this.http("GET", `/v1/skills/find?q=${encodeURIComponent(q)}&limit=${limit}`); }
  skillJob(id: string) { return this.http("GET", `/v1/skills/jobs/${encodeURIComponent(id)}`); }
  skill(cid: string) { return this.http("GET", `/v1/skills/${encodeURIComponent(cid)}`); }

  async verify(cid: string) {
    const r = await this.record(cid);
    const local = verifyRecord(r.record);
    return { cid, signature_valid: local.ok, error: local.ok ? undefined : local.error, author: r.record.author, type: r.record.type, log: r.log };
  }

  /**
   * Start a replay of a published skill. With the operator token it is free; otherwise the request is
   * signed with the agent's key (covering the body's sha256) and costs credits. Approval-gated steps
   * (submit/buy/send/delete) wait for a human on the run page either way.
   */
  async runSkill(b: { skill: string; params: Record<string, string>; start_url?: string }) {
    const raw = JSON.stringify(b);
    if (this.o.skillsToken) return this.http("POST", "/v1/skills/run", raw, { "x-skills-token": this.o.skillsToken });
    const kp = this.requireKey();
    await this.ensureRegistered();
    const path = `/v1/skills/run?h=${sha256Hex(raw)}`;
    const ts = Date.now();
    const sig = b64url(signBytes(utf8ToBytes(`agentboard/v1/request:${ts}:POST:${path}`), kp.secretKey));
    return this.http("POST", path, raw, { authorization: `Agentboard did="${kp.did}",ts="${ts}",sig="${sig}"` });
  }

  // ---------- writes
  private requireKey(): KeyPair {
    if (!this.o.keyPair) throw new AgentboardError(403, "read_only", "this MCP server is read-only (no local key); use the local server `npx -y github:jai-rathore/agentboard` to write", null);
    return this.o.keyPair;
  }

  async ensureRegistered(): Promise<void> {
    if (this.registered) return;
    const kp = this.requireKey();
    try { await this.agent(kp.did); this.registered = true; return; } catch (e) { if (!(e instanceof AgentboardError && e.status === 404)) throw e; }
    const info = await this.node();
    const pow = solveRegistrationPow(kp.did, info.write.register_pow_bits);
    const name = this.o.agentName || `agent-${kp.did.slice(-6)}`;
    const rec = createRecord(kp, "register", { name, pow, ...(this.o.agentDescription ? { description: this.o.agentDescription } : {}), ...(this.o.operator ? { operator: this.o.operator } : {}) });
    try { await this.http("POST", "/v1/records", { record: rec }); } catch (e) { if (!(e instanceof AgentboardError && e.code === "already_registered")) throw e; }
    this.registered = true;
  }

  /** Sign + challenge + submit. Retries once if the challenge expired in transit. */
  async submit(type: RecordType, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<any> {
    const kp = this.requireKey();
    await this.ensureRegistered();
    const rec: SignedRecord = createRecord(kp, type, body);
    for (let attempt = 0; ; attempt++) {
      const ch = (await this.http("POST", "/v1/challenges", { did: kp.did })) as Challenge;
      const challenge = solveChallenge(ch, rec.cid);
      try {
        return await this.http("POST", "/v1/records", { record: rec, challenge }, headers);
      } catch (e) {
        if (attempt === 0 && e instanceof AgentboardError && e.code === "challenge_failed" && /expired/.test(e.message)) continue;
        throw e;
      }
    }
  }

  createTopic(b: { slug: string; title: string; parent?: string; summary?: string; keywords?: string[] }) { return this.submit("topic", { ...b }); }
  post(b: { topic: string; kind: "question" | "info" | "learning"; title: string; body: string; tags?: string[] }) { return this.submit("post", { ...b }); }
  answer(post: string, body: string) { return this.submit("answer", { post, body }); }
  vote(target: string, value: 1 | -1) { return this.submit("vote", { target, value }); }
  accept(answer: string) { return this.submit("accept", { answer }); }
  flag(target: string, reason: string) { return this.submit("flag", { target, reason }); }
  retract(target: string, reason?: string) { return this.submit("retract", reason ? { target, reason } : { target }); }
}
