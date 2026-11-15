import type { Db } from './db/client'
import { record } from './ai/llm'
import { bm25Scores } from './bm25'
import { getEmbeddingProvider, toVectorLiteral, type EmbeddingProvider } from './indexing/embeddings'

export interface SearchParams {
  q: string
  from?: string | null
  to?: string | null
  role?: 'user' | 'assistant' | null
  includeHidden?: boolean
  includeBranches?: boolean
  limit?: number
}

export interface SearchHit {
  messageId: number
  conversationId: number
  conversationTitle: string
  role: string | null
  createdAt: string | null
  isCanonical: boolean
  /** Snippet with matches wrapped in \u0001 … \u0002 (render-safe markers, never HTML). */
  snippet: string
  matchedBy: ('keyword' | 'semantic')[]
  score: number
}

export interface ConversationHit {
  id: number
  title: string
  updatedAt: string | null
  messageCount: number
}

export interface SearchResult {
  hits: SearchHit[]
  conversations: ConversationHit[]
  semanticEnabled: boolean
  semanticError?: string
}

export const MARK_START = '\u0001'
export const MARK_END = '\u0002'
const RRF_K = 60
/** Messages that match at least one query term and get re-ranked with BM25. */
const KEYWORD_CANDIDATES = 1000

/**
 * Keyword ranking. PostgreSQL selects the candidates (OR of the query terms, or the strict query when it has
 * "-exclusions") using the GIN index; BM25 then orders them, with document frequencies counted under the same
 * filters. This replaced ts_rank_cd + an all-terms bonus, which has no IDF and favours long messages; see
 * src/lib/bm25.ts for the measurement.
 */
async function keywordSearch(
  db: Db,
  q: string,
  where: string,
  filterParams: unknown[],
  strict: boolean,
): Promise<{ id: number; score: number }[]> {
  const params = [q, ...filterParams]
  const candidates = await db.query<{ id: number; tsv: string; created_at: Date | string | null }>(
    `WITH tq AS (
       SELECT CASE WHEN $${filterParams.length + 2}::boolean OR websearch_to_tsquery('english', $1)::text = ''
                   THEN websearch_to_tsquery('english', $1)
                   ELSE replace(websearch_to_tsquery('english', $1)::text, ' & ', ' | ')::tsquery END AS q)
     SELECT m.id, m.tsv::text AS tsv, m.created_at
       FROM messages m, tq
      WHERE m.tsv @@ tq.q ${where}
      ORDER BY ts_rank_cd(m.tsv, tq.q) DESC
      LIMIT ${KEYWORD_CANDIDATES}`,
    [...params, strict],
  )
  if (!candidates.length) return []

  const [corpus] = await db.query<{ n: number; avg_len: number }>(
    `SELECT count(*)::int AS n, coalesce(avg(length(m.tsv)), 0)::float8 AS avg_len
       FROM messages m WHERE $1::text IS NOT NULL ${where}`,
    params,
  )
  const dfRows = await db.query<{ lexeme: string; df: number }>(
    `WITH lex AS (SELECT DISTINCT unnest(tsvector_to_array(to_tsvector('english', $1))) AS lexeme)
     SELECT lexeme, (SELECT count(*) FROM messages m WHERE m.tsv @@ quote_literal(lexeme)::tsquery ${where})::int AS df
       FROM lex`,
    params,
  )
  const lexemes = dfRows.map((r) => r.lexeme)
  const scores = bm25Scores(candidates, lexemes, {
    n: corpus.n,
    avgLen: corpus.avg_len,
    df: new Map(dfRows.map((r) => [r.lexeme, r.df])),
  })
  const time = (d: Date | string | null) => (d ? new Date(d).getTime() : 0)
  return candidates
    .map((c) => ({ id: c.id, score: scores.get(c.id) ?? 0, t: time(c.created_at) }))
    .sort((a, b) => b.score - a.score || b.t - a.t)
    .slice(0, 200)
    .map(({ id, score }) => ({ id, score }))
}

/**
 * Hybrid search over every stored message. Keyword matching (PostgreSQL full-text, OR-ed terms with
 * all-terms matches ranked first) always runs; semantic matching over chunk embeddings joins in when an
 * embedding provider is configured. Results are fused with Reciprocal Rank Fusion.
 */
