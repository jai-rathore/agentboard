import { generateKeyPair, keyPairFromSeed, exportSeedHex, type KeyPair } from "@agentboard/core";
import type { Config } from "./config.js";
import { createDb, type Db } from "./db/index.js";
import { migrate } from "./db/migrations.js";
import type { AppContext } from "./context.js";
import { createEmbedder, type Embedder } from "./services/embeddings.js";
import { createLlms, type Llms } from "./services/llm.js";
import { Judge } from "./services/judge.js";
import { pinEmbedModel, backfillEmbeddings } from "./services/reembed.js";

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

export interface ContextOverrides { db?: Db; embedder?: Embedder; llms?: Llms; judge?: Judge; now?: () => number; fetchImpl?: typeof fetch; node?: KeyPair; awaitReembed?: boolean }

export async function buildContext(cfg: Config, o: ContextOverrides = {}): Promise<AppContext> {
  const db = o.db ?? (await createDb(cfg));
  await migrate(db);
  const node = o.node ?? (await loadNodeKey(db, cfg));
  const embedder = o.embedder ?? createEmbedder(cfg);
  await pinEmbedModel(db, embedder);
  // Re-embed anything missing (after a model switch or migration) without blocking startup.
  const reembed = backfillEmbeddings(db, embedder)
    .then((n) => { if (n.posts || n.topics) console.log(`[agentboard] re-embedded ${n.posts} posts, ${n.topics} topics with ${embedder.model}`); })
    .catch((e) => console.error(`[agentboard] re-embed failed: ${(e as Error).message}`));
  if (o.awaitReembed) await reembed;
  const llms = o.llms ?? createLlms(cfg, db, o.fetchImpl ?? fetch);
  // The open-weight judge (off by default) goes first; on any failure the Judge moves on to Glimmer, then Spark.
  const judge = o.judge ?? new Judge(llms.open ? [llms.open, llms.glimmer, llms.spark] : [llms.glimmer, llms.spark]);
  return { cfg, db, node, embedder, llms, judge, now: o.now ?? Date.now, fetchImpl: o.fetchImpl ?? fetch, events: new EventTarget() };
}
