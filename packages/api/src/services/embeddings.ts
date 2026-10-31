/**
 * Vectors for hybrid search, without any embedding model. Agentboard's runtime calls only Meta models, and neither the
 * Meta Model API nor Baseten's Model APIs serve a Meta embedding model, so the vector list in hybrid search is a
 * deterministic feature-hashing vector (words, word bigrams and character trigrams hashed into 384 dimensions,
 * L2-normalized). It is lexical, not semantic: no learned weights, no download, no network, no model call. It sits next
 * to Postgres full text search and pg_trgm, all fused with reciprocal rank fusion.
 * Earlier builds used an open-source in-process model (bge-small) or an opt-in hosted one; both were removed. The active
 * `model@dim` is pinned in `meta` and a change re-embeds stored rows (services/reembed.ts), so a node that ran the old
 * model re-indexes itself with this one on boot.
 */
import type { Config } from "../config.js";
import { sha256 } from "@agentboard/core";

/** Cosine cut-offs for the hashing vectors (the find_skill gate values are the ones test/skill-search.test.ts checks against a copy of the live catalog). */
export interface EmbedThresholds {
  /** topic requests at or above this cosine become an alias of the existing topic */
  topicSame: number;
  /** topic candidates worth an LLM adjudication */
  topicInteresting: number;
  /** a new post at or above this cosine to an existing one is rejected as a duplicate */
  postDuplicate: number;
  /** search results at or above this cosine to a better-ranked one are collapsed */
  collapse: number;
  /** a result found only by the vector list must be at least this close to the query */
  vectorOnlyMin: number;
  /** find_skill confidence gate (skillMatch.ts): a skill matches on its own at this cosine... */
  skillStrongCos: number;
  /** ...or at this cosine when more than half of the query's words are in the skill or its verified inputs... */
  skillTermCos: number;
  /** ...or at this cosine when all of them are */
  skillAllTermsCos: number;
}

export const HASH_THRESHOLDS: EmbedThresholds = { topicSame: 0.9, topicInteresting: 0.7, postDuplicate: 0.97, collapse: 0.95, vectorOnlyMin: 0.35, skillStrongCos: 0.6, skillTermCos: 0.2, skillAllTermsCos: -1 };

export interface Embedder {
  model: string;
  dim: number;
  thresholds: EmbedThresholds;
  embed(texts: string[], kind: "query" | "document"): Promise<number[][]>;
}

export function l2normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const STOP = new Set("a an the and or of to in on for with is are was were be been it this that how what why when where which who do does did can could should would i you we they my our your from by at as into about via using use not no".split(" "));

/** Tiny suffix stripper so "indexes"/"indexing"/"index" collide. */
export function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("es") && !w.endsWith("ses")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  return w;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().normalize("NFKD").match(/[a-z0-9][a-z0-9+#.\-]*[a-z0-9+#]|[a-z0-9]/g) ?? [])
    .flatMap((t) => t.split(/[.\-]/).filter(Boolean).concat(t.includes("-") || t.includes(".") ? [t.replace(/[.\-]/g, "")] : []))
    .filter((t) => !STOP.has(t))
    .map(stem);
}

export class HashEmbedder implements Embedder {
  thresholds = HASH_THRESHOLDS;
  constructor(public dim = 384) {}
  get model() { return `local-hash-${this.dim}`; }
  private bucket(feature: string): [number, number] {
    const h = sha256(feature);
    const idx = ((h[0] << 16) | (h[1] << 8) | h[2]) % this.dim;
    return [idx, h[3] & 1 ? 1 : -1];
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array(this.dim).fill(0);
      const toks = tokenize(t);
      const add = (f: string, w: number) => { const [i, s] = this.bucket(f); v[i] += s * w; };
      toks.forEach((tok, i) => {
        add("w:" + tok, 1.0);
        if (i > 0) add("b:" + toks[i - 1] + "_" + tok, 0.5);
        const padded = `^${tok}$`;
        for (let j = 0; j + 3 <= padded.length; j++) add("c:" + padded.slice(j, j + 3), 0.25);
      });
      return l2normalize(v);
    });
  }
}

/** The only embedder: lexical feature hashing (see the header). */
export function createEmbedder(cfg: Pick<Config, "embedDim">): Embedder {
  return new HashEmbedder(cfg.embedDim);
}

export function toPgVector(v: number[]): string {
  return "[" + v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",") + "]";
}
