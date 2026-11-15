import { config } from '../config'
import { record } from '../ai/llm'
import type { Db } from '../db/client'

export interface EmbeddingProvider {
  /** Recorded in external_calls when `external` is true. */
  name: string
  /** True when text leaves this machine (logged in external_calls); false for the local model. */
  external: boolean
  model: string
  dim: number
  embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]>
}

export function getEmbeddingProvider(): EmbeddingProvider | null {
  switch (config.embeddingProvider) {
    case 'voyage':
      if (!config.voyageApiKey) throw new Error('EMBEDDING_PROVIDER=voyage requires VOYAGE_API_KEY')
      return voyageProvider(config.voyageApiKey, config.embeddingModel, config.embeddingDim)
    case 'local':
      return localProvider(config.embeddingModel, config.embeddingDim)
    default:
      return null
  }
}

function voyageProvider(apiKey: string, model: string, dim: number): EmbeddingProvider {
  return {
    name: 'voyage',
    external: true,
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

/** bge models want this instruction on queries (not on documents). */
const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '

type FeatureExtractor = (
  texts: string[],
  opts: { pooling: 'cls' | 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>
const extractors = new Map<string, Promise<FeatureExtractor>>()

/**
 * Embeddings computed on this machine with transformers.js (ONNX, CPU). No API key, and no message text leaves the
 * computer. The model (about 35 MB quantized for bge-small) is downloaded once from Hugging Face and cached.
 * Measured on LongMemEval_s with memory-recall-bench, bge-small fused with BM25 is the safe upgrade over keyword
 * search alone (see README, "Measured retrieval quality").
 */
export function localProvider(model: string, dim: number): EmbeddingProvider {
  const isBge = /bge/i.test(model)
  const load = () => {
    let p = extractors.get(model)
    if (!p) {
      p = import('@huggingface/transformers')
        .catch(() => {
          throw new Error('EMBEDDING_PROVIDER=local needs the optional package: npm install @huggingface/transformers')
        })
        .then(({ pipeline }) => pipeline('feature-extraction', model, { dtype: 'q8' }) as unknown as Promise<FeatureExtractor>)
      p.catch(() => extractors.delete(model)) // a failed load can be retried
      extractors.set(model, p)
    }
    return p
  }
  return {
    name: 'local',
    external: false,
    model,
    dim,
    async embed(texts, kind) {
      const fe = await load()
      const input = kind === 'query' && isBge ? texts.map((t) => BGE_QUERY_PREFIX + t) : texts
      const vectors = (await fe(input, { pooling: isBge ? 'cls' : 'mean', normalize: true })).tolist()
      if (vectors[0] && vectors[0].length !== dim) {
        throw new Error(`${model} returns ${vectors[0].length}-dimension vectors but EMBEDDING_DIM is ${dim}.`)
      }
      return vectors
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
      if (provider.external) await record(db, { provider: provider.name, model: provider.model, purpose: 'embedding', chars, ok: true })
    } catch (e) {
      if (provider.external) {
        await record(db, { provider: provider.name, model: provider.model, purpose: 'embedding', chars, ok: false, error: (e as Error).message })
      }
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
