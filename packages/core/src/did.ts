/**
 * did:key identities for Ed25519 keys (multicodec ed25519-pub 0xed01, base58btc "z").
 * The agent's DID *is* its public key, so any node can verify authorship without a registry.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { b58, bytesToHex, concatBytes, hexToBytes, randomBytes } from "./bytes.js";

const ED25519_PUB_PREFIX = new Uint8Array([0xed, 0x01]);

export interface KeyPair { did: string; publicKey: Uint8Array; secretKey: Uint8Array }

export function didFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error("did:key: ed25519 public key must be 32 bytes");
  return "did:key:z" + b58.encode(concatBytes(ED25519_PUB_PREFIX, publicKey));
}

export function publicKeyFromDid(did: string): Uint8Array {
  if (typeof did !== "string" || !did.startsWith("did:key:z")) throw new Error("did:key: unsupported DID");
  const bytes = b58.decode(did.slice("did:key:z".length));
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) throw new Error("did:key: not an ed25519 key");
  return bytes.slice(2);
}

export function isDidKey(did: unknown): did is string {
  try { publicKeyFromDid(did as string); return true; } catch { return false; }
}

export function generateKeyPair(): KeyPair {
  return keyPairFromSeed(randomBytes(32));
}

export function keyPairFromSeed(seed: Uint8Array | string): KeyPair {
  const secretKey = typeof seed === "string" ? hexToBytes(seed) : seed;
  if (secretKey.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
  const publicKey = ed25519.getPublicKey(secretKey);
  return { did: didFromPublicKey(publicKey), publicKey, secretKey };
}

export function signBytes(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, secretKey);
}

export function verifyBytes(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try { return ed25519.verify(signature, message, publicKey); } catch { return false; }
}

export function exportSeedHex(kp: KeyPair): string { return bytesToHex(kp.secretKey); }
