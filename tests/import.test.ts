import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import yazl from 'yazl'
import { openDb, type Db } from '../src/lib/db/client'
import { sha256 } from '../src/lib/hash'
import { registerUpload, runImport } from '../src/lib/importer/import'
import { search } from '../src/lib/search'
import type { EmbeddingProvider } from '../src/lib/indexing/embeddings'
import { embedPendingChunks } from '../src/lib/indexing/embeddings'
import { conversation, marketingConversation, t, vk7Conversation } from './fixtures/build-export'

let db: Db
let dir: string

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-test-'))
  db = await openDb({ embeddingDim: 8 })
})
afterEach(async () => {
  await db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function writeZip(name: string, conversations: unknown[]): Promise<string> {
  const file = path.join(dir, name)
  const zip = new yazl.ZipFile()
  zip.addBuffer(Buffer.from(JSON.stringify(conversations)), 'conversations.json')
  zip.addBuffer(Buffer.from('<html></html>'), 'chat.html')
  zip.end()
  await new Promise<void>((resolve, reject) =>
    zip.outputStream.pipe(fs.createWriteStream(file)).on('close', resolve).on('error', reject),
  )
  return file
}

async function upload(file: string) {
  const tmp = path.join(dir, `upload-${Math.random()}`)
  fs.copyFileSync(file, tmp)
  const buf = fs.readFileSync(tmp)
  return registerUpload(db, {
    tempPath: tmp,
    originalFilename: path.basename(file),
    sha256: sha256(buf),
    size: buf.length,
    sourceLabel: 'ChatGPT',
    rawDir: path.join(dir, 'raw'),
  })
}

async function importFile(file: string) {
  const { batchId, duplicateOf } = await upload(file)
  if (duplicateOf) return { batchId, duplicateOf, stats: null }
  return { batchId, duplicateOf, stats: await runImport(db, batchId) }
}

const count = async (sql: string, params: unknown[] = []) =>
  (await db.query<{ n: number }>(`SELECT (${sql})::int AS n`, params))[0].n

describe('import', () => {
  it('imports a ZIP export completely and reconciles node counts', async () => {
    const { stats, batchId } = await importFile(await writeZip('export1.zip', [vk7Conversation(), marketingConversation()]))
    expect(stats).toMatchObject({ format: 'zip', conversationsInFile: 2, newConversations: 2, failedConversations: 0, nodesInFile: 13 })
    expect(stats!.reconciliation).toMatchObject({ ok: true, expectedNodes: 13, storedNodes: 13 })
    expect(await count('SELECT count(*) FROM messages')).toBe(13)
    expect(await count('SELECT count(*) FROM conversation_versions')).toBe(2)
    const [b] = await db.query<{ status: string }>('SELECT status FROM import_batches WHERE id = $1', [batchId])
    expect(b.status).toBe('complete')
  })

  it('stores the original JSON verbatim for verification', async () => {
    await importFile(await writeZip('e.zip', [vk7Conversation()]))
    const [v] = await db.query<{ raw: unknown }>('SELECT raw FROM conversation_versions')
    expect(v.raw).toEqual(JSON.parse(JSON.stringify(vk7Conversation())))
  })

  it('treats re-uploading the same file as a duplicate and does nothing', async () => {
    const file = await writeZip('e.zip', [vk7Conversation()])
    await importFile(file)
    const second = await importFile(file)
    expect(second.duplicateOf).not.toBeNull()
    expect(await count('SELECT count(*) FROM conversations')).toBe(1)
    expect(await count('SELECT count(*) FROM messages')).toBe(10)
  })

  it('merges a newer export without duplicating: unchanged, updated and new conversations', async () => {
    await importFile(await writeZip('old.zip', [vk7Conversation(), marketingConversation()]))
    const newer = vk7Conversation(
      [{ id: 'u3', parent: 'a2b', role: 'user', text: 'Add a players table with jersey numbers.', time: t('2026-03-05T09:00:00Z') }],
      'u3',
    )
    newer.update_time = t('2026-03-05T09:00:00Z')
    const third = conversation({
      id: 'conv-new',
      title: 'Hiring plan',
      create: t('2026-05-01T08:00:00Z'),
      update: t('2026-05-01T08:00:00Z'),
      current: 'h1',
      messages: [
        { id: 'hr', parent: null },
        { id: 'h1', parent: 'hr', role: 'user', text: 'Draft a hiring plan for two backend engineers.' },
      ],
    })
    const { stats } = await importFile(await writeZip('new.zip', [newer, marketingConversation(), third]))
    expect(stats).toMatchObject({
      newConversations: 1,
      updatedConversations: 1,
      unchangedConversations: 1,
      messagesAdded: 3,
      messagesChanged: 0,
      missingFromExport: 0,
    })
    expect(stats!.reconciliation!.ok).toBe(true)
    expect(await count('SELECT count(*) FROM conversations')).toBe(3)
    expect(await count("SELECT count(*) FROM conversation_versions v JOIN conversations c ON c.id = v.conversation_id WHERE c.external_id = 'conv-vk7'")).toBe(2)
    expect(await count("SELECT max(canonical_position) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.external_id = 'conv-vk7'")).toBe(7)
  })

  it('flags (never deletes) conversations missing from a newer full export', async () => {
    await importFile(await writeZip('a.zip', [vk7Conversation(), marketingConversation()]))
    const later = vk7Conversation()
    later.update_time = t('2026-06-01T00:00:00Z')
    later.title = 'VK7SPORTS backend planning (renamed)'
    const { stats } = await importFile(await writeZip('b.zip', [later]))
    expect(stats!.missingFromExport).toBe(1)
    expect(await count('SELECT count(*) FROM conversations WHERE missing_since_batch_id IS NOT NULL')).toBe(1)
    expect(await count('SELECT count(*) FROM messages')).toBe(13)
  })

  it('does not roll a conversation back when an older export is imported later', async () => {
    const newer = vk7Conversation()
    newer.update_time = t('2026-07-01T00:00:00Z')
    newer.title = 'VK7SPORTS backend planning v2'
    await importFile(await writeZip('newer.zip', [newer]))
    const { stats } = await importFile(await writeZip('older.zip', [vk7Conversation()]))
    expect(stats).toMatchObject({ olderVersionsKept: 1, updatedConversations: 0 })
    expect(stats!.reconciliation!.ok).toBe(true)
    const [c] = await db.query<{ title: string }>('SELECT title FROM conversations')
    expect(c.title).toBe('VK7SPORTS backend planning v2')
    expect(await count('SELECT count(*) FROM conversation_versions')).toBe(2)
  })

  it('records a bad conversation as an error without losing the others', async () => {
    const { stats, batchId } = await importFile(await writeZip('bad.zip', [{ title: 'broken' }, marketingConversation()]))
    expect(stats).toMatchObject({ failedConversations: 1, newConversations: 1 })
    const [b] = await db.query<{ status: string }>('SELECT status FROM import_batches WHERE id = $1', [batchId])
    expect(b.status).toBe('complete_with_errors')
    expect(await count("SELECT count(*) FROM import_issues WHERE severity = 'error'")).toBe(1)
  })

  it('accepts a bare conversations.json and rejects files that are not exports', async () => {
    const json = path.join(dir, 'conversations.json')
    fs.writeFileSync(json, JSON.stringify([marketingConversation()]))
    expect((await importFile(json)).stats).toMatchObject({ format: 'json', newConversations: 1 })

    const notExport = path.join(dir, 'other.json')
    fs.writeFileSync(notExport, JSON.stringify({ hello: 'world' }))
    const { batchId } = await upload(notExport)
    await expect(runImport(db, batchId)).rejects.toThrow()
    const [b] = await db.query<{ status: string }>('SELECT status FROM import_batches WHERE id = $1', [batchId])
    expect(b.status).toBe('failed')
  })

  it('builds turn-based chunks from the canonical thread only', async () => {
    await importFile(await writeZip('e.zip', [vk7Conversation()]))
    const chunks = await db.query<{ text: string; context_header: string }>('SELECT text, context_header FROM chunks ORDER BY ordinal')
    expect(chunks).toHaveLength(2)
    expect(chunks[0].text).toMatch(/^User: What database should the VK7SPORTS backend use/)
    expect(chunks[0].text).toContain('Assistant: I suggest PostgreSQL')
    expect(chunks.map((c) => c.text).join()).not.toContain('MongoDB')
    expect(chunks[0].context_header).toBe('Conversation: "VK7SPORTS backend planning" · 2026-03-01')
  })
})

describe('search', () => {
  beforeEach(async () => {
    await importFile(await writeZip('e.zip', [vk7Conversation(), marketingConversation()]))
  })

  it('finds messages by keyword with highlighted snippets and title matches', async () => {
    const r = await search(db, { q: 'vk7sports postgresql' }, null)
    expect(r.hits.length).toBeGreaterThan(0)
    expect(r.hits[0].conversationTitle).toBe('VK7SPORTS backend planning')
    expect(r.hits[0].snippet).toContain('\u0001')
    expect(r.conversations.map((c) => c.title)).toContain('VK7SPORTS backend planning')
  })

  it('ranks messages containing all terms first, but still returns partial matches', async () => {
    const r = await search(db, { q: 'PostgreSQL schema' }, null)
    expect(r.hits[0].snippet.replace(/[\u0001\u0002]/g, '')).toMatch(/PostgreSQL.*schema/)
    expect(r.hits.length).toBeGreaterThanOrEqual(2)
  })

  it('hides edited-away branches and hidden context unless asked', async () => {
    expect((await search(db, { q: 'MongoDB' }, null)).hits).toHaveLength(0)
    const withBranches = await search(db, { q: 'MongoDB', includeBranches: true }, null)
    expect(withBranches.hits).toHaveLength(1)
    expect(withBranches.hits[0].isCanonical).toBe(false)
    expect((await search(db, { q: 'cost section' }, null)).hits).toHaveLength(0)
    expect((await search(db, { q: 'cost section', includeHidden: true }, null)).hits).toHaveLength(1)
  })

  it('applies role and date filters, and honours exclusions', async () => {
    expect((await search(db, { q: 'PostgreSQL', role: 'user' }, null)).hits.every((h) => h.role === 'user')).toBe(true)
    expect((await search(db, { q: 'PostgreSQL', from: '2026-04-01' }, null)).hits).toHaveLength(0)
    expect((await search(db, { q: 'cricket', to: '2026-04-10' }, null)).hits).toHaveLength(1)
    const r = await search(db, { q: 'PostgreSQL -schema' }, null)
    expect(r.hits.every((h) => !/schema/i.test(h.snippet))).toBe(true)
  })

  it('fuses semantic matches when embeddings exist', async () => {
    // Deterministic toy embedder: dimension i = presence of a keyword.
    const vocab = ['database', 'postgresql', 'schema', 'marketing', 'cricket', 'campaign', 'coaching', 'schools']
    const provider: EmbeddingProvider = {
      name: 'toy',
      external: true,
      model: 'toy',
      dim: 8,
      async embed(texts) {
        return texts.map((s) => vocab.map((w) => (s.toLowerCase().includes(w) ? 1 : 0.001)))
      },
    }
    expect(await embedPendingChunks(db, provider)).toBe(3)
    const r = await search(db, { q: 'promotion campaign for coaching' }, provider)
    expect(r.hits[0].conversationTitle).toBe('Q2 marketing ideas')
    expect(r.hits.some((h) => h.matchedBy.includes('semantic'))).toBe(true)
  })

  it('logs external embedding calls but not on-device ones', async () => {
    const calls = async () => (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM external_calls'))[0].n
    const toy = (external: boolean): EmbeddingProvider => ({
      name: external ? 'remote-toy' : 'local',
      external,
      model: 'toy',
      dim: 8,
      async embed(texts) {
        return texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0])
      },
    })
    const before = await calls()
    await search(db, { q: 'cricket' }, toy(false))
    expect(await calls()).toBe(before)
    await search(db, { q: 'cricket' }, toy(true))
    expect(await calls()).toBe(before + 1)
  })
})
