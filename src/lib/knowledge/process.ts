import { z } from 'zod'
import type { Llm } from '../ai/llm'
import type { Db, Queryable } from '../db/client'
import { sha256 } from '../hash'
import { enqueueJob } from '../jobs'
import { log } from '../logger'
import { heuristicExtract } from './heuristic'
import { llmExtract } from './llm-extract'
import { normalizeEntityName, verifyQuote, type Extraction, type SourceMessage } from './types'

export interface ProcessResult {
  skipped: boolean
  items: number
  rejectedQuotes: number
  entities: number
  relations: number
  extractor: string
}

/**
 * Builds the knowledge record for one conversation: summary, entities, verified items, and links to items in
 * other conversations that it changes or contradicts. Re-running replaces the conversation's previous record,
 * and is skipped when the conversation content and extractor are unchanged.
 */
export async function processConversation(db: Db, conversationId: number, llm: Llm | null, opts: { force?: boolean } = {}): Promise<ProcessResult> {
  const extractor = llm ? `${llm.provider}:${llm.model}` : 'rules-v1'
  const [conv] = await db.query<{ id: number; title: string; content_hash: string; processed_hash: string | null; processed_by: string | null }>(
    'SELECT id, title, content_hash, processed_hash, processed_by FROM conversations WHERE id = $1',
    [conversationId],
  )
  if (!conv) throw new Error(`Conversation ${conversationId} not found`)

  const rows = await db.query<{ id: number; role: string; content_text: string; created_at: Date | string | null }>(
    `SELECT id, role, content_text, created_at FROM messages
      WHERE conversation_id = $1 AND is_canonical AND present_in_latest AND role IN ('user','assistant')
        AND NOT is_hidden AND content_text <> ''
      ORDER BY canonical_position, id`,
    [conversationId],
  )
  const messages: SourceMessage[] = rows.map((r) => ({
    id: r.id,
    role: r.role,
    text: r.content_text,
    createdAt: r.created_at ? new Date(r.created_at) : null,
  }))
  const stateHash = sha256(`${conv.content_hash}|${messages.map((m) => `${m.id}:${sha256(m.text)}`).join(',')}`)
  if (!opts.force && conv.processed_hash === stateHash && conv.processed_by === extractor) {
    return { skipped: true, items: 0, rejectedQuotes: 0, entities: 0, relations: 0, extractor }
  }

  let extraction: Extraction
  if (llm) {
    const known = await db.query<{ name: string }>(
      `SELECT e.name FROM entities e JOIN conversation_entities ce ON ce.entity_id = e.id
        GROUP BY e.id, e.name ORDER BY count(*) DESC LIMIT 150`,
    )
    extraction = await llmExtract(llm, conv.title, messages, known.map((k) => k.name))
  } else {
    extraction = heuristicExtract(conv.title, messages)
  }

  const byId = new Map(messages.map((m) => [m.id, m]))
  const verified = extraction.items.filter((it) => verifyQuote(it, byId))
  const rejectedQuotes = extraction.items.length - verified.length
  if (rejectedQuotes) log('warn', 'extraction_quotes_rejected', { conversationId, rejected: rejectedQuotes, kept: verified.length })

  const result = await db.tx(async (q) => {
    await q.query('DELETE FROM knowledge_items WHERE conversation_id = $1', [conversationId])
    await q.query('DELETE FROM conversation_entities WHERE conversation_id = $1', [conversationId])

    // Entities: one row per normalised name, shared by all conversations.
    const entityIds = new Map<string, number>()
    const counts = new Map<number, number>()
    const names = [...extraction.entities, ...verified.flatMap((i) => i.entities.map((n) => ({ name: n, kind: 'topic' as const })))]
    const mentioned = mentionChecker(`${conv.title}\n${messages.map((m) => m.text).join('\n')}`)
    for (const e of names) {
      const norm = normalizeEntityName(e.name)
      if (!norm || norm.length < 2) continue
      // Never link a conversation to a project/person/technology it does not actually name (prevents project mixing).
      if (!mentioned(e.name)) continue
      let id = entityIds.get(norm)
      if (!id) {
        id = await upsertEntity(q, e.name.trim(), e.kind, norm)
        entityIds.set(norm, id)
      }
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    for (const [entityId, n] of counts) {
      await q.query('INSERT INTO conversation_entities(conversation_id, entity_id, mentions) VALUES ($1,$2,$3)', [conversationId, entityId, n])
    }

    // Items with their evidence. Exact duplicates within the conversation are collapsed.
    const seen = new Set<string>()
    const newItemIds: number[] = []
    for (const it of verified) {
      const key = `${it.kind}|${it.status}|${it.statement.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      const msg = byId.get(it.message_id)!
      const [row] = await q.query<{ id: number }>(
        `INSERT INTO knowledge_items(conversation_id, kind, status, statement, effective_at, due_text, confidence, extractor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [conversationId, it.kind, it.status, it.statement.trim(), msg.createdAt?.toISOString() ?? null, it.due, llm ? 0.8 : 0.5, extractor],
      )
      await q.query('INSERT INTO evidence(item_id, message_id, quote) VALUES ($1,$2,$3)', [row.id, msg.id, it.quote.trim()])
      for (const name of new Set(it.entities)) {
        const id = entityIds.get(normalizeEntityName(name))
        if (id) await q.query('INSERT INTO item_entities(item_id, entity_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [row.id, id])
      }
      newItemIds.push(row.id)
    }

    await q.query(
      'UPDATE conversations SET summary = $1, processed_hash = $2, processed_at = now(), processed_by = $3 WHERE id = $4',
      [extraction.summary.slice(0, 4000), stateHash, extractor, conversationId],
    )
    return { newItemIds, entities: counts.size }
  })

  // Change detection is a separate step: if it fails, the extracted record is kept and only this step is retried.
  let relations = 0
  try {
    relations = await detectRelations(db, result.newItemIds, llm)
  } catch (e) {
    log('warn', 'change_detection_deferred', { conversationId, error: (e as Error).message })
    await enqueueJob(db, 'detect_changes', { conversationId }, { dedupeKey: `changes:${conversationId}`, delaySeconds: 120 })
  }
  return { skipped: false, items: result.newItemIds.length, rejectedQuotes, entities: result.entities, relations, extractor }
}

/** Re-runs change detection for a conversation's current items (used when the first attempt failed). */
export async function detectChangesForConversation(db: Db, conversationId: number, llm: Llm | null): Promise<number> {
  const rows = await db.query<{ id: number }>('SELECT id FROM knowledge_items WHERE conversation_id = $1', [conversationId])
  return detectRelations(
    db,
    rows.map((r) => r.id),
    llm,
  )
}

/**
 * Returns a test for whether a name occurs in the text, ignoring case, spacing and punctuation
 * ("VK7 Sports" matches "vk7sports"). Short names must match whole words so "AWS" does not match "laws".
 */
export function mentionChecker(text: string): (name: string) => boolean {
  const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const squashed = tokens.join('')
  const grams = new Set<string>()
  for (let i = 0; i < tokens.length; i++) {
    let joined = ''
    for (let k = i; k < Math.min(i + 4, tokens.length); k++) {
      joined += tokens[k]
      grams.add(joined)
    }
  }
  return (name: string) => {
    const n = normalizeEntityName(name)
    if (!n) return false
    return n.length >= 6 ? squashed.includes(n) : grams.has(n)
  }
}

async function upsertEntity(q: Queryable, name: string, kind: string, norm: string): Promise<number> {
  const [existing] = await q.query<{ id: number; kind: string }>(
    'SELECT id, kind FROM entities WHERE norm_name = $1 OR $1 = ANY(aliases) LIMIT 1',
    [norm],
  )
  if (existing) {
    // A specific kind (project, technology…) wins over the generic 'topic'.
    if (existing.kind === 'topic' && kind !== 'topic') await q.query('UPDATE entities SET kind = $1 WHERE id = $2', [kind, existing.id])
    return existing.id
  }
  const [row] = await q.query<{ id: number }>('INSERT INTO entities(kind, name, norm_name) VALUES ($1,$2,$3) RETURNING id', [kind, name, norm])
  return row.id
}

// ---- Change and conflict detection across conversations ----------------------------------

const COMPARABLE_KINDS = ['decision', 'requirement', 'task', 'preference', 'deadline']

interface Candidate {
  a: number
  b: number
  a_statement: string
  b_statement: string
  a_status: string
  b_status: string
  a_kind: string
  a_at: Date | string | null
  b_at: Date | string | null
}

const JudgeSchema = z.object({
  pairs: z.array(
    z.object({
      pair: z.number().int(),
      relation: z.enum(['supersedes', 'contradicts', 'same', 'unrelated']),
      explanation: z.string(),
    }),
  ),
})
const JUDGE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pairs'],
  properties: {
    pairs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['pair', 'relation', 'explanation'],
        properties: {
          pair: { type: 'integer' },
          relation: { type: 'string', enum: ['supersedes', 'contradicts', 'same', 'unrelated'] },
          explanation: { type: 'string' },
        },
      },
    },
  },
}

