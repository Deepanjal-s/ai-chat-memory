import fs from 'node:fs'
import path from 'node:path'
import type { Db, Queryable } from '../db/client'
import { chunkConversation } from '../indexing/chunker'
import { enqueueJob } from '../jobs'
import { readExport } from './export-reader'
import { normalizeConversation, type NormalizedConversation, type NormalizedNode, type RawConversation } from './normalize'

export interface ImportStats {
  format?: 'zip' | 'json'
  conversationFiles?: string[]
  otherFilesInExport?: number
  conversationsInFile: number
  nodesInFile: number
  newConversations: number
  updatedConversations: number
  unchangedConversations: number
  /** Conversations whose incoming copy is older than what is stored; kept as a historical version only. */
  olderVersionsKept: number
  failedConversations: number
  duplicatesInFile: number
  messagesAdded: number
  messagesChanged: number
  messagesNoLongerInSource: number
  warnings: number
  missingFromExport: number
  exportAsOf?: string | null
  reconciliation?: Reconciliation
}

export interface Reconciliation {
  expectedConversations: number
  storedConversations: number
  expectedNodes: number
  storedNodes: number
  ok: boolean
}

export type BatchStatus = 'queued' | 'processing' | 'complete' | 'complete_with_errors' | 'failed' | 'duplicate'

const emptyStats = (): ImportStats => ({
  conversationsInFile: 0,
  nodesInFile: 0,
  newConversations: 0,
  updatedConversations: 0,
  unchangedConversations: 0,
  olderVersionsKept: 0,
  failedConversations: 0,
  duplicatesInFile: 0,
  messagesAdded: 0,
  messagesChanged: 0,
  messagesNoLongerInSource: 0,
  warnings: 0,
  missingFromExport: 0,
})

export async function getOrCreateSource(db: Queryable, kind: string, label: string): Promise<number> {
  const rows = await db.query<{ id: number }>(
    `INSERT INTO sources(kind, label) VALUES ($1, $2)
     ON CONFLICT (kind, label) DO UPDATE SET label = EXCLUDED.label RETURNING id`,
    [kind, label],
  )
  return rows[0].id
}

/**
 * Records an uploaded export and moves it into immutable storage (named by its SHA-256).
 * Uploading a file that was already imported successfully creates a 'duplicate' batch and nothing else.
 */
