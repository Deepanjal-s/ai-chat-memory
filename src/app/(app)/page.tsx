import Link from 'next/link'
import { AutoRefresh } from '@/components/AutoRefresh'
import { ButtonLink, Card, CardHeader, EmptyState, PageHeader, Stat, StatusBadge, inputClass, buttonClass } from '@/components/ui'
import { getDb } from '@/lib/db/client'
import { fmtDate, fmtDateTime, fmtNum } from '@/lib/format'
import { ExportReminder } from '@/components/ExportReminder'
import { ItemList } from '@/components/ItemList'
import { knowledgeOverview } from '@/lib/knowledge/queries'
import { config } from '@/lib/config'
import { dashboardStats, exportFreshness, listBatches, listConversations } from '@/lib/queries'

export default async function DashboardPage() {
  const db = await getDb()
  const [stats, batches, recent, fresh, knowledge] = await Promise.all([
    dashboardStats(db),
    listBatches(db, 5),
    listConversations(db, { pageSize: 8, sort: 'updated' }),
    exportFreshness(db, config.exportReminderDays),
    knowledgeOverview(db),
  ])
  const importing = batches.some((b) => b.status === 'queued' || b.status === 'processing')
  const reminder = fresh.stale && !importing && (
    <ExportReminder ageDays={fresh.ageDays} exportAsOf={fresh.exportAsOf} watchEnabled={config.watchEnabled} watchDir={config.watchDir} />
  )

  if (stats.conversations === 0 && !importing) {
    return (
      <>
        <PageHeader title="Welcome" subtitle="Your conversation archive is empty." />
        {reminder}
        <EmptyState title="Import your ChatGPT history to get started" action={<ButtonLink href="/import">Import an export</ButtonLink>}>
          Nothing is lost or duplicated, and newer exports can be imported at any time.
        </EmptyState>
      </>
    )
  }

  const maxMonth = Math.max(1, ...stats.perMonth.map((m) => m.n))
  return (
    <>
      <AutoRefresh active={importing} intervalMs={3000} />
      <PageHeader
        title="Dashboard"
        subtitle={stats.first ? `History from ${fmtDate(stats.first)} to ${fmtDate(stats.last)}` : undefined}
      />
      {reminder}

      <form action="/ask" className="mb-6 flex gap-2">
        <input name="q" placeholder="Ask about a project, decision or task…" className={`${inputClass} py-2.5 text-base`} aria-label="Ask" />
        <button className={buttonClass()}>Ask</button>
        <Link href="/search" className={buttonClass('secondary')}>Search</Link>
      </form>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Conversations" value={fmtNum(stats.conversations)} />
        <Stat label="Messages" value={fmtNum(stats.messages)} hint="Your messages and ChatGPT replies" />
        <Stat
          label="Semantic index"
          value={stats.chunks ? `${Math.round((stats.embedded / stats.chunks) * 100)}%` : '—'}
          hint={stats.embedded ? `${fmtNum(stats.embedded)} of ${fmtNum(stats.chunks)} passages` : 'Keyword search active'}
        />
        <Stat
          label="Not in latest export"
          value={fmtNum(stats.missing)}
          hint={stats.missing ? 'Kept here; deleted in ChatGPT?' : 'Archive matches ChatGPT'}
        />
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Projects recognised" value={fmtNum(knowledge.counts.projects)} hint={<Link href="/projects" className="text-accent">View projects</Link>} />
        <Stat label="Confirmed decisions" value={fmtNum(knowledge.counts.decisions)} />
        <Stat label="Open tasks" value={fmtNum(knowledge.counts.open_tasks)} />
        <Stat
          label="Understood"
          value={`${fmtNum(knowledge.counts.processed)} / ${fmtNum(knowledge.counts.total)}`}
          hint={<Link href="/status" className="text-accent">Processing status</Link>}
        />
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Latest confirmed decisions" action={<Link href="/knowledge?tab=decisions" className="text-sm text-accent">All</Link>} />
          <ItemList items={knowledge.recentDecisions} empty="No confirmed decisions recorded yet." />
        </Card>
        <Card>
          <CardHeader title="Open tasks & deadlines" action={<Link href="/knowledge?tab=tasks" className="text-sm text-accent">All</Link>} />
          <ItemList items={knowledge.openTasks} empty="No open tasks recorded." />
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader title="Recently active conversations" action={<Link href="/conversations" className="text-sm text-accent">View all</Link>} />
          <ul className="divide-y divide-line">
            {recent.items.map((c) => (
              <li key={c.id}>
                <Link href={`/conversations/${c.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-panel-2">
                  <span className="min-w-0 truncate text-sm text-ink">{c.title}</span>
                  <span className="shrink-0 text-xs tabular-nums text-ink-3">{fmtDate(c.updatedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Imports" action={<Link href="/import" className="text-sm text-accent">Manage</Link>} />
            <ul className="divide-y divide-line">
              {batches.map((b) => (
                <li key={b.id}>
                  <Link href={`/imports/${b.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-panel-2">
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-ink">{b.originalFilename}</span>
                      <span className="text-xs text-ink-3">{fmtDateTime(b.uploadedAt)}</span>
                    </span>
                    <StatusBadge status={b.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>

          {stats.perMonth.length > 0 && (
            <Card>
              <CardHeader title="Conversations started per month" />
              <div className="flex h-36 items-end gap-1.5 px-4 pb-2 pt-4" role="img" aria-label="Conversations per month">
                {stats.perMonth.map((m) => (
                  <div key={m.month} className="flex h-full flex-1 flex-col items-center justify-end gap-1" title={`${m.month}: ${m.n}`}>
                    <span className="text-[10px] tabular-nums text-ink-3">{m.n}</span>
                    <div className="w-full rounded-t bg-accent" style={{ height: `${(m.n / maxMonth) * 100}%`, minHeight: 2 }} />
                  </div>
                ))}
              </div>
              <div className="flex gap-1.5 px-4 pb-3">
                {stats.perMonth.map((m) => (
                  <span key={m.month} className="flex-1 text-center text-[10px] text-ink-3">
                    {m.month.slice(5)}
                  </span>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  )
}
