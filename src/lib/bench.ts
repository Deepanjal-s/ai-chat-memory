/**
 * Runs a benchmark conversation through the app's real import pipeline and search, and returns the
 * app's ranking of the conversation's messages. Shared by scripts/bench-rankings.ts (rankings files for
 * memory-recall-bench) and tests/retrieval.test.ts (the retrieval regression check).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { openDb } from './db/client'
import { embedPendingChunks, type EmbeddingProvider } from './indexing/embeddings'
import { registerUpload, runImport } from './importer/import'
import { search } from './search'

export interface BenchMessage { id: string; role: string; content: string }
export interface BenchSession { id: string; messages: BenchMessage[] }
export interface BenchConversation { id: string; question: string; sessions: BenchSession[] }

/** One session → one conversation in the exact shape of ChatGPT's conversations.json (a linear thread). */
export function toChatGpt(session: BenchSession, index: number) {
  const base = 1_700_000_000 + index * 86_400
  const mapping: Record<string, unknown> = { root: { id: 'root', parent: null, children: [] as string[], message: null } }
  let parent = 'root'
  session.messages.forEach((m, i) => {
    mapping[m.id] = {
      id: m.id,
      parent,
      children: [],
      message: {
        id: m.id,
        author: { role: m.role === 'assistant' ? 'assistant' : 'user', name: null, metadata: {} },
        create_time: base + i * 30,
        content: { content_type: 'text', parts: [m.content] },
        metadata: {},
        recipient: 'all',
      },
    }
    ;(mapping[parent] as { children: string[] }).children.push(m.id)
    parent = m.id
  })
  return {
    title: `Session ${session.id}`,
    create_time: base,
    update_time: base + session.messages.length * 30,
    mapping,
    current_node: parent,
    conversation_id: `bench-${session.id}`,
    id: `bench-${session.id}`,
    is_archived: false,
    moderation_results: [],
  }
}

/**
 * Fresh in-memory database, each session imported as one ChatGPT conversation, then the question run
 * through `search()`. Returns benchmark message ids, best first. With a provider, chunks are embedded
 * first and search runs as the app does with semantic search enabled.
 */
export async function rankConversation(
  conv: BenchConversation,
  workDir: string,
  provider: EmbeddingProvider | null = null,
): Promise<string[]> {
  const db = await openDb({ embeddingDim: provider?.dim ?? 8 })
  try {
    const file = path.join(workDir, `${crypto.randomUUID()}.json`)
    const body = JSON.stringify(conv.sessions.map(toChatGpt))
    fs.writeFileSync(file, body)
    const { batchId } = await registerUpload(db, {
      tempPath: file,
      originalFilename: 'conversations.json',
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
      size: Buffer.byteLength(body),
      sourceLabel: 'bench',
      rawDir: path.join(workDir, 'raw'),
      origin: 'cli',
    })
    await runImport(db, batchId)
    if (provider) await embedPendingChunks(db, provider, { batchSize: 32 })
    const { hits, semanticError } = await search(db, { q: conv.question, limit: 200 }, provider)
    if (semanticError) throw new Error(`semantic search failed: ${semanticError}`)
    if (!hits.length) return []
    const rows = await db.query<{ id: number; node_external_id: string }>(
      'SELECT id, node_external_id FROM messages WHERE id = ANY($1::int[])',
      [hits.map((h) => h.messageId)],
    )
    const ext = new Map(rows.map((r) => [r.id, r.node_external_id]))
    return hits.map((h) => ext.get(h.messageId)).filter((x): x is string => !!x)
  } finally {
    await db.close()
  }
}

/**
 * Takes ranked messages in order until a token budget is full (~4 characters per token, the same
 * estimate memory-recall-bench uses); a message that doesn't fit is skipped. Returns the ids taken.
 */
export function packBudget(ranked: string[], lengths: Map<string, number>, budgetTokens: number): Set<string> {
  const taken = new Set<string>()
  let used = 0
  for (const id of ranked) {
    const cost = Math.max(1, Math.ceil((lengths.get(id) ?? 0) / 4))
    if (used + cost > budgetTokens) continue
    taken.add(id)
    used += cost
  }
  return taken
}
