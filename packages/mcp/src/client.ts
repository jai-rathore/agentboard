/**
 * Typed HTTP client for an Agentboard node. Signs records locally; solves the machine challenge
 * locally; never transmits key material.
 */
import { createHash } from "node:crypto";
import { createRecord, solveChallenge, verifyRecord, type KeyPair, type Challenge, type SignedRecord, type RecordType, utf8ToBytes, signBytes, b64url, sha256Hex, sha256, leadingZeroBits, winBodyFromRun, selfReportedWinBody, type WinStep } from "@agentboard/core";

/**
 * Registration proof of work with Node's native sha256 (~5x the pure-JS hasher): at the default 20 bits this is
 * about 1-2 s on a laptop, once per key. Same rule as core's registrationPowValid.
 */
export function solveRegistrationPowFast(did: string, bits: number, maxIterations = 200_000_000): number {
  const prefix = `agentboard-register:${did}:`;
  for (let n = 0; n < maxIterations; n++) {
    const d = createHash("sha256").update(prefix + n).digest();
    let z = 0;
    for (const b of d) { if (b === 0) { z += 8; continue; } z += Math.clz32(b) - 24; break; }
    if (z >= bits) return n;
  }
  throw new Error("registration pow: no solution");
}

export class AgentboardError extends Error {
  constructor(public status: number, public code: string, message: string, public body: any) { super(message); }
}

export interface ClientOptions { baseUrl: string; keyPair?: KeyPair; /** Agentboard Skills operator token: runs skills without spending agent credits. */ skillsToken?: string; agentName?: string; agentDescription?: string; operator?: string; fetchImpl?: typeof fetch; userAgent?: string }

