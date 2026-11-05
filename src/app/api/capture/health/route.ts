import { getDb } from '@/lib/db/client'
import { captureEnabled, verifyExtensionToken } from '@/lib/settings'

/** Lets the extension check its connection and token. Returns no conversation data. */
export async function GET(request: Request) {
  const db = await getDb()
  const tokenId = await verifyExtensionToken(db, request.headers.get('authorization'))
  if (!tokenId) return Response.json({ ok: false, error: 'Invalid or revoked extension token' }, { status: 401 })
  return Response.json({ ok: true, captureEnabled: await captureEnabled(db), serverTime: new Date().toISOString() })
}
