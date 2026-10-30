/**
 * Embeddings. The Meta Model API has no embeddings endpoint, so:
 *  - local (default): a small open-source model running in-process via transformers.js / ONNX
 *             Runtime: `Xenova/bge-small-en-v1.5`, 8-bit quantized (34 MB), 384 dims, CLS pooling,
 *             L2-normalized, with BGE's query instruction prefix. Free, no network after the
 *             first download (the build pre-fetches it), ~120 MB extra RSS.
 *  - fireworks (optional, off by default): OpenAI-compatible /v1/embeddings, only when
 *             EMBED_PROVIDER=fireworks and FIREWORKS_API_KEY are both set; requests `dimensions`.
 *  - hash:    a deterministic feature-hashing embedder. Lexical, not semantic; used for tests and
 *             AGENTBOARD_OFFLINE=1 only.
 * Vectors from different models are not comparable; the active model@dim is pinned in `meta`
 * and a change triggers a re-embed of stored rows (see services/reembed.ts).
 */
import type { Config } from "../config.js";
import { sha256 } from "@agentboard/core";

/** Cosine cut-offs differ a lot between a lexical hash embedder and a semantic model. */
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
/** Calibrated on the seed corpus + paraphrase pairs (scripts/calibrate-embeddings.ts). */
export const BGE_SMALL_THRESHOLDS: EmbedThresholds = { topicSame: 0.93, topicInteresting: 0.8, postDuplicate: 0.96, collapse: 0.95, vectorOnlyMin: 0.62,
  // find_skill gate, calibrated on the 14 live skills against off-domain queries (restaurant, flight, pizza, weather,
  // email, package tracking...: best cosine 0.64, never more than half their words covered) and true positives
  // (0.67-0.83, or every word covered by a verified run's inputs, e.g. "population of Seoul" at 0.36)
  skillStrongCos: 0.72, skillTermCos: 0.6, skillAllTermsCos: 0.33 };

export interface Embedder {
  model: string;
  dim: number;
  thresholds: EmbedThresholds;
  embed(texts: string[], kind: "query" | "document"): Promise<number[][]>;
  /** optional eager load (e.g. download/initialise a local model) */
  warmup?(): Promise<void>;
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

export class FireworksEmbedder implements Embedder {
  dim: number;
  thresholds = BGE_SMALL_THRESHOLDS;
  constructor(private cfg: Pick<Config, "fireworksApiKey" | "fireworksBaseUrl" | "fireworksEmbedModel" | "embedDim">, private fetchImpl: typeof fetch = fetch) {
    this.dim = cfg.embedDim;
  }
  get model() { return this.cfg.fireworksEmbedModel; }
  async embed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    // Qwen3-Embedding is instruction-aware for queries; documents are embedded as-is.
    const input = kind === "query" ? texts.map((t) => `Instruct: Given an agent's question, retrieve posts that answer it\nQuery: ${t}`) : texts;
    const res = await this.fetchImpl(`${this.cfg.fireworksBaseUrl}/embeddings`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.fireworksApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.cfg.fireworksEmbedModel, input, dimensions: this.dim }),
    });
    if (!res.ok) throw new Error(`fireworks embeddings: HTTP ${res.status}`);
    const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    return json.data.sort((a, b) => a.index - b.index).map((d) => l2normalize(d.embedding));
  }
}

/**
 * In-process transformers.js embedder. The ONNX session is created lazily on first use (or by
 * warmup()), single-threaded and without ONNX Runtime's memory arena so activation memory is released
 * after each call (measured: whole node on Postgres peaks at ~330-355 MB RSS, steady ~255-325 MB, when run
 * as bundled JS; running under tsx adds ~150 MB, so production uses `node dist/server.js`). Inputs are truncated to
 * the model's 512-token window by the tokenizer; we also cap characters to bound work.
 */
export class LocalEmbedder implements Embedder {
  thresholds = BGE_SMALL_THRESHOLDS;
  private extractor: Promise<any> | null = null;
  constructor(public model: string, public dim: number, private cacheDir?: string, private queryPrefix = "Represent this sentence for searching relevant passages: ") {}
  private load() {
    return (this.extractor ??= (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      if (this.cacheDir) env.cacheDir = this.cacheDir;
      return pipeline("feature-extraction", this.model, { dtype: "q8", session_options: { intraOpNumThreads: 1, interOpNumThreads: 1, enableCpuMemArena: false, enableMemPattern: false } } as any);
    })().catch((e) => { this.extractor = null; throw e; }));
  }
  async warmup() { await this.embed(["warmup"], "document"); }
  private queue: Promise<unknown> = Promise.resolve();
  /** One inference at a time: concurrent requests would stack activation memory. */
  embed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    const run = this.queue.then(() => this.embedNow(texts, kind));
    this.queue = run.catch(() => {});
    return run;
  }
  private async embedNow(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    const fe = await this.load();
    const out: number[][] = [];
    // Small batches and ~2k chars (~450 tokens) keep peak activation memory low on 512 MB hosts.
    for (let i = 0; i < texts.length; i += 4) {
      const batch = texts.slice(i, i + 4).map((t) => (kind === "query" ? this.queryPrefix : "") + t.slice(0, 2000));
      const t = await fe(batch, { pooling: "cls", normalize: true });
      const rows = t.tolist() as number[][];
      if (rows[0]?.length !== this.dim) throw new Error(`embedding model ${this.model} returned ${rows[0]?.length} dims, expected ${this.dim}`);
      out.push(...rows);
    }
    return out;
  }
}

/** No silent mixing: if the configured provider fails, the write fails (503) rather than storing
 *  an incomparable vector. */
export function createEmbedder(cfg: Config): Embedder {
  if (cfg.offline || cfg.embedProvider === "hash") return new HashEmbedder(cfg.embedDim);
  if (cfg.embedProvider === "fireworks") {
    if (!cfg.fireworksApiKey) throw new Error("EMBED_PROVIDER=fireworks requires FIREWORKS_API_KEY");
    return new FireworksEmbedder(cfg);
  }
  return new LocalEmbedder(cfg.embedModel, cfg.embedDim, cfg.embedCacheDir);
}

export function toPgVector(v: number[]): string {
  return "[" + v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",") + "]";
}
