import Link from 'next/link'
import { AutoRefresh } from '@/components/AutoRefresh'
import { UploadForm } from '@/components/UploadForm'
import { Card, CardHeader, PageHeader, StatusBadge } from '@/components/ui'
import { getDb } from '@/lib/db/client'
import { fmtBytes, fmtDateTime, fmtNum } from '@/lib/format'
import { listBatches, recentWatchedFiles } from '@/lib/queries'
import { watcherStatus } from '@/lib/importer/watcher'
import { Badge } from '@/components/ui'

const ORIGIN_LABEL: Record<string, string> = { upload: 'Uploaded', cli: 'Command line', watch: 'Auto · Downloads' }

export default async function ImportPage() {
  const db = await getDb()
  const [batches, watched] = await Promise.all([listBatches(db), recentWatchedFiles(db)])
  const watch = watcherStatus()
  const active = batches.some((b) => b.status === 'queued' || b.status === 'processing')
  return (
    <>
      <AutoRefresh active={active} />
      <PageHeader title="Import & sync" subtitle="Bring in your ChatGPT history. Re-importing is always safe: only new or changed conversations are added." />

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="p-5 lg:col-span-3">
          <UploadForm />
        </Card>
        <Card className="p-5 text-sm text-ink-2 lg:col-span-2">
          <h2 className="mb-2 font-semibold text-ink">How to get your export</h2>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>In ChatGPT, open <b>Settings → Data controls</b>.</li>
            <li>Choose <b>Export data</b> and confirm.</li>
            <li>OpenAI emails a download link (usually within minutes; the link expires after 24 hours).</li>
            <li>Upload the .zip here. You don’t need to unzip it.</li>
          </ol>
          <p className="mt-3 text-ink-3">Repeat monthly (or whenever you like) to keep this archive up to date.</p>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader
          title="Automatic import from your Downloads folder"
          action={watch.enabled ? <Badge tone={watch.lastError ? 'warn' : 'ok'}>{watch.lastError ? 'Needs attention' : 'Watching'}</Badge> : <Badge>Off</Badge>}
        />
        <div className="space-y-2 px-4 py-3 text-sm text-ink-2">
          {watch.enabled ? (
            <>
              <p>
                New ChatGPT exports saved to <code className="break-all text-ink">{watch.dir}</code> are detected and imported automatically
                (checked every {watch.intervalSeconds} seconds; the original file is left untouched).
              </p>
              <p className="text-xs text-ink-3">
                Last checked {watch.lastScanAt ? fmtDateTime(watch.lastScanAt) : 'not yet'}
                {watch.lastImportAt && ` · last automatic import ${fmtDateTime(watch.lastImportAt)}`}
              </p>
              {watch.lastError && <p className="rounded-lg bg-warn-soft px-3 py-2 text-warn">{watch.lastError}</p>}
            </>
          ) : (
            <p>Turned off. Set <code>WATCH_ENABLED=true</code> (and optionally <code>WATCH_DIR</code>) in .env.local and restart.</p>
          )}
          {watched.length > 0 && (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {watched.map((w) => (
                <li key={w.path} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 truncate text-ink" title={w.path}>{w.path.split(/[\\/]/).pop()}</span>
                  <span className="flex shrink-0 items-center gap-2 text-xs">
                    {w.batch_id && <Link className="text-accent" href={`/imports/${w.batch_id}`}>import #{w.batch_id}</Link>}
                    <Badge tone={w.status === 'error' ? 'bad' : w.status === 'imported' ? 'ok' : 'neutral'}>
                      {w.status === 'duplicate' ? 'already imported' : w.status}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card className="mt-6">
        <CardHeader title="Import history" />
        {batches.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-3">No imports yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-ink-3">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 font-medium">#</th>
                  <th className="px-4 py-2 font-medium">File</th>
                  <th className="px-4 py-2 font-medium">Uploaded</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">New</th>
                  <th className="px-4 py-2 text-right font-medium">Updated</th>
                  <th className="px-4 py-2 text-right font-medium">Unchanged</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {batches.map((b) => (
                  <tr key={b.id} className="hover:bg-panel-2">
                    <td className="px-4 py-2.5 tabular-nums text-ink-3">{b.id}</td>
                    <td className="px-4 py-2.5">
                      <Link href={`/imports/${b.id}`} className="font-medium text-accent">{b.originalFilename}</Link>
                      <div className="text-xs text-ink-3">{b.sourceLabel} · {fmtBytes(b.fileSize)} · {ORIGIN_LABEL[b.origin] ?? b.origin}</div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-ink-2">{fmtDateTime(b.uploadedAt)}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={b.status} />
                      {b.status === 'processing' && (
                        <div className="mt-1 text-xs text-ink-3">{fmtNum(b.stats.conversationsInFile)} conversations read…</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{fmtNum(b.stats.newConversations)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{fmtNum(b.stats.updatedConversations)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{fmtNum(b.stats.unchangedConversations)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