/**
 * Compares new items with items about the same entity in other conversations. The later item of a pair
 * 'supersedes' the earlier one when it replaces it, or they 'contradict' when they cannot both hold.
 * With an AI provider, an LLM judges each candidate pair; without one, a cautious word-overlap rule only
 * flags 'possibly_changes' for human review and never marks anything as outdated on its own.
 */
export async function detectRelations(db: Db, itemIds: number[], llm: Llm | null): Promise<number> {
  if (!itemIds.length) return 0
  const candidates = await db.query<Candidate>(
    `SELECT DISTINCT n.id AS a, o.id AS b, n.statement AS a_statement, o.statement AS b_statement,
            n.status AS a_status, o.status AS b_status, n.kind AS a_kind, n.effective_at AS a_at, o.effective_at AS b_at
       FROM knowledge_items n
       JOIN item_entities ne ON ne.item_id = n.id
       JOIN item_entities oe ON oe.entity_id = ne.entity_id
       JOIN knowledge_items o ON o.id = oe.item_id
      WHERE n.id = ANY($1::int[]) AND o.conversation_id <> n.conversation_id
        AND n.kind = ANY($2::text[]) AND o.kind = n.kind
      LIMIT 400`,
    [itemIds, COMPARABLE_KINDS],
  )
  if (!candidates.length) return 0

  // Orient each pair as (later, earlier).
  const pairs = candidates.map((c) => {
    const aTime = c.a_at ? Date.parse(String(c.a_at)) : 0
    const bTime = c.b_at ? Date.parse(String(c.b_at)) : 0
    return aTime >= bTime
      ? { later: c.a, earlier: c.b, laterText: c.a_statement, earlierText: c.b_statement, kind: c.a_kind, laterStatus: c.a_status, earlierStatus: c.b_status }
      : { later: c.b, earlier: c.a, laterText: c.b_statement, earlierText: c.a_statement, kind: c.a_kind, laterStatus: c.b_status, earlierStatus: c.a_status }
  })

  let stored = 0
  if (llm) {
    for (let i = 0; i < pairs.length; i += 40) {
      const batch = pairs.slice(i, i + 40)
      const user = batch
        .map(
          (p, j) =>
            `Pair ${j}: (${p.kind})\n  EARLIER [${p.earlierStatus}]: ${p.earlierText}\n  LATER   [${p.laterStatus}]: ${p.laterText}`,
        )
        .join('\n\n')
      const res = await llm.json({
        purpose: 'change_detection',
        system:
          'For each pair of statements from a director\'s conversations (same project, earlier vs later), classify the relation: ' +
          '"supersedes" if the later statement replaces or updates the earlier one (changed decision, revised requirement, completed task); ' +
          '"contradicts" if both cannot be true and it is unclear which is current; "same" if they say the same thing; "unrelated" otherwise. ' +
          'Be conservative: only use supersedes/contradicts when clearly warranted. Explanation: one short sentence.',
        user,
        schema: JUDGE_JSON_SCHEMA,
        validate: JudgeSchema,
        effort: 'low',
        maxTokens: 16000,
      })
      for (const r of res.pairs) {
        const p = batch[r.pair]
        if (!p || (r.relation !== 'supersedes' && r.relation !== 'contradicts')) continue
        await db.query(
          `INSERT INTO item_relations(from_item, to_item, type, explanation, detected_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [p.later, p.earlier, r.relation, r.explanation, `${llm.provider}:${llm.model}`],
        )
        stored++
      }
    }
  } else {
    for (const p of pairs) {
      const overlap = jaccard(p.laterText, p.earlierText)
      if (overlap < 0.25 || p.laterText.toLowerCase() === p.earlierText.toLowerCase()) continue
      await db.query(
        `INSERT INTO item_relations(from_item, to_item, type, explanation, detected_by) VALUES ($1,$2,'possibly_changes',$3,'rules-v1') ON CONFLICT DO NOTHING`,
        [p.later, p.earlier, `A later ${p.kind} on the same subject uses different wording (${Math.round(overlap * 100)}% word overlap). Review whether it replaces the earlier one.`],
      )
      stored++
    }
  }
  return stored
}

const STOP = new Set('the a an and or of to for in on at with we will be is are it this that use using our go'.split(' '))
function words(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)))
}
export function jaccard(a: string, b: string): number {
  const A = words(a)
  const B = words(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / (A.size + B.size - inter)
}
