import Link from 'next/link'
import { Badge, Card, EmptyState, PageHeader, buttonClass, inputClass } from '@/components/ui'
import { getDb } from '@/lib/db/client'
import { fmtDate, fmtNum } from '@/lib/format'
import { listEntities } from '@/lib/knowledge/queries'

type SP = Promise<Record<string, string | string[] | undefined>>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
const KINDS = ['project', 'organization', 'person', 'product', 'technology', 'topic']

export default async function ProjectsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams
  const q = one(sp.q).trim()
  const kind = KINDS.includes(one(sp.kind)) ? one(sp.kind) : ''
  const entities = await listEntities(await getDb(), { q, kind })
  return (
    <>
      <PageHeader
        title="Projects & topics"
        subtitle="Recognised automatically across all conversations. Open one to see its decisions, requirements, tasks and history."
      />
      <form className="mb-4 flex flex-wrap gap-2">
        <input name="q" defaultValue={q} placeholder="Filter by name…" className={`${inputClass} min-w-0 flex-1`} aria-label="Filter" />
        <select name="kind" defaultValue={kind} className={`${inputClass} w-auto`} aria-label="Type">
          <option value="">All types</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k[0].toUpperCase() + k.slice(1)}
            </option>
          ))}
        </select>
        <button className={buttonClass('secondary')}>Apply</button>
      </form>
      {entities.length === 0 ? (
        <EmptyState title="Nothing recognised yet">
          Projects and topics appear once conversations have been processed. Check <Link className="text-accent" href="/status">Status</Link> for progress.
        </EmptyState>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {entities.map((e) => (
              <li key={e.id}>
                <Link href={`/projects/${e.id}`} className="flex flex-col gap-1 px-4 py-3 hover:bg-panel-2 sm:flex-row sm:items-center sm:gap-4">
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate font-medium text-ink">{e.name}</span>
                    <Badge tone={e.kind === 'project' ? 'accent' : 'neutral'}>{e.kind}</Badge>
                  </span>
                  <span className="flex flex-wrap items-center gap-3 text-xs tabular-nums text-ink-3">
                    <span>{fmtNum(e.conversations)} conversation{e.conversations === 1 ? '' : 's'}</span>
                    <span>{fmtNum(e.items)} records</span>
                    {e.open_tasks > 0 && <Badge tone="accent">{e.open_tasks} open task{e.open_tasks === 1 ? '' : 's'}</Badge>}
                    <span className="w-40 text-right">
                      {fmtDate(e.first_activity)} – {fmtDate(e.last_activity)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  )
}
