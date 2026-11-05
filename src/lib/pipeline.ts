import { getLlm } from './ai/llm'
import { runBackup, listBackups } from './backup'
import type { Db } from './db/client'
import { generateDocument } from './documents/generate'
import { embedPendingChunks, getEmbeddingProvider } from './indexing/embeddings'
import { enqueueJob, startWorker, type JobHandler, type JobKind } from './jobs'
import { detectChangesForConversation, processConversation } from './knowledge/process'
import { log } from './logger'

export const handlers: Partial<Record<JobKind, JobHandler>> = {
  async process_conversation(db, job) {
    const id = Number(job.payload.conversationId)
    const res = await processConversation(db, id, getLlm(db))
    if (!res.skipped) log('info', 'conversation_processed', { conversationId: id, ...res })
    if (getEmbeddingProvider()) await enqueueJob(db, 'embed', {}, { dedupeKey: 'embed' })
  },
  async detect_changes(db, job) {
    const id = Number(job.payload.conversationId)
    const relations = await detectChangesForConversation(db, id, getLlm(db))
    log('info', 'changes_detected', { conversationId: id, relations })
  },
  async embed(db) {
    const provider = getEmbeddingProvider()
    if (provider) await embedPendingChunks(db, provider)
  },
  async generate_document(db, job) {
    await generateDocument(db, Number(job.payload.documentId))
  },
  async backup(db) {
    await runBackup(db)
  },
}

/**
 * Makes sure every conversation is processed with the current extractor (covers data imported before the
 * memory engine existed, and a change of AI provider), and schedules a daily backup.
 */
export async function sweep(db: Db): Promise<void> {
  const llm = getLlm(db)
  const extractor = llm ? `${llm.provider}:${llm.model}` : 'rules-v1'
  const pending = await db.query<{ id: number }>(
    `SELECT id FROM conversations WHERE processed_hash IS NULL OR processed_by IS DISTINCT FROM $1 ORDER BY updated_at DESC NULLS LAST LIMIT 500`,
    [extractor],
  )
  for (const r of pending) await enqueueJob(db, 'process_conversation', { conversationId: r.id }, { dedupeKey: `process:${r.id}` })
  if (db.dumpTo) {
    const last = listBackups()[0]
    if (!last || Date.now() - Date.parse(last.createdAt) > 24 * 3600 * 1000) await enqueueJob(db, 'backup', {}, { dedupeKey: 'backup' })
  }
}

const g = globalThis as unknown as { __aimSweep?: NodeJS.Timeout }

export function startPipeline(getDb: () => Promise<Db>): void {
  startWorker(getDb, handlers)
  if (g.__aimSweep) return
  const run = () =>
    getDb()
      .then(sweep)
      .catch((e) => log('error', 'sweep_failed', { error: String(e) }))
  void run()
  g.__aimSweep = setInterval(run, 10 * 60 * 1000)
  g.__aimSweep.unref?.()
}
