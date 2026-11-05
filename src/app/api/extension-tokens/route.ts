import { audit } from '@/lib/audit'
import { clientIp, guardApi } from '@/lib/auth'
import { getDb } from '@/lib/db/client'
import { createExtensionToken } from '@/lib/settings'

/** Creates a pairing token for the browser extension. The token is shown once and only its hash is stored. */
export async function POST(request: Request) {
  const denied = await guardApi(request)
  if (denied) return denied
  const body = (await request.json().catch(() => ({}))) as { label?: unknown }
  const label = typeof body.label === 'string' ? body.label.trim() : ''
  const { id, token } = await createExtensionToken(await getDb(), label || 'Browser extension')
  await audit('extension_token_created', `token:${id}`, await clientIp())
  return Response.json({ id, token })
}
