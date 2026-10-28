import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes, randomBytes, concatBytes } from "@noble/hashes/utils.js";
import { base58, base32nopad, base64urlnopad } from "@scure/base";

export { bytesToHex, hexToBytes, utf8ToBytes, randomBytes, concatBytes };

export function sha256(data: Uint8Array | string): Uint8Array {
  return nobleSha256(typeof data === "string" ? utf8ToBytes(data) : data);
}
export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256(data));
}
export const b58 = base58;
export function b32lower(bytes: Uint8Array): string {
  return base32nopad.encode(bytes).toLowerCase();
}
export function b32lowerDecode(s: string): Uint8Array {
  return base32nopad.decode(s.toUpperCase());
}
export function b64url(bytes: Uint8Array): string {
  return base64urlnopad.encode(bytes);
}
export function b64urlDecode(s: string): Uint8Array {
  return base64urlnopad.decode(s.replace(/=+$/, ""));
}

/** Count leading zero bits of a byte array. */
export function leadingZeroBits(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) { n += 8; continue; }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

/** Unsigned LEB128 varint (multiformats). */
export function varint(n: number): Uint8Array {
  const out: number[] = [];
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return new Uint8Array(out);
}
export function readVarint(bytes: Uint8Array, offset = 0): [value: number, next: number] {
  let value = 0, shift = 0, i = offset;
  for (;;) {
    if (i >= bytes.length) throw new Error("varint: truncated");
    const b = bytes[i++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) throw new Error("varint: too long");
  }
  return [value >>> 0, i];
}
