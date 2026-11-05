import fs from 'node:fs'
import path from 'node:path'
import { getLlm } from '../ai/llm'
import { config } from '../config'
import type { Db } from '../db/client'
import { errorMessage } from '../logger'
import { buildDocument } from './build'
import { DocRequestSchema } from './model'
import { renderDocx, renderMarkdown, renderPdf } from './render'

/** Background job: builds the document model once, renders each requested format, records the files. */
export async function generateDocument(db: Db, documentId: number): Promise<void> {
  const [row] = await db.query<{ id: number; request: unknown }>('SELECT id, request FROM documents WHERE id = $1', [documentId])
  if (!row) throw new Error(`Document ${documentId} not found`)
  const req = DocRequestSchema.parse(row.request)
  await db.query(`UPDATE documents SET status = 'generating', error = NULL WHERE id = $1`, [documentId])
  try {
    const llm = getLlm(db)
    const model = await buildDocument(db, req, llm)
    const dir = path.join(config.documentsDir, String(documentId))
    fs.mkdirSync(dir, { recursive: true })
    const files: Record<string, string> = {}
    for (const f of req.formats) {
      const buf = f === 'pdf' ? await renderPdf(model) : f === 'docx' ? await renderDocx(model) : renderMarkdown(model)
      const file = path.join(dir, `document.${f}`)
      fs.writeFileSync(file, buf)
      files[f] = file
    }
    fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(model, null, 2))
    await db.query(
      `UPDATE documents SET status = 'ready', title = $2, files = $3::jsonb, source_count = $4, mode = $5, finished_at = now() WHERE id = $1`,
      [documentId, model.title, JSON.stringify(files), model.sources.length, model.mode],
    )
  } catch (e) {
    await db.query(`UPDATE documents SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [documentId, errorMessage(e).slice(0, 2000)])
    throw e
  }
}
