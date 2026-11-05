import type { Db } from './db/client'
import { normalizeEntityName } from './knowledge/types'
import { search } from './search'

export interface ItemSource {
  type: 'item'
  itemId: number
  kind: string
  status: string
  statement: string
  quote: string
  messageId: number
  conversationId: number
  conversationTitle: string
  externalId: string
  date: string | null
  /** Set when a later item replaces this one. */
  supersededBy: number | null
  contradictedBy: number[]
  possiblyChangedBy: number[]
  origin: string
}

export interface MessageSource {
  type: 'message'
  messageId: number
  conversationId: number
  conversationTitle: string
  externalId: string
  role: string | null
  date: string | null
  text: string
  truncated: boolean
  origin: string
}

export type Source = (ItemSource | MessageSource) & { n: number }

export interface RetrievalScope {
  query: string
  entityIds?: number[]
  from?: string | null
  to?: string | null
  maxItems?: number
  maxMessages?: number
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null)

/** Recognises "last 6 months", "past two weeks", "this year" in a question. */
export function parseTimeWindow(q: string, now = new Date()): { from: string | null } {
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 }
  const m = q.toLowerCase().match(/\b(?:last|past|previous)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)?\s*(day|week|month|year)s?\b/)
  if (m) {
    const n = m[1] ? Number(m[1]) || words[m[1]] : 1
    const d = new Date(now)
    if (m[2] === 'day') d.setDate(d.getDate() - n)
    if (m[2] === 'week') d.setDate(d.getDate() - 7 * n)
    if (m[2] === 'month') d.setMonth(d.getMonth() - n)
    if (m[2] === 'year') d.setFullYear(d.getFullYear() - n)
    return { from: d.toISOString().slice(0, 10) }
  }
  if (/\bthis year\b/i.test(q)) return { from: `${now.getFullYear()}-01-01` }
  return { from: null }
}

/** Entities whose name (or alias) appears in the text, longest names first. */
export async function detectEntities(db: Db, text: string): Promise<{ id: number; name: string; kind: string }[]> {
  const normText = normalizeEntityName(text)
  const rows = await db.query<{ id: number; name: string; kind: string; norm_name: string; aliases: string[] }>(
    `SELECT e.id, e.name, e.kind, e.norm_name, e.aliases FROM entities e
      WHERE length(e.norm_name) >= 3 AND EXISTS (SELECT 1 FROM conversation_entities ce WHERE ce.entity_id = e.id)`,
  )
  // Word-level match to avoid "go" matching inside "google".
  const tokens = new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).map(normalizeEntityName).filter(Boolean))
  return rows
    .filter((e) => [e.norm_name, ...(e.aliases ?? [])].some((n) => tokens.has(n) || (n.length >= 6 && normText.includes(n))))
    .sort((a, b) => b.norm_name.length - a.norm_name.length)
    .map(({ id, name, kind }) => ({ id, name, kind }))
}

/**
 * Collects the evidence for a question or document: knowledge items (with their status and whether something
 * later replaced or contradicts them) and the most relevant original messages. Sources are numbered S1..Sn.
 */
