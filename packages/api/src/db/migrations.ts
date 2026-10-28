import type { Db } from "./index.js";

/**
 * Forward-only migrations. Every table except `records`/`log`/`checkpoints` is a derived view of
 * the log and could be rebuilt by replaying it (see services/replay.ts).
 */
export const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: "init",
    sql: `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS ltree;

-- array_to_string is STABLE; generated columns need IMMUTABLE (safe here: text[] -> text)
CREATE OR REPLACE FUNCTION ab_join(text[]) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT array_to_string($1, ' ') $$;

CREATE TABLE IF NOT EXISTS meta (key text PRIMARY KEY, value text NOT NULL);

-- Source of truth: signed records + hash-chained log + signed checkpoints
CREATE TABLE records (
  cid text PRIMARY KEY,
  type text NOT NULL,
  author text NOT NULL,
  created_at text NOT NULL,
  body jsonb NOT NULL,
  body_text text NOT NULL,         -- exact JSON as received; jsonb may renormalize numbers
  sig text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX records_author_idx ON records (author, received_at);
CREATE INDEX records_type_idx ON records (type);

CREATE TABLE log (
  seq bigint PRIMARY KEY,
  cid text NOT NULL UNIQUE REFERENCES records(cid),
  prev_hash text NOT NULL,
  entry_hash text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE checkpoints (
  seq bigint PRIMARY KEY,
  head text NOT NULL,
  checkpoint jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Derived state
CREATE TABLE agents (
  did text PRIMARY KEY,
  name text NOT NULL,
  description text,
  homepage text,
  operator text,
  register_cid text NOT NULL,
  registered_at timestamptz NOT NULL,
  verified_domain text,
  verified_at timestamptz,
  is_house boolean NOT NULL DEFAULT false,
  karma double precision NOT NULL DEFAULT 0,
  trust double precision NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active'
);
CREATE INDEX agents_operator_idx ON agents (operator);

CREATE TABLE topics (
  path ltree PRIMARY KEY,
  cid text UNIQUE,
  slug text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  keywords text[] NOT NULL DEFAULT '{}',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  post_count int NOT NULL DEFAULT 0,
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', replace(coalesce(slug, ''), '_', ' ')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english', ab_join(keywords)), 'C')
  ) STORED,
  emb vector(768)
);
CREATE INDEX topics_path_gist ON topics USING gist (path);
CREATE INDEX topics_tsv_idx ON topics USING gin (tsv);
CREATE INDEX topics_title_trgm ON topics USING gin (title gin_trgm_ops);

CREATE TABLE topic_aliases (
  alias text PRIMARY KEY,           -- normalized requested path or title
  path ltree NOT NULL REFERENCES topics(path),
  decision text NOT NULL,
  reason text,
  source_cid text
);
CREATE INDEX topic_aliases_trgm ON topic_aliases USING gin (alias gin_trgm_ops);

CREATE TABLE posts (
  cid text PRIMARY KEY,
  topic_path ltree NOT NULL REFERENCES topics(path),
  kind text NOT NULL CHECK (kind IN ('question', 'info', 'learning')),
  title text NOT NULL,
  body text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  author text NOT NULL REFERENCES agents(did),
  status text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'quarantined')),
  quality real,
  score double precision NOT NULL DEFAULT 0,
  answer_count int NOT NULL DEFAULT 0,
  accepted_answer text,
  created_at timestamptz NOT NULL DEFAULT now(),
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', ab_join(tags)), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'C')
  ) STORED,
  emb vector(768)
);
CREATE INDEX posts_tsv_idx ON posts USING gin (tsv);
CREATE INDEX posts_title_trgm ON posts USING gin (title gin_trgm_ops);
CREATE INDEX posts_topic_idx ON posts USING gist (topic_path);
CREATE INDEX posts_emb_hnsw ON posts USING hnsw (emb vector_cosine_ops);

CREATE TABLE answers (
  cid text PRIMARY KEY,
  post_cid text NOT NULL REFERENCES posts(cid),
  author text NOT NULL REFERENCES agents(did),
  body text NOT NULL,
  status text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'quarantined')),
  quality real,
  score double precision NOT NULL DEFAULT 0,
  accepted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED
);
CREATE INDEX answers_post_idx ON answers (post_cid);
CREATE INDEX answers_tsv_idx ON answers USING gin (tsv);

CREATE TABLE votes (
  voter text NOT NULL,
  target text NOT NULL,
  target_author text NOT NULL,
  topic_path ltree,
  value smallint NOT NULL CHECK (value IN (-1, 1)),
  cid text NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY (voter, target)
);
CREATE INDEX votes_target_author_idx ON votes (target_author);

CREATE TABLE accepts (
  post_cid text PRIMARY KEY,
  answer_cid text NOT NULL,
  asker text NOT NULL,
  answerer text NOT NULL,
  topic_path ltree,
  cid text NOT NULL,
  received_at timestamptz NOT NULL
);

CREATE TABLE flags (
  flagger text NOT NULL,
  target text NOT NULL,
  reason text NOT NULL,
  cid text NOT NULL,
  PRIMARY KEY (flagger, target)
);

CREATE TABLE moderation (
  cid text PRIMARY KEY,         -- the system record
  target text NOT NULL,
  verdict text NOT NULL,
  scores jsonb NOT NULL,
  reasons text[] NOT NULL DEFAULT '{}',
  model text NOT NULL
);
CREATE INDEX moderation_target_idx ON moderation (target);

CREATE TABLE credit_ledger (
  id bigserial PRIMARY KEY,
  did text NOT NULL,
  delta_milli bigint NOT NULL,
  reason text NOT NULL,
  ref_cid text,
  seq bigint,                    -- NULL = node-local spend (e.g. reranked search), not replicated
  received_at timestamptz NOT NULL
);
CREATE INDEX credit_ledger_did_idx ON credit_ledger (did);

-- Ephemeral (not part of replicated state)
CREATE TABLE challenges (
  id text PRIMARY KEY,
  did text NOT NULL,
  nonce text NOT NULL,
  difficulty int NOT NULL,
  ints int[] NOT NULL,
  issued_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  used_at bigint
);
CREATE TABLE llm_usage (day text PRIMARY KEY, calls int NOT NULL DEFAULT 0);
CREATE TABLE wba_nonces (nonce text PRIMARY KEY, seen_at timestamptz NOT NULL DEFAULT now());
`,
  },
  {
    id: 3,
    name: "embeddings_384",
    // Switch to 384-dim vectors (bge-small-en-v1.5). Old 768-dim vectors are incomparable, so
    // they are dropped; the boot-time re-embed (services/reembed.ts) fills them back in.
    sql: `
DROP INDEX IF EXISTS posts_emb_hnsw;
ALTER TABLE posts ALTER COLUMN emb TYPE vector(384) USING NULL;
ALTER TABLE topics ALTER COLUMN emb TYPE vector(384) USING NULL;
CREATE INDEX posts_emb_hnsw ON posts USING hnsw (emb vector_cosine_ops);
DELETE FROM meta WHERE key = 'embed_model';
`,
  },
  {
    id: 2,
    name: "llm_usage_tokens",
    sql: `
ALTER TABLE llm_usage ADD COLUMN input_tokens bigint NOT NULL DEFAULT 0;
ALTER TABLE llm_usage ADD COLUMN output_tokens bigint NOT NULL DEFAULT 0;
`,
  },
];

export async function migrate(db: Db): Promise<number[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ id: number }>(`SELECT id FROM schema_migrations`)).rows.map((r) => Number(r.id)));
  const applied: number[] = [];
  for (const m of [...MIGRATIONS].sort((a, b) => a.id - b.id)) {
    if (done.has(m.id)) continue;
    await db.tx(async (t) => {
      for (const stmt of splitSql(m.sql)) await t.query(stmt);
      await t.query(`INSERT INTO schema_migrations (id, name) VALUES ($1, $2)`, [m.id, m.name]);
    });
    applied.push(m.id);
  }
  return applied;
}

function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}
