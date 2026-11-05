import { audit } from '@/lib/audit'
import { clientIp, guardApi } from '@/lib/auth'
import { getDb } from '@/lib/db/client'
import { setSetting } from '@/lib/settings'

export async function POST(request: Request) {
  const denied = await guardApi(request)
  if (denied) return denied
  const body = (await request.json().catch(() => ({}))) as { enabled?: unknown; acknowledged?: unknown }
  if (typeof body.enabled !== 'boolean') return Response.json({ error: 'enabled must be true or false' }, { status: 400 })
  if (body.enabled && body.acknowledged !== true) {
    return Response.json({ error: 'Confirm that you have read the terms-of-service note first' }, { status: 400 })
  }
  await setSetting(await getDb(), 'capture_enabled', body.enabled)
  await audit(body.enabled ? 'capture_enabled' : 'capture_disabled', null, await clientIp())
  return Response.json({ ok: true, enabled: body.enabled })
}