export async function retrieve(db: Db, scope: RetrievalScope): Promise<Source[]> {
  const maxItems = scope.maxItems ?? 50
  const maxMessages = scope.maxMessages ?? 20
  const params: unknown[] = [scope.entityIds ?? [], scope.query, scope.from ?? null, scope.to ?? null, maxItems]
  const items = await db.query<{
    id: number
    kind: string
    status: string
    statement: string
    quote: string
    message_id: number
    conversation_id: number
    title: string
    external_id: string
    effective_at: Date | null
    origin: string
    superseded_by: number | null
    contradicted_by: number[] | null
    possibly_changed_by: number[] | null
  }>(
    `WITH tq AS (SELECT CASE WHEN websearch_to_tsquery('english', $2)::text = '' THEN NULL
                        ELSE replace(websearch_to_tsquery('english', $2)::text, ' & ', ' | ')::tsquery END AS q)
     SELECT k.id, k.kind, k.status, k.statement, ev.quote, ev.message_id, k.conversation_id, c.title, c.external_id,
            k.effective_at, m.origin,
            (SELECT r.from_item FROM item_relations r WHERE r.to_item = k.id AND r.type = 'supersedes' LIMIT 1) AS superseded_by,
            (SELECT array_agg(CASE WHEN r.to_item = k.id THEN r.from_item ELSE r.to_item END) FROM item_relations r
              WHERE r.type = 'contradicts' AND (r.to_item = k.id OR r.from_item = k.id)) AS contradicted_by,
            (SELECT array_agg(r.from_item) FROM item_relations r WHERE r.to_item = k.id AND r.type = 'possibly_changes') AS possibly_changed_by
       FROM knowledge_items k
       JOIN evidence ev ON ev.item_id = k.id
       JOIN messages m ON m.id = ev.message_id
       JOIN conversations c ON c.id = k.conversation_id, tq
      WHERE (EXISTS (SELECT 1 FROM item_entities ie WHERE ie.item_id = k.id AND ie.entity_id = ANY($1::int[]))
             OR (tq.q IS NOT NULL AND k.tsv @@ tq.q
                 -- When the question names a project, keyword matches must come from that project's conversations.
                 AND (cardinality($1::int[]) = 0 OR EXISTS (SELECT 1 FROM conversation_entities ce
                       WHERE ce.conversation_id = k.conversation_id AND ce.entity_id = ANY($1::int[])))))
        AND ($3::date IS NULL OR k.effective_at >= $3::date)
        AND ($4::date IS NULL OR k.effective_at < $4::date + 1)
      ORDER BY (EXISTS (SELECT 1 FROM item_entities ie WHERE ie.item_id = k.id AND ie.entity_id = ANY($1::int[]))) DESC,
               CASE WHEN tq.q IS NOT NULL THEN ts_rank_cd(k.tsv, tq.q) ELSE 0 END DESC,
               k.effective_at DESC NULLS LAST
      LIMIT $5`,
    params,
  )

  let { hits } = await search(db, { q: scope.query, from: scope.from, to: scope.to, limit: maxMessages * 4 })
  if (scope.entityIds?.length) {
    const inScope = new Set(
      (
        await db.query<{ conversation_id: number }>('SELECT DISTINCT conversation_id FROM conversation_entities WHERE entity_id = ANY($1::int[])', [
          scope.entityIds,
        ])
      ).map((r) => r.conversation_id),
    )
    hits = hits.filter((h) => inScope.has(h.conversationId))
  }
  const evidenceIds = new Set(items.map((i) => i.message_id))
  const msgIds = hits.map((h) => h.messageId).filter((id) => !evidenceIds.has(id)).slice(0, maxMessages)
  const messages = msgIds.length
    ? await db.query<{
        id: number
        conversation_id: number
        title: string
        external_id: string
        role: string | null
        created_at: Date | null
        content_text: string
        origin: string
      }>(
        `SELECT m.id, m.conversation_id, c.title, c.external_id, m.role, m.created_at, m.content_text, m.origin
           FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ANY($1::int[])`,
        [msgIds],
      )
    : []
  const msgById = new Map(messages.map((m) => [m.id, m]))

  const sources: Source[] = []
  for (const i of items) {
    sources.push({
      n: sources.length + 1,
      type: 'item',
      itemId: i.id,
      kind: i.kind,
      status: i.status,
      statement: i.statement,
      quote: i.quote,
      messageId: i.message_id,
      conversationId: i.conversation_id,
      conversationTitle: i.title,
      externalId: i.external_id,
      date: iso(i.effective_at),
      supersededBy: i.superseded_by,
      contradictedBy: i.contradicted_by ?? [],
      possiblyChangedBy: i.possibly_changed_by ?? [],
      origin: i.origin,
    })
  }
  for (const id of msgIds) {
    const m = msgById.get(id)
    if (!m) continue
    const LIMIT = 2500
    sources.push({
      n: sources.length + 1,
      type: 'message',
      messageId: m.id,
      conversationId: m.conversation_id,
      conversationTitle: m.title,
      externalId: m.external_id,
      role: m.role,
      date: iso(m.created_at),
      text: m.content_text.length > LIMIT ? m.content_text.slice(0, LIMIT) : m.content_text,
      truncated: m.content_text.length > LIMIT,
      origin: m.origin,
    })
  }
  return sources
}

/** Item ids → source numbers, so "superseded by item 42" can be shown as "superseded by S7". */
export function itemNumberMap(sources: Source[]): Map<number, number> {
  return new Map(sources.filter((s): s is ItemSource & { n: number } => s.type === 'item').map((s) => [s.itemId, s.n]))
}

export function sourceLink(s: { conversationId: number; messageId: number }): string {
  return `/conversations/${s.conversationId}#m-${s.messageId}`
}
