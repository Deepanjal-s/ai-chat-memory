import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { config } from '../config'
import type { Db } from '../db/client'
import { isChatGptExportZip } from './export-reader'
import { registerUpload } from './import'

export interface ScanOptions {
  dir: string
  rawDir: string
  uploadDir: string
  sourceLabel: string
  /** A file must be unmodified for this long before it is read (so half-downloaded files are skipped). */
  stableMs?: number
  now?: number
  onBatch: (batchId: number) => void
}

export interface ScanResult {
  examined: number
  imported: { file: string; batchId: number; duplicateOf: number | null }[]
  errors: { file: string; error: string }[]
}

/**
 * Checks a folder once for ChatGPT export ZIPs that have not been seen before (or that changed) and registers
 * them as imports. Only *.zip files directly in the folder are considered; anything that is not a ChatGPT export
 * is remembered and left alone. The original file is copied, never moved or modified.
 */
export async function scanFolder(db: Db, opts: ScanOptions): Promise<ScanResult> {
  const result: ScanResult = { examined: 0, imported: [], errors: [] }
  const stableMs = opts.stableMs ?? 10_000
  const now = opts.now ?? Date.now()
  let names: string[]
  try {
    names = fs.readdirSync(opts.dir)
  } catch (e) {
    throw new Error(`Cannot read watched folder ${opts.dir}: ${(e as Error).message}`)
  }

  for (const name of names) {
    if (!/\.zip$/i.test(name)) continue
    const file = path.join(opts.dir, name)
    let st: fs.Stats
    try {
      st = fs.statSync(file)
    } catch {
      continue
    }
    if (!st.isFile() || st.size === 0) continue
    if (stableMs > 0 && now - st.mtimeMs < stableMs) continue

    const [seen] = await db.query<{ size: string | number; mtime_ms: string | number }>(
      'SELECT size, mtime_ms FROM watched_files WHERE path = $1',
      [file],
    )
    if (seen && Number(seen.size) === st.size && Number(seen.mtime_ms) === Math.floor(st.mtimeMs)) continue
    result.examined++

    let status = 'not_export'
    let batchId: number | null = null
    let error: string | null = null
    try {
      if (await isChatGptExportZip(file)) {
        const reg = await copyAndRegister(db, file, opts)
        batchId = reg.batchId
        status = reg.duplicateOf ? 'duplicate' : 'imported'
        result.imported.push({ file, ...reg })
        if (!reg.duplicateOf) opts.onBatch(reg.batchId)
      }
    } catch (e) {
      status = 'error'
      error = (e as Error).message
      result.errors.push({ file, error })
    }
    await db.query(
      `INSERT INTO watched_files(path, size, mtime_ms, status, batch_id, error, checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (path) DO UPDATE SET size = EXCLUDED.size, mtime_ms = EXCLUDED.mtime_ms, status = EXCLUDED.status,
         batch_id = EXCLUDED.batch_id, error = EXCLUDED.error, checked_at = now()`,
      [file, st.size, Math.floor(st.mtimeMs), status, batchId, error],
    )
  }
  return result
}

async function copyAndRegister(db: Db, file: string, opts: ScanOptions) {
  fs.mkdirSync(opts.uploadDir, { recursive: true })
  const temp = path.join(opts.uploadDir, `${crypto.randomUUID()}.part`)
  const hash = crypto.createHash('sha256')
  let size = 0
  const src = fs.createReadStream(file)
  src.on('data', (c: string | Buffer) => {
    size += c.length
    hash.update(c)
  })
  try {
    await pipeline(src, fs.createWriteStream(temp))
  } catch (e) {
    fs.rmSync(temp, { force: true })
    throw e
  }
  return registerUpload(db, {
    tempPath: temp,
    originalFilename: path.basename(file),
    sha256: hash.digest('hex'),
    size,
    sourceLabel: opts.sourceLabel,
    rawDir: opts.rawDir,
    origin: 'watch',
  })
}

// ---- Background loop inside the web app -------------------------------------------------

export interface WatcherStatus {
  enabled: boolean
  dir: string
  intervalSeconds: number
  lastScanAt: string | null
  lastError: string | null
  lastImportAt: string | null
}

const g = globalThis as unknown as { __aimWatcher?: { timer?: NodeJS.Timeout; status: WatcherStatus; running: boolean } }

export function watcherStatus(): WatcherStatus {
  return (
    g.__aimWatcher?.status ?? {
      enabled: config.watchEnabled,
      dir: config.watchDir,
      intervalSeconds: config.watchIntervalSeconds,
      lastScanAt: null,
      lastError: null,
      lastImportAt: null,
    }
  )
}

export function startWatcher(getDb: () => Promise<Db>, enqueue: (batchId: number) => void): void {
  if (g.__aimWatcher || !config.watchEnabled) return
  const state = (g.__aimWatcher = {
    running: false,
    status: {
      enabled: true,
      dir: config.watchDir,
      intervalSeconds: config.watchIntervalSeconds,
      lastScanAt: null,
      lastError: null,
      lastImportAt: null,
    } as WatcherStatus,
  } as { timer?: NodeJS.Timeout; status: WatcherStatus; running: boolean })

  const tick = async () => {
    if (state.running) return
    state.running = true
    try {
      const res = await scanFolder(await getDb(), {
        dir: config.watchDir,
        rawDir: config.rawDir,
        uploadDir: config.uploadDir,
        sourceLabel: config.watchSourceLabel,
        onBatch: enqueue,
      })
      state.status.lastError = res.errors.length ? res.errors.map((e) => `${path.basename(e.file)}: ${e.error}`).join('; ') : null
      if (res.imported.length) state.status.lastImportAt = new Date().toISOString()
    } catch (e) {
      state.status.lastError = (e as Error).message
    } finally {
      state.status.lastScanAt = new Date().toISOString()
      state.running = false
    }
  }
  void tick()
  state.timer = setInterval(tick, config.watchIntervalSeconds * 1000)
  state.timer.unref?.()
}
