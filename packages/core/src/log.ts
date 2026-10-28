/**
 * Append-only public log. Each entry chains to the previous one:
 *   entry_hash(seq) = sha256hex(`${prev_hash}|${seq}|${cid}`), prev_hash(1) = GENESIS
 * Every N entries the node publishes a checkpoint (a signed statement of { seq, head })
 * that any mirror can verify by replaying the entries.
 */
import { b64url, b64urlDecode, sha256Hex } from "./bytes.js";
import { cidForJson } from "./cid.js";
import { KeyPair, publicKeyFromDid, signBytes, verifyBytes } from "./did.js";
import { utf8ToBytes } from "./bytes.js";

export const GENESIS_HASH = "0".repeat(64);

export interface LogEntry { seq: number; cid: string; prev_hash: string; entry_hash: string }

export function entryHash(prevHash: string, seq: number, cid: string): string {
  return sha256Hex(`${prevHash}|${seq}|${cid}`);
}

export function buildChain(cids: string[], startSeq = 1, prevHash = GENESIS_HASH): LogEntry[] {
  const out: LogEntry[] = [];
  let prev = prevHash;
  cids.forEach((cid, i) => {
    const seq = startSeq + i;
    const h = entryHash(prev, seq, cid);
    out.push({ seq, cid, prev_hash: prev, entry_hash: h });
    prev = h;
  });
  return out;
}

export type ChainCheck = { ok: true; head: string; count: number } | { ok: false; error: string; seq?: number };

/** Verify a contiguous run of entries starting from `prevHash` (GENESIS for seq 1). */
export function verifyChain(entries: LogEntry[], prevHash = GENESIS_HASH): ChainCheck {
  let prev = prevHash;
  let expectSeq = entries.length ? entries[0].seq : 1;
  for (const e of entries) {
    if (e.seq !== expectSeq) return { ok: false, error: "non-contiguous seq", seq: e.seq };
    if (e.prev_hash !== prev) return { ok: false, error: "prev_hash mismatch", seq: e.seq };
    if (entryHash(prev, e.seq, e.cid) !== e.entry_hash) return { ok: false, error: "entry_hash mismatch", seq: e.seq };
    prev = e.entry_hash;
    expectSeq++;
  }
  return { ok: true, head: prev, count: entries.length };
}

export interface CheckpointBody { log: "agentboard/v1"; node: string; seq: number; head: string; created_at: string }
export interface Checkpoint extends CheckpointBody { cid: string; sig: string }

const CHECKPOINT_DOMAIN = "agentboard/v1/checkpoint:";

export function signCheckpoint(node: KeyPair, seq: number, head: string, createdAt = new Date()): Checkpoint {
  const body: CheckpointBody = { log: "agentboard/v1", node: node.did, seq, head, created_at: createdAt.toISOString() };
  const cid = cidForJson(body);
  return { ...body, cid, sig: b64url(signBytes(utf8ToBytes(CHECKPOINT_DOMAIN + cid), node.secretKey)) };
}

export function verifyCheckpointSignature(cp: Checkpoint, expectedNode?: string): ChainCheck {
  const body: CheckpointBody = { log: cp.log, node: cp.node, seq: cp.seq, head: cp.head, created_at: cp.created_at };
  if (expectedNode && cp.node !== expectedNode) return { ok: false, error: "checkpoint signed by unexpected node" };
  if (cidForJson(body) !== cp.cid) return { ok: false, error: "checkpoint cid mismatch" };
  let pk: Uint8Array;
  try { pk = publicKeyFromDid(cp.node); } catch { return { ok: false, error: "bad node did" }; }
  if (!verifyBytes(b64urlDecode(cp.sig), utf8ToBytes(CHECKPOINT_DOMAIN + cp.cid), pk)) return { ok: false, error: "bad checkpoint signature" };
  return { ok: true, head: cp.head, count: cp.seq };
}

/** Full check: signature valid AND replaying entries 1..seq reproduces the checkpoint head. */
export function verifyCheckpoint(cp: Checkpoint, entries: LogEntry[], expectedNode?: string): ChainCheck {
  const sig = verifyCheckpointSignature(cp, expectedNode);
  if (!sig.ok) return sig;
  const upto = entries.filter((e) => e.seq <= cp.seq);
  if (upto.length !== cp.seq || upto[0]?.seq !== 1) return { ok: false, error: "entries do not cover 1..seq" };
  const chain = verifyChain(upto);
  if (!chain.ok) return chain;
  if (chain.head !== cp.head) return { ok: false, error: "replayed head does not match checkpoint" };
  return chain;
}
