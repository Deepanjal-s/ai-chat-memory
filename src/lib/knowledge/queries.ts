import type { Db } from '../db/client'

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null)

export interface ItemView {
  id: number
  kind: string
  status: string
  statement: string
  quote: string
  messageId: number
  conversationId: number
  conversationTitle: string
  date: string | null
  due: string | null
  extractor: string
  origin: string
  supersededBy: { id: number; statement: string; conversationId: number; messageId: number } | null
  contradicts: { id: number; statement: string; conversationId: number; messageId: number }[]
  possiblyChangedBy: { id: number; statement: string; conversationId: number; messageId: number; explanation: string | null }[]
}

const ITEM_SELECT = `
  SELECT k.id, k.kind, k.status, k.statement, ev.quote, ev.message_id, k.conversation_id, c.title, k.effective_at, k.due_text,
         k.extractor, m.origin,
         (SELECT json_build_object('id', o.id, 'statement', o.statement, 'conversationId', o.conversation_id,
                                   'messageId', (SELECT message_id FROM evidence WHERE item_id = o.id LIMIT 1))
            FROM item_relations r JOIN knowledge_items o ON o.id = r.from_item
           WHERE r.to_item = k.id AND r.type = 'supersedes' LIMIT 1) AS superseded_by,
         (SELECT coalesce(json_agg(json_build_object('id', o.id, 'statement', o.statement, 'conversationId', o.conversation_id,
                                   'messageId', (SELECT message_id FROM evidence WHERE item_id = o.id LIMIT 1))), '[]'::json)
            FROM item_relations r JOIN knowledge_items o ON o.id = CASE WHEN r.to_item = k.id THEN r.from_item ELSE r.to_item END
           WHERE r.type = 'contradicts' AND (r.to_item = k.id OR r.from_item = k.id)) AS contradicts,
         (SELECT coalesce(json_agg(json_build_object('id', o.id, 'statement', o.statement, 'conversationId', o.conversation_id,
                                   'messageId', (SELECT message_id FROM evidence WHERE item_id = o.id LIMIT 1), 'explanation', r.explanation)), '[]'::json)
            FROM item_relations r JOIN knowledge_items o ON o.id = r.from_item
           WHERE r.to_item = k.id AND r.type = 'possibly_changes') AS possibly_changed_by
    FROM knowledge_items k
    JOIN evidence ev ON ev.item_id = k.id
    JOIN messages m ON m.id = ev.message_id
    JOIN conversations c ON c.id = k.conversation_id`

type ItemRow = {
  id: number
  kind: string
  status: string
  statement: string
  quote: string
  message_id: number
  conversation_id: number
  title: string
  effective_at: Date | null
  due_text: string | null
  extractor: string
  origin: string
  superseded_by: ItemView['supersededBy']
  contradicts: ItemView['contradicts']
  possibly_changed_by: ItemView['possiblyChangedBy']
}

const toItem = (r: ItemRow): ItemView => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  statement: r.statement,
  quote: r.quote,
  messageId: r.message_id,
  conversationId: r.conversation_id,
  conversationTitle: r.title,
  date: iso(r.effective_at),
  due: r.due_text,
  extractor: r.extractor,
  origin: r.origin,
  supersededBy: r.superseded_by ?? null,
  contradicts: r.contradicts ?? [],
  possiblyChangedBy: r.possibly_changed_by ?? [],
})

export async function listEntities(db: Db, opts: { q?: string; kind?: string } = {}) {
  const rows = await db.query<{ id: number; name: string; kind: string; conversations: number; items: number; open_tasks: number; last_activity: Date | null; first_activity: Date | null }>(
    `SELECT e.id, e.name, e.kind,
            count(DISTINCT ce.conversation_id)::int AS conversations,
            (SELECT count(*)::int FROM item_entities ie WHERE ie.entity_id = e.id) AS items,
            (SELECT count(*)::int FROM item_entities ie JOIN knowledge_items k ON k.id = ie.item_id
              WHERE ie.entity_id = e.id AND k.kind = 'task' AND k.status = 'open'
                AND NOT EXISTS (SELECT 1 FROM item_relations r WHERE r.to_item = k.id AND r.type = 'supersedes')) AS open_tasks,
            max(c.updated_at) AS last_activity, min(c.created_at) AS first_activity
       FROM entities e
       JOIN conversation_entities ce ON ce.entity_id = e.id
       JOIN conversations c ON c.id = ce.conversation_id
      WHERE ($1::text IS NULL OR e.name ILIKE '%' || $1 || '%') AND ($2::text IS NULL OR e.kind = $2)
      GROUP BY e.id
      ORDER BY CASE e.kind WHEN 'project' THEN 0 WHEN 'organization' THEN 1 WHEN 'product' THEN 2 ELSE 3 END,
               count(DISTINCT ce.conversation_id) DESC, max(c.updated_at) DESC NULLS LAST
      LIMIT 300`,
    [opts.q || null, opts.kind || null],
  )
  return rows.map((r) => ({ ...r, last_activity: iso(r.last_activity), first_activity: iso(r.first_activity) }))
}