export async function registerUpload(
  db: Db,
  args: {
    tempPath: string
    originalFilename: string
    sha256: string
    size: number
    sourceLabel: string
    rawDir: string
    origin?: 'upload' | 'cli' | 'watch'
  },
): Promise<{ batchId: number; duplicateOf: number | null }> {
  fs.mkdirSync(args.rawDir, { recursive: true })
  const ext = path.extname(args.originalFilename).toLowerCase() === '.json' ? '.json' : '.zip'
  const storedPath = path.join(args.rawDir, `${args.sha256}${ext}`)
  if (fs.existsSync(storedPath)) fs.rmSync(args.tempPath, { force: true })
  else fs.renameSync(args.tempPath, storedPath)
  fs.chmodSync(storedPath, 0o444)

  const sourceId = await getOrCreateSource(db, 'chatgpt', args.sourceLabel)
  const prior = await db.query<{ id: number }>(
    `SELECT id FROM import_batches
      WHERE file_sha256 = $1 AND source_id = $2 AND status IN ('complete', 'complete_with_errors')
      ORDER BY id LIMIT 1`,
    [args.sha256, sourceId],
  )
  const duplicateOf = prior[0]?.id ?? null
  const [row] = await db.query<{ id: number }>(
    `INSERT INTO import_batches(source_id, original_filename, file_sha256, file_size, stored_path, status, duplicate_of, finished_at, origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      sourceId,
      args.originalFilename,
      args.sha256,
      args.size,
      storedPath,
      duplicateOf ? 'duplicate' : 'queued',
      duplicateOf,
      duplicateOf ? new Date().toISOString() : null,
      args.origin ?? 'upload',
    ],
  )
  return { batchId: row.id, duplicateOf }
}

/**
 * Imports one export batch. Idempotent: re-running a batch (e.g. after a crash) converges to the same state,
 * because conversations are keyed by their ChatGPT id and messages by their tree node id.
 */
export async function runImport(
  db: Db,
  batchId: number,
  opts: { onProgress?: (s: ImportStats) => void; progressEvery?: number } = {},
): Promise<ImportStats> {
  const [batch] = await db.query<{ id: number; source_id: number; stored_path: string }>(
    'SELECT id, source_id, stored_path FROM import_batches WHERE id = $1',
    [batchId],
  )
  if (!batch) throw new Error(`Import batch ${batchId} not found`)
  await db.query(`DELETE FROM import_issues WHERE batch_id = $1`, [batchId])
  await db.query(`UPDATE import_batches SET status = 'processing', started_at = now(), finished_at = NULL, error = NULL WHERE id = $1`, [
    batchId,
  ])

  const stats = emptyStats()
  const seen = new Set<string>()
  /** Live node count each stored conversation must have after this batch, keyed by ChatGPT id. */
  const expectedNodes = new Map<string, number>()
  let exportAsOf: Date | null = null
  const saveProgress = () =>
    db.query('UPDATE import_batches SET stats = $1::jsonb WHERE id = $2', [JSON.stringify(stats), batchId])
  const issue = (severity: 'error' | 'warning', externalId: string | null, message: string) =>
    db.query('INSERT INTO import_issues(batch_id, severity, conversation_external_id, message) VALUES ($1,$2,$3,$4)', [
      batchId,
      severity,
      externalId,
      message.slice(0, 2000),
    ])

  try {
    const entries = await readExport(batch.stored_path, (inv) => {
      stats.format = inv.format
      stats.conversationFiles = inv.conversationFiles
      stats.otherFilesInExport = inv.otherFiles
    })
    for await (const entry of entries) {
      stats.conversationsInFile++
      const fallbackId = (entry.raw?.conversation_id ?? entry.raw?.id ?? null) as string | null
      let n: NormalizedConversation
      try {
        n = normalizeConversation(entry.raw)
      } catch (e) {
        stats.failedConversations++
        await issue('error', fallbackId, `${entry.file}[${entry.index}]: ${(e as Error).message}`)
        continue
      }
      if (seen.has(n.externalId)) {
        stats.duplicatesInFile++
        await issue('warning', n.externalId, 'Conversation appears more than once in the export; later copy applied')
      }
      seen.add(n.externalId)
      if (n.updatedAt && (!exportAsOf || n.updatedAt > exportAsOf)) exportAsOf = n.updatedAt
      for (const w of n.warnings) {
        stats.warnings++
        await issue('warning', n.externalId, w)
      }
      try {
        const live = await db.tx((q) => upsertConversation(q, batch.source_id, batchId, entry.raw, n, stats))
        expectedNodes.set(n.externalId, live)
        stats.nodesInFile += n.nodes.length
      } catch (e) {
        stats.failedConversations++
        await issue('error', n.externalId, `Failed to store "${n.title}": ${(e as Error).message}`)
      }
      if (stats.conversationsInFile % (opts.progressEvery ?? 25) === 0) {
        await saveProgress()
        opts.onProgress?.(stats)
      }
    }

    stats.exportAsOf = exportAsOf?.toISOString() ?? null
    stats.missingFromExport = await markMissing(db, batch.source_id, batchId, stats, exportAsOf)
    stats.reconciliation = await reconcile(db, batchId, expectedNodes)
    const status: BatchStatus =
      stats.failedConversations > 0 || !stats.reconciliation.ok ? 'complete_with_errors' : 'complete'
    if (!stats.reconciliation.ok) {
      await issue(
        'error',
        null,
        `Reconciliation mismatch: expected ${stats.reconciliation.expectedConversations} conversations / ${stats.reconciliation.expectedNodes} nodes, ` +
          `stored ${stats.reconciliation.storedConversations} / ${stats.reconciliation.storedNodes}`,
      )
    }
    await db.query(`UPDATE import_batches SET status = $1, stats = $2::jsonb, finished_at = now() WHERE id = $3`, [
      status,
      JSON.stringify(stats),
      batchId,
    ])
    opts.onProgress?.(stats)
    return stats
  } catch (e) {
    await db.query(`UPDATE import_batches SET status = 'failed', stats = $1::jsonb, error = $2, finished_at = now() WHERE id = $3`, [
      JSON.stringify(stats),
      (e as Error).message,
      batchId,
    ])
    throw e
  }
}

async function upsertConversation(
  q: Queryable,
  sourceId: number,
  batchId: number,
  raw: RawConversation,
  n: NormalizedConversation,
  stats: ImportStats,
): Promise<number> {
  const [existing] = await q.query<{ id: number; content_hash: string; version: number; updated_at: Date | string | null; node_count: number }>(
    'SELECT id, content_hash, version, updated_at, node_count FROM conversations WHERE source_id = $1 AND external_id = $2',
    [sourceId, n.externalId],
  )

  if (existing && existing.content_hash === n.contentHash) {
    await q.query(
      'UPDATE conversations SET last_seen_batch_id = $1, missing_since_batch_id = NULL, is_archived = $2 WHERE id = $3',
      [batchId, n.isArchived, existing.id],
    )
    stats.unchangedConversations++
    return existing.node_count
  }

  const rawJson = jsonForPostgres(raw)

  if (existing) {
    // Compare with the newest export already stored (live captures don't count: they are not an export).
    const [{ t: newestExport }] = await q.query<{ t: number | null }>(
      `SELECT max((raw->>'update_time')::float8) AS t FROM conversation_versions WHERE conversation_id = $1`,
      [existing.id],
    )
    const storedUpdated = newestExport ? new Date(newestExport * 1000) : null
    if (n.updatedAt && storedUpdated && n.updatedAt < storedUpdated) {
      // An older export than what we already hold: keep it for the record, but don't roll the conversation back.
      const known = await q.query('SELECT 1 FROM conversation_versions WHERE conversation_id = $1 AND content_hash = $2', [
        existing.id,
        n.contentHash,
      ])
      if (known.length === 0) {
        const [{ v }] = await q.query<{ v: number }>(
          'SELECT coalesce(max(version), 0) + 1 AS v FROM conversation_versions WHERE conversation_id = $1',
          [existing.id],
        )
        await insertVersion(q, existing.id, v, batchId, n.contentHash, rawJson)
      }
      await q.query('UPDATE conversations SET last_seen_batch_id = $1, missing_since_batch_id = NULL WHERE id = $2', [
        batchId,
        existing.id,
      ])
      stats.olderVersionsKept++
      return existing.node_count
    }
  }

  let conversationId: number
  let version: number
  if (!existing) {
    version = 1
    const [row] = await q.query<{ id: number }>(
      `INSERT INTO conversations(source_id, external_id, title, created_at, updated_at, current_node_external_id, content_hash,
         version, message_count, node_count, branch_count, model_slugs, is_archived,
         first_seen_batch_id, last_seen_batch_id, last_changed_batch_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13,$13,$13) RETURNING id`,
      [
        sourceId,
        n.externalId,
        n.title,
        iso(n.createdAt),
        iso(n.updatedAt),
        n.currentNodeId,
        n.contentHash,
        n.messageCount,
        n.nodes.length,
        n.branchCount,
        n.modelSlugs,
        n.isArchived,
        batchId,
      ],
    )
    conversationId = row.id
    stats.newConversations++
  } else {
    conversationId = existing.id
    const [{ v }] = await q.query<{ v: number }>(
      'SELECT greatest($2::int, coalesce(max(version), 0)) + 1 AS v FROM conversation_versions WHERE conversation_id = $1',
      [conversationId, existing.version],
    )
    version = v
    await q.query(
      `UPDATE conversations SET title = $1, created_at = $2, updated_at = $3, current_node_external_id = $4, content_hash = $5,
         version = $6, message_count = $7, node_count = $8, branch_count = $9, model_slugs = $10, is_archived = $11,
         last_seen_batch_id = $12, last_changed_batch_id = $12, missing_since_batch_id = NULL
       WHERE id = $13`,
      [
        n.title,
        iso(n.createdAt),
        iso(n.updatedAt),
        n.currentNodeId,
        n.contentHash,
        version,
        n.messageCount,
        n.nodes.length,
        n.branchCount,
        n.modelSlugs,
        n.isArchived,
        batchId,
        conversationId,
      ],
    )
    stats.updatedConversations++
  }
  await insertVersion(q, conversationId, version, batchId, n.contentHash, rawJson)
  await upsertNodes(q, conversationId, batchId, n.nodes, !existing, stats, n.updatedAt)
  await q.query("UPDATE conversations SET origin = 'export' WHERE id = $1", [conversationId])
  await resequenceLiveMessages(q, conversationId)
  await recountMessages(q, conversationId)
  await rebuildChunks(q, conversationId, n.title, n.createdAt)
  await enqueueJob(q, 'process_conversation', { conversationId }, { dedupeKey: `process:${conversationId}` })
  return n.nodes.length
}

function insertVersion(q: Queryable, conversationId: number, version: number, batchId: number, hash: string, rawJson: string) {
  return q.query(
    `INSERT INTO conversation_versions(conversation_id, version, batch_id, content_hash, raw) VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [conversationId, version, batchId, hash, rawJson],
  )
}

