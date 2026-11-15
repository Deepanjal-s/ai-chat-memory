import { describe, expect, it } from 'vitest'
import { chunkConversation, MAX_CHARS } from '../src/lib/indexing/chunker'

const header = 'Conversation: "t" · 2024-01-01'

describe('chunkConversation', () => {
  it('keeps a short question and its answer in one unit', () => {
    const chunks = chunkConversation('t', new Date('2024-01-01'), [
      { id: 1, role: 'user', text: 'What is my dog called?' },
      { id: 2, role: 'assistant', text: 'You said Rex.' },
    ])
    expect(chunks).toHaveLength(1)
    expect(chunks[0].messageIds).toEqual([1, 2])
    expect(chunks[0].contextHeader).toBe(header)
  })

  it('splits a long turn into per-message units within the embedder window', () => {
    const para = 'word '.repeat(100).trim() // 499 chars
    const long = Array.from({ length: 8 }, () => para).join('\n\n')
    const chunks = chunkConversation('t', null, [
      { id: 1, role: 'user', text: 'I prefer vegetarian recipes.' },
      { id: 2, role: 'assistant', text: long },
    ])
    expect(chunks[0]).toMatchObject({ messageIds: [1], text: 'User: I prefer vegetarian recipes.' })
    expect(chunks.length).toBeGreaterThan(2)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(MAX_CHARS)
    expect(chunks.slice(1).every((c) => c.messageIds[0] === 2)).toBe(true)
  })
})

describe('splitLongText', () => {
  it('never exceeds the max, even with overlap before a near-max paragraph', async () => {
    const { splitLongText } = await import('../src/lib/indexing/chunker')
    const pieces = splitLongText(['a'.repeat(900), 'b'.repeat(1450), 'c'.repeat(300)].join('\n\n'))
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(MAX_CHARS)
    expect(pieces.join('')).toContain('b'.repeat(1450))
  })
})
