import type { Db, Queryable } from './db/client'
import { errorMessage, log } from './logger'

export type JobKind = 'process_conversation' | 'detect_changes' | 'embed' | 'generate_document' | 'backup'

export interface Job {
  id: number
  kind: JobKind
  payload: Record<string, unknown>
  attempts: number
  max_attempts: number
}

export type JobHandler = (db: Db, job: Job) => Promise<void>

/** Adds a job unless an identical one (same dedupe key) is already waiting. Safe inside a transaction. */
export async function enqueueJob(
  q: Queryable,
  kind: JobKind,
  payload: Record<string, unknown> = {},
  opts: { dedupeKey?: string; delaySeconds?: number; maxAttempts?: number } = {},
): Promise<void> {
  await q.query(
    `INSERT INTO jobs(kind, payload, dedupe_key, run_after, max_attempts)
     VALUES ($1, $2::jsonb, $3, now() + ($4 || ' seconds')::interval, $5)
     ON CONFLICT (dedupe_key) WHERE status = 'queued' DO NOTHING`,
    [kind, JSON.stringify(payload), opts.dedupeKey ?? null, String(opts.delaySeconds ?? 0), opts.maxAttempts ?? 5],
  )
}

/** Claims and runs at most one ready job. Returns false when there was nothing to do. */
export async function runNextJob(db: Db, handlers: Partial<Record<JobKind, JobHandler>>): Promise<boolean> {
  const claimed = await db.tx(async (q) => {
    const [job] = await q.query<Job>(
      `SELECT id, kind, payload, attempts, max_attempts FROM jobs
        WHERE status = 'queued' AND run_after <= now()
        ORDER BY CASE kind WHEN 'generate_document' THEN 0 WHEN 'process_conversation' THEN 1 ELSE 2 END, id
        LIMIT 1 FOR UPDATE SKIP LOCKED`,
    )
    if (!job) return null
    await q.query(`UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = now() WHERE id = $1`, [job.id])
    return { ...job, attempts: job.attempts + 1 }
  })
  if (!claimed) return false
  const handler = handlers[claimed.kind]
  try {
    if (!handler) throw new Error(`No handler for job kind ${claimed.kind}`)
    await handler(db, claimed)
    await db.query(`UPDATE jobs SET status = 'done', last_error = NULL, updated_at = now() WHERE id = $1`, [claimed.id])
  } catch (e) {
    const msg = errorMessage(e)
    const final = claimed.attempts >= claimed.max_attempts
    // Exponential backoff: 30s, 2m, 8m, 32m...
    const delay = 30 * 4 ** (claimed.attempts - 1)
    await db.query(
      `UPDATE jobs SET status = $2, last_error = $3, run_after = now() + ($4 || ' seconds')::interval, updated_at = now() WHERE id = $1`,
      [claimed.id, final ? 'failed' : 'queued', msg.slice(0, 2000), String(delay)],
    )
    log(final ? 'error' : 'warn', 'job_failed', { jobId: claimed.id, kind: claimed.kind, attempt: claimed.attempts, final, error: msg })
  }
  return true
}

/** Jobs left 'running' by a crash or restart go back to the queue. */
export async function recoverStuckJobs(db: Db): Promise<number> {
  const rows = await db.query<{ n: number }>(
    `WITH upd AS (UPDATE jobs SET status = 'queued', updated_at = now() WHERE status = 'running' RETURNING 1)
     SELECT count(*)::int AS n FROM upd`,
  )
  return rows[0]?.n ?? 0
}

export async function retryJob(db: Queryable, id: number): Promise<boolean> {
  const rows = await db.query(
    `UPDATE jobs SET status = 'queued', attempts = 0, run_after = now(), updated_at = now()
      WHERE id = $1 AND status = 'failed' RETURNING id`,
    [id],
  )
  return rows.length > 0
}

export async function jobSummary(db: Queryable) {
  const counts = await db.query<{ kind: string; status: string; n: number }>(
    `SELECT kind, status, count(*)::int AS n FROM jobs WHERE status <> 'done' OR updated_at > now() - interval '1 day'
      GROUP BY kind, status ORDER BY kind, status`,
  )
  const failed = await db.query<{ id: number; kind: string; payload: Record<string, unknown>; last_error: string; updated_at: Date; attempts: number }>(
    `SELECT id, kind, payload, last_error, updated_at, attempts FROM jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 20`,
  )
  const retrying = await db.query<{ id: number; kind: string; last_error: string; run_after: Date; attempts: number }>(
    `SELECT id, kind, last_error, run_after, attempts FROM jobs WHERE status = 'queued' AND attempts > 0 ORDER BY run_after LIMIT 20`,
  )
  return { counts, failed, retrying }
}

// ---- In-process worker loop -------------------------------------------------------------

const g = globalThis as unknown as { __aimWorker?: { timer: NodeJS.Timeout; busy: boolean } }

export function startWorker(getDb: () => Promise<Db>, handlers: Partial<Record<JobKind, JobHandler>>, intervalMs = 2000) {
  if (g.__aimWorker) return
  const state = { busy: false } as { timer: NodeJS.Timeout; busy: boolean }
  g.__aimWorker = state
  void getDb()
    .then(recoverStuckJobs)
    .catch(() => 0)
  state.timer = setInterval(async () => {
    if (state.busy) return
    state.busy = true
    try {
      const db = await getDb()
      // Drain everything that is ready, then wait for the next tick.
      while (await runNextJob(db, handlers)) {}
    } catch (e) {
      log('error', 'worker_error', { error: errorMessage(e) })
    } finally {
      state.busy = false
    }
  }, intervalMs)
  state.timer.unref?.()
}
