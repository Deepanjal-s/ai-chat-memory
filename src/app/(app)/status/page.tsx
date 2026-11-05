import Link from 'next/link'
import { ActionButton } from '@/components/Actions'
import { AutoRefresh } from '@/components/AutoRefresh'
import { Badge, Card, CardHeader, PageHeader, Stat } from '@/components/ui'
import { getDb } from '@/lib/db/client'
import { fmtBytes, fmtDateTime, fmtNum } from '@/lib/format'
import { watcherStatus } from '@/lib/importer/watcher'
import { exportFreshness } from '@/lib/queries'
import { systemStatus } from '@/lib/status'
import { config } from '@/lib/config'

const JOB_LABEL: Record<string, string> = {
  process_conversation: 'Understanding conversations',
  detect_changes: 'Detecting changed decisions',
  embed: 'Semantic indexing',
  generate_document: 'Document generation',
  backup: 'Backup',
}

export default async function StatusPage() {
  const db = await getDb()
  const [s, fresh] = await Promise.all([systemStatus(db), exportFreshness(db, config.exportReminderDays)])
  const watch = watcherStatus()
  const queued = s.jobs.counts.filter((c) => c.status === 'queued' || c.status === 'running').reduce((a, c) => a + c.n, 0)
  const captureHealthy = s.capture.enabled && s.capture.lastCaptureAt && Date.now() - Date.parse(s.capture.lastCaptureAt) < 3 * 86400_000
  return (
    <>
      <AutoRefresh active={queued > 0} intervalMs={4000} />
      <PageHeader title="Sync & processing status" subtitle="Where your data comes from, what the background worker is doing, and anything that needs attention." />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Conversations understood" value={`${fmtNum(s.processing.processed)} / ${fmtNum(s.processing.total)}`} hint={s.processing.pending ? `${s.processing.pending} waiting` : 'Up to date'} />
        <Stat label="Background queue" value={fmtNum(queued)} hint={s.jobs.failed.length ? `${s.jobs.failed.length} failed` : 'No failures'} />
        <Stat label="Last export import" value={fresh.ageDays === null ? '—' : `${fresh.ageDays}d ago`} hint={fresh.exportAsOf ? `Covers up to ${fmtDateTime(fresh.exportAsOf)}` : 'No export yet'} />
        <Stat label="Live capture" value={s.capture.enabled ? (captureHealthy ? 'Active' : 'Idle') : 'Off'} hint={s.capture.lastCaptureAt ? `Last ${fmtDateTime(s.capture.lastCaptureAt)}` : 'Nothing captured yet'} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Data sources" />
          <dl className="space-y-3 p-4 text-sm">
            <div>
              <dt className="font-medium text-ink">Official exports (complete history)</dt>
              <dd className="text-ink-2">
                {watch.enabled ? <>Watching <code className="break-all">{watch.dir}</code>; last checked {fmtDateTime(watch.lastScanAt)}.</> : 'Folder watching is off.'}{' '}
                <Link href="/import" className="text-accent">Imports →</Link>
                {watch.lastError && <span className="block text-warn">{watch.lastError}</span>}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-ink">Live capture (browser extension)</dt>
              <dd className="text-ink-2">
                {s.capture.enabled ? 'On' : 'Off'} · {fmtNum(s.capture.ok24h)} captures in 24h · {fmtNum(s.capture.conversations)} conversations ·{' '}
                {fmtNum(s.capture.liveMessages)} messages not yet confirmed by an export. <Link href="/settings" className="text-accent">Settings →</Link>
                {(s.capture.errors24h > 0 || s.capture.rejected24h > 0) && (
                  <span className="block text-warn">{s.capture.errors24h} errors and {s.capture.rejected24h} rejected captures in the last 24h.</span>
                )}
              </dd>
            </div>
          </dl>
          {s.capture.recentErrors.length > 0 && (
            <ul className="divide-y divide-line border-t border-line text-xs">
              {s.capture.recentErrors.map((e, i) => (
                <li key={i} className="px-4 py-2 text-ink-2">
                  <Badge tone="bad">{e.result}</Badge> {fmtDateTime(e.received_at)} — {e.error?.slice(0, 200)}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Background work" action={<ActionButton url="/api/jobs/reprocess" label="Re-process all" confirm="Re-run understanding for every conversation?" done="{queued} queued" />} />
          <ul className="divide-y divide-line text-sm">
            {Object.keys(JOB_LABEL).map((kind) => {
              const rows = s.jobs.counts.filter((c) => c.kind === kind)
              const get = (st: string) => rows.find((r) => r.status === st)?.n ?? 0
              return (
                <li key={kind} className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-ink">{JOB_LABEL[kind]}</span>
                  <span className="flex gap-2 text-xs">
                    {get('running') > 0 && <Badge tone="accent">running</Badge>}
                    {get('queued') > 0 && <Badge>{get('queued')} queued</Badge>}
                    <Badge tone="ok">{get('done')} done (24h)</Badge>
                    {get('failed') > 0 && <Badge tone="bad">{get('failed')} failed</Badge>}
                  </span>
                </li>
              )
            })}
          </ul>
          {(s.jobs.failed.length > 0 || s.jobs.retrying.length > 0) && (
            <ul className="divide-y divide-line border-t border-line text-xs">
              {s.jobs.retrying.map((j) => (
                <li key={`r${j.id}`} className="px-4 py-2 text-ink-2">
                  <Badge tone="warn">retrying</Badge> {JOB_LABEL[j.kind] ?? j.kind} (attempt {j.attempts}, next {fmtDateTime(j.run_after)}): {j.last_error?.slice(0, 200)}
                </li>
              ))}
              {s.jobs.failed.map((j) => (
                <li key={`f${j.id}`} className="flex items-start justify-between gap-2 px-4 py-2 text-ink-2">
                  <span>
                    <Badge tone="bad">failed</Badge> {JOB_LABEL[j.kind] ?? j.kind} — {j.last_error?.slice(0, 200)}
                  </span>
                  <ActionButton url={`/api/jobs/${j.id}/retry`} label="Retry" />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Data sent outside this server (30 days)" />
          <div className="space-y-2 p-4 text-sm text-ink-2">
            <p>
              AI provider: <b className="text-ink">{s.ai.provider}</b>
              {s.ai.model && <> · model {s.ai.model}</>}. Embeddings: <b className="text-ink">{s.embeddings ? `${s.embeddings.provider} (${s.embeddings.model})` : 'off'}</b>.
            </p>
            {s.external.length === 0 ? (
              <p className="text-ok">No conversation content has been sent to any external service.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-left text-ink-3">
                  <tr>
                    <th className="py-1">Provider</th>
                    <th>Purpose</th>
                    <th className="text-right">Calls</th>
                    <th className="text-right">Characters sent</th>
                    <th className="text-right">Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {s.external.map((e, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="py-1">{e.provider}</td>
                      <td>{e.purpose}</td>
                      <td className="text-right tabular-nums">{fmtNum(e.calls)}</td>
                      <td className="text-right tabular-nums">{fmtNum(e.chars)}</td>
                      <td className="text-right tabular-nums">{fmtNum(e.failures)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Backups" action={s.backups.supported ? <ActionButton url="/api/backup" label="Back up now" done="Backup created" /> : undefined} />
          <div className="space-y-2 p-4 text-sm text-ink-2">
            <p>
              {s.backups.supported
                ? <>Daily snapshots of the database in <code className="break-all">{s.backups.dir}</code>, keeping the newest {s.backups.keep}.</>
                : 'This deployment uses a PostgreSQL server: back it up with pg_dump (see README).'}{' '}
              Original export files are kept unchanged in <code className="break-all">{s.storage.dataDir}</code>.
            </p>
            {s.backups.list.length > 0 && (
              <ul className="text-xs">
                {s.backups.list.map((b) => (
                  <li key={b.file} className="flex justify-between border-t border-line py-1">
                    <span>{fmtDateTime(b.createdAt)}</span>
                    <span className="tabular-nums">{fmtBytes(b.size)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </>
  )
}
