import { audit } from '@/lib/audit'
import { clientIp, guardApi } from '@/lib/auth'
import { getDb } from '@/lib/db/client'
import { revokeExtensionToken } from '@/lib/settings'

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guardApi(request)
  if (denied) return denied
  const id = Number((await params).id)
  await revokeExtensionToken(await getDb(), id)
  await audit('extension_token_revoked', `token:${id}`, await clientIp())
  return Response.json({ ok: true })
}
