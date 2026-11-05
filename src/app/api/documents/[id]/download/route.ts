import fs from 'node:fs'
import path from 'node:path'
import { audit } from '@/lib/audit'
import { clientIp, guardApi } from '@/lib/auth'
import { config } from '@/lib/config'
import { getDb } from '@/lib/db/client'

const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  md: 'text/markdown; charset=utf-8',
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guardApi(request)
  if (denied) return denied
  const id = Number((await params).id)
  const format = new URL(request.url).searchParams.get('format') ?? 'pdf'
  if (!TYPES[format]) return Response.json({ error: 'Unknown format' }, { status: 400 })
  const [doc] = await (await getDb()).query<{ title: string; files: Record<string, string> }>('SELECT title, files FROM documents WHERE id = $1', [id])
  const file = doc?.files?.[format]
  // Only serve files inside the documents directory.
  if (!file || !path.resolve(file).startsWith(path.resolve(config.documentsDir) + path.sep) || !fs.existsSync(file)) {
    return Response.json({ error: 'File not found' }, { status: 404 })
  }
  await audit('document_download', `document:${id}`, await clientIp(), { format })
  const name = `${doc.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'document'}.${format}`
  return new Response(fs.readFileSync(file), {
    headers: { 'content-type': TYPES[format], 'content-disposition': `attachment; filename="${name}"` },
  })
}
