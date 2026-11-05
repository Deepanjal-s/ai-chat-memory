import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import yazl from 'yazl'
import type { Llm } from '../src/lib/ai/llm'
import { ingestCapture, type CapturePayload } from '../src/lib/capture/ingest'
import { openDb, type Db } from '../src/lib/db/client'
import { buildDocument } from '../src/lib/documents/build'
import { renderDocx, renderMarkdown, renderPdf } from '../src/lib/documents/render'
import { sha256 } from '../src/lib/hash'
import { registerUpload, runImport } from '../src/lib/importer/import'
import { scanFolder } from '../src/lib/importer/watcher'
import { enqueueJob, runNextJob } from '../src/lib/jobs'
import { heuristicExtract } from '../src/lib/knowledge/heuristic'
import { processConversation } from '../src/lib/knowledge/process'
import { verifyQuote } from '../src/lib/knowledge/types'
import { answerQuestion, verifyCitations } from '../src/lib/qa'
import { runBackup } from '../src/lib/backup'
import { createExtensionToken, verifyExtensionToken, revokeExtensionToken } from '../src/lib/settings'
import { conversation, t } from './fixtures/build-export'

let db: Db
let dir: string
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-mem-'))
  db = await openDb({ embeddingDim: 8 })
})
afterEach(async () => {
  await db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const n = async (sql: string, params: unknown[] = []) => (await db.query<{ n: number }>(`SELECT (${sql})::int AS n`, params))[0].n

/** Two conversations about the same project on different days: the database decision changes. */
function projectConversations() {
  const c1 = conversation({
    id: 'c1-aaaaaaaa',
    title: 'VK7SPORTS backend planning',
    create: t('2026-03-01T10:00:00Z'),
    update: t('2026-03-01T10:30:00Z'),
    current: 'a2',
    messages: [
      { id: 'r1', parent: null },
      { id: 'u1', parent: 'r1', role: 'user', text: 'Which database should VK7SPORTS use for match statistics?', time: t('2026-03-01T10:00:00Z') },
      { id: 'a1', parent: 'u1', role: 'assistant', text: 'I recommend PostgreSQL for relational match data.', time: t('2026-03-01T10:00:20Z') },
      { id: 'u2', parent: 'a1', role: 'user', text: 'Decision: VK7SPORTS will use PostgreSQL for match statistics. Pending: design the players table by end of March.', time: t('2026-03-01T10:05:00Z') },
      { id: 'a2', parent: 'u2', role: 'assistant', text: 'Great. Here is a players table design.', time: t('2026-03-01T10:05:30Z') },
    ],
  })
  const c2 = conversation({
    id: 'c2-bbbbbbbb',
    title: 'VK7SPORTS scaling issues',
    create: t('2026-05-10T09:00:00Z'),
    update: t('2026-05-10T09:30:00Z'),
    current: 'b2',
    messages: [
      { id: 'r2', parent: null },
      { id: 'v1', parent: 'r2', role: 'user', text: 'The VK7SPORTS live score feed has an issue: writes are failing under load.', time: t('2026-05-10T09:00:00Z') },
      { id: 'b1', parent: 'v1', role: 'assistant', text: 'You could use Redis as a write buffer in front of the database.', time: t('2026-05-10T09:00:30Z') },
      { id: 'v2', parent: 'b1', role: 'user', text: 'Decision: VK7SPORTS will use MongoDB for match statistics instead of PostgreSQL.', time: t('2026-05-10T09:10:00Z') },
      { id: 'b2', parent: 'v2', role: 'assistant', text: 'Understood, here is a migration plan.', time: t('2026-05-10T09:10:30Z') },
    ],
  })
  return [c1, c2]
}

async function importConvs(convs: unknown[], name = 'export.zip') {
  const file = path.join(dir, name)
  const zip = new yazl.ZipFile()
  zip.addBuffer(Buffer.from(JSON.stringify(convs)), 'conversations.json')
  zip.addBuffer(Buffer.from('<html></html>'), 'chat.html')
  zip.end()
  await new Promise<void>((res, rej) => zip.outputStream.pipe(fs.createWriteStream(file)).on('close', res).on('error', rej))
  const tmp = path.join(dir, `up-${Math.random()}`)
  fs.copyFileSync(file, tmp)
  const buf = fs.readFileSync(tmp)
  const { batchId } = await registerUpload(db, { tempPath: tmp, originalFilename: name, sha256: sha256(buf), size: buf.length, sourceLabel: 'ChatGPT', rawDir: path.join(dir, 'raw') })
  return runImport(db, batchId)
}

const convId = async (ext: string) => (await db.query<{ id: number }>('SELECT id FROM conversations WHERE external_id = $1', [ext]))[0].id

describe('rule-based extraction (no AI)', () => {
  it('classifies decisions, suggestions, tasks and problems conservatively', () => {
    const x = heuristicExtract('VK7SPORTS backend planning', [
      { id: 1, role: 'user', text: 'Decision: VK7SPORTS will use PostgreSQL. Pending: design the players table by end of March.', createdAt: null },
      { id: 2, role: 'assistant', text: 'I recommend PostgreSQL for relational data. Decision: we go with Oracle.', createdAt: null },
      { id: 3, role: 'user', text: 'The login page has a bug when the password is empty.', createdAt: null },
    ])
    const by = (k: string, s: string) => x.items.filter((i) => i.kind === k && i.status === s)
    expect(by('decision', 'confirmed')).toHaveLength(1)
    expect(by('decision', 'proposed')).toHaveLength(1)
    // ChatGPT saying "Decision:" is never a confirmed decision.
    expect(x.items.some((i) => i.message_id === 2 && i.status === 'confirmed')).toBe(false)
    expect(by('task', 'open')[0].due).toMatch(/end of March/)
    expect(by('problem', 'discussed')).toHaveLength(1)
    expect(x.entities.map((e) => e.name)).toEqual(expect.arrayContaining(['VK7SPORTS', 'PostgreSQL']))
  })

  it('rejects quotes that are not in the cited message', () => {
    const msgs = new Map([[1, { id: 1, role: 'user', text: 'We will launch **VK7SPORTS** in   April.', createdAt: null }]])
    expect(verifyQuote({ quote: 'launch VK7SPORTS in April', message_id: 1 }, msgs)).toBe(true)
    expect(verifyQuote({ quote: 'launch VK7SPORTS in May', message_id: 1 }, msgs)).toBe(false)
    expect(verifyQuote({ quote: 'launch VK7SPORTS in April', message_id: 2 }, msgs)).toBe(false)
  })
})

describe('knowledge processing', () => {
  it('builds a cross-conversation record and flags the changed decision for review', async () => {
    await importConvs(projectConversations())
    // Imports queue processing jobs automatically.
    expect(await n("SELECT count(*) FROM jobs WHERE kind = 'process_conversation' AND status = 'queued'")).toBe(2)
    const { handlers } = await import('../src/lib/pipeline')
    while (await runNextJob(db, handlers)) {}
    expect(await n("SELECT count(*) FROM jobs WHERE status = 'failed'")).toBe(0)

    const vk7 = (await db.query<{ id: number }>("SELECT id FROM entities WHERE norm_name = 'vk7sports'"))[0]
    expect(vk7).toBeTruthy()
    expect(await n('SELECT count(*) FROM conversation_entities WHERE entity_id = $1', [vk7.id])).toBe(2)
    expect(await n("SELECT count(*) FROM knowledge_items WHERE kind = 'decision' AND status = 'confirmed'")).toBe(2)
    expect(await n('SELECT count(*) FROM knowledge_items k WHERE NOT EXISTS (SELECT 1 FROM evidence e WHERE e.item_id = k.id)')).toBe(0)
    const rel = await db.query<{ type: string; later: string; earlier: string }>(
      `SELECT r.type, a.statement AS later, b.statement AS earlier FROM item_relations r
         JOIN knowledge_items a ON a.id = r.from_item JOIN knowledge_items b ON b.id = r.to_item WHERE a.kind = 'decision'`,
    )
    expect(rel.some((r) => r.type === 'possibly_changes' && /MongoDB/.test(r.later) && /PostgreSQL/.test(r.earlier) && !/MongoDB/.test(r.earlier))).toBe(true)

    // Re-processing unchanged content is skipped.
    const again = await processConversation(db, await convId('c1-aaaaaaaa'), null)
    expect(again.skipped).toBe(true)
  })

  it('with an AI extractor: discards fabricated quotes and records supersession', async () => {
    await importConvs(projectConversations())
    const msgId = async (text: string) => (await db.query<{ id: number }>('SELECT id FROM messages WHERE content_text LIKE $1', [`%${text}%`]))[0].id
    const pgMsg = await msgId('will use PostgreSQL')
    const mongoMsg = await msgId('will use MongoDB')
    const calls: string[] = []
    const fake: Llm = {
      provider: 'fake',
      model: 'test',
      async json({ purpose, user }) {
        calls.push(purpose)
        if (purpose === 'change_detection') return { pairs: [{ pair: 0, relation: 'supersedes', explanation: 'Database changed to MongoDB.' }] } as never
        const isFirst = user.includes('backend planning')
        return {
          summary: isFirst ? 'Chose PostgreSQL.' : 'Switched to MongoDB.',
          entities: [{ name: 'VK7SPORTS', kind: 'project' }],
          items: isFirst
            ? [
                { kind: 'decision', status: 'confirmed', statement: 'VK7SPORTS uses PostgreSQL for match statistics.', quote: 'VK7SPORTS will use PostgreSQL for match statistics', message_id: pgMsg, due: null, entities: ['VK7SPORTS'] },
                { kind: 'decision', status: 'confirmed', statement: 'Invented decision.', quote: 'we will buy a stadium', message_id: pgMsg, due: null, entities: ['VK7SPORTS'] },
              ]
            : [{ kind: 'decision', status: 'confirmed', statement: 'VK7SPORTS uses MongoDB for match statistics.', quote: 'VK7SPORTS will use MongoDB for match statistics', message_id: mongoMsg, due: null, entities: ['vk7 sports'] }],
        } as never
      },
    }
    const r1 = await processConversation(db, await convId('c1-aaaaaaaa'), fake)
    expect(r1).toMatchObject({ items: 1, rejectedQuotes: 1 })
    const r2 = await processConversation(db, await convId('c2-bbbbbbbb'), fake)
    expect(r2.relations).toBe(1)
    const [rel] = await db.query<{ later: string; earlier: string }>(
      `SELECT a.statement AS later, b.statement AS earlier FROM item_relations r
         JOIN knowledge_items a ON a.id = r.from_item JOIN knowledge_items b ON b.id = r.to_item WHERE r.type = 'supersedes'`,
    )
    expect(rel).toEqual({ later: 'VK7SPORTS uses MongoDB for match statistics.', earlier: 'VK7SPORTS uses PostgreSQL for match statistics.' })
    // "vk7 sports" resolved to the same entity as "VK7SPORTS".
    expect(await n("SELECT count(*) FROM entities WHERE norm_name = 'vk7sports'")).toBe(1)
    expect(await n('SELECT count(*) FROM external_calls')).toBe(0) // fake provider does not log; real one does (see llm.ts)

    // Question answering marks the earlier decision as outdated and verifies citations.
    const answerLlm: Llm = {
      ...fake,
      async json({ user }) {
        expect(user).toMatch(/OUTDATED \(replaced by S\d+\)/)
        return { answer: 'VK7SPORTS now uses MongoDB [S1], replacing PostgreSQL [S2]. Budget was approved [S99].', confidence: 'high', conflicts: [] } as never
      },
    }
    const a = await answerQuestion(db, 'What database does VK7SPORTS use?', answerLlm)
    expect(a.mode).toBe('ai')
    expect(a.removedCitations).toBe(1)
    expect(a.answer).not.toContain('[S99]')
    expect(a.entities.map((e) => e.name)).toContain('VK7SPORTS')
  })
})

describe('question answering without AI', () => {
  it('returns the verified record grouped by status with valid citations', async () => {
    await importConvs(projectConversations())
    for (const ext of ['c1-aaaaaaaa', 'c2-bbbbbbbb']) await processConversation(db, await convId(ext), null)
    const a = await answerQuestion(db, 'What decisions were made about VK7SPORTS database?', null)
    expect(a.mode).toBe('local')
    expect(a.answer).toContain('**Confirmed decisions**')
    expect(a.answer).toMatch(/MongoDB.*\[S\d+\]/)
    expect(a.answer).toMatch(/possibly changed later/)
    const { removed, cited } = verifyCitations(a.answer, a.sources.length)
    expect(removed).toBe(0)
    expect(cited.size).toBeGreaterThan(0)
  })

  it('keeps answers about a named project free of other projects', async () => {
    const other = conversation({
      id: 'c3-cccccccc',
      title: 'HELIXAI backend',
      create: t('2026-05-12T08:00:00Z'),
      update: t('2026-05-12T08:10:00Z'),
      current: 'h1',
      messages: [
        { id: 'hr', parent: null },
        { id: 'h1', parent: 'hr', role: 'user', text: 'Decision: HELIXAI will use the PostgreSQL database for match statistics too.', time: t('2026-05-12T08:00:00Z') },
      ],
    })
    await importConvs([...projectConversations(), other])
    for (const ext of ['c1-aaaaaaaa', 'c2-bbbbbbbb', 'c3-cccccccc']) await processConversation(db, await convId(ext), null)
    const a = await answerQuestion(db, 'What database does VK7SPORTS use for match statistics?', null)
    expect(a.sources.length).toBeGreaterThan(0)
    expect(a.sources.every((s) => s.conversationTitle.startsWith('VK7SPORTS'))).toBe(true)
    expect(a.answer).not.toContain('HELIXAI')
  })

  it('says so when nothing relevant exists', async () => {
    await importConvs(projectConversations())
    const a = await answerQuestion(db, 'Quarterly tax filing for the bakery', null)
    expect(a.confidence).toBe('insufficient')
    expect(a.sources).toHaveLength(0)
  })

  it('verifyCitations keeps valid and drops invalid references', () => {
    const r = verifyCitations('A [S1] B [S3] C [S0]', 2)
    expect(r).toMatchObject({ text: 'A [S1] B  C ', removed: 2 })
    expect(verifyCitations('X [S1, S2] Y [S2; 5]', 3)).toMatchObject({ text: 'X [S1][S2] Y [S2]', removed: 1 })
  })

  it('only links a conversation to entities it actually names', async () => {
    const { mentionChecker } = await import('../src/lib/knowledge/process')
    const has = mentionChecker('We launch VK7 Sports on AWS. The laws changed.')
    expect(has('VK7SPORTS')).toBe(true)
    expect(has('AWS')).toBe(true)
    expect(has('aw')).toBe(false)
    expect(has('HELIXAI')).toBe(false)
    expect(mentionChecker('Ideas for a cricket academy launch campaign')('VK7SPORTS')).toBe(false)
  })
})

describe('documents', () => {
  it('generates PDF, DOCX and Markdown with sources from a project', async () => {
    await importConvs(projectConversations())
    for (const ext of ['c1-aaaaaaaa', 'c2-bbbbbbbb']) await processConversation(db, await convId(ext), null)
    const [vk7] = await db.query<{ id: number }>("SELECT id FROM entities WHERE norm_name = 'vk7sports'")
    const model = await buildDocument(db, { entityId: vk7.id, docType: 'project_report', formats: ['pdf', 'docx', 'md'] }, null)
    expect(model.sections.map((s) => s.heading)).toEqual(
      expect.arrayContaining(['Overview', 'Timeline of discussions', 'Decisions', 'Pending work', 'Changes and conflicts']),
    )
    expect(model.sources.length).toBeGreaterThan(0)
    const md = renderMarkdown(model).toString()
    expect(md).toContain('## Sources')
    expect(md).toMatch(/PostgreSQL.*\[\d+\]/)
    expect(md).toMatch(/players table/)
    // A typed subject naming the project finds the same records as choosing the project.
    const typed = await buildDocument(db, { query: 'VK7SPORTS', docType: 'decision_record', formats: ['md'] }, null)
    expect(renderMarkdown(typed).toString()).toMatch(/PostgreSQL/)
    const pdf = await renderPdf(model)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    const docx = await renderDocx(model)
    expect(docx.subarray(0, 2).toString()).toBe('PK')
  })
})

describe('live capture', () => {
  const payload = (messages: CapturePayload['messages'], at = '2026-06-01T10:00:00.000Z'): CapturePayload => ({
    conversationId: 'live-1234-abcd',
    title: 'Hiring plan',
    url: 'https://chatgpt.com/c/live-1234-abcd',
    capturedAt: at,
    extensionVersion: '1.0.0',
    messages,
  })
  const canonical = async () =>
    (
      await db.query<{ role: string; content_text: string }>(
        `SELECT role, content_text FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.external_id = 'live-1234-abcd' AND m.is_canonical AND m.present_in_latest AND NOT m.is_hidden ORDER BY canonical_position`,
      )
    ).map((r) => `${r.role}: ${r.content_text}`)

  it('captures new conversations, continuations and regenerations without duplicates', async () => {
    const u1 = { id: 'm-u1', role: 'user' as const, text: 'Draft a hiring plan for two backend engineers.' }
    const a1 = { id: 'm-a1', role: 'assistant' as const, text: 'Here is a draft plan.' }
    const r1 = await ingestCapture(db, payload([u1, a1]))
    expect(r1).toMatchObject({ created: true, added: 2 })
    expect(await n("SELECT count(*) FROM jobs WHERE kind = 'process_conversation'")).toBe(1)

    // Same page captured again: nothing changes.
    expect(await ingestCapture(db, payload([u1, a1]))).toMatchObject({ added: 0, updated: 0, unchanged: 2 })

    // Conversation continued.
    const u2 = { id: 'm-u2', role: 'user' as const, text: 'Make it remote-first.' }
    const a2 = { id: 'm-a2', role: 'assistant' as const, text: 'Updated plan, remote-first.' }
    expect(await ingestCapture(db, payload([u1, a1, u2, a2], '2026-06-01T10:05:00.000Z'))).toMatchObject({ added: 2 })

    // Reply regenerated: the old reply becomes an earlier version.
    const a2b = { id: 'm-a2b', role: 'assistant' as const, text: 'Alternative remote-first plan.', variant: { index: 2, count: 2 } }
    const r = await ingestCapture(db, payload([u1, a1, u2, a2b], '2026-06-01T10:06:00.000Z'))
    expect(r).toMatchObject({ added: 1, movedToEarlierVersions: 1 })
    expect(await canonical()).toEqual([
      'user: Draft a hiring plan for two backend engineers.',
      'assistant: Here is a draft plan.',
      'user: Make it remote-first.',
      'assistant: Alternative remote-first plan.',
    ])
    expect(await n("SELECT count(*) FROM messages WHERE node_external_id = 'm-a2' AND NOT is_canonical")).toBe(1)
    expect(await n("SELECT message_count FROM conversations WHERE external_id = 'live-1234-abcd'")).toBe(4)
    expect(await n('SELECT count(*) FROM capture_events')).toBe(4)

    // Messages without ids are matched by text, so re-capturing does not duplicate them.
    const noIds = [u1, a1, u2, a2b].map((m) => ({ ...m, id: null }))
    expect(await ingestCapture(db, payload(noIds, '2026-06-01T10:07:00.000Z'))).toMatchObject({ added: 0 })
  })

  it('reconciles with a later official export: export wins, newer live messages are kept', async () => {
    const exportConv = conversation({
      id: 'live-1234-abcd',
      title: 'Hiring plan',
      create: t('2026-06-01T09:59:00Z'),
      update: t('2026-06-01T10:00:30Z'),
      current: 'm-a1',
      messages: [
        { id: 'root', parent: null },
        { id: 'm-u1', parent: 'root', role: 'user', text: 'Draft a hiring plan for two backend engineers.', time: t('2026-06-01T09:59:00Z') },
        { id: 'm-a1', parent: 'm-u1', role: 'assistant', text: 'Here is a draft plan (export text).', time: t('2026-06-01T10:00:00Z') },
      ],
    })
    await ingestCapture(db, payload([
      { id: 'm-u1', role: 'user', text: 'Draft a hiring plan for two backend engineers.' },
      { id: 'm-a1', role: 'assistant', text: 'Here is a draft plan.' },
      { id: 'm-u2', role: 'user', text: 'Make it remote-first.' },
    ], '2026-06-01T10:05:00.000Z'))
    const stats = await importConvs([exportConv])
    expect(stats.reconciliation!.ok).toBe(true)
    expect(stats.updatedConversations).toBe(1)
    expect(await canonical()).toEqual([
      'user: Draft a hiring plan for two backend engineers.',
      'assistant: Here is a draft plan (export text).',
      'user: Make it remote-first.',
    ])
    expect(await n("SELECT count(*) FROM messages WHERE origin = 'export' AND node_external_id IN ('m-u1','m-a1')")).toBe(2)
    expect(await n("SELECT count(*) FROM messages WHERE origin = 'live_capture' AND present_in_latest")).toBe(1)
    // A later capture showing old text cannot overwrite the export's text.
    const r = await ingestCapture(db, payload([
      { id: 'm-u1', role: 'user', text: 'Draft a hiring plan for two backend engineers.' },
      { id: 'm-a1', role: 'assistant', text: 'Here is a draft plan.' },
      { id: 'm-u2', role: 'user', text: 'Make it remote-first.' },
    ], '2026-06-01T10:06:00.000Z'))
    expect(r.exportTextKept).toBe(1)
  })

  it('pairs extensions with revocable tokens stored only as hashes', async () => {
    const { id, token } = await createExtensionToken(db, 'Chrome')
    expect(await n('SELECT count(*) FROM extension_tokens WHERE token_hash = $1', [sha256(token)])).toBe(1)
    expect(await verifyExtensionToken(db, `Bearer ${token}`)).toBe(id)
    expect(await verifyExtensionToken(db, 'Bearer aim_wrongwrongwrongwrongwrong')).toBeNull()
    await revokeExtensionToken(db, id)
    expect(await verifyExtensionToken(db, `Bearer ${token}`)).toBeNull()
  })
})

describe('background infrastructure', () => {
  it('retries failing jobs with backoff and marks them failed after the last attempt', async () => {
    await enqueueJob(db, 'backup', {}, { maxAttempts: 2 })
    const boom = { backup: async () => { throw new Error('disk full') } }
    expect(await runNextJob(db, boom)).toBe(true)
    let [job] = await db.query<{ status: string; attempts: number; last_error: string }>('SELECT status, attempts, last_error FROM jobs')
    expect(job).toMatchObject({ status: 'queued', attempts: 1, last_error: 'disk full' })
    await db.query('UPDATE jobs SET run_after = now()')
    await runNextJob(db, boom)
    ;[job] = await db.query('SELECT status, attempts, last_error FROM jobs')
    expect(job).toMatchObject({ status: 'failed', attempts: 2 })
  })

  it('auto-imports ChatGPT exports found in the watched folder, once', async () => {
    const watch = path.join(dir, 'Downloads')
    fs.mkdirSync(watch)
    fs.writeFileSync(path.join(watch, 'notes.zip'), 'not a zip')
    const zip = new yazl.ZipFile()
    zip.addBuffer(Buffer.from(JSON.stringify(projectConversations())), 'conversations.json')
    zip.addBuffer(Buffer.from('<html></html>'), 'chat.html')
    zip.end()
    const exportFile = path.join(watch, '0a1b2c-2026-11-02-10-00-00.zip')
    await new Promise<void>((res) => zip.outputStream.pipe(fs.createWriteStream(exportFile)).on('close', res))
    const queued: number[] = []
    const opts = { dir: watch, rawDir: path.join(dir, 'raw'), uploadDir: path.join(dir, 'up'), sourceLabel: 'ChatGPT', stableMs: 0, onBatch: (id: number) => queued.push(id) }
    const r1 = await scanFolder(db, opts)
    expect(r1.imported).toHaveLength(1)
    expect(queued).toHaveLength(1)
    expect(fs.existsSync(exportFile)).toBe(true) // original left in place
    const r2 = await scanFolder(db, opts)
    expect(r2.examined).toBe(0)
    expect(await n("SELECT count(*) FROM import_batches WHERE origin = 'watch'")).toBe(1)
  })

  it('writes a restorable database snapshot', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-bk-'))
    const persistent = await openDb({ pgliteDir: path.join(tmpDir, 'pglite'), embeddingDim: 8 })
    await persistent.query("INSERT INTO sources(kind, label) VALUES ('chatgpt', 'Backup test')")
    const info = await runBackup(persistent, path.join(tmpDir, 'backups'), 2)
    expect(info.size).toBeGreaterThan(1000)
    await persistent.close()
    const { PGlite } = await import('@electric-sql/pglite')
    const { vector } = await import('@electric-sql/pglite-pgvector')
    const restored = await PGlite.create({ loadDataDir: new Blob([fs.readFileSync(info.file)]), extensions: { vector } })
    const rows = await restored.query<{ label: string }>('SELECT label FROM sources')
    expect(rows.rows.map((r) => r.label)).toContain('Backup test')
    await restored.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
