/**
 * Retrieval regression check on a 36-question slice of LongMemEval (6 per question type; see
 * bench/make_fixture.py). Each question runs through the real import pipeline and keyword search,
 * and the top results are packed into a 4,000-token budget. The test fails if evidence recall drops
 * below the floors measured when the check was added. Full-size runs: scripts/bench-rankings.ts with
 * memory-recall-bench (https://github.com/Deepanjal-s/memory-recall-bench).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { packBudget, rankConversation, type BenchConversation } from '../src/lib/bench'

interface FixtureConversation extends BenchConversation { kind: string; evidence_groups: string[][] }

const BUDGET = 4000
// Measured 2026-11-17 with keyword search + BM25 re-rank: any-evidence 32/36, all-evidence 28/36
// (recency: 13/36 and 6/36). Floors sit one question below. Ordering by date instead of BM25
// gives 28/36 and 14/36, which fails both. Raise the floors when retrieval improves.
const FLOOR = { any: 31 / 36, all: 27 / 36 }

const fixture: FixtureConversation[] = zlib
  .gunzipSync(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'longmemeval-mini.jsonl.gz')))
  .toString('utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))

function score(conv: FixtureConversation, ranked: string[]) {
  const lengths = new Map(conv.sessions.flatMap((s) => s.messages.map((m) => [m.id, m.content.length] as const)))
  const taken = packBudget(ranked, lengths, BUDGET)
  const hit = conv.evidence_groups.map((g) => g.some((id) => taken.has(id)))
  return { any: hit.some(Boolean), all: hit.every(Boolean) }
}

const rate = (xs: boolean[]) => xs.filter(Boolean).length / xs.length
const pct = (x: number) => `${Math.round(x * 100)}%`

describe('retrieval on LongMemEval (36-question slice)', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-retrieval-'))
  afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }))

  it(
    `keeps evidence recall at ${BUDGET} tokens above the recorded floor and above recency`,
    async () => {
      const app: { kind: string; any: boolean; all: boolean }[] = []
      const recent: { any: boolean; all: boolean }[] = []
      for (const conv of fixture) {
        app.push({ kind: conv.kind, ...score(conv, await rankConversation(conv, workDir)) })
        const newestFirst = conv.sessions.flatMap((s) => s.messages.map((m) => m.id)).reverse()
        recent.push(score(conv, newestFirst))
      }
      const anyApp = rate(app.map((r) => r.any))
      const allApp = rate(app.map((r) => r.all))
      const anyRecent = rate(recent.map((r) => r.any))
      const kinds = [...new Set(app.map((r) => r.kind))].sort()
      console.log(
        [
          `app search: any-evidence ${pct(anyApp)}, all-evidence ${pct(allApp)}`,
          `recency:    any-evidence ${pct(anyRecent)}, all-evidence ${pct(rate(recent.map((r) => r.all)))}`,
          ...kinds.map((k) => {
            const rs = app.filter((r) => r.kind === k)
            return `  ${k}: any ${pct(rate(rs.map((r) => r.any)))}, all ${pct(rate(rs.map((r) => r.all)))} (n=${rs.length})`
          }),
        ].join('\n'),
      )
      expect(anyApp).toBeGreaterThanOrEqual(FLOOR.any)
      expect(allApp).toBeGreaterThanOrEqual(FLOOR.all)
      expect(anyApp).toBeGreaterThan(anyRecent)
    },
    600_000,
  )
})
