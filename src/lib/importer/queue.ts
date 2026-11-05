import { getDb } from '../db/client'
import { embedPendingChunks, getEmbeddingProvider } from '../indexing/embeddings'
import { runImport } from './import'

/**
 * In-process, one-at-a-time import queue. Imports are idempotent, so anything left 'queued' or 'processing'
 * by a restart is simply run again when the app starts.
 */
const g = globalThis as unknown as { __aimQueue?: { pending: number[]; running: boolean; resumed: boolean } }
const state = (g.__aimQueue ??= { pending: [], running: false, resumed: false })

export function enqueueImport(batchId: number): void {
  if (!state.pending.includes(batchId)) state.pending.push(batchId)
  void drain()
}

export async function resumeInterruptedImports(): Promise<void> {
  if (state.resumed) return
  state.resumed = true
  const db = await getDb()
  const rows = await db.query<{ id: number }>(
    "SELECT id FROM import_batches WHERE status IN ('queued', 'processing') ORDER BY id",
  )
  rows.forEach((r) => enqueueImport(r.id))
}

async function drain(): Promise<void> {
  if (state.running) return
  state.running = true
  try {
    const db = await getDb()
    while (state.pending.length) {
      const id = state.pending.shift()!
      try {
        await runImport(db, id)
      } catch (e) {
        console.error(`Import batch ${id} failed:`, e)
      }
    }
    const provider = getEmbeddingProvider()
    if (provider) await embedPendingChunks(db, provider)
  } catch (e) {
    console.error('Import queue error:', e)
  } finally {
    state.running = false
  }
}

export function queueBusy(): boolean {
  return state.running || state.pending.length > 0
}
