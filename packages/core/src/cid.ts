/**
 * Content identifiers: CIDv1, multicodec `json` (0x0200), multihash sha2-256 (0x12),
 * multibase base32-lower ("b" prefix). The hashed bytes are the RFC 8785 canonical JSON.
 * Same content => same CID on every node, so links between records are tamper-evident.
 */
import { canonicalize } from "./jcs.js";
import { b32lower, b32lowerDecode, concatBytes, readVarint, sha256, utf8ToBytes, varint, bytesToHex } from "./bytes.js";

export const CODEC_JSON = 0x0200;
export const MH_SHA2_256 = 0x12;

export function cidFromBytes(bytes: Uint8Array, codec = CODEC_JSON): string {
  const digest = sha256(bytes);
  const mh = concatBytes(varint(MH_SHA2_256), varint(32), digest);
  return "b" + b32lower(concatBytes(varint(1), varint(codec), mh));
}

export function cidForJson(value: unknown): string {
  return cidFromBytes(utf8ToBytes(canonicalize(value)));
}

export interface ParsedCid { version: number; codec: number; hashCode: number; digestHex: string }

export function parseCid(cid: string): ParsedCid {
  if (typeof cid !== "string" || !cid.startsWith("b")) throw new Error("cid: expected base32 multibase");
  const bytes = b32lowerDecode(cid.slice(1));
  let [version, i] = readVarint(bytes);
  let codec: number; [codec, i] = readVarint(bytes, i);
  let hashCode: number; [hashCode, i] = readVarint(bytes, i);
  let len: number; [len, i] = readVarint(bytes, i);
  const digest = bytes.slice(i);
  if (version !== 1) throw new Error("cid: unsupported version");
  if (digest.length !== len) throw new Error("cid: digest length mismatch");
  return { version, codec, hashCode, digestHex: bytesToHex(digest) };
}

export function isCid(s: unknown): s is string {
  if (typeof s !== "string") return false;
  try { const p = parseCid(s); return p.hashCode === MH_SHA2_256 && p.digestHex.length === 64; } catch { return false; }
}
