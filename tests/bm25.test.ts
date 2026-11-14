import { describe, expect, it } from 'vitest'
import { bm25Scores, parseTsvector, type CorpusStats } from '../src/lib/bm25'

describe('parseTsvector', () => {
  it('counts positions per lexeme and handles quotes and weights', () => {
    const { tf, length } = parseTsvector(`'priya':3 'sister':2,7B 'o''brien':5 'nopos'`)
    expect(tf.get('priya')).toBe(1)
    expect(tf.get('sister')).toBe(2)
    expect(tf.get("o'brien")).toBe(1)
    expect(tf.get('nopos')).toBe(1)
    expect(length).toBe(4) // distinct lexemes, like PostgreSQL length(tsvector)
  })
})

describe('bm25Scores', () => {
  const stats = (df: Record<string, number>, n = 100, avgLen = 10): CorpusStats => ({ n, avgLen, df: new Map(Object.entries(df)) })

  it('weights a rare term above a common one (IDF), unlike ts_rank', () => {
    const docs = [
      { id: 1, tsv: `'use':1,2,3` }, // common word, repeated
      { id: 2, tsv: `'priya':1` }, // rare name, once
    ]
    const s = bm25Scores(docs, ['use', 'priya'], stats({ use: 90, priya: 2 }))
    expect(s.get(2)!).toBeGreaterThan(s.get(1)!)
  })

  it('normalises for length: the same match in a short message beats a long one', () => {
    const long = Array.from({ length: 60 }, (_, i) => `'w${i}':${i + 2}`).join(' ')
    const docs = [
      { id: 1, tsv: `'degre':1 ${long}` },
      { id: 2, tsv: `'degre':1 'busi':2` },
    ]
    const s = bm25Scores(docs, ['degre'], stats({ degre: 5 }))
    expect(s.get(2)!).toBeGreaterThan(s.get(1)!)
  })

  it('saturates term frequency and ignores duplicate query lexemes', () => {
    const docs = [{ id: 1, tsv: `'x':1` }, { id: 2, tsv: `'x':1,2,3,4,5,6,7,8,9,10` }]
    const once = bm25Scores(docs, ['x'], stats({ x: 10 }))
    const twice = bm25Scores(docs, ['x', 'x'], stats({ x: 10 }))
    expect(once.get(2)! / once.get(1)!).toBeLessThan(3)
    expect(twice.get(1)).toBeCloseTo(once.get(1)!)
  })
})
