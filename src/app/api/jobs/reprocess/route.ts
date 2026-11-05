import { audit } from '@/lib/audit'
import { clientIp, guardApi } from '@/lib/auth'
import { getDb } from '@/lib/db/client'
import { enqueueJob } from '@/lib/jobs'

/** Re-runs knowledge extraction for every conversation (e.g. after switching the AI provider on). */
export async function POST(request: Request) {
  const denied = await guardApi(request)
  if (denied) return denied
  const db = await getDb()
  await db.query('UPDATE conversations SET processed_hash = NULL')
  const rows = await db.query<{ id: number }>('SELECT id FROM conversations ORDER BY updated_at DESC NULLS LAST')
  for (const r of rows) await enqueueJob(db, 'process_conversation', { conversationId: r.id }, { dedupeKey: `process:${r.id}` })
  await audit('reprocess_all', null, await clientIp(), { conversations: rows.length })
  return Response.json({ ok: true, queued: rows.length })
}
