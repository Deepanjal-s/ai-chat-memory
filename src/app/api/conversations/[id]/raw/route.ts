import { audit } from '@/lib/audit'
import { clientIp, guardApi } from '@/lib/auth'
import { getDb } from '@/lib/db/client'

/** Download the original export JSON of a conversation (latest version, or ?version=N) for verification. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guardApi(request)
  if (denied) return denied
  const id = Number((await params).id)
  const version = new URL(request.url).searchParams.get('version')
  const db = await getDb()
  const rows = await db.query<{ raw: unknown; version: number; external_id: string }>(
    `SELECT v.raw, v.version, c.external_id FROM conversation_versions v JOIN conversations c ON c.id = v.conversation_id
      WHERE v.conversation_id = $1 AND ($2::int IS NULL OR v.version = $2::int)
      ORDER BY v.version DESC LIMIT 1`,
    [id, version ? Number(version) : null],
  )
  if (!rows.length) {
    // Not in any export yet: return the raw live captures exactly as the extension sent them.
    const captures = await db.query<{ raw: unknown; received_at: Date }>(
      `SELECT raw, received_at FROM capture_events WHERE conversation_id = $1 AND result = 'ok' ORDER BY id`,
      [id],
    )
    if (!captures.length) return Response.json({ error: 'Not found' }, { status: 404 })
    await audit('raw_download', `conversation:${id}`, await clientIp(), { captures: captures.length })
    return new Response(JSON.stringify({ source: 'live_capture', captures }, null, 2), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="conversation-${id}-captures.json"` },
    })
  }
  await audit('raw_download', `conversation:${id}`, await clientIp(), { version: rows[0].version })
  const safeName = rows[0].external_id.replace(/[^\w.-]/g, '_')
  return new Response(JSON.stringify(rows[0].raw, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${safeName}-v${rows[0].version}.json"`,
    },
  })
}
