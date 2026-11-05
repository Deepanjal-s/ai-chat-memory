import { audit } from '@/lib/audit'
import { clientIp, guardApi } from '@/lib/auth'
import { getDb } from '@/lib/db/client'
import { enqueueImport } from '@/lib/importer/queue'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guardApi(request)
  if (denied) return denied
  const id = Number((await params).id)
  const db = await getDb()
  const rows = await db.query<{ id: number }>(
    `UPDATE import_batches SET status = 'queued' WHERE id = $1 AND status IN ('failed', 'complete_with_errors') RETURNING id`,
    [id],
  )
  if (!rows.length) return Response.json({ error: 'Only failed or partially failed imports can be retried' }, { status: 409 })
  await audit('import_retry', `batch:${id}`, await clientIp())
  enqueueImport(id)
  return Response.json({ ok: true }, { status: 202 })
}
