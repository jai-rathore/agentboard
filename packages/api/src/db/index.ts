/**
 * Minimal database abstraction so the same SQL runs on real Postgres (pg) in production and on
 * embedded PGlite (Postgres compiled to WASM, with pgvector/pg_trgm/ltree) for dev and tests.
 */
import type { Config } from "../config.js";

export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: "pg" | "pglite";
}

export async function createDb(cfg: Pick<Config, "databaseUrl" | "pgliteDataDir">): Promise<Db> {
  if (cfg.databaseUrl) return createPgDb(cfg.databaseUrl);
  return createPgliteDb(cfg.pgliteDataDir);
}

async function createPgDb(url: string): Promise<Db> {
  const pg = await import("pg");
  const Pool = pg.default?.Pool ?? (pg as any).Pool;
  // bigint/numeric -> JS number for our small counters
  const types = pg.default?.types ?? (pg as any).types;
  types.setTypeParser(20, (v: string) => Number(v));
  const pool = new Pool({ connectionString: url, max: 10, ssl: /sslmode=require|render\.com/.test(url) ? { rejectUnauthorized: false } : undefined });
  // an idle client that the server drops (restart, failover, a test database dropped) must not crash the process
  pool.on("error", (e: Error) => console.error(`[agentboard] idle database client error: ${e.message}`));
  const wrap = (q: { query: (s: string, p?: unknown[]) => Promise<any> }): Omit<Db, "tx" | "close" | "kind"> => ({
    query: async (sql, params) => q.query(sql, params as any[]),
  });
  const db: Db = {
    kind: "pg",
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inner: Db = { kind: "pg", ...wrap(client), tx: (f) => f(inner), close: async () => {} };
        const out = await fn(inner);
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  return db;
}

async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  const { ltree } = await import("@electric-sql/pglite/contrib/ltree");
  const extensions = { vector, pg_trgm, ltree };
  const pg = dataDir ? new PGlite(dataDir, { extensions }) : new PGlite({ extensions });
  await pg.waitReady;
  // PGlite serializes access; run transactions through a promise chain so callers queue.
  let chain: Promise<unknown> = Promise.resolve();
  const db: Db = {
    kind: "pglite",
    query: async (sql, params) => {
      const r = await pg.query(sql, params as any[]);
      return { rows: r.rows as any[] };
    },
    tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      const run = chain.then(() =>
        pg.transaction(async (t) => {
          const inner: Db = {
            kind: "pglite",
            query: async (sql, params) => ({ rows: (await t.query(sql, params as any[])).rows as any[] }),
            tx: (f) => f(inner),
            close: async () => {},
          };
          return fn(inner);
        }),
      );
      chain = run.catch(() => {});
      return run as Promise<T>;
    },
    close: () => pg.close(),
  };
  return db;
}
