import type { Db } from './client'

interface Migration {
  id: number
  name: string
  sql: (opts: { embeddingDim: number }) => string
}

/**
 * Append-only list. Never edit a migration that has shipped; add a new one.
 * The same SQL runs on embedded PGlite and on PostgreSQL 17 + pgvector.
 */
const migrations: Migration[] = [
  {
    id: 1,
    name: 'archive_and_search',
    sql: ({ embeddingDim }) => `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
INSERT INTO settings(key, value) VALUES ('embedding_dim', '${embeddingDim}'::jsonb);

-- One row per connected account/export origin (e.g. "ChatGPT – director").
CREATE TABLE sources (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       text NOT NULL,
  label      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, label)
);

-- Every uploaded export file. The original file is kept on disk, addressed by its SHA-256.
CREATE TABLE import_batches (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id         integer NOT NULL REFERENCES sources(id),
  original_filename text NOT NULL,
  file_sha256       text NOT NULL,
  file_size         bigint NOT NULL,
  stored_path       text NOT NULL,
  status            text NOT NULL DEFAULT 'queued',
  duplicate_of      integer REFERENCES import_batches(id),
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  stats             jsonb NOT NULL DEFAULT '{}'::jsonb,
  error             text
);
CREATE INDEX import_batches_sha ON import_batches(file_sha256);

CREATE TABLE import_issues (
  id                       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id                 integer NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  severity                 text NOT NULL,
  conversation_external_id text,
  message                  text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_issues_batch ON import_issues(batch_id);

CREATE TABLE conversations (
  id                       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id                integer NOT NULL REFERENCES sources(id),
  external_id              text NOT NULL,
  title                    text NOT NULL DEFAULT '',
  created_at               timestamptz,
  updated_at               timestamptz,
  current_node_external_id text,
  content_hash             text NOT NULL,
  version                  integer NOT NULL DEFAULT 1,
  message_count            integer NOT NULL DEFAULT 0,
  node_count               integer NOT NULL DEFAULT 0,
  branch_count             integer NOT NULL DEFAULT 0,
  model_slugs              text[] NOT NULL DEFAULT '{}',
  is_archived              boolean NOT NULL DEFAULT false,
  first_seen_batch_id      integer REFERENCES import_batches(id),
  last_seen_batch_id       integer REFERENCES import_batches(id),
  last_changed_batch_id    integer REFERENCES import_batches(id),
  missing_since_batch_id   integer REFERENCES import_batches(id),
  title_tsv                tsvector GENERATED ALWAYS AS (to_tsvector('english', title)) STORED,
  UNIQUE (source_id, external_id)
);
CREATE INDEX conversations_updated ON conversations(updated_at DESC);
CREATE INDEX conversations_title_tsv ON conversations USING gin(title_tsv);

-- Full original JSON for every distinct version of a conversation. Append-only.
CREATE TABLE conversation_versions (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id integer NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  version         integer NOT NULL,
  batch_id        integer NOT NULL REFERENCES import_batches(id),
  content_hash    text NOT NULL,
  raw             jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, version)
);

-- One row per node of the export's message tree, including edited/regenerated branches.
CREATE TABLE messages (
  id                      integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id         integer NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  node_external_id        text NOT NULL,
  parent_node_external_id text,
  role                    text,
  author_name             text,
  content_type            text,
  content_text            text NOT NULL DEFAULT '',
  created_at              timestamptz,
  model_slug              text,
  is_hidden               boolean NOT NULL DEFAULT false,
  is_canonical            boolean NOT NULL DEFAULT false,
  canonical_position      integer,
  depth                   integer NOT NULL DEFAULT 0,
  sibling_index           integer NOT NULL DEFAULT 0,
  sibling_count           integer NOT NULL DEFAULT 1,
  content_hash            text NOT NULL,
  present_in_latest       boolean NOT NULL DEFAULT true,
  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_batch_id     integer REFERENCES import_batches(id),
  last_changed_batch_id   integer REFERENCES import_batches(id),
  tsv                     tsvector GENERATED ALWAYS AS (to_tsvector('english', content_text)) STORED,
  UNIQUE (conversation_id, node_external_id)
);
CREATE INDEX messages_tsv ON messages USING gin(tsv);
CREATE INDEX messages_canonical ON messages(conversation_id, canonical_position);
CREATE INDEX messages_parent ON messages(conversation_id, parent_node_external_id);
CREATE INDEX messages_created ON messages(created_at);

-- Retrieval units for semantic search (one conversational turn, or a slice of a long one).
CREATE TABLE chunks (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id integer NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_ids     integer[] NOT NULL,
  ordinal         integer NOT NULL,
  context_header  text NOT NULL,
  text            text NOT NULL,
  embedding       vector(${embeddingDim}),
  embedding_model text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chunks_conversation ON chunks(conversation_id);
CREATE INDEX chunks_pending ON chunks(id) WHERE embedding IS NULL;
CREATE INDEX chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE audit_log (
  id      integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  action  text NOT NULL,
  target  text,
  ip      text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_at ON audit_log(at DESC);
`,
  },
  {
    id: 2,
    name: 'export_folder_watch',
    sql: () => `
-- How an import arrived: 'upload' (web page), 'cli' (command line) or 'watch' (found in the watched folder).
ALTER TABLE import_batches ADD COLUMN origin text NOT NULL DEFAULT 'upload';

-- Files the folder watcher has examined, so each file is checked once per version (size + modified time).
CREATE TABLE watched_files (
  path        text PRIMARY KEY,
  size        bigint NOT NULL,
  mtime_ms    bigint NOT NULL,
  status      text NOT NULL,
  batch_id    integer REFERENCES import_batches(id),
  error       text,
  checked_at  timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    id: 3,
    name: 'memory_engine',
    sql: () => `
-- Provenance of each message: 'export' (official export, authoritative) or 'live_capture' (browser extension).
ALTER TABLE messages ADD COLUMN origin text NOT NULL DEFAULT 'export';
ALTER TABLE messages ADD COLUMN captured_at timestamptz;
ALTER TABLE conversations ADD COLUMN origin text NOT NULL DEFAULT 'export';
ALTER TABLE conversations ADD COLUMN last_captured_at timestamptz;
ALTER TABLE conversations ADD COLUMN summary text;
ALTER TABLE conversations ADD COLUMN processed_hash text;
ALTER TABLE conversations ADD COLUMN processed_at timestamptz;
ALTER TABLE conversations ADD COLUMN processed_by text;

-- Durable background work with retries.
CREATE TABLE jobs (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key  text,
  status      text NOT NULL DEFAULT 'queued',
  attempts    integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_after   timestamptz NOT NULL DEFAULT now(),
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX jobs_dedupe_queued ON jobs(dedupe_key) WHERE status = 'queued';
CREATE INDEX jobs_ready ON jobs(status, run_after);

-- Projects, people, organisations, technologies and topics, shared across conversations.
CREATE TABLE entities (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL,
  name        text NOT NULL,
  norm_name   text NOT NULL,
  aliases     text[] NOT NULL DEFAULT '{}',
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (norm_name)
);

CREATE TABLE conversation_entities (
  conversation_id integer NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  entity_id       integer NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  mentions        integer NOT NULL DEFAULT 1,
  PRIMARY KEY (conversation_id, entity_id)
);
CREATE INDEX conversation_entities_entity ON conversation_entities(entity_id);

-- Decisions, requirements, tasks, problems, ideas... Every item must quote its source message (evidence).
CREATE TABLE knowledge_items (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id integer NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind            text NOT NULL,
  status          text NOT NULL,
  statement       text NOT NULL,
  effective_at    timestamptz,
  due_text        text,
  confidence      real NOT NULL DEFAULT 0.5,
  extractor       text NOT NULL,
  review_state    text NOT NULL DEFAULT 'auto',
  created_at      timestamptz NOT NULL DEFAULT now(),
  tsv             tsvector GENERATED ALWAYS AS (to_tsvector('english', statement)) STORED
);
CREATE INDEX knowledge_items_conv ON knowledge_items(conversation_id);
CREATE INDEX knowledge_items_tsv ON knowledge_items USING gin(tsv);
CREATE INDEX knowledge_items_kind ON knowledge_items(kind, status);

CREATE TABLE evidence (
  item_id    integer NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  message_id integer NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  quote      text NOT NULL,
  PRIMARY KEY (item_id, message_id)
);

CREATE TABLE item_entities (
  item_id   integer NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  entity_id integer NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, entity_id)
);
CREATE INDEX item_entities_entity ON item_entities(entity_id);

-- How items relate across time: a later item 'supersedes' or 'contradicts' an earlier one.
CREATE TABLE item_relations (
  from_item   integer NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  to_item     integer NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  type        text NOT NULL,
  explanation text,
  detected_by text NOT NULL,
  PRIMARY KEY (from_item, to_item, type)
);
CREATE INDEX item_relations_to ON item_relations(to_item);

-- Raw live-capture payloads exactly as received from the browser extension (append-only).
CREATE TABLE capture_events (
  id                       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at              timestamptz NOT NULL DEFAULT now(),
  conversation_external_id text,
  conversation_id          integer REFERENCES conversations(id) ON DELETE SET NULL,
  message_count            integer NOT NULL DEFAULT 0,
  added                    integer NOT NULL DEFAULT 0,
  updated                  integer NOT NULL DEFAULT 0,
  result                   text NOT NULL,
  error                    text,
  raw                      jsonb NOT NULL
);
CREATE INDEX capture_events_received ON capture_events(received_at DESC);

CREATE TABLE extension_tokens (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label        text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE TABLE qa_turns (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question    text NOT NULL,
  answer      jsonb NOT NULL,
  mode        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title       text NOT NULL,
  doc_type    text NOT NULL,
  request     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'queued',
  formats     text[] NOT NULL DEFAULT '{}',
  files       jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_count integer NOT NULL DEFAULT 0,
  mode        text,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

-- Every time conversation content leaves this server (AI or embedding provider), it is recorded here.
CREATE TABLE external_calls (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  provider    text NOT NULL,
  model       text,
  purpose     text NOT NULL,
  chars_sent  integer NOT NULL,
  ok          boolean NOT NULL,
  error       text
);
CREATE INDEX external_calls_at ON external_calls(at DESC);
`,
  },
]

export async function migrate(db: Db, opts: { embeddingDim: number }): Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`)
  const applied = new Set(
    (await db.query<{ id: number }>('SELECT id FROM schema_migrations')).map((r) => r.id),
  )
  for (const m of migrations) {
    if (applied.has(m.id)) continue
    await db.tx(async (q) => {
      for (const stmt of splitStatements(m.sql(opts))) await q.query(stmt)
      await q.query('INSERT INTO schema_migrations(id, name) VALUES ($1, $2)', [m.id, m.name])
    })
  }
}

/** Migrations contain no functions or string literals with semicolons, so a plain split is safe. */
function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean)
}
