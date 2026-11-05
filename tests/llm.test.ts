import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { getLlm } from '../src/lib/ai/llm'
import { openDb, type Db } from '../src/lib/db/client'

let db: Db
const calls: { url: string; init: RequestInit }[] = []
let responses: { status: number; body: unknown }[] = []

beforeEach(async () => {
  db = await openDb({ embeddingDim: 8 })
  calls.length = 0
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  vi.stubEnv('AI_PROVIDER', 'gemini')
  vi.stubEnv('GEMINI_API_KEY', 'test-key-123')
  vi.stubEnv('AI_MODEL', '')
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = responses.shift()!
    return { ok: r.status < 400, status: r.status, statusText: '', json: async () => r.body }
  })
})
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await db.close()
})

const ok = (obj: unknown, finishReason = 'STOP') => ({
  status: 200,
  body: { candidates: [{ finishReason, content: { parts: [{ text: 'thinking…', thought: true }, { text: JSON.stringify(obj) }] } }] },
})
const call = async () => {
  const llm = getLlm(db)!
  const p = llm.json({ purpose: 'test', system: 'sys', user: 'hello', schema: { type: 'object' }, validate: z.object({ a: z.number() }) })
  p.catch(() => {})
  await vi.runAllTimersAsync()
  return p
}

describe('Gemini provider (simulated API)', () => {
  it('sends the key in a header, uses the default model and parses JSON output', async () => {
    responses = [ok({ a: 1 })]
    expect(getLlm(db)).toMatchObject({ provider: 'gemini', model: 'gemini-3.5-flash' })
    await expect(call()).resolves.toEqual({ a: 1 })
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent')
    expect(calls[0].url).not.toContain('test-key-123')
    expect((calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key-123')
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.generationConfig).toMatchObject({ responseMimeType: 'application/json', responseJsonSchema: { type: 'object' } })
    const [rec] = await db.query<{ provider: string; ok: boolean; chars_sent: number }>('SELECT provider, ok, chars_sent FROM external_calls')
    expect(rec).toEqual({ provider: 'gemini', ok: true, chars_sent: 8 })
  })

  it('retries when Google is busy or rate-limiting, then succeeds', async () => {
    responses = [{ status: 503, body: { error: { message: 'high demand' } } }, { status: 429, body: {} }, ok({ a: 2 })]
    await expect(call()).resolves.toEqual({ a: 2 })
    expect(calls).toHaveLength(3)
  })

  it('reports blocked, truncated and malformed responses as failures and logs them', async () => {
    responses = [{ status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } }]
    await expect(call()).rejects.toThrow(/declined/)
    responses = [ok({ a: 1 }, 'MAX_TOKENS')]
    await expect(call()).rejects.toThrow(/cut off/)
    responses = [ok({ wrong: true })]
    await expect(call()).rejects.toThrow(/expected format/)
    responses = [{ status: 400, body: { error: { message: 'bad request' } } }]
    await expect(call()).rejects.toThrow(/Gemini API error 400/)
    const [{ n }] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM external_calls WHERE NOT ok')
    expect(n).toBe(4)
  })

  it('requires a key when Gemini is selected', () => {
    vi.stubEnv('GEMINI_API_KEY', '')
    expect(() => getLlm(db)).toThrow(/GEMINI_API_KEY/)
  })
})
