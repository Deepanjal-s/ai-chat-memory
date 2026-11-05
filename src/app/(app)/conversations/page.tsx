import Link from 'next/link'
import { Badge, Card, EmptyState, PageHeader, buttonClass, inputClass } from '@/components/ui'
import { getDb } from '@/lib/db/client'
import { fmtDate, fmtNum } from '@/lib/format'
import { listConversations } from '@/lib/queries'

type SP = Promise<Record<string, string | string[] | undefined>>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
const PAGE_SIZE = 50

export default async function ConversationsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams
  const q = one(sp.q).trim()
  const sort = (['updated', 'created', 'title'].includes(one(sp.sort)) ? one(sp.sort) : 'updated') as 'updated' | 'created' | 'title'
  const page = Math.max(1, Number(one(sp.page)) || 1)
  const { items, total } = await listConversations(await getDb(), { q, sort, page, pageSize: PAGE_SIZE })
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const href = (p: number) => `/conversations?${new URLSearchParams({ ...(q && { q }), sort, page: String(p) })}`

  return (
    <>
      <PageHeader title="Conversations" subtitle={`${fmtNum(total)} conversation${total === 1 ? '' : 's'}${q ? ` with “${q}” in the title` : ''}`} />
      <form className="mb-4 flex flex-wrap gap-2">
        <input name="q" defaultValue={q} placeholder="Filter by title…" className={`${inputClass} min-w-0 flex-1`} aria-label="Filter by title" />
        <select name="sort" defaultValue={sort} className={`${inputClass} w-auto`} aria-label="Sort">
          <option value="updated">Last active</option>
          <option value="created">Date started</option>
          <option value="title">Title A–Z</option>
        </select>
        <button className={buttonClass('secondary')}>Apply</button>
      </form>

      {items.length === 0 ? (
        <EmptyState title={q ? 'No conversation titles match' : 'No conversations yet'}>
          {q ? <>Try <Link className="text-accent" href={`/search?q=${encodeURIComponent(q)}`}>searching message text</Link> instead.</> : 'Import an export to see conversations here.'}
        </EmptyState>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {items.map((c) => (
              <li key={c.id}>
                <Link href={`/conversations/${c.id}`} className="flex flex-col gap-1 px-4 py-3 hover:bg-panel-2 sm:flex-row sm:items-center sm:gap-4">
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">{c.title}</span>
                  <span className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                    {c.missing && <Badge tone="warn">Not in latest export</Badge>}
                    {c.isArchived && <Badge>Archived in ChatGPT</Badge>}
                    {c.branchCount > 0 && <Badge title="Messages that were edited or regenerated">{c.branchCount} edit{c.branchCount === 1 ? '' : 's'}</Badge>}
                    <span className="tabular-nums">{fmtNum(c.messageCount)} msgs</span>
                    <span className="w-24 text-right tabular-nums">{fmtDate(sort === 'created' ? c.createdAt : c.updatedAt)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {pages > 1 && (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pages">
          {page > 1 ? <Link className={buttonClass('secondary')} href={href(page - 1)}>← Previous</Link> : <span />}
          <span className="text-ink-3">Page {page} of {pages}</span>
          {page < pages ? <Link className={buttonClass('secondary')} href={href(page + 1)}>Next →</Link> : <span />}
        </nav>
      )}
    </>
  )
}
