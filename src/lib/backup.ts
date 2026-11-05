import fs from 'node:fs'
import path from 'node:path'
import { config } from './config'
import type { Db } from './db/client'
import { log } from './logger'

export interface BackupInfo {
  file: string
  size: number
  createdAt: string
}

/**
 * Snapshot of the embedded database into BACKUP_DIR, keeping the newest BACKUP_KEEP files.
 * Original export files in DATA_DIR/raw are immutable and are not duplicated here; back up DATA_DIR/raw separately.
 */
export async function runBackup(db: Db, dir = config.backupDir, keep = config.backupKeep): Promise<BackupInfo> {
  if (!db.dumpTo) throw new Error('This deployment uses an external PostgreSQL server: back it up with pg_dump (see README).')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(dir, `memory-${stamp}.tar.gz`)
  const tmp = `${file}.part`
  await db.dumpTo(tmp)
  fs.renameSync(tmp, file)
  const backups = listBackups(dir)
  for (const old of backups.slice(keep)) fs.rmSync(old.file, { force: true })
  const info = { file, size: fs.statSync(file).size, createdAt: new Date().toISOString() }
  log('info', 'backup_created', { file, size: info.size })
  return info
}

export function listBackups(dir = config.backupDir): BackupInfo[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => /^memory-.*\.tar\.gz$/.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f))
      return { file: path.join(dir, f), size: st.size, createdAt: st.mtime.toISOString() }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
