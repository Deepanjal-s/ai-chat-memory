import { guardApi } from '@/lib/auth'
import { getDb } from '@/lib/db/client'
import { getBatch } from '@/lib/queries'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guardApi(request)
  if (denied) return denied
  const found = await getBatch(await getDb(), Number((await params).id))
  return found ? Response.json(found) : Response.json({ error: 'Not found' }, { status: 404 })
}
