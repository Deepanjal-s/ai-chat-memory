/**
 * Build or resume the semantic index:  npm run embed  (requires EMBEDDING_PROVIDER).
 * npm run embed -- --rechunk  first rebuilds every conversation's retrieval units with the current chunker
 * (for example after the chunk size changed), which discards their embeddings so they are computed again.
 */
import './load-env'
import { getDb } from '../src/lib/db/client'
import { rebuildChunks } from '../src/lib/importer/import'
import { embedPendingChunks, getEmbeddingProvider } from '../src/lib/indexing/embeddings'

async function main() {
  const provider = getEmbeddingProvider()
  if (!provider) {
    console.error('Set EMBEDDING_PROVIDER (e.g. voyage) and its API key in .env.local first.')
    process.exit(1)
  }
  const db = await getDb()
  if (process.argv.includes('--rechunk')) {
    const convs = await db.query<{ id: number; title: string; created_at: Date | null }>(
      'SELECT id, title, created_at FROM conversations ORDER BY id',
    )
    for (const [i, c] of convs.entries()) {
      await db.tx((q) => rebuildChunks(q, c.id, c.title, c.created_at ? new Date(c.created_at) : null))
      process.stdout.write(`\r${i + 1}/${convs.length} conversations re-chunked`)
    }
    console.log()
  }
  const n = await embedPendingChunks(db, provider, {
    onProgress: (d, left) => process.stdout.write(`\r${d} embedded, ${left} left`),
  })
  console.log(`\nDone: ${n} passages embedded with ${provider.model}.`)
  await db.close()
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
