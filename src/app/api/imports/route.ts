import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { audit } from '@/lib/audit'
import { clientIp, guardApi } from '@/lib/auth'
import { config } from '@/lib/config'
import { getDb } from '@/lib/db/client'
import { registerUpload } from '@/lib/importer/import'
import { enqueueImport } from '@/lib/importer/queue'
import { listBatches } from '@/lib/queries'

export const runtime = 'nodejs'

const MAX_BYTES = 10 * 1024 ** 3

export async function GET(request: Request) {
  const denied = await guardApi(request)
  if (denied) return denied
  return Response.json(await listBatches(await getDb()))
}

/**
 * Upload an export as the raw request body (not multipart) so multi-gigabyte files stream straight to disk.
 * Headers: x-filename (URI-encoded original name), x-source-label (optional account label).
 */
export async function POST(request: Request) {
  const denied = await guardApi(request)
  if (denied) return denied
  if (!request.body) return Response.json({ error: 'Empty upload' }, { status: 400 })

  const filename = path.basename(decodeURIComponent(request.headers.get('x-filename') ?? 'export.zip')).slice(0, 255)
  if (!/\.(zip|json)$/i.test(filename)) {
    return Response.json({ error: 'Upload the .zip export from ChatGPT, or its conversations.json' }, { status: 400 })
  }
  const sourceLabel = (request.headers.get('x-source-label') ?? '').trim().slice(0, 100) || 'ChatGPT'

  fs.mkdirSync(config.uploadDir, { recursive: true })
  const tempPath = path.join(config.uploadDir, `${crypto.randomUUID()}.part`)
  const hash = crypto.createHash('sha256')
  let size = 0
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length
      if (size > MAX_BYTES) return cb(new Error('File is larger than 10 GB'))
      hash.update(chunk)
      cb(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(request.body as NodeReadableStream), meter, fs.createWriteStream(tempPath))
  } catch (e) {
    fs.rmSync(tempPath, { force: true })
    return Response.json({ error: `Upload failed: ${(e as Error).message}` }, { status: 400 })
  }
  if (size === 0) {
    fs.rmSync(tempPath, { force: true })
    return Response.json({ error: 'Empty upload' }, { status: 400 })
  }

  const db = await getDb()
  const sha256 = hash.digest('hex')
  const { batchId, duplicateOf } = await registerUpload(db, {
    tempPath,
    originalFilename: filename,
    sha256,
    size,
    sourceLabel,
    rawDir: config.rawDir,
  })
  await audit('import_uploaded', `batch:${batchId}`, await clientIp(), { filename, size, sha256, duplicateOf })
  if (!duplicateOf) enqueueImport(batchId)
  return Response.json({ batchId, duplicateOf }, { status: 202 })
}
