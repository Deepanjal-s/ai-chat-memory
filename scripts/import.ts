/**
 * Import a ChatGPT export from the command line (useful for very large files).
 *   npm run import -- path/to/export.zip [--label "ChatGPT – Director"]
 * Stop the web app first when using the embedded database.
 */
import './load-env'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { config } from '../src/lib/config'
import { getDb } from '../src/lib/db/client'
import { registerUpload, runImport } from '../src/lib/importer/import'
import { embedPendingChunks, getEmbeddingProvider } from '../src/lib/indexing/embeddings'

async function main() {
  const args = process.argv.slice(2)
  const file = args.find((a) => !a.startsWith('--'))
  const labelIdx = args.indexOf('--label')
  const label = labelIdx >= 0 ? args[labelIdx + 1] : 'ChatGPT'
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: npm run import -- <export.zip | conversations.json> [--label "Account name"]')
    process.exit(1)
  }

  fs.mkdirSync(config.uploadDir, { recursive: true })
  const temp = path.join(config.uploadDir, `${crypto.randomUUID()}.part`)
  const hash = crypto.createHash('sha256')
  const src = fs.createReadStream(file)
  src.on('data', (c) => hash.update(c))
  await pipeline(src, fs.createWriteStream(temp))

  const db = await getDb()
  const { batchId, duplicateOf } = await registerUpload(db, {
    tempPath: temp,
    originalFilename: path.basename(file),
    sha256: hash.digest('hex'),
    size: fs.statSync(file).size,
    sourceLabel: label,
    rawDir: config.rawDir,
    origin: 'cli',
  })
  if (duplicateOf) {
    console.log(`This exact file was already imported (import #${duplicateOf}). Nothing to do.`)
    await db.close()
    return
  }
  console.log(`Import #${batchId} started…`)
  const stats = await runImport(db, batchId, {
    progressEvery: 100,
    onProgress: (s) => process.stdout.write(`\r  ${s.conversationsInFile} conversations read`),
  })
  console.log('\n')
  console.table({
    'In file': stats.conversationsInFile,
    New: stats.newConversations,
    Updated: stats.updatedConversations,
    Unchanged: stats.unchangedConversations,
    'Older copies kept': stats.olderVersionsKept,
    Failed: stats.failedConversations,
    'Message nodes in file': stats.nodesInFile,
    'Missing from export': stats.missingFromExport,
  })
  const r = stats.reconciliation!
  console.log(
    r.ok
      ? `✓ Reconciliation passed: ${r.storedConversations} conversations / ${r.storedNodes} nodes stored.`
      : `⚠ Reconciliation mismatch: expected ${r.expectedConversations}/${r.expectedNodes}, stored ${r.storedConversations}/${r.storedNodes}.`,
  )

  const provider = getEmbeddingProvider()
  if (provider) {
    console.log('Building semantic index…')
    await embedPendingChunks(db, provider, { onProgress: (d, left) => process.stdout.write(`\r  ${d} embedded, ${left} left`) })
    console.log()
  }
  await db.close()
  if (!r.ok || stats.failedConversations) process.exitCode = 2
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
