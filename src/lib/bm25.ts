/**
 * Okapi BM25 over PostgreSQL tsvectors.
 *
 * PostgreSQL's ts_rank/ts_rank_cd have no inverse document frequency: a rare, telling word ("Priya") counts the
 * same as a common one ("use"), and long messages win by sheer volume. Measured with memory-recall-bench on
 * LongMemEval_s, that left the right message out of a 4k-token context far more often than plain BM25.
 * Postgres still does the fast part (candidate filtering with the GIN index); this file does the ranking.
 */

export interface Bm25Doc {
  id: number
  /** tsvector in its text form, e.g. `'priya':3 'sister':2,7`. */
  tsv: string
}

export interface CorpusStats {
  /** Number of documents searched. */
  n: number
  /** Average document length in distinct lexemes, i.e. avg(length(tsv)) in SQL. */
  avgLen: number
  /** Documents containing each query lexeme. */
  df: Map<string, number>
}

const ENTRY = /'((?:[^']|'')+)'(?::([\d,A-D]+))?/g

/**
 * Lexeme → term frequency, from a tsvector's text form. Positions are counted; a lexeme without positions counts
 * once. `length` is the number of distinct lexemes, matching PostgreSQL's length(tsvector), so document length and
 * the corpus average use the same measure.
 */
export function parseTsvector(tsv: string): { tf: Map<string, number>; length: number } {
  const tf = new Map<string, number>()
  for (const m of tsv.matchAll(ENTRY)) {
    const lexeme = m[1].replace(/''/g, "'")
    const count = m[2] ? m[2].split(',').length : 1
    tf.set(lexeme, (tf.get(lexeme) ?? 0) + count)
  }
  return { tf, length: tf.size }
}

/** Scores documents for the given query lexemes. Higher is better. */
export function bm25Scores(docs: Bm25Doc[], lexemes: string[], stats: CorpusStats, k1 = 1.2, b = 0.75): Map<number, number> {
  const unique = [...new Set(lexemes)]
  const idf = new Map(unique.map((l) => {
    const df = stats.df.get(l) ?? 0
    return [l, Math.log(1 + (stats.n - df + 0.5) / (df + 0.5))]
  }))
  const scores = new Map<number, number>()
  for (const d of docs) {
    const { tf, length } = parseTsvector(d.tsv)
    const norm = 1 - b + b * (stats.avgLen > 0 ? length / stats.avgLen : 1)
    let s = 0
    for (const l of unique) {
      const f = tf.get(l)
      if (f) s += idf.get(l)! * ((f * (k1 + 1)) / (f + k1 * norm))
    }
    scores.set(d.id, s)
  }
  return scores
}
