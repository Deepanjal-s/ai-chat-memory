import { audit } from '@/lib/audit'
import { clientIp, guardApi } from '@/lib/auth'
import { getDb } from '@/lib/db/client'
import { DOC_TYPES, DocRequestSchema } from '@/lib/documents/model'
import { enqueueJob } from '@/lib/jobs'

/** Queues a document; the background worker generates it and the Documents page shows progress. */
export async function POST(request: Request) {
  const denied = await guardApi(request)
  if (denied) return denied
  const parsed = DocRequestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'Invalid document request', details: parsed.error.issues.slice(0, 5) }, { status: 400 })
  const req = parsed.data
  if (!req.entityId && !req.query) return Response.json({ error: 'Choose a project/topic or type a subject.' }, { status: 400 })
  const db = await getDb()
  const title = req.title || `${DOC_TYPES[req.docType]}: ${req.query ?? 'project'}`
  const [row] = await db.query<{ id: number }>(
    'INSERT INTO documents(title, doc_type, request, formats) VALUES ($1, $2, $3::jsonb, $4) RETURNING id',
    [title, req.docType, JSON.stringify(req), req.formats],
  )
  await enqueueJob(db, 'generate_document', { documentId: row.id }, { maxAttempts: 2 })
  await audit('document_requested', `document:${row.id}`, await clientIp(), { docType: req.docType })
  return Response.json({ id: row.id }, { status: 202 })
}
