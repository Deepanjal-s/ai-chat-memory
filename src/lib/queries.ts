import type { Db } from './db/client'
import type { ImportStats } from './importer/import'

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null)

export async function dashboardStats(db: Db) {
  const [totals] = await db.query<{
    conversations: number
    messages: number
    first: Date | null
    last: Date | null
    missing: number
    chunks: number
    embedded: number
  }>(`SELECT
        (SELECT count(*) FROM conversations)::int AS conversations,
        (SELECT count(*) FROM messages WHERE role IN ('user','assistant') AND NOT is_hidden AND present_in_latest)::int AS messages,
        (SELECT min(created_at) FROM conversations) AS first,
        (SELECT max(updated_at) FROM conversations) AS last,
        (SELECT count(*) FROM conversations WHERE missing_since_batch_id IS NOT NULL)::int AS missing,
        (SELECT count(*) FROM chunks)::int AS chunks,
        (SELECT count(*) FROM chunks WHERE embedding IS NOT NULL)::int AS embedded`)
  const perMonth = await db.query<{ month: string; n: number }>(
    `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, count(*)::int AS n
       FROM conversations WHERE created_at IS NOT NULL
      GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
  )
  return { ...totals, first: iso(totals.first), last: iso(totals.last), perMonth: perMonth.reverse() }
}

/** When the archive was last brought up to date by an official export, and how old that is. */
export async function exportFreshness(db: Db, reminderDays: number) {
  const [row] = await db.query<{ finished_at: Date | string | null; export_as_of: string | null }>(
    `SELECT finished_at, stats->>'exportAsOf' AS export_as_of FROM import_batches
      WHERE status IN ('complete', 'complete_with_errors') ORDER BY finished_at DESC NULLS LAST LIMIT 1`,
  )
  const lastImportAt = iso(row?.finished_at ?? null)
  const ageDays = lastImportAt ? Math.floor((Date.now() - Date.parse(lastImportAt)) / 86_400_000) : null
  return {
    lastImportAt,
    exportAsOf: row?.export_as_of ?? null,
    ageDays,
    stale: ageDays === null || ageDays >= reminderDays,
  }
}

export async function recentWatchedFiles(db: Db, limit = 8) {
  const rows = await db.query<{ path: string; status: string; batch_id: number | null; error: string | null; checked_at: Date }>(
    `SELECT path, status, batch_id, error, checked_at FROM watched_files
      WHERE status <> 'not_export' ORDER BY checked_at DESC LIMIT $1`,
    [limit],
  )
  return rows.map((r) => ({ ...r, checked_at: iso(r.checked_at) }))
}

export interface ConversationListItem {
  id: number
  title: string
  createdAt: string | null
  updatedAt: string | null
  messageCount: number
  branchCount: number
  missing: boolean
  isArchived: boolean
}

export async function listConversations(
  db: Db,
  opts: { q?: string; page?: number; pageSize?: number; sort?: 'updated' | 'created' | 'title' },
): Promise<{ items: ConversationListItem[]; total: number }> {
  const pageSize = opts.pageSize ?? 50
  const page = Math.max(1, opts.page ?? 1)
  const order = { updated: 'updated_at DESC NULLS LAST', created: 'created_at DESC NULLS LAST', title: 'lower(title) ASC' }[
    opts.sort ?? 'updated'
  ]
  const where = opts.q ? 'WHERE title ILIKE $3' : ''
  const params: unknown[] = [pageSize, (page - 1) * pageSize]
  if (opts.q) params.push(`%${opts.q.replace(/[\\%_]/g, (c) => '\\' + c)}%`)
  const rows = await db.query<{
    id: number
    title: string
    created_at: Date | null
    updated_at: Date | null
    message_count: number
    branch_count: number
    missing_since_batch_id: number | null
    is_archived: boolean
    total: number
  }>(
    `SELECT id, title, created_at, updated_at, message_count, branch_count, missing_since_batch_id, is_archived,
            count(*) OVER ()::int AS total
       FROM conversations ${where} ORDER BY ${order} LIMIT $1 OFFSET $2`,
    params,
  )
  return {
    total: rows[0]?.total ?? (page > 1 ? (await listConversations(db, { ...opts, page: 1 })).total : 0),
    items: rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
      messageCount: r.message_count,
      branchCount: r.branch_count,
      missing: r.missing_since_batch_id !== null,
      isArchived: r.is_archived,
    })),
  }
}

export interface ReaderMessage {
  id: number
  nodeId: string
  parentNodeId: string | null
  role: string | null
  authorName: string | null
  contentType: string | null
  text: string
  createdAt: string | null
  modelSlug: string | null
  isHidden: boolean
  isCanonical: boolean
  siblingIndex: number
  siblingCount: number
  presentInLatest: boolean
  metadata: Record<string, unknown>
}

export async function getConversation(db: Db, id: number) {
  const [c] = await db.query<{
    id: number
    external_id: string
    title: string
    created_at: Date | null
    updated_at: Date | null
    version: number
    message_count: number
    node_count: number
    branch_count: number
    model_slugs: string[]
    is_archived: boolean
    missing_since_batch_id: number | null
    first_seen_batch_id: number | null
    last_changed_batch_id: number | null
    source_label: string
  }>(
    `SELECT c.*, s.label AS source_label FROM conversations c JOIN sources s ON s.id = c.source_id WHERE c.id = $1`,
    [id],
  )
  if (!c) return null
  const rows = await db.query<{
    id: number
    node_external_id: string
    parent_node_external_id: string | null
    role: string | null
    author_name: string | null
    content_type: string | null
    content_text: string
    created_at: Date | null
    model_slug: string | null
    is_hidden: boolean
    is_canonical: boolean
    sibling_index: number
    sibling_count: number
    present_in_latest: boolean
    metadata: Record<string, unknown>
    canonical_position: number | null
  }>(
    `SELECT id, node_external_id, parent_node_external_id, role, author_name, content_type, content_text, created_at,
            model_slug, is_hidden, is_canonical, sibling_index, sibling_count, present_in_latest, metadata, canonical_position
       FROM messages WHERE conversation_id = $1
      ORDER BY canonical_position NULLS LAST, created_at NULLS FIRST, id`,
    [id],
  )
  const toMsg = (r: (typeof rows)[number]): ReaderMessage => ({
    id: r.id,
    nodeId: r.node_external_id,
    parentNodeId: r.parent_node_external_id,
    role: r.role,
    authorName: r.author_name,
    contentType: r.content_type,
    text: r.content_text,
    createdAt: iso(r.created_at),
    modelSlug: r.model_slug,
    isHidden: r.is_hidden,
    isCanonical: r.is_canonical,
    siblingIndex: r.sibling_index,
    siblingCount: r.sibling_count,
    presentInLatest: r.present_in_latest,
    metadata: r.metadata ?? {},
  })
  const versions = await db.query<{ version: number; batch_id: number; created_at: Date }>(
    'SELECT version, batch_id, created_at FROM conversation_versions WHERE conversation_id = $1 ORDER BY version',
    [id],
  )
  return {
    id: c.id,
    externalId: c.external_id,
    title: c.title,
    createdAt: iso(c.created_at),
    updatedAt: iso(c.updated_at),
    version: c.version,
    messageCount: c.message_count,
    nodeCount: c.node_count,
    branchCount: c.branch_count,
    modelSlugs: c.model_slugs ?? [],
    isArchived: c.is_archived,
    missing: c.missing_since_batch_id !== null,
    sourceLabel: c.source_label,
    canonical: rows.filter((r) => r.is_canonical).map(toMsg),
    offPath: rows.filter((r) => !r.is_canonical).map(toMsg),
    versions: versions.map((v) => ({ version: v.version, batchId: v.batch_id, createdAt: iso(v.created_at) })),
  }
}

export type ConversationDetail = NonNullable<Awaited<ReturnType<typeof getConversation>>>

export interface BatchRow {
  id: number
  sourceLabel: string
  originalFilename: string
  fileSha256: string
  fileSize: number
  status: string
  origin: string
  duplicateOf: number | null
  uploadedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  stats: Partial<ImportStats>
  error: string | null
}

function toBatch(r: Record<string, unknown>): BatchRow {
  return {
    id: r.id as number,
    sourceLabel: r.source_label as string,
    originalFilename: r.original_filename as string,
    fileSha256: r.file_sha256 as string,
    fileSize: Number(r.file_size),
    status: r.status as string,
    origin: (r.origin as string | undefined) ?? 'upload',
    duplicateOf: (r.duplicate_of as number | null) ?? null,
    uploadedAt: iso(r.uploaded_at as Date | null),
    startedAt: iso(r.started_at as Date | null),
    finishedAt: iso(r.finished_at as Date | null),
    stats: (r.stats as Partial<ImportStats>) ?? {},
    error: (r.error as string | null) ?? null,
  }
}

export async function listBatches(db: Db, limit = 50): Promise<BatchRow[]> {
  const rows = await db.query(
    `SELECT b.*, s.label AS source_label FROM import_batches b JOIN sources s ON s.id = b.source_id ORDER BY b.id DESC LIMIT $1`,
    [limit],
  )
  return rows.map(toBatch)
}

export async function getBatch(db: Db, id: number) {
  const [row] = await db.query(
    `SELECT b.*, s.label AS source_label FROM import_batches b JOIN sources s ON s.id = b.source_id WHERE b.id = $1`,
    [id],
  )
  if (!row) return null
  const issues = await db.query<{ severity: string; conversation_external_id: string | null; message: string }>(
    `SELECT severity, conversation_external_id, message FROM import_issues WHERE batch_id = $1
      ORDER BY CASE severity WHEN 'error' THEN 0 ELSE 1 END, id LIMIT 500`,
    [id],
  )
  const [{ n: issueCount }] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM import_issues WHERE batch_id = $1', [id])
  return { batch: toBatch(row), issues, issueCount }
}