const NODE_COLS = [
  'conversation_id',
  'node_external_id',
  'parent_node_external_id',
  'role',
  'author_name',
  'content_type',
  'content_text',
  'created_at',
  'model_slug',
  'is_hidden',
  'is_canonical',
  'canonical_position',
  'depth',
  'sibling_index',
  'sibling_count',
  'content_hash',
  'metadata',
  'first_seen_batch_id',
  'last_changed_batch_id',
] as const

async function upsertNodes(
  q: Queryable,
  conversationId: number,
  batchId: number,
  nodes: NormalizedNode[],
  isNew: boolean,
  stats: ImportStats,
  exportUpdatedAt: Date | null,
): Promise<void> {
  const prior = new Map<string, string>()
  if (!isNew) {
    const rows = await q.query<{ node_external_id: string; content_hash: string }>(
      'SELECT node_external_id, content_hash FROM messages WHERE conversation_id = $1',
      [conversationId],
    )
    for (const r of rows) prior.set(r.node_external_id, r.content_hash)
  }
  for (const node of nodes) {
    const h = prior.get(node.nodeId)
    if (h === undefined) stats.messagesAdded++
    else if (h !== node.contentHash) stats.messagesChanged++
  }

  const BATCH = 200
  for (let i = 0; i < nodes.length; i += BATCH) {
    const slice = nodes.slice(i, i + BATCH)
    const params: unknown[] = []
    const tuples = slice.map((node) => {
      const values = [
        conversationId,
        node.nodeId,
        node.parentId,
        node.role,
        node.authorName,
        node.contentType,
        stripNul(node.text),
        iso(node.createdAt),
        node.modelSlug,
        node.isHidden,
        node.isCanonical,
        node.canonicalPosition,
        node.depth,
        node.siblingIndex,
        node.siblingCount,
        node.contentHash,
        JSON.stringify(node.metadata),
        batchId,
        batchId,
      ]
      const placeholders = values.map((v, j) => {
        params.push(v)
        return NODE_COLS[j] === 'metadata' ? `$${params.length}::jsonb` : `$${params.length}`
      })
      return `(${placeholders.join(',')}, true)`
    })
    await q.query(
      `INSERT INTO messages(${NODE_COLS.join(',')}, present_in_latest) VALUES ${tuples.join(',')}
       ON CONFLICT (conversation_id, node_external_id) DO UPDATE SET
         parent_node_external_id = EXCLUDED.parent_node_external_id, role = EXCLUDED.role, author_name = EXCLUDED.author_name,
         content_type = EXCLUDED.content_type, content_text = EXCLUDED.content_text, created_at = EXCLUDED.created_at,
         model_slug = EXCLUDED.model_slug, is_hidden = EXCLUDED.is_hidden, is_canonical = EXCLUDED.is_canonical,
         canonical_position = EXCLUDED.canonical_position, depth = EXCLUDED.depth, sibling_index = EXCLUDED.sibling_index,
         sibling_count = EXCLUDED.sibling_count, metadata = EXCLUDED.metadata, present_in_latest = true, origin = 'export',
         last_changed_batch_id = CASE WHEN messages.content_hash <> EXCLUDED.content_hash
                                      THEN EXCLUDED.last_changed_batch_id ELSE messages.last_changed_batch_id END,
         content_hash = EXCLUDED.content_hash`,
      params,
    )
  }

  if (!isNew) {
    const ids = nodes.map((nd) => nd.nodeId)
    const gone = await q.query<{ n: number }>(
      `WITH upd AS (
         UPDATE messages SET present_in_latest = false, is_canonical = false, canonical_position = NULL
          WHERE conversation_id = $1 AND present_in_latest AND NOT (node_external_id = ANY($2::text[]))
            -- Live-captured messages newer than this export are not covered by it yet: keep them.
            AND NOT (origin = 'live_capture' AND captured_at > $3::timestamptz)
          RETURNING 1)
       SELECT count(*)::int AS n FROM upd`,
      [conversationId, ids, iso(exportUpdatedAt)],
    )
    stats.messagesNoLongerInSource += gone[0]?.n ?? 0
  }
}

