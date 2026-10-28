import { describe, it, expect } from "vitest";
import {
  canonicalize, cidForJson, parseCid, isCid, generateKeyPair, keyPairFromSeed, didFromPublicKey, publicKeyFromDid,
  createRecord, verifyRecord, computeCid, b64url, b64urlDecode,
} from "../src/index.js";

describe("JCS canonicalization (RFC 8785)", () => {
  it("sorts keys and strips whitespace", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], c: { z: 1, y: 2 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
  });
  it("uses ES number serialization", () => {
    expect(canonicalize([1e21, 1.5, -0, 0.000001, 1e-7, 100])).toBe("[1e+21,1.5,0,0.000001,1e-7,100]");
  });
  it("sorts by UTF-16 code units (RFC 8785 example)", () => {
    const obj = { "\u20ac": "Euro Sign", "\r": "Carriage Return", "\ufb33": "Hebrew Letter Dalet With Dagesh", "1": "One", "\ud83d\ude00": "Emoji: Grinning Face", "\u0080": "Control", "\u00f6": "Latin Small Letter O With Diaeresis" };
    const keys = [...canonicalize(obj).matchAll(/"((?:[^"\\]|\\.)*)":/g)].map((m) => JSON.parse(`"${m[1]}"`));
    expect(keys).toEqual(["\r", "1", "\u0080", "\u00f6", "\u20ac", "\ud83d\ude00", "\ufb33"]);
  });
  it("rejects non-finite numbers and cycles", () => {
    expect(() => canonicalize({ a: NaN })).toThrow();
    const o: Record<string, unknown> = {}; o.self = o;
    expect(() => canonicalize(o)).toThrow();
  });
  it("is independent of key insertion order", () => {
    expect(canonicalize({ x: 1, y: { b: 2, a: 1 } })).toBe(canonicalize({ y: { a: 1, b: 2 }, x: 1 }));
  });
});

describe("content hashing (CIDv1 json sha2-256)", () => {
  it("is deterministic and order-insensitive", () => {
    const a = cidForJson({ hello: "world", n: 1 });
    expect(a).toBe(cidForJson({ n: 1, hello: "world" }));
    expect(a.startsWith("b")).toBe(true);
    expect(isCid(a)).toBe(true);
  });
  it("changes when content changes", () => {
    expect(cidForJson({ hello: "world" })).not.toBe(cidForJson({ hello: "world!" }));
  });
  it("encodes a parseable CIDv1 with a sha2-256 digest of the canonical bytes", async () => {
    const value = { a: 1 };
    const p = parseCid(cidForJson(value));
    expect(p.version).toBe(1);
    expect(p.codec).toBe(0x0200);
    expect(p.hashCode).toBe(0x12);
    const { createHash } = await import("node:crypto");
    expect(p.digestHex).toBe(createHash("sha256").update('{"a":1}').digest("hex"));
  });
  it("rejects garbage", () => {
    expect(isCid("bnotacid")).toBe(false);
    expect(isCid("Qm123")).toBe(false);
  });
});

describe("did:key identities", () => {
  it("round-trips public keys", () => {
    const kp = generateKeyPair();
    expect(kp.did.startsWith("did:key:z6Mk")).toBe(true);
    expect(Buffer.from(publicKeyFromDid(kp.did)).equals(Buffer.from(kp.publicKey))).toBe(true);
  });
  it("is deterministic from a seed", () => {
    const seed = "9f8362f87a484a954e6e740c5b4c0e84229139a20aa8ab56ff66586f6a7d29c5";
    expect(keyPairFromSeed(seed).did).toBe(keyPairFromSeed(seed).did);
  });
  it("rejects non-ed25519 DIDs", () => {
    expect(() => publicKeyFromDid("did:web:example.com")).toThrow();
    expect(() => didFromPublicKey(new Uint8Array(31))).toThrow();
  });
});

describe("signed records", () => {
  const kp = generateKeyPair();
  const rec = createRecord(kp, "post", { topic: "ai.muse", kind: "question", title: "How?", body: "Details" }, "2026-10-27T12:00:00.000Z");

  it("verifies a well-formed record", () => {
    expect(verifyRecord(rec)).toEqual({ ok: true, cid: rec.cid });
    expect(rec.cid).toBe(computeCid(rec));
  });
  it("survives a JSON round trip with reordered keys", () => {
    const shuffled = JSON.parse(JSON.stringify({ sig: rec.sig, body: { body: rec.body.body, title: rec.body.title, kind: "question", topic: "ai.muse" }, cid: rec.cid, created_at: rec.created_at, author: rec.author, type: rec.type, v: 1 }));
    expect(verifyRecord(shuffled).ok).toBe(true);
  });
  it("detects body tampering via the CID", () => {
    const t = { ...rec, body: { ...rec.body, title: "How!" } };
    expect(verifyRecord(t)).toEqual({ ok: false, error: "cid does not match content" });
  });
  it("detects re-hashed tampering via the signature", () => {
    const t = { ...rec, body: { ...rec.body, title: "How!" } };
    t.cid = computeCid(t);
    expect(verifyRecord(t)).toEqual({ ok: false, error: "bad signature" });
  });
  it("rejects a record re-attributed to another agent", () => {
    const other = generateKeyPair();
    const t = { ...rec, author: other.did };
    t.cid = computeCid(t);
    expect(verifyRecord(t).ok).toBe(false);
  });
  it("rejects a flipped signature bit", () => {
    const sig = b64urlDecode(rec.sig); sig[5] ^= 1;
    expect(verifyRecord({ ...rec, sig: b64url(sig) })).toEqual({ ok: false, error: "bad signature" });
  });
  it("rejects malformed records", () => {
    expect(verifyRecord(null).ok).toBe(false);
    expect(verifyRecord({ ...rec, v: 2 }).ok).toBe(false);
    expect(verifyRecord({ ...rec, type: "nope" }).ok).toBe(false);
    expect(verifyRecord({ ...rec, created_at: "yesterday" }).ok).toBe(false);
  });
});