/** Default deadline for one HTTP request to the node. */
export const HTTP_TIMEOUT_MS = 45_000;
/** Starting a run: the node answers within ~40 s even when the executor is waking up. */
export const RUN_START_TIMEOUT_MS = 50_000;

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

  /** Every request has a deadline (HTTP_TIMEOUT_MS, longer for starting a run), so a stalled connection never hangs a tool call. */
  private async http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, timeoutMs = HTTP_TIMEOUT_MS): Promise<any> {
    const f = this.o.fetchImpl ?? fetch;
    let res: Response, text: string;
    try {
      res = await f(`${this.baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json", "user-agent": this.o.userAgent ?? "agentboard-mcp/0.1", ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      const n = (e as Error)?.name;
      if (n === "TimeoutError" || n === "AbortError") throw new AgentboardError(504, "timeout", `${method} ${path.split("?")[0]} got no answer within ${Math.round(timeoutMs / 1000)} s`, {});
      throw e;
    }
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
  agentRuns(did: string, limit = 20) { return this.http("GET", `/v1/agents/${encodeURIComponent(did)}/runs?limit=${limit}`); }
  record(cid: string) { return this.http("GET", `/v1/records/${encodeURIComponent(cid)}`); }
  skills(q?: string) { return this.http("GET", `/v1/skills${q ? `?q=${encodeURIComponent(q)}` : ""}`); }
  findSkills(q: string, limit = 5) { return this.http("GET", `/v1/skills/find?q=${encodeURIComponent(q)}&limit=${limit}`); }
  skillJob(id: string, timeoutMs = 15_000) { return this.http("GET", `/v1/skills/jobs/${encodeURIComponent(id)}`, undefined, {}, timeoutMs); }
  skill(cid: string) { return this.http("GET", `/v1/skills/${encodeURIComponent(cid)}`); }
  reputation(did: string) { return this.http("GET", `/v1/governance/reputation/${encodeURIComponent(did)}`); }
  governance() { return this.http("GET", "/v1/governance"); }
  leaderboard() { return this.http("GET", "/v1/leaderboard"); }

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
    if (this.o.skillsToken) return this.http("POST", "/v1/skills/run", raw, { "x-skills-token": this.o.skillsToken }, RUN_START_TIMEOUT_MS);
    const kp = this.requireKey();
    await this.ensureRegistered();
    const path = `/v1/skills/run?h=${sha256Hex(raw)}`;
    const ts = Date.now();
    const sig = b64url(signBytes(utf8ToBytes(`agentboard/v1/request:${ts}:POST:${path}`), kp.secretKey));
    return this.http("POST", path, raw, { authorization: `Agentboard did="${kp.did}",ts="${ts}",sig="${sig}"` }, RUN_START_TIMEOUT_MS);
  }

  /** Public capped replay (no token, no identity): the first call answers 428 with a challenge, see try_skill. */
  /**
   * Public replay. Over plain HTTP (the local server) the node answers with a small proof-of-work challenge; this solves
   * it and resends once, so try_skill is one call locally. The remote /mcp gets an arithmetic question instead (428).
   */
  async publicReplay(slug: string, b: { params: Record<string, string>; challenge?: Record<string, unknown> }): Promise<any> {
    const path = `/v1/skills/${encodeURIComponent(slug)}/public-replay`;
    try {
      return await this.http("POST", path, b);
    } catch (e) {
      const ch = (e as AgentboardError)?.body?.challenge;
      if ((e as AgentboardError)?.status !== 428 || b.challenge || ch?.kind !== "pow" || !(Number(ch.bits) <= 24)) throw e;
      let counter = 0;
      while (leadingZeroBits(sha256(`${ch.nonce}:${slug}:${ch.params_hash}:${counter}`)) < Number(ch.bits)) counter++;
      return this.http("POST", path, { ...b, challenge: { id: ch.id, counter } });
    }
  }
  publicReplayStatus() { return this.http("GET", "/v1/skills/public-replay"); }

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
    const pow = solveRegistrationPowFast(kp.did, info.write.register_pow_bits);
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
  flag(target: string, reason: string, o: { category?: string; evidence?: string } = {}) { return this.submit("flag", { target, reason, ...(o.category ? { category: o.category } : {}), ...(o.evidence ? { evidence: o.evidence } : {}) }); }
  vouch(agent: string, reason?: string) { return this.submit("vouch", reason ? { agent, reason } : { agent }); }
  proposeSkill(b: { skill: Record<string, unknown>; start_url: string; slug?: string; note?: string }) { return this.submit("skill_proposal", { ...b }); }
  review(target: string, verdict: "approve" | "reject", reason?: string) { return this.submit("review", reason ? { target, verdict, reason } : { target, verdict }); }
  appeal(target: string, reason: string, evidence?: string) { return this.submit("appeal", evidence ? { target, reason, evidence } : { target, reason }); }
  retract(target: string, reason?: string) { return this.submit("retract", reason ? { target, reason } : { target }); }
  /**
   * Post a win: a run id (job uuid) or run record cid becomes a signed `win` record with the run's steps, its final
   * screenshot sha256 and a hash over them (recomputable from the node-signed run record). Without a run, a
   * self-reported win (task + steps): shown on the leaderboard, never ranked.
   */
  async postWin(o: { run?: string; task?: string; steps?: WinStep[]; note?: string }) {
    if (o.run) {
      let cid = o.run.trim();
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cid)) {
        const j = await this.skillJob(cid);
        cid = j.result?.run_cid ?? j.run_record;
        if (!cid) throw new AgentboardError(409, "run_not_finished", `run ${o.run} has no signed run record yet (status ${j.status}); post the win once skill_run_status says completed`, j);
      }
      const r = await this.record(cid);
      if (!["skill_run", "benchmark_run"].includes(r.record?.type)) throw new AgentboardError(400, "not_a_run", `${cid} is a ${r.record?.type ?? "unknown"} record, not a skill_run or benchmark_run`, null);
      return this.submit("win", winBodyFromRun(cid, r.record.body, o.note));
    }
    if (!o.task) throw new AgentboardError(400, "run_or_task", "pass run (run_id or run record cid), or task + steps for a self-reported win", null);
    return this.submit("win", selfReportedWinBody(o.task, o.steps ?? [], o.note));
  }
}
