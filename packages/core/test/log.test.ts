import { describe, it, expect } from "vitest";
import { buildChain, verifyChain, signCheckpoint, verifyCheckpoint, verifyCheckpointSignature, generateKeyPair, cidForJson, GENESIS_HASH, entryHash } from "../src/index.js";

const cids = Array.from({ length: 25 }, (_, i) => cidForJson({ i }));

describe("hash-chained log", () => {
  it("builds and verifies a chain", () => {
    const chain = buildChain(cids);
    expect(chain[0].prev_hash).toBe(GENESIS_HASH);
    expect(chain[1].prev_hash).toBe(chain[0].entry_hash);
    const r = verifyChain(chain);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.head).toBe(chain[24].entry_hash);
  });
  it("detects a swapped cid", () => {
    const chain = buildChain(cids);
    chain[10] = { ...chain[10], cid: cids[11] };
    expect(verifyChain(chain)).toMatchObject({ ok: false, seq: 11 });
  });
  it("detects a deleted entry", () => {
    const chain = buildChain(cids);
    chain.splice(5, 1);
    expect(verifyChain(chain).ok).toBe(false);
  });
  it("detects reordering even if hashes are recomputed downstream", () => {
    const reordered = [...cids]; [reordered[3], reordered[4]] = [reordered[4], reordered[3]];
    const forged = buildChain(reordered);
    const honest = buildChain(cids);
    expect(forged[24].entry_hash).not.toBe(honest[24].entry_hash);
  });
  it("verifies a suffix from a known prev hash", () => {
    const chain = buildChain(cids);
    expect(verifyChain(chain.slice(10), chain[9].entry_hash).ok).toBe(true);
    expect(entryHash(chain[9].entry_hash, 11, cids[10])).toBe(chain[10].entry_hash);
  });
});

describe("signed checkpoints", () => {
  const node = generateKeyPair();
  const chain = buildChain(cids);

  it("verifies signature and replayed head", () => {
    const cp = signCheckpoint(node, 20, chain[19].entry_hash);
    expect(verifyCheckpoint(cp, chain, node.did).ok).toBe(true);
  });
  it("rejects a checkpoint whose head does not match the log", () => {
    const cp = signCheckpoint(node, 20, chain[18].entry_hash);
    expect(verifyCheckpoint(cp, chain)).toMatchObject({ ok: false, error: "replayed head does not match checkpoint" });
  });
  it("rejects a checkpoint against a tampered log", () => {
    const cp = signCheckpoint(node, 20, chain[19].entry_hash);
    const tampered = buildChain([...cids.slice(0, 7), cidForJson({ evil: true }), ...cids.slice(8)]);
    expect(verifyCheckpoint(cp, tampered).ok).toBe(false);
  });
  it("rejects a forged signature or unexpected signer", () => {
    const cp = signCheckpoint(node, 20, chain[19].entry_hash);
    expect(verifyCheckpointSignature({ ...cp, seq: 21 }).ok).toBe(false);
    expect(verifyCheckpointSignature(cp, generateKeyPair().did).ok).toBe(false);
    const mallory = generateKeyPair();
    const forged = { ...signCheckpoint(mallory, 20, chain[19].entry_hash), node: node.did };
    expect(verifyCheckpointSignature(forged).ok).toBe(false);
  });
  it("rejects when entries do not cover 1..seq", () => {
    const cp = signCheckpoint(node, 20, chain[19].entry_hash);
    expect(verifyCheckpoint(cp, chain.slice(0, 10)).ok).toBe(false);
  });
});
