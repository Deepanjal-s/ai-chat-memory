import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AutoRefresh } from '@/components/AutoRefresh'
import { RetryButton } from '@/components/RetryButton'
import { Badge, Card, CardHeader, PageHeader, Stat, StatusBadge } from '@/components/ui'
import { getDb } from '@/lib/db/client'
import { fmtBytes, fmtDateTime, fmtNum } from '@/lib/format'
import { getBatch } from '@/lib/queries'

export default async function ImportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id)
  if (!Number.isInteger(id)) notFound()
  const found = await getBatch(await getDb(), id)
  if (!found) notFound()
  const { batch: b, issues, issueCount } = found
  const s = b.stats
  const r = s.reconciliation
  const active = b.status === 'queued' || b.status === 'processing'

  return (
    <>
      <AutoRefresh active={active} />
      <div className="mb-3 text-sm">
        <Link href="/import" className="text-accent">← Import & sync</Link>
      </div>
      <PageHeader
        title={`Import #${b.id}`}
        subtitle={`${b.originalFilename} · ${fmtBytes(b.fileSize)} · uploaded ${fmtDateTime(b.uploadedAt)}`}
        actions={
          <>
            <StatusBadge status={b.status} />
            {(b.status === 'failed' || b.status === 'complete_with_errors') && <RetryButton batchId={b.id} />}
          </>
        }
      />

      {b.status === 'duplicate' && (
        <Card className="mb-6 p-4 text-sm text-ink-2">
          This exact file (same SHA-256 fingerprint) was already imported as{' '}
          <Link className="text-accent" href={`/imports/${b.duplicateOf}`}>import #{b.duplicateOf}</Link>. Nothing was changed.
        </Card>
      )}
      {b.error && <Card className="mb-6 border-bad bg-bad-soft p-4 text-sm text-bad">{b.error}</Card>}

      {r && (
        <Card className={`mb-6 p-4 text-sm ${r.ok ? 'border-ok' : 'border-warn'}`}>
          <div className="mb-1 font-semibold text-ink">{r.ok ? '✓ Reconciliation passed' : '⚠ Reconciliation mismatch'}</div>
          <p className="text-ink-2">
            Expected {fmtNum(r.expectedConversations)} conversations and {fmtNum(r.expectedNodes)} message nodes from this file; the archive
            holds {fmtNum(r.storedConversations)} and {fmtNum(r.storedNodes)}.
            {r.ok ? ' Every message in the export is stored.' : ' See the issues below.'}
          </p>
        </Card>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="In file" value={fmtNum(s.conversationsInFile)} hint={`${fmtNum(s.nodesInFile)} message nodes`} />
        <Stat label="New" value={fmtNum(s.newConversations)} hint={`${fmtNum(s.messagesAdded)} messages added`} />
        <Stat label="Updated" value={fmtNum(s.updatedConversations)} hint={`${fmtNum(s.messagesChanged)} messages changed`} />
        <Stat label="Unchanged" value={fmtNum(s.unchangedConversations)} hint="Skipped, already up to date" />
      </div>

      <Card className="mb-6">
        <CardHeader title="Details" />
        <dl className="grid gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-2">
          <Row k="Account label" v={b.sourceLabel} />
          <Row k="Export format" v={s.format ? s.format.toUpperCase() : '—'} />
          <Row k="Conversation files" v={s.conversationFiles?.join(', ') ?? '—'} />
          <Row k="Other files in export" v={fmtNum(s.otherFilesInExport)} />
          <Row k="Export covers up to" v={fmtDateTime(s.exportAsOf)} />
          <Row k="Failed conversations" v={fmtNum(s.failedConversations)} />
          <Row k="Older copies kept as history" v={fmtNum(s.olderVersionsKept)} />
          <Row k="Duplicates inside file" v={fmtNum(s.duplicatesInFile)} />
          <Row k="Conversations not in this export" v={fmtNum(s.missingFromExport)} />
          <Row k="Messages removed from source" v={fmtNum(s.messagesNoLongerInSource)} />
          <Row k="Started / finished" v={`${fmtDateTime(b.startedAt)} → ${fmtDateTime(b.finishedAt)}`} />
          <Row k="File SHA-256" v={<code className="break-all text-xs">{b.fileSha256}</code>} />
        </dl>
      </Card>

      <Card>
        <CardHeader title={`Issues (${fmtNum(issueCount)})`} />
        {issues.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-3">No issues.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {issues.map((i, n) => (
              <li key={n} className="flex gap-3 px-4 py-2">
                <Badge tone={i.severity === 'error' ? 'bad' : 'warn'}>{i.severity}</Badge>
                <span className="min-w-0 text-ink-2">
                  {i.message}
                  {i.conversation_external_id && <span className="block text-xs text-ink-3">Conversation {i.conversation_external_id}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line py-1.5 last:border-0 sm:[&:nth-last-child(2)]:border-0">
      <dt className="text-ink-3">{k}</dt>
      <dd className="min-w-0 text-right text-ink">{v}</dd>
    </div>
  )
}
