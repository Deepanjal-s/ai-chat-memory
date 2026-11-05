import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config'
import { migrate } from './migrations'

/** Minimal query surface shared by the embedded (PGlite) and server (node-postgres) backends. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
}

export interface Db extends Queryable {
  kind: 'pglite' | 'postgres'
  exec(sql: string): Promise<void>
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>
  close(): Promise<void>
  /** Writes a complete, consistent snapshot of the embedded database (gzip tar). PostgreSQL: use pg_dump instead. */
  dumpTo?(file: string): Promise<void>
}

export interface OpenOptions {
  /** PostgreSQL URL. Empty → embedded PGlite. */
  databaseUrl?: string
  /** PGlite data directory. Undefined → in-memory (tests). */
  pgliteDir?: string
  embeddingDim?: number
}

export async function openDb(opts: OpenOptions): Promise<Db> {
  const db = opts.databaseUrl ? await openPostgres(opts.databaseUrl) : await openPglite(opts.pgliteDir)
  await migrate(db, { embeddingDim: opts.embeddingDim ?? config.embeddingDim })
  return db
}

async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite')
  const { vector } = await import('@electric-sql/pglite-pgvector')
  let releaseLock = () => {}
  if (dataDir) {
    fs.mkdirSync(dataDir, { recursive: true })
    releaseLock = acquireLock(path.join(path.dirname(dataDir), 'pglite.lock'))
  }
  const pg = await PGlite.create({ dataDir, extensions: { vector } })
  return {
    kind: 'pglite',
    async query(sql, params) {
      const res = await pg.query(sql, params as unknown[] | undefined)
      return res.rows as never
    },
    async exec(sql) {
      await pg.exec(sql)
    },
    async tx(fn) {
      return pg.transaction(async (t) =>
        fn({
          async query(sql, params) {
            const res = await t.query(sql, params as unknown[] | undefined)
            return res.rows as never
          },
        }),
      )
    },
    async close() {
      await pg.close()
      releaseLock()
    },
    async dumpTo(file) {
      const blob = await pg.dumpDataDir('gzip')
      fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()))
    },
  }
}

async function openPostgres(url: string): Promise<Db> {
  const pgMod = await import('pg')
  const Pool = pgMod.default?.Pool ?? (pgMod as unknown as { Pool: typeof import('pg').Pool }).Pool
  const pool = new Pool({ connectionString: url, max: 10 })
  return {
    kind: 'postgres',
    async query(sql, params) {
      const res = await pool.query(sql, params as unknown[] | undefined)
      return res.rows
    },
    async exec(sql) {
      await pool.query(sql)
    },
    async tx(fn) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const out = await fn({
          async query(sql, params) {
            const res = await client.query(sql, params as unknown[] | undefined)
            return res.rows
          },
        })
        await client.query('COMMIT')
        return out
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      } finally {
        client.release()
      }
    },
    async close() {
      await pool.end()
    },
  }
}

/**
 * The embedded database must only ever be opened by one process; two writers would corrupt it.
 * A pid lockfile makes a second process (e.g. the CLI importer while the web app runs) fail fast.
 */
function acquireLock(lockPath: string): () => void {
  try {
    const fd = fs.openSync(lockPath, 'wx')
    fs.writeSync(fd, String(process.pid))
    fs.closeSync(fd)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    const pid = Number(fs.readFileSync(lockPath, 'utf8'))
    if (pid && pid !== process.pid && isAlive(pid)) {
      throw new Error(
        `The embedded database is already open in another process (pid ${pid}). ` +
          'Stop the web app before using the command-line tools, or upload through the web app instead.',
      )
    }
    fs.writeFileSync(lockPath, String(process.pid))
  }
  let released = false
  const release = () => {
    if (released) return
    released = true
    try {
      if (fs.readFileSync(lockPath, 'utf8') === String(process.pid)) fs.unlinkSync(lockPath)
    } catch {}
  }
  process.once('exit', release)
  return release
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const g = globalThis as unknown as { __aimDb?: Promise<Db> }

/** Process-wide database handle for the app (survives Next.js dev hot reloads). */
export function getDb(): Promise<Db> {
  if (!g.__aimDb) {
    g.__aimDb = openDb({
      databaseUrl: config.databaseUrl,
      pgliteDir: config.databaseUrl ? undefined : config.pgliteDir,
    }).catch((e) => {
      g.__aimDb = undefined
      throw e
    })
  }
  return g.__aimDb
}
