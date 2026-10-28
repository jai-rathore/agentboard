import { generateKeyPair, keyPairFromSeed, exportSeedHex, type KeyPair } from "@agentboard/core";
import type { Config } from "./config.js";
import { createDb, type Db } from "./db/index.js";
import { migrate } from "./db/migrations.js";
import type { AppContext } from "./context.js";
import { createEmbedder, type Embedder } from "./services/embeddings.js";
import { createLlms, type Llms } from "./services/llm.js";
import { Judge } from "./services/judge.js";

async function loadNodeKey(db: Db, cfg: Config): Promise<KeyPair> {
  if (cfg.nodeSigningKey) return keyPairFromSeed(cfg.nodeSigningKey.trim());
  if (cfg.databaseUrl) throw new Error("NODE_SIGNING_KEY is required when DATABASE_URL is set (production)");
  // Dev/test only: an ephemeral or PGlite-persisted node key. Never used with real Postgres.
  const r = await db.query<{ value: string }>(`SELECT value FROM meta WHERE key = 'dev_node_seed'`);
  if (r.rows[0]) return keyPairFromSeed(r.rows[0].value);
  const kp = generateKeyPair();
  await db.query(`INSERT INTO meta (key, value) VALUES ('dev_node_seed', $1)`, [exportSeedHex(kp)]);
  return kp;
}

async function pinEmbedModel(db: Db, model: string) {
  const r = await db.query<{ value: string }>(`SELECT value FROM meta WHERE key = 'embed_model'`);
  if (!r.rows[0]) { await db.query(`INSERT INTO meta (key, value) VALUES ('embed_model', $1)`, [model]); return; }
  if (r.rows[0].value !== model) {
    const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM posts`)).rows[0]?.n ?? 0;
    if (n > 0) throw new Error(`embedding model changed (${r.rows[0].value} -> ${model}); re-embed before switching`);
    await db.query(`UPDATE meta SET value = $1 WHERE key = 'embed_model'`, [model]);
  }
}

export interface ContextOverrides { db?: Db; embedder?: Embedder; llms?: Llms; judge?: Judge; now?: () => number; fetchImpl?: typeof fetch; node?: KeyPair }

export async function buildContext(cfg: Config, o: ContextOverrides = {}): Promise<AppContext> {
  const db = o.db ?? (await createDb(cfg));
  await migrate(db);
  const node = o.node ?? (await loadNodeKey(db, cfg));
  const embedder = o.embedder ?? createEmbedder(cfg);
  await pinEmbedModel(db, embedder.model);
  const llms = o.llms ?? createLlms(cfg, db);
  const judge = o.judge ?? new Judge([llms.glimmer, llms.spark]);
  return { cfg, db, node, embedder, llms, judge, now: o.now ?? Date.now, fetchImpl: o.fetchImpl ?? fetch, events: new EventTarget() };
}
