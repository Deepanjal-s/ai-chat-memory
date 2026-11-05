import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Markdown } from '@/components/Markdown'
import { Badge, Card, PageHeader, buttonClass } from '@/components/ui'
import { getDb } from '@/lib/db/client'
import { ROLE_LABEL, fmtDate, fmtDateTime, fmtNum } from '@/lib/format'
import { getConversation, type ReaderMessage } from '@/lib/queries'
import { conversationKnowledge } from '@/lib/knowledge/queries'
import { ItemList } from '@/components/ItemList'
import { CardHeader } from '@/components/ui'

type SP = Promise<Record<string, string | string[] | undefined>>

export default async function ConversationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const id = Number((await params).id)
  const showHidden = (await searchParams).hidden === '1'
  if (!Number.isInteger(id)) notFound()
  const db = await getDb()
  const c = await getConversation(db, id)
  if (!c) notFound()
  const k = await conversationKnowledge(db, id)

  // Off-path versions grouped by the node they branch from, so each edit/regeneration shows next to its replacement.
  const altByParent = new Map<string, ReaderMessage[]>()
  for (const m of c.offPath) {
    if (!m.role || m.isHidden || !m.parentNodeId) continue
    const list = altByParent.get(m.parentNodeId) ?? []
    list.push(m)
    altByParent.set(m.parentNodeId, list)
  }
  const visible = c.canonical.filter((m) => m.role && (showHidden || !m.isHidden))
  const hiddenCount = c.canonical.filter((m) => m.role && m.isHidden && m.text.trim()).length

  return (
    <>
      <div className="mb-3 text-sm">
        <Link href="/conversations" className="text-accent">← Conversations</Link>
      </div>
      <PageHeader
        title={c.title}
        subtitle={`Started ${fmtDateTime(c.createdAt)} · last active ${fmtDateTime(c.updatedAt)} · ${fmtNum(c.messageCount)} messages`}
        actions={
          <a href={`/api/conversations/${c.id}/raw`} className={buttonClass('secondary')} title="Download the original export JSON for verification">
            Original JSON
          </a>
        }
      />

      <div className="mb-6 flex flex-wrap gap-2 text-xs">
        <Badge>Source: {c.sourceLabel}</Badge>
        {c.modelSlugs.map((m) => <Badge key={m}>{m}</Badge>)}
        {c.branchCount > 0 && <Badge tone="accent">{c.branchCount} edited/regenerated point{c.branchCount === 1 ? '' : 's'}</Badge>}
        {c.missing && <Badge tone="warn">Not in latest export — possibly deleted in ChatGPT</Badge>}
        {c.isArchived && <Badge>Archived in ChatGPT</Badge>}
        {c.versions.length ? (
          <Badge title={c.versions.map((v) => `v${v.version} · import #${v.batchId} · ${fmtDate(v.createdAt)}`).join('\n')}>
            Export version {c.version} · {c.versions.length} stored
          </Badge>
        ) : (
          <Badge tone="warn" title="Only captured live so far; the next official export will confirm it">Live capture only — not yet in an export</Badge>
        )}
        <a className="text-accent underline" href={`https://chatgpt.com/c/${encodeURIComponent(c.externalId)}`} target="_blank" rel="noopener noreferrer">
          Open in ChatGPT
        </a>
        {hiddenCount > 0 && (
          <Link className="text-accent underline" href={showHidden ? `/conversations/${c.id}` : `/conversations/${c.id}?hidden=1`}>
            {showHidden ? 'Hide' : 'Show'} custom instructions & system text ({hiddenCount})
          </Link>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0">
      <ol className="space-y-4">
        {visible.map((m) => {
          const alts = m.parentNodeId ? altByParent.get(m.parentNodeId) ?? [] : []
          return (
            <li key={m.id} id={`m-${m.id}`} className="msg rounded-xl">
              <MessageCard m={m} />
              {alts.length > 0 && (
                <details className="mt-2 ml-4 text-sm">
                  <summary className="cursor-pointer text-ink-3 hover:text-ink">
                    {alts.length} other version{alts.length === 1 ? '' : 's'} of this {m.role === 'user' ? 'message (edited)' : 'reply (regenerated)'}
                  </summary>
                  <ol className="mt-2 space-y-2 border-l-2 border-line pl-3">
                    {alts.map((a) => (
                      <li key={a.id} id={`m-${a.id}`} className="msg rounded-xl">
                        <MessageCard m={a} alt />
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </li>
          )
        })}
      </ol>
      </div>
      <aside className="space-y-4 xl:sticky xl:top-6 xl:h-fit">
        <Card>
          <CardHeader title="Summary" />
          <div className="space-y-2 p-4 text-sm text-ink-2">
            {k.summary ? <p>{k.summary}</p> : <p className="text-ink-3">Not processed yet; it will be shortly.</p>}
            {k.entities.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {k.entities.map((e) => (
                  <Link key={e.id} href={`/projects/${e.id}`} className="rounded-md border border-line px-2 py-0.5 text-xs text-ink hover:bg-panel-2">
                    {e.name}
                  </Link>
                ))}
              </div>
            )}
            {k.processedBy && <p className="text-xs text-ink-3">Processed {fmtDateTime(k.processedAt)} by {k.processedBy === 'rules-v1' ? 'local rules' : k.processedBy}</p>}
          </div>
        </Card>
        <Card>
          <CardHeader title={`Recorded from this conversation (${k.items.length})`} />
          <div className="max-h-[480px] overflow-y-auto">
            <ItemList items={k.items} showConversation={false} empty="No decisions, tasks or requirements recorded." />
          </div>
        </Card>
        {k.related.length > 0 && (
          <Card>
            <CardHeader title="Related conversations" />
            <ul className="divide-y divide-line">
              {k.related.map((r) => (
                <li key={r.id}>
                  <Link href={`/conversations/${r.id}`} className="block px-4 py-2.5 hover:bg-panel-2">
                    <span className="block truncate text-sm text-ink">{r.title}</span>
                    <span className="text-xs text-ink-3">{fmtDate(r.updated_at)} · shares {r.shared.slice(0, 3).join(', ')}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </aside>
      </div>

      {c.offPath.some((m) => m.role && !m.isHidden && !altByParent.get(m.parentNodeId ?? '')?.includes(m)) && (
        <p className="mt-6 text-sm text-ink-3">Some messages belong to deeper edited branches and are available through search with “Include edited versions”.</p>
      )}
    </>
  )
}

function MessageCard({ m, alt = false }: { m: ReaderMessage; alt?: boolean }) {
  const isUser = m.role === 'user'
  const attachments = (m.metadata.attachments as { name?: string }[] | undefined) ?? []
  return (
    <Card className={`p-4 ${isUser ? 'bg-user' : ''} ${alt ? 'opacity-90' : ''}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className={`font-semibold ${isUser ? 'text-accent' : 'text-ink'}`}>
          {ROLE_LABEL[m.role ?? ''] ?? m.role}
          {m.role === 'tool' && m.authorName ? ` · ${m.authorName}` : ''}
        </span>
        {alt && <Badge tone="warn">Earlier version</Badge>}
        {m.metadata.captured_from === 'browser_extension' && <Badge title="Captured live by the browser extension; time is when it was captured. Confirmed when the next export is imported.">Live capture</Badge>}
        {m.isHidden && <Badge>Not shown in ChatGPT</Badge>}
        {!m.presentInLatest && <Badge tone="warn">Removed in a later export</Badge>}
        {m.modelSlug && <span className="text-ink-3">{m.modelSlug}</span>}
        <span className="ml-auto tabular-nums text-ink-3">{fmtDateTime(m.createdAt)}</span>
        <a href={`#m-${m.id}`} className="text-ink-3 hover:text-accent" title="Link to this message">#</a>
      </div>
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((a, i) => <Badge key={i}>📎 {a.name ?? 'attachment'}</Badge>)}
        </div>
      )}
      {m.text.trim() ? <Markdown text={m.text} /> : <p className="text-sm italic text-ink-3">(no text content)</p>}
    </Card>
  )
}
