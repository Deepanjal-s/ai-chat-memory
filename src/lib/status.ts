import { aiDescription } from './ai/llm'
import { listBackups } from './backup'
import { config } from './config'
import type { Db } from './db/client'
import { jobSummary } from './jobs'
import { captureEnabled } from './settings'

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null)

export async function captureStatus(db: Db) {
  const [s] = await db.query<{ last_ok: Date | null; ok_24h: number; errors_24h: number; rejected_24h: number; conversations: number; live_messages: number }>(
    `SELECT (SELECT max(received_at) FROM capture_events WHERE result = 'ok') AS last_ok,
            (SELECT count(*) FROM capture_events WHERE result = 'ok' AND received_at > now() - interval '1 day')::int AS ok_24h,
            (SELECT count(*) FROM capture_events WHERE result = 'error' AND received_at > now() - interval '1 day')::int AS errors_24h,
            (SELECT count(*) FROM capture_events WHERE result = 'rejected' AND received_at > now() - interval '1 day')::int AS rejected_24h,
            (SELECT count(DISTINCT conversation_id) FROM capture_events WHERE result = 'ok')::int AS conversations,
            (SELECT count(*) FROM messages WHERE origin = 'live_capture' AND present_in_latest)::int AS live_messages`,
  )
  const recentErrors = await db.query<{ received_at: Date; result: string; error: string | null; conversation_external_id: string | null }>(
    `SELECT received_at, result, error, conversation_external_id FROM capture_events WHERE result <> 'ok' ORDER BY received_at DESC LIMIT 5`,
  )
  const tokens = await db.query<{ id: number; label: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }>(
    'SELECT id, label, created_at, last_used_at, revoked_at FROM extension_tokens ORDER BY id DESC',
  )
  return {
    enabled: await captureEnabled(db),
    lastCaptureAt: iso(s.last_ok),
    ok24h: s.ok_24h,
    errors24h: s.errors_24h,
    rejected24h: s.rejected_24h,
    conversations: s.conversations,
    liveMessages: s.live_messages,
    recentErrors: recentErrors.map((e) => ({ ...e, received_at: iso(e.received_at) })),
    tokens: tokens.map((t) => ({ ...t, created_at: iso(t.created_at), last_used_at: iso(t.last_used_at), revoked_at: iso(t.revoked_at) })),
  }
}

export async function externalSummary(db: Db) {
  const rows = await db.query<{ provider: string; purpose: string; calls: number; chars: number; failures: number; last: Date }>(
    `SELECT provider, purpose, count(*)::int AS calls, sum(chars_sent)::int AS chars, count(*) FILTER (WHERE NOT ok)::int AS failures, max(at) AS last
       FROM external_calls WHERE at > now() - interval '30 days' GROUP BY provider, purpose ORDER BY max(at) DESC`,
  )
  return rows.map((r) => ({ ...r, last: iso(r.last) }))
}

export async function systemStatus(db: Db) {
  const [jobs, capture, external] = await Promise.all([jobSummary(db), captureStatus(db), externalSummary(db)])
  const [proc] = await db.query<{ processed: number; total: number; pending: number }>(
    `SELECT (SELECT count(*) FROM conversations WHERE processed_at IS NOT NULL)::int AS processed,
            (SELECT count(*) FROM conversations)::int AS total,
            (SELECT count(*) FROM jobs WHERE kind = 'process_conversation' AND status IN ('queued','running'))::int AS pending`,
  )
  return {
    jobs: {
      ...jobs,
      failed: jobs.failed.map((f) => ({ ...f, updated_at: iso(f.updated_at) })),
      retrying: jobs.retrying.map((r) => ({ ...r, run_after: iso(r.run_after) })),
    },
    capture,
    external,
    processing: proc,
    ai: aiDescription(),
    embeddings: config.embeddingProvider === 'none' ? null : { provider: config.embeddingProvider, model: config.embeddingModel },
    backups: { dir: config.backupDir, keep: config.backupKeep, list: listBackups().slice(0, 5), supported: !config.databaseUrl },
    storage: { dataDir: config.dataDir, database: config.databaseUrl ? 'PostgreSQL server' : 'Embedded PostgreSQL (PGlite)' },
  }
}