/** Live-captured messages newer than the export continue the thread after the export's last message. */
export async function resequenceLiveMessages(q: Queryable, conversationId: number): Promise<void> {
  await q.query(
    `WITH base AS (
       SELECT coalesce(max(canonical_position), 0) AS b FROM messages
        WHERE conversation_id = $1 AND is_canonical AND origin = 'export'),
     live AS (
       SELECT id, row_number() OVER (ORDER BY canonical_position NULLS LAST, captured_at, id) AS rn FROM messages
        WHERE conversation_id = $1 AND origin = 'live_capture' AND present_in_latest AND is_canonical)
     UPDATE messages m SET canonical_position = base.b + live.rn FROM base, live WHERE m.id = live.id`,
    [conversationId],
  )
}

export async function recountMessages(q: Queryable, conversationId: number): Promise<void> {
  await q.query(
    `UPDATE conversations SET message_count = (
       SELECT count(*) FROM messages WHERE conversation_id = $1 AND is_canonical AND present_in_latest AND NOT is_hidden
          AND role IN ('user', 'assistant', 'tool'))
     WHERE id = $1`,
    [conversationId],
  )
}

export async function rebuildChunks(q: Queryable, conversationId: number, title: string, createdAt: Date | null): Promise<void> {
  await q.query('DELETE FROM chunks WHERE conversation_id = $1', [conversationId])
  const msgs = await q.query<{ id: number; role: string | null; content_text: string }>(
    `SELECT id, role, content_text FROM messages
      WHERE conversation_id = $1 AND is_canonical AND present_in_latest AND NOT is_hidden AND role IN ('user', 'assistant', 'tool')
      ORDER BY canonical_position`,
    [conversationId],
  )
  const chunks = chunkConversation(
    title,
    createdAt,
    msgs.map((m) => ({ id: m.id, role: m.role, text: m.content_text })),
  )
  for (const c of chunks) {
    await q.query(
      'INSERT INTO chunks(conversation_id, message_ids, ordinal, context_header, text) VALUES ($1, $2::int[], $3, $4, $5)',
      [conversationId, c.messageIds, c.ordinal, c.contextHeader, c.text],
    )
  }
}

