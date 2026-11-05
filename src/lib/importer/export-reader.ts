import fs from 'node:fs'
import type { Readable } from 'node:stream'
import yauzl from 'yauzl'
import chain from 'stream-chain'
import { parser } from 'stream-json'
import { streamArray } from 'stream-json/streamers/stream-array.js'
import type { RawConversation } from './normalize'

export interface ExportEntry {
  /** File inside the export that the conversation came from. */
  file: string
  /** Position within that file (0-based). */
  index: number
  raw: RawConversation
}

export interface ExportInventory {
  format: 'zip' | 'json'
  conversationFiles: string[]
  otherFiles: number
}

const CONVERSATION_FILE = /(^|\/)conversations(-\d+)?\.json$/i

export async function detectFormat(filePath: string): Promise<'zip' | 'json'> {
  const fd = await fs.promises.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(4)
    await fd.read(buf, 0, 4, 0)
    return buf[0] === 0x50 && buf[1] === 0x4b ? 'zip' : 'json'
  } finally {
    await fd.close()
  }
}

/**
 * Streams conversations out of a ChatGPT export (the .zip OpenAI emails, or a bare conversations.json)
 * one at a time, so exports far larger than memory can be imported.
 */
export async function readExport(
  filePath: string,
  onInventory?: (inv: ExportInventory) => void,
): Promise<AsyncGenerator<ExportEntry>> {
  const format = await detectFormat(filePath)
  if (format === 'json') {
    onInventory?.({ format, conversationFiles: ['conversations.json'], otherFiles: 0 })
    return streamConversations(fs.createReadStream(filePath), 'conversations.json')
  }
  const zip = await openZip(filePath)
  const entries = await listEntries(zip)
  const convFiles = entries.filter((e) => CONVERSATION_FILE.test(e.fileName)).sort((a, b) => a.fileName.localeCompare(b.fileName))
  if (convFiles.length === 0) {
    zip.close()
    throw new Error('No conversations.json found in this ZIP. Is it a ChatGPT data export?')
  }
  onInventory?.({
    format,
    conversationFiles: convFiles.map((e) => e.fileName),
    otherFiles: entries.filter((e) => !e.fileName.endsWith('/')).length - convFiles.length,
  })
  return (async function* () {
    try {
      for (const entry of convFiles) {
        const stream = await openEntry(zip, entry)
        yield* streamConversations(stream, entry.fileName)
      }
    } finally {
      zip.close()
    }
  })()
}

/**
 * True when a ZIP looks like an official ChatGPT data export: it contains conversations.json (or numbered parts)
 * together with chat.html or user.json. Only the ZIP's directory is read, never file contents.
 */
export async function isChatGptExportZip(filePath: string): Promise<boolean> {
  if ((await detectFormat(filePath)) !== 'zip') return false
  const zip = await openZip(filePath)
  try {
    const names = (await listEntries(zip)).map((e) => e.fileName.toLowerCase())
    const hasConversations = names.some((n) => CONVERSATION_FILE.test(n))
    const hasCompanion = names.some((n) => /(^|\/)(chat\.html|user\.json)$/.test(n))
    return hasConversations && hasCompanion
  } finally {
    zip.close()
  }
}

async function* streamConversations(input: Readable, file: string): AsyncGenerator<ExportEntry> {
  const pipeline = chain([input, parser(), streamArray()])
  try {
    for await (const item of pipeline as AsyncIterable<{ key: number; value: RawConversation }>) {
      yield { file, index: item.key, raw: item.value }
    }
  } catch (e) {
    const msg = (e as Error).message
    if (/array/i.test(msg)) throw new Error(`${file} is not a JSON array of conversations (${msg})`)
    throw new Error(`Could not parse ${file}: ${msg}`)
  } finally {
    input.destroy()
  }
}

function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (err, zip) => (err ? reject(err) : resolve(zip!))),
  )
}

function listEntries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const out: yauzl.Entry[] = []
    zip.on('entry', (e: yauzl.Entry) => {
      out.push(e)
      zip.readEntry()
    })
    zip.once('end', () => resolve(out))
    zip.once('error', reject)
    zip.readEntry()
  })
}

function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) =>
    zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream!))),
  )
}
