import { config } from '../config'
import { record } from '../ai/llm'
import type { Db } from '../db/client'

export interface EmbeddingProvider {
  model: string
  dim: number
  embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]>
}

export function getEmbeddingProvider(): EmbeddingProvider | null {
  switch (config.embeddingProvider) {
    case 'voyage':
      if (!config.voyageApiKey) throw new Error('EMBEDDING_PROVIDER=voyage requires VOYAGE_API_KEY')
      return voyageProvider(config.voyageApiKey, config.embeddingModel, config.embeddingDim)
    default:
      return null
  }
}

function voyageProvider(apiKey: string, model: string, dim: number): EmbeddingProvider {
  return {
    model,
    dim,
    async embed(texts, kind) {
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ input: texts, model, input_type: kind, output_dimension: dim, truncation: true }),
      })
      if (!res.ok) throw new Error(`Voyage embeddings failed: ${res.status} ${await res.text()}`)
      const body = (await res.json()) as { data: { embedding: number[]; index: number }[] }
      return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
    },
  }
}

export function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`
}

/** Embeds every chunk that has no embedding yet. Safe to re-run; resumes where it stopped. */
export async function embedPendingChunks(
  db: Db,
  provider: EmbeddingProvider,
  opts: { batchSize?: number; onProgress?: (done: number, remaining: number) => void } = {},
): Promise<number> {
  const [{ value: dim }] = await db.query<{ value: number }>("SELECT value FROM settings WHERE key = 'embedding_dim'")
  if (Number(dim) !== provider.dim) {
    throw new Error(`Database was created for ${dim}-dimension embeddings but the provider returns ${provider.dim}.`)
  }
  const batchSize = opts.batchSize ?? 64
  let done = 0
  for (;;) {
    const rows = await db.query<{ id: number; context_header: string; text: string }>(
      'SELECT id, context_header, text FROM chunks WHERE embedding IS NULL ORDER BY id LIMIT $1',
      [batchSize],
    )
    if (rows.length === 0) return done
    const texts = rows.map((r) => `${r.context_header}\n\n${r.text}`)
    const chars = texts.reduce((a, t) => a + t.length, 0)
    let vectors: number[][]
    try {
      vectors = await provider.embed(texts, 'document')
      await record(db, { provider: 'voyage', model: provider.model, purpose: 'embedding', chars, ok: true })
    } catch (e) {
      await record(db, { provider: 'voyage', model: provider.model, purpose: 'embedding', chars, ok: false, error: (e as Error).message })
      throw e
    }
    await db.tx(async (q) => {
      for (let i = 0; i < rows.length; i++) {
        await q.query('UPDATE chunks SET embedding = $1::vector, embedding_model = $2 WHERE id = $3', [
          toVectorLiteral(vectors[i]),
          provider.model,
          rows[i].id,
        ])
      }
    })
    done += rows.length
    const [{ n }] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM chunks WHERE embedding IS NULL')
    opts.onProgress?.(done, n)
  }
}
