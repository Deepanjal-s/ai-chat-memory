/**
 * Produces a rankings file for memory-recall-bench (https://github.com/Deepanjal-s/memory-recall-bench),
 * so this app's real retrieval can be measured on LongMemEval.
 *
 *   npx tsx scripts/bench-rankings.ts convs.jsonl rankings.json [--limit N] [--embed]
 *
 * For each benchmark conversation: a fresh in-memory database, each session imported as one ChatGPT
 * conversation through the normal import pipeline, then the question run through the app's own `search()`.
 * Output: { "<conversation id>": ["<message id>", ...best first...] }.
 * Keyword search only by default. With --embed, chunks are also embedded with the on-device provider
 * (EMBEDDING_PROVIDER=local, bge-small) and search runs as the app does with semantic search enabled.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { rankConversation, type BenchConversation } from '../src/lib/bench'
import { localProvider } from '../src/lib/indexing/embeddings'

async function main() {
  const [input, output] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const li = process.argv.indexOf('--limit')
  const limit = li >= 0 ? Number(process.argv[li + 1]) : Infinity
  const provider = process.argv.includes('--embed') ? localProvider('Xenova/bge-small-en-v1.5', 384) : null
  if (!input || !output) {
    console.error('Usage: npx tsx scripts/bench-rankings.ts convs.jsonl rankings.json [--limit N] [--embed]')
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
      rankings[conv.id] = await rankConversation(conv, workDir, provider)
      const n = Object.keys(rankings).length
      if (n % (provider ? 1 : 10) === 0) {
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
