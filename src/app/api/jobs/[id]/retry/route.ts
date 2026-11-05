import { guardApi } from '@/lib/auth'
import { getDb } from '@/lib/db/client'
import { retryJob } from '@/lib/jobs'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guardApi(request)
  if (denied) return denied
  const ok = await retryJob(await getDb(), Number((await params).id))
  return ok ? Response.json({ ok: true }) : Response.json({ error: 'Only failed jobs can be retried' }, { status: 409 })
}
