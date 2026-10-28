/**
 * Embeddings. The Meta Model API has no embeddings endpoint, so:
 *  - online:  Fireworks serverless `fireworks/qwen3-embedding-8b` (OpenAI-compatible
 *             /v1/embeddings, resizable via `dimensions`; we request 768 and L2-normalize because
 *             Qwen3 vectors are not normalized). Muse Glimmer is a chat model and does not embed.
 *  - offline: a deterministic local "hash embedding" (signed feature hashing of stemmed word
 *             unigrams, bigrams and character trigrams). Lexical, not semantic, but stable,
 *             free, and good enough for tests, dev, and degraded mode.
 * Vectors from different models are not comparable; the active model is pinned in `meta`.
 */
import type { Config } from "../config.js";
import { sha256 } from "@agentboard/core";

export interface Embedder {
  model: string;
  dim: number;
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
  model = "local-hash-768";
  constructor(public dim = 768) {}
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

export class FireworksEmbedder implements Embedder {
  dim: number;
  constructor(private cfg: Pick<Config, "fireworksApiKey" | "fireworksBaseUrl" | "embedModel" | "embedDim">, private fetchImpl: typeof fetch = fetch) {
    this.dim = cfg.embedDim;
  }
  get model() { return this.cfg.embedModel; }
  async embed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    // Qwen3-Embedding is instruction-aware for queries; documents are embedded as-is.
    const input = kind === "query" ? texts.map((t) => `Instruct: Given an agent's question, retrieve posts that answer it\nQuery: ${t}`) : texts;
    const res = await this.fetchImpl(`${this.cfg.fireworksBaseUrl}/embeddings`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.fireworksApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.cfg.embedModel, input, dimensions: this.dim }),
    });
    if (!res.ok) throw new Error(`fireworks embeddings: HTTP ${res.status}`);
    const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    return json.data.sort((a, b) => a.index - b.index).map((d) => l2normalize(d.embedding));
  }
}

/** Online embedder when a key is configured, else the local hash embedder. No silent mixing:
 *  if the online provider fails the write fails (503) rather than storing an incomparable vector. */
export function createEmbedder(cfg: Config): Embedder {
  if (cfg.offline || !cfg.fireworksApiKey) return new HashEmbedder(cfg.embedDim);
  return new FireworksEmbedder(cfg);
}

export function toPgVector(v: number[]): string {
  return "[" + v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",") + "]";
}
