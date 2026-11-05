import Link from 'next/link'
import { Snippet } from '@/components/Snippet'
import { Badge, Card, EmptyState, PageHeader, buttonClass, inputClass } from '@/components/ui'
import { getDb } from '@/lib/db/client'
import { ROLE_LABEL, fmtDate, fmtDateTime } from '@/lib/format'
import { search } from '@/lib/search'

type SP = Promise<Record<string, string | string[] | undefined>>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''

export default async function SearchPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams
  const q = one(sp.q).trim()
  const from = one(sp.from)
  const to = one(sp.to)
  const role = one(sp.role)
  const hidden = one(sp.hidden) === '1'
  const branches = one(sp.branches) === '1'

  const result = q
    ? await search(await getDb(), {
        q,
        from: from || null,
        to: to || null,
        role: role === 'user' || role === 'assistant' ? role : null,
        includeHidden: hidden,
        includeBranches: branches,
        limit: 100,
      })
    : null

  return (
    <>
      <PageHeader
        title="Search"
        subtitle="Searches every message you exchanged with ChatGPT. Use quotes for exact phrases and -word to exclude."
      />
      <form className="mb-6 space-y-3">
        <div className="flex gap-2">
          <input name="q" defaultValue={q} autoFocus placeholder='e.g. VK7SPORTS database decision, "backend architecture"' className={`${inputClass} py-2.5 text-base`} aria-label="Search" />
          <button className={buttonClass()}>Search</button>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink-2">
          <label className="flex items-center gap-1.5">
            From <input type="date" name="from" defaultValue={from} className={`${inputClass} w-auto py-1`} />
          </label>
          <label className="flex items-center gap-1.5">
            To <input type="date" name="to" defaultValue={to} className={`${inputClass} w-auto py-1`} />
          </label>
          <label className="flex items-center gap-1.5">
            Said by
            <select name="role" defaultValue={role} className={`${inputClass} w-auto py-1`}>
              <option value="">Anyone</option>
              <option value="user">You</option>
              <option value="assistant">ChatGPT</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" name="branches" value="1" defaultChecked={branches} /> Include edited/regenerated versions
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" name="hidden" value="1" defaultChecked={hidden} /> Include custom instructions &amp; system text
          </label>
        </div>
      </form>

      {!result ? null : result.hits.length === 0 && result.conversations.length === 0 ? (
        <EmptyState title="No matches in your history">
          Try fewer or different words, widen the date range, or include edited versions.
        </EmptyState>
      ) : (
        <div className="space-y-6">
          <p className="text-sm text-ink-3">
            {result.hits.length} matching message{result.hits.length === 1 ? '' : 's'}
            {result.semanticEnabled ? ' · keyword + meaning-based search' : ' · keyword search'}
            {result.semanticError && <span className="text-warn"> · semantic search unavailable: {result.semanticError}</span>}
          </p>

          {result.conversations.length > 0 && (
            <div>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">Conversation titles</h2>
              <div className="flex flex-wrap gap-2">
                {result.conversations.map((c) => (
                  <Link key={c.id} href={`/conversations/${c.id}`} className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-ink hover:bg-panel-2">
                    {c.title} <span className="text-ink-3">· {fmtDate(c.updatedAt)}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          <ul className="space-y-3">
            {result.hits.map((h) => (
              <li key={h.messageId}>
                <Card className="p-4 hover:border-accent">
                  <Link href={`/conversations/${h.conversationId}#m-${h.messageId}`} className="block">
                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{h.conversationTitle}</span>
                      <Badge tone={h.role === 'user' ? 'accent' : 'neutral'}>{ROLE_LABEL[h.role ?? ''] ?? h.role ?? 'Message'}</Badge>
                      {!h.isCanonical && <Badge tone="warn" title="This text was later edited or regenerated in ChatGPT">Earlier version</Badge>}
                      {h.matchedBy.includes('semantic') && !h.matchedBy.includes('keyword') && <Badge tone="ok">Similar meaning</Badge>}
                      <span className="ml-auto text-xs tabular-nums text-ink-3">{fmtDateTime(h.createdAt)}</span>
                    </div>
                    <p className="text-sm leading-relaxed text-ink-2">
                      <Snippet text={h.snippet} />
                    </p>
                  </Link>
                </Card>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}
