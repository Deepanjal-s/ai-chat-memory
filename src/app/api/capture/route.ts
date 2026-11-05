import { CapturePayloadSchema, ingestCapture, logCapture } from '@/lib/capture/ingest'
import { getDb } from '@/lib/db/client'
import { errorMessage, log } from '@/lib/logger'
import { allow } from '@/lib/rate-limit'
import { captureEnabled, verifyExtensionToken } from '@/lib/settings'

export const runtime = 'nodejs'
const MAX_BODY = 8 * 1024 * 1024

/**
 * Receives a conversation snapshot from the paired browser extension. Authenticated with the extension's
 * pairing token (not the login cookie); refused unless live capture is switched on in Settings.
 */
export async function POST(request: Request) {
  const db = await getDb()
  const tokenId = await verifyExtensionToken(db, request.headers.get('authorization'))
  if (!tokenId) return Response.json({ error: 'Invalid or revoked extension token' }, { status: 401 })
  if (!allow(`capture:${tokenId}`, 120, 60_000)) return Response.json({ error: 'Too many captures, slow down' }, { status: 429 })
  if (!(await captureEnabled(db))) {
    return Response.json({ error: 'Live capture is turned off in Settings', disabled: true }, { status: 403 })
  }
  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > MAX_BODY) return Response.json({ error: 'Capture too large' }, { status: 413 })

  let body: unknown
  try {
    const text = await request.text()
    if (text.length > MAX_BODY) return Response.json({ error: 'Capture too large' }, { status: 413 })
    body = JSON.parse(text)
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 })
  }
  const parsed = CapturePayloadSchema.safeParse(body)
  if (!parsed.success) {
    const reason = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ')
    await logCapture(db, body, null, 'rejected', reason.slice(0, 1000))
    return Response.json({ error: 'Invalid capture', details: parsed.error.issues.slice(0, 5) }, { status: 400 })
  }
  try {
    const result = await ingestCapture(db, parsed.data)
    return Response.json({ ok: true, ...result })
  } catch (e) {
    log('error', 'capture_ingest_failed', { conversation: parsed.data.conversationId, error: errorMessage(e) })
    await logCapture(db, parsed.data, null, 'error', errorMessage(e)).catch(() => {})
    return Response.json({ error: 'Could not store capture; the extension will retry' }, { status: 500 })
  }
}
