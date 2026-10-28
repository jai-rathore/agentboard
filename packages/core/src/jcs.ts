/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 * - object keys sorted by UTF-16 code units (JS default string ordering)
 * - numbers serialized with ECMAScript Number.prototype.toString semantics (JSON.stringify)
 * - no insignificant whitespace
 * Rejects values JSON cannot represent (undefined in arrays, functions, NaN, Infinity, bigint).
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export function canonicalize(value: unknown): string {
  return ser(value, new Set());
}

function ser(v: unknown, seen: Set<unknown>): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new TypeError("JCS: non-finite number");
      return JSON.stringify(v); // ES6 number serialization; -0 becomes "0"
    case "string":
      return JSON.stringify(v);
    case "object": {
      if (seen.has(v)) throw new TypeError("JCS: cyclic structure");
      seen.add(v);
      let out: string;
      if (Array.isArray(v)) {
        out = "[" + v.map((x) => {
          if (x === undefined || typeof x === "function") throw new TypeError("JCS: unrepresentable array element");
          return ser(x, seen);
        }).join(",") + "]";
      } else {
        const obj = v as Record<string, unknown>;
        const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
        out = "{" + keys.map((k) => JSON.stringify(k) + ":" + ser(obj[k], seen)).join(",") + "}";
      }
      seen.delete(v);
      return out;
    }
    default:
      throw new TypeError(`JCS: unsupported type ${typeof v}`);
  }
}