export async function getEntity(db: Db, id: number) {
  const [e] = await db.query<{ id: number; name: string; kind: string }>('SELECT id, name, kind FROM entities WHERE id = $1', [id])
  if (!e) return null
  const conversations = await db.query<{ id: number; title: string; created_at: Date | null; updated_at: Date | null; summary: string | null; message_count: number; mentions: number }>(
    `SELECT c.id, c.title, c.created_at, c.updated_at, c.summary, c.message_count, ce.mentions
       FROM conversation_entities ce JOIN conversations c ON c.id = ce.conversation_id
      WHERE ce.entity_id = $1 ORDER BY c.created_at NULLS LAST, c.id`,
    [id],
  )
  const items = (await db.query<ItemRow>(`${ITEM_SELECT} JOIN item_entities ie ON ie.item_id = k.id WHERE ie.entity_id = $1 ORDER BY k.effective_at NULLS LAST, k.id`, [id])).map(toItem)
  const related = await db.query<{ id: number; name: string; kind: string; shared: number }>(
    `SELECT e2.id, e2.name, e2.kind, count(*)::int AS shared
       FROM conversation_entities a JOIN conversation_entities b ON b.conversation_id = a.conversation_id AND b.entity_id <> a.entity_id
       JOIN entities e2 ON e2.id = b.entity_id
      WHERE a.entity_id = $1 GROUP BY e2.id ORDER BY shared DESC, e2.name LIMIT 20`,
    [id],
  )
  return {
    entity: e,
    conversations: conversations.map((c) => ({ ...c, created_at: iso(c.created_at), updated_at: iso(c.updated_at) })),
    items,
    related,
  }
}

export async function conversationKnowledge(db: Db, conversationId: number) {
  const [c] = await db.query<{ summary: string | null; processed_at: Date | null; processed_by: string | null }>(
    'SELECT summary, processed_at, processed_by FROM conversations WHERE id = $1',
    [conversationId],
  )
  const items = (await db.query<ItemRow>(`${ITEM_SELECT} WHERE k.conversation_id = $1 ORDER BY k.effective_at NULLS LAST, k.id`, [conversationId])).map(toItem)
  const entities = await db.query<{ id: number; name: string; kind: string }>(
    `SELECT e.id, e.name, e.kind FROM conversation_entities ce JOIN entities e ON e.id = ce.entity_id
      WHERE ce.conversation_id = $1 ORDER BY CASE e.kind WHEN 'project' THEN 0 ELSE 1 END, ce.mentions DESC`,
    [conversationId],
  )
  // Related = shares projects/topics; weighted so a shared project counts more than a shared technology.
  const related = await db.query<{ id: number; title: string; updated_at: Date | null; shared: string[]; score: number }>(
    `SELECT c.id, c.title, c.updated_at, array_agg(DISTINCT e.name) AS shared,
            sum(CASE e.kind WHEN 'project' THEN 3 WHEN 'organization' THEN 2 WHEN 'product' THEN 2 WHEN 'person' THEN 2 ELSE 1 END)::int AS score
       FROM conversation_entities a
       JOIN conversation_entities b ON b.entity_id = a.entity_id AND b.conversation_id <> a.conversation_id
       JOIN entities e ON e.id = a.entity_id
       JOIN conversations c ON c.id = b.conversation_id
      WHERE a.conversation_id = $1
      GROUP BY c.id ORDER BY score DESC, c.updated_at DESC NULLS LAST LIMIT 8`,
    [conversationId],
  )
  return {
    summary: c?.summary ?? null,
    processedAt: iso(c?.processed_at ?? null),
    processedBy: c?.processed_by ?? null,
    items,
    entities,
    related: related.map((r) => ({ ...r, updated_at: iso(r.updated_at) })),
  }
}

export async function knowledgeOverview(db: Db) {
  const [counts] = await db.query<{ items: number; decisions: number; open_tasks: number; changes: number; projects: number; processed: number; total: number }>(
    `SELECT (SELECT count(*) FROM knowledge_items)::int AS items,
            (SELECT count(*) FROM knowledge_items WHERE kind = 'decision' AND status = 'confirmed')::int AS decisions,
            (SELECT count(*) FROM knowledge_items k WHERE kind = 'task' AND status = 'open'
               AND NOT EXISTS (SELECT 1 FROM item_relations r WHERE r.to_item = k.id AND r.type = 'supersedes'))::int AS open_tasks,
            (SELECT count(*) FROM item_relations)::int AS changes,
            (SELECT count(*) FROM entities e WHERE kind = 'project' AND EXISTS (SELECT 1 FROM conversation_entities ce WHERE ce.entity_id = e.id))::int AS projects,
            (SELECT count(*) FROM conversations WHERE processed_at IS NOT NULL)::int AS processed,
            (SELECT count(*) FROM conversations)::int AS total`,
  )
  const recentDecisions = (await db.query<ItemRow>(`${ITEM_SELECT} WHERE k.kind = 'decision' AND k.status = 'confirmed' ORDER BY k.effective_at DESC NULLS LAST LIMIT 6`)).map(toItem)
  const openTasks = (
    await db.query<ItemRow>(
      `${ITEM_SELECT} WHERE ((k.kind = 'task' AND k.status = 'open') OR k.kind = 'deadline')
         AND NOT EXISTS (SELECT 1 FROM item_relations r WHERE r.to_item = k.id AND r.type = 'supersedes')
       ORDER BY k.effective_at DESC NULLS LAST LIMIT 6`,
    )
  ).map(toItem)
  return { counts, recentDecisions, openTasks }
}

export async function listItems(db: Db, opts: { kind?: string; status?: string; limit?: number }) {
  return (
    await db.query<ItemRow>(
      `${ITEM_SELECT} WHERE ($1::text IS NULL OR k.kind = $1) AND ($2::text IS NULL OR k.status = $2)
       ORDER BY k.effective_at DESC NULLS LAST, k.id DESC LIMIT $3`,
      [opts.kind || null, opts.status || null, opts.limit ?? 200],
    )
  ).map(toItem)
}
