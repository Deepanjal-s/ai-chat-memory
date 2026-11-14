/**
 * Produces a rankings file for memory-recall-bench (https://github.com/Deepanjal-s/memory-recall-bench),
 * so this app's real retrieval can be measured on LongMemEval.
 *
 *   npx tsx scripts/bench-rankings.ts convs.jsonl rankings.json [--limit N]
 *
 * For each benchmark conversation: a fresh in-memory database, each session imported as one ChatGPT
 * conversation through the normal import pipeline, then the question run through the app's own `search()`.
 * Output: { "<conversation id>": ["<message id>", ...best first...] }.
 * Keyword search only (no embedding provider is configured offline).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { openDb } from '../src/lib/db/client'
import { registerUpload, runImport } from '../src/lib/importer/import'
import { search } from '../src/lib/search'

interface BenchMessage { id: string; role: string; content: string }
interface BenchConversation { id: string; question: string; sessions: { id: string; messages: BenchMessage[] }[] }

/** One session → one conversation in the exact shape of ChatGPT's conversations.json (a linear thread). */
function toChatGpt(session: { id: string; messages: BenchMessage[] }, index: number) {
  const base = 1_700_000_000 + index * 86_400
  const mapping: Record<string, unknown> = { root: { id: 'root', parent: null, children: [] as string[], message: null } }
  let parent = 'root'
  session.messages.forEach((m, i) => {
    mapping[m.id] = {
      id: m.id,
      parent,
      children: [],
      message: {
        id: m.id,
        author: { role: m.role === 'assistant' ? 'assistant' : 'user', name: null, metadata: {} },
        create_time: base + i * 30,
        content: { content_type: 'text', parts: [m.content] },
        metadata: {},
        recipient: 'all',
      },
    }
    ;(mapping[parent] as { children: string[] }).children.push(m.id)
    parent = m.id
  })
  return {
    title: `Session ${session.id}`,
    create_time: base,
    update_time: base + session.messages.length * 30,
    mapping,
    current_node: parent,
    conversation_id: `bench-${session.id}`,
    id: `bench-${session.id}`,
    is_archived: false,
    moderation_results: [],
  }
}

async function rank(conv: BenchConversation, workDir: string): Promise<string[]> {
  const db = await openDb({ embeddingDim: 8 })
  try {
    const file = path.join(workDir, `${crypto.randomUUID()}.json`)
    const body = JSON.stringify(conv.sessions.map(toChatGpt))
    fs.writeFileSync(file, body)
    const { batchId } = await registerUpload(db, {
      tempPath: file,
      originalFilename: 'conversations.json',
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
      size: Buffer.byteLength(body),
      sourceLabel: 'bench',
      rawDir: path.join(workDir, 'raw'),
      origin: 'cli',
    })
    await runImport(db, batchId)
    const { hits } = await search(db, { q: conv.question, limit: 200 }, null)
    if (!hits.length) return []
    const rows = await db.query<{ id: number; node_external_id: string }>(
      'SELECT id, node_external_id FROM messages WHERE id = ANY($1::int[])',
      [hits.map((h) => h.messageId)],
    )
    const ext = new Map(rows.map((r) => [r.id, r.node_external_id]))
    return hits.map((h) => ext.get(h.messageId)).filter((x): x is string => !!x)
  } finally {
    await db.close()
  }
}

async function main() {
  const [input, output] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const li = process.argv.indexOf('--limit')
  const limit = li >= 0 ? Number(process.argv[li + 1]) : Infinity
  if (!input || !output) {
    console.error('Usage: npx tsx scripts/bench-rankings.ts convs.jsonl rankings.json [--limit N]')
    process.exit(1)
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-bench-'))
  // Resume: conversations already in the output file (from a checkpoint) are skipped.
  const rankings: Record<string, string[]> = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : {}
  const resumed = Object.keys(rankings).length
  if (resumed) console.error(`resuming: ${resumed} conversations already ranked`)
  const started = Date.now()
  let lineNo = 0
  try {
    const lines = readline.createInterface({ input: fs.createReadStream(input, 'utf8'), crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.trim()) continue
      if (Object.keys(rankings).length >= limit) break
      lineNo += 1
      let conv: BenchConversation
      try {
        conv = JSON.parse(line) as BenchConversation
      } catch (e) {
        throw new Error(`Line ${lineNo} of ${input} is not valid JSON (was it written with raw U+2028 characters?): ${e}`)
      }
      if (conv.id in rankings) continue
      rankings[conv.id] = await rank(conv, workDir)
      const n = Object.keys(rankings).length
      if (n % 10 === 0) {
        fs.writeFileSync(output, JSON.stringify(rankings)) // checkpoint: a crash keeps finished work
        console.error(`${n} conversations (${((Date.now() - started) / 1000).toFixed(0)}s)`)
      }
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
  fs.writeFileSync(output, JSON.stringify(rankings))
  console.error(`wrote ${Object.keys(rankings).length} rankings to ${output}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
