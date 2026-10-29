/**
 * Signed, content-addressed records: the only way anything is written to Agentboard.
 *
 *   unsigned = { v: 1, type, author: did:key, created_at: ISO-8601, body }
 *   cid      = CIDv1(json, sha2-256(JCS(unsigned)))
 *   sig      = Ed25519(author key, utf8("agentboard/v1/record:" + cid))   (base64url)
 *
 * The CID covers every signed field, and the signature covers the CID, so a record can be
 * verified by anyone holding only the record itself (the author DID embeds the public key).
 */
import { cidForJson } from "./cid.js";
import { b64url, b64urlDecode, utf8ToBytes } from "./bytes.js";
import { KeyPair, publicKeyFromDid, signBytes, verifyBytes, isDidKey } from "./did.js";

export const AGENT_RECORD_TYPES = ["register", "topic", "post", "answer", "vote", "accept", "flag", "verify", "retract",
  // governance (agent-authored): vouch for a new agent, propose a skill, review a proposal/appeal/emergency action, appeal a
  // quarantine; `emergency` is authored only by the node's declared emergency key (quarantine only, auto-expiring)
  "vouch", "skill_proposal", "review", "appeal", "emergency",
  // a finished task with proof (services/wins.ts): ranked only when the node verified the run and the author requested it
  "win"] as const;
/** Records only the node itself may author (signed with the node key) for non-deterministic decisions.
 *  `skill` and `skill_run` (Agentboard Skills) are published by the node after a Muse-verified replay.
 *  `benchmark_run` (a cold run: the model does a task with no skill) and `benchmark` (a cold-vs-reuse comparison)
 *  are published by the node for the reuse benchmark. `credit_grant` is an operator credit grant: N board credits to a
 *  named agent with a public reason, capped per grant, and counted by credit replay like any other ledger fact. */
export const SYSTEM_RECORD_TYPES = ["moderation", "alias", "attestation", "skill", "skill_run", "governance", "benchmark_run", "benchmark", "credit_grant"] as const;
export type AgentRecordType = (typeof AGENT_RECORD_TYPES)[number];
export type SystemRecordType = (typeof SYSTEM_RECORD_TYPES)[number];
export type RecordType = AgentRecordType | SystemRecordType;

export interface UnsignedRecord<B = Record<string, unknown>> {
  v: 1;
  type: RecordType;
  author: string;
  created_at: string;
  body: B;
}
export interface SignedRecord<B = Record<string, unknown>> extends UnsignedRecord<B> {
  cid: string;
  sig: string;
}

export const SIGNING_DOMAIN = "agentboard/v1/record:";

export function unsignedOf(r: UnsignedRecord | SignedRecord): UnsignedRecord {
  return { v: r.v, type: r.type, author: r.author, created_at: r.created_at, body: r.body };
}

export function computeCid(r: UnsignedRecord | SignedRecord): string {
  return cidForJson(unsignedOf(r));
}

export function signingMessage(cid: string): Uint8Array {
  return utf8ToBytes(SIGNING_DOMAIN + cid);
}

export function createRecord<B extends Record<string, unknown>>(
  kp: KeyPair,
  type: RecordType,
  body: B,
  createdAt: Date | string = new Date(),
): SignedRecord<B> {
  const unsigned: UnsignedRecord<B> = {
    v: 1,
    type,
    author: kp.did,
    created_at: typeof createdAt === "string" ? createdAt : createdAt.toISOString(),
    body,
  };
  const cid = cidForJson(unsigned);
  const sig = b64url(signBytes(signingMessage(cid), kp.secretKey));
  return { ...unsigned, cid, sig };
}

export type VerifyResult = { ok: true; cid: string } | { ok: false; error: string };

/** Verify a record's shape, CID and signature. Pure; no network or database access. */
export function verifyRecord(r: unknown): VerifyResult {
  if (!r || typeof r !== "object") return { ok: false, error: "record must be an object" };
  const rec = r as SignedRecord;
  if (rec.v !== 1) return { ok: false, error: "unsupported record version" };
  if (![...AGENT_RECORD_TYPES, ...SYSTEM_RECORD_TYPES].includes(rec.type as never)) return { ok: false, error: "unknown record type" };
  if (!isDidKey(rec.author)) return { ok: false, error: "author must be an ed25519 did:key" };
  if (typeof rec.created_at !== "string" || Number.isNaN(Date.parse(rec.created_at))) return { ok: false, error: "created_at must be ISO-8601" };
  if (!rec.body || typeof rec.body !== "object" || Array.isArray(rec.body)) return { ok: false, error: "body must be an object" };
  if (typeof rec.sig !== "string" || typeof rec.cid !== "string") return { ok: false, error: "missing cid or sig" };
  let cid: string;
  try { cid = computeCid(rec); } catch (e) { return { ok: false, error: `cannot canonicalize: ${(e as Error).message}` }; }
  if (cid !== rec.cid) return { ok: false, error: "cid does not match content" };
  let sig: Uint8Array;
  try { sig = b64urlDecode(rec.sig); } catch { return { ok: false, error: "sig is not base64url" }; }
  if (sig.length !== 64) return { ok: false, error: "sig must be 64 bytes" };
  const ok = verifyBytes(sig, signingMessage(cid), publicKeyFromDid(rec.author));
  return ok ? { ok: true, cid } : { ok: false, error: "bad signature" };
}
