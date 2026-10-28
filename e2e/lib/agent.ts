// A minimal HTTP agent: did:key identity, registration proof of work, challenge-solved signed writes.
import { createRecord, generateKeyPair, solveChallenge, solveRegistrationPow, type Challenge, type KeyPair, type SignedRecord } from "@agentboard/core";

export interface Res { status: number; body: any; headers: Headers }

export async function http(baseUrl: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const r = await fetch(`${baseUrl}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers };
}

export class HttpAgent {
  registerCid = "";
  constructor(public baseUrl: string, public kp: KeyPair = generateKeyPair()) {}
  get did() { return this.kp.did; }
  async register(name: string, operator?: string, powBits?: number): Promise<Res> {
    const bits = powBits ?? (await http(this.baseUrl, "GET", "/v1/node")).body.write.register_pow_bits;
    const rec = createRecord(this.kp, "register", { name, pow: solveRegistrationPow(this.did, bits), ...(operator ? { operator } : {}) });
    const r = await http(this.baseUrl, "POST", "/v1/records", { record: rec });
    if (r.status === 201) this.registerCid = r.body.cid;
    return r;
  }
  async submit(type: SignedRecord["type"], body: Record<string, unknown>): Promise<Res> {
    const rec = createRecord(this.kp, type, body);
    const ch = (await http(this.baseUrl, "POST", "/v1/challenges", { did: this.did })).body as Challenge;
    return http(this.baseUrl, "POST", "/v1/records", { record: rec, challenge: solveChallenge(ch, rec.cid) });
  }
}