/**
 * Flags conversations that are absent from this export. Only full ZIP exports that are at least as new as
 * everything stored can say a conversation is gone; nothing is ever deleted locally.
 */
async function markMissing(
  db: Db,
  sourceId: number,
  batchId: number,
  stats: ImportStats,
  exportAsOf: Date | null,
): Promise<number> {
  if (stats.format !== 'zip' || stats.failedConversations > 0 || !exportAsOf) return 0
  const [{ newest }] = await db.query<{ newest: Date | string | null }>(
    'SELECT max(updated_at) AS newest FROM conversations WHERE source_id = $1 AND last_seen_batch_id IS DISTINCT FROM $2',
    [sourceId, batchId],
  )
  if (newest && new Date(newest) > exportAsOf) return 0
  const rows = await db.query<{ n: number }>(
    `WITH upd AS (
       UPDATE conversations SET missing_since_batch_id = $2
        WHERE source_id = $1 AND last_seen_batch_id IS DISTINCT FROM $2 AND missing_since_batch_id IS NULL
        RETURNING 1)
     SELECT count(*)::int AS n FROM upd`,
    [sourceId, batchId],
  )
  return rows[0]?.n ?? 0
}

async function reconcile(db: Db, batchId: number, expectedNodes: Map<string, number>): Promise<Reconciliation> {
  const [row] = await db.query<{ convs: number; nodes: number }>(
    `SELECT count(DISTINCT c.id)::int AS convs, count(m.id)::int AS nodes
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id AND m.present_in_latest AND m.origin = 'export'
      WHERE c.last_seen_batch_id = $1`,
    [batchId],
  )
  const expected = [...expectedNodes.values()].reduce((a, b) => a + b, 0)
  return {
    expectedConversations: expectedNodes.size,
    storedConversations: row.convs,
    expectedNodes: expected,
    storedNodes: row.nodes,
    ok: expectedNodes.size === row.convs && expected === row.nodes,
  }
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null
}

function stripNul(s: string): string {
  return s.includes('\u0000') ? s.replace(/\u0000/g, '') : s
}

/** PostgreSQL text and jsonb cannot hold NUL characters; remove them from string values only. */
function jsonForPostgres(raw: unknown): string {
  const json = JSON.stringify(raw)
  if (!json.includes('\\u0000')) return json
  return JSON.stringify(raw, (_k, v) => (typeof v === 'string' ? stripNul(v) : v))
}