export async function search(
  db: Db,
  params: SearchParams,
  provider: EmbeddingProvider | null = safeProvider(),
): Promise<SearchResult> {
  const q = params.q.trim()
  const limit = Math.min(params.limit ?? 50, 200)
  if (!q) return { hits: [], conversations: [], semanticEnabled: !!provider }

  const filters: string[] = []
  const filterParams: unknown[] = []
  const add = (sql: string, v: unknown) => {
    filterParams.push(v)
    filters.push(sql.replace('?', `$${filterParams.length + 1}`))
  }
  if (params.from) add('m.created_at >= ?::timestamptz', params.from)
  if (params.to) add("m.created_at < (?::date + interval '1 day')", params.to)
  if (params.role) add('m.role = ?', params.role)
  if (!params.includeHidden) filters.push('NOT m.is_hidden')
  if (!params.includeBranches) filters.push('m.is_canonical')
  filters.push('m.present_in_latest')
  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''

  // A query with exclusions ("-term") must not be loosened to OR, or excluded terms would match.
  const strict = /(^|\s)-\S/.test(q)
  const keyword = await keywordSearch(db, q, where, filterParams, strict)

  let semantic: { message_ids: number[] }[] = []
  let semanticError: string | undefined
  if (provider) {
    try {
      const [vec] = await provider.embed([q], 'query')
      if (provider.external) {
        await record(db, { provider: provider.name, model: provider.model, purpose: 'search_query_embedding', chars: q.length, ok: true })
      }
      semantic = await db.query<{ message_ids: number[] }>(
        `SELECT ch.message_ids FROM chunks ch
          WHERE ch.embedding IS NOT NULL
            AND EXISTS (SELECT 1 FROM messages m WHERE m.id = ANY(ch.message_ids) ${where})
          ORDER BY ch.embedding <=> $1::vector
          LIMIT 50`,
        [toVectorLiteral(vec), ...filterParams],
      )
    } catch (e) {
      semanticError = (e as Error).message
    }
  }

  // Reciprocal Rank Fusion at message level.
  const fused = new Map<number, { score: number; matchedBy: Set<'keyword' | 'semantic'> }>()
  const bump = (id: number, rank: number, by: 'keyword' | 'semantic') => {
    const e = fused.get(id) ?? { score: 0, matchedBy: new Set() }
    if (e.matchedBy.has(by)) return
    e.score += 1 / (RRF_K + rank)
    e.matchedBy.add(by)
    fused.set(id, e)
  }
  keyword.forEach((r, i) => bump(r.id, i + 1, 'keyword'))
  semantic.forEach((c, i) => c.message_ids.forEach((id) => bump(id, i + 1, 'semantic')))

  const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit)
  const ids = ranked.map(([id]) => id)
  const details = ids.length
    ? await db.query<{
        id: number
        conversation_id: number
        title: string
        role: string | null
        created_at: Date | string | null
        is_canonical: boolean
        headline: string
      }>(
        `SELECT m.id, m.conversation_id, c.title, m.role, m.created_at, m.is_canonical,
                CASE WHEN m.tsv @@ replace(websearch_to_tsquery('english', $2)::text, ' & ', ' | ')::tsquery
                     THEN ts_headline('english', m.content_text,
                            replace(websearch_to_tsquery('english', $2)::text, ' & ', ' | ')::tsquery,
                            'MaxFragments=2, MaxWords=35, MinWords=12, FragmentDelimiter=" … ", StartSel=${MARK_START}, StopSel=${MARK_END}')
                     ELSE left(m.content_text, 280) END AS headline
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE m.id = ANY($1::int[])`,
        [ids, q],
      )
    : []
  const byId = new Map(details.map((d) => [d.id, d]))

  const conversations = await db.query<{ id: number; title: string; updated_at: Date | string | null; message_count: number }>(
    `SELECT id, title, updated_at, message_count FROM conversations
      WHERE title_tsv @@ replace(websearch_to_tsquery('english', $1)::text, ' & ', ' | ')::tsquery
      ORDER BY ts_rank_cd(title_tsv, websearch_to_tsquery('english', $1)) DESC, updated_at DESC NULLS LAST
      LIMIT 8`,
    [q],
  ).catch(() => [])

  return {
    semanticEnabled: !!provider,
    semanticError,
    conversations: conversations.map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: toIso(c.updated_at),
      messageCount: c.message_count,
    })),
    hits: ranked
      .filter(([id]) => byId.has(id))
      .map(([id, f]) => {
        const d = byId.get(id)!
        return {
          messageId: id,
          conversationId: d.conversation_id,
          conversationTitle: d.title,
          role: d.role,
          createdAt: toIso(d.created_at),
          isCanonical: d.is_canonical,
          snippet: d.headline,
          matchedBy: [...f.matchedBy],
          score: f.score,
        }
      }),
  }
}

function safeProvider(): EmbeddingProvider | null {
  try {
    return getEmbeddingProvider()
  } catch {
    return null
  }
}

function toIso(d: Date | string | null): string | null {
  return d ? new Date(d).toISOString() : null
}
