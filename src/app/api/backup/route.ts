import { audit } from '@/lib/audit'
import { clientIp, guardApi } from '@/lib/auth'
import { runBackup } from '@/lib/backup'
import { getDb } from '@/lib/db/client'
import { errorMessage } from '@/lib/logger'

export async function POST(request: Request) {
  const denied = await guardApi(request)
  if (denied) return denied
  try {
    const info = await runBackup(await getDb())
    await audit('backup', null, await clientIp(), { size: info.size })
    return Response.json({ ok: true, ...info })
  } catch (e) {
    return Response.json({ error: errorMessage(e) }, { status: 500 })
  }
}
