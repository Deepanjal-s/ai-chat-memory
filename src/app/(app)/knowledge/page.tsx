import Link from 'next/link'
import { ItemList } from '@/components/ItemList'
import { Card, PageHeader } from '@/components/ui'
import { getDb } from '@/lib/db/client'
import { listItems } from '@/lib/knowledge/queries'

type SP = Promise<Record<string, string | string[] | undefined>>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''

const TABS = [
  { key: 'decisions', label: 'Decisions', kind: 'decision', status: '' },
  { key: 'tasks', label: 'Open tasks', kind: 'task', status: 'open' },
  { key: 'requirements', label: 'Requirements', kind: 'requirement', status: '' },
  { key: 'problems', label: 'Problems', kind: 'problem', status: '' },
  { key: 'ideas', label: 'Ideas', kind: 'idea', status: '' },
  { key: 'preferences', label: 'Preferences', kind: 'preference', status: '' },
]

export default async function KnowledgePage({ searchParams }: { searchParams: SP }) {
  const requested = one((await searchParams).tab)
  const tab = TABS.find((t) => t.key === requested) ?? TABS[0]
  const items = await listItems(await getDb(), { kind: tab.kind, status: tab.status || undefined, limit: 300 })
  return (
    <>
      <PageHeader title="Decisions & tasks" subtitle="Everything recorded across all conversations, newest first. Each entry links to the exact message it came from." />
      <nav className="mb-4 flex flex-wrap gap-1" aria-label="Record type">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/knowledge?tab=${t.key}`}
            className={`rounded-lg px-3 py-1.5 text-sm ${t.key === tab.key ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 hover:bg-panel-2'}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <Card>
        <ItemList items={items} empty="Nothing recorded yet." />
      </Card>
    </>
  )
}
