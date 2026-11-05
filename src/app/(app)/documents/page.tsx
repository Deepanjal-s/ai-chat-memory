import { AutoRefresh } from '@/components/AutoRefresh'
import { DocumentForm } from '@/components/DocumentForm'
import { Badge, Card, CardHeader, PageHeader } from '@/components/ui'
import { aiDescription } from '@/lib/ai/llm'
import { getDb } from '@/lib/db/client'
import { DOC_TYPES } from '@/lib/documents/model'
import { fmtDateTime } from '@/lib/format'
import { listEntities } from '@/lib/knowledge/queries'

type SP = Promise<Record<string, string | string[] | undefined>>

export default async function DocumentsPage({ searchParams }: { searchParams: SP }) {
  const db = await getDb()
  const entity = Number((await searchParams).entity)
  const [entities, docs] = await Promise.all([
    listEntities(db),
    db.query<{ id: number; title: string; doc_type: string; status: string; formats: string[]; files: Record<string, string>; source_count: number; mode: string | null; error: string | null; created_at: Date }>(
      'SELECT id, title, doc_type, status, formats, files, source_count, mode, error, created_at FROM documents ORDER BY id DESC LIMIT 50',
    ),
  ])
  const active = docs.some((d) => d.status === 'queued' || d.status === 'generating')
  const ai = aiDescription()
  return (
    <>
      <AutoRefresh active={active} />
      <PageHeader
        title="Documents"
        subtitle={
          ai.enabled
            ? `Built from verified records with numbered source references. The overview section is written by ${ai.provider} from cited records.`
            : 'Built from verified records with numbered source references. AI is off, so every section comes directly from the records.'
        }
      />
      <Card className="mb-6 p-5">
        <DocumentForm entities={entities.map((e) => ({ id: e.id, name: e.name, kind: e.kind }))} defaultEntityId={Number.isInteger(entity) ? entity : undefined} />
      </Card>
      <Card>
        <CardHeader title="Document history" />
        {docs.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-3">No documents yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {docs.map((d) => (
              <li key={d.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-ink">{d.title}</div>
                  <div className="text-xs text-ink-3">
                    {DOC_TYPES[d.doc_type as keyof typeof DOC_TYPES] ?? d.doc_type} · {fmtDateTime(new Date(d.created_at).toISOString())}
                    {d.status === 'ready' && ` · ${d.source_count} sources · ${d.mode === 'ai' ? 'AI overview' : 'records only'}`}
                  </div>
                  {d.error && <div className="mt-1 text-xs text-bad">{d.error}</div>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {d.status === 'ready' ? (
                    Object.keys(d.files).map((f) => (
                      <a key={f} href={`/api/documents/${d.id}/download?format=${f}`} className="rounded-lg border border-line px-2.5 py-1 text-sm text-accent hover:bg-panel-2">
                        {f === 'md' ? 'Markdown' : f.toUpperCase()}
                      </a>
                    ))
                  ) : (
                    <Badge tone={d.status === 'failed' ? 'bad' : 'accent'}>{d.status === 'failed' ? 'Failed' : 'Generating…'}</Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}
