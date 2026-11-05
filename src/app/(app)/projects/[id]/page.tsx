import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ItemList } from '@/components/ItemList'
import { Badge, ButtonLink, Card, CardHeader, PageHeader, Stat } from '@/components/ui'
import { getDb } from '@/lib/db/client'
import { fmtDate, fmtNum } from '@/lib/format'
import { getEntity, type ItemView } from '@/lib/knowledge/queries'

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id)
  if (!Number.isInteger(id)) notFound()
  const data = await getEntity(await getDb(), id)
  if (!data) notFound()
  const { entity, conversations, items, related } = data
  const current = (i: ItemView) => !i.supersededBy
  const recentFirst = (a: ItemView, b: ItemView) => (b.date ?? '').localeCompare(a.date ?? '')
  const pick = (pred: (i: ItemView) => boolean) => items.filter(pred).sort(recentFirst)
  const decisions = pick((i) => i.kind === 'decision' && i.status === 'confirmed')
  const suggestions = pick((i) => i.kind === 'decision' && i.status !== 'confirmed')
  const requirements = pick((i) => i.kind === 'requirement' || i.kind === 'preference')
  const tasks = pick((i) => ((i.kind === 'task' && i.status === 'open') || i.kind === 'deadline') && current(i))
  const problems = pick((i) => i.kind === 'problem' || i.kind === 'solution')
  const ideas = pick((i) => i.kind === 'idea')
  const changes = items.filter((i) => i.supersededBy || i.contradicts.length || i.possiblyChangedBy.length)

  return (
    <>
      <div className="mb-3 text-sm">
        <Link href="/projects" className="text-accent">← Projects & topics</Link>
      </div>
      <PageHeader
        title={entity.name}
        subtitle={
          <>
            <Badge tone="accent">{entity.kind}</Badge>{' '}
            {conversations.length ? `Discussed from ${fmtDate(conversations[0].created_at)} to ${fmtDate(conversations.at(-1)!.updated_at)}` : ''}
          </>
        }
        actions={
          <>
            <ButtonLink href={`/ask?about=${encodeURIComponent(entity.name)}`} variant="secondary">Ask about it</ButtonLink>
            <ButtonLink href={`/documents?entity=${entity.id}`}>Generate document</ButtonLink>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Conversations" value={fmtNum(conversations.length)} />
        <Stat label="Confirmed decisions" value={fmtNum(decisions.filter(current).length)} hint={`${decisions.length - decisions.filter(current).length} outdated`} />
        <Stat label="Open tasks" value={fmtNum(tasks.length)} />
        <Stat label="Changes & conflicts" value={fmtNum(changes.length)} hint="Later statements to review" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Confirmed decisions" />
            <ItemList items={decisions} empty="No confirmed decisions recorded." />
          </Card>
          <Card>
            <CardHeader title="Open tasks & deadlines" />
            <ItemList items={tasks} empty="No open tasks recorded." />
          </Card>
          <Card>
            <CardHeader title="Requirements & preferences" />
            <ItemList items={requirements} empty="No requirements recorded." />
          </Card>
          <Card>
            <CardHeader title="Suggestions (not confirmed)" />
            <ItemList items={suggestions} empty="No unconfirmed suggestions." />
          </Card>
          <Card>
            <CardHeader title="Problems & solutions" />
            <ItemList items={problems} empty="No problems recorded." />
          </Card>
          {ideas.length > 0 && (
            <Card>
              <CardHeader title="Ideas" />
              <ItemList items={ideas} />
            </Card>
          )}
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Timeline" />
            <ol className="relative space-y-4 border-l border-line px-4 py-4 pl-6">
              {conversations.map((c) => (
                <li key={c.id} className="relative">
                  <span className="absolute -left-[22px] top-1.5 h-2.5 w-2.5 rounded-full bg-accent" />
                  <div className="text-xs tabular-nums text-ink-3">{fmtDate(c.created_at)}</div>
                  <Link href={`/conversations/${c.id}`} className="text-sm font-medium text-ink hover:text-accent">
                    {c.title}
                  </Link>
                  {c.summary && <p className="mt-0.5 line-clamp-3 text-xs text-ink-2">{c.summary}</p>}
                </li>
              ))}
            </ol>
          </Card>
          {related.length > 0 && (
            <Card>
              <CardHeader title="Often discussed together" />
              <div className="flex flex-wrap gap-2 p-4">
                {related.map((r) => (
                  <Link key={r.id} href={`/projects/${r.id}`} className="rounded-lg border border-line px-2.5 py-1 text-sm text-ink hover:bg-panel-2">
                    {r.name} <span className="text-ink-3">· {r.shared}</span>
                  </Link>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  )
}
