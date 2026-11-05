/** Build or resume the semantic index:  npm run embed  (requires EMBEDDING_PROVIDER). */
import './load-env'
import { getDb } from '../src/lib/db/client'
import { embedPendingChunks, getEmbeddingProvider } from '../src/lib/indexing/embeddings'

async function main() {
  const provider = getEmbeddingProvider()
  if (!provider) {
    console.error('Set EMBEDDING_PROVIDER (e.g. voyage) and its API key in .env.local first.')
    process.exit(1)
  }
  const db = await getDb()
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
