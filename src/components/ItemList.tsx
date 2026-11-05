import Link from 'next/link'
import { fmtDate } from '@/lib/format'
import { KIND_LABEL, STATUS_LABEL } from '@/lib/knowledge/types'
import type { ItemView } from '@/lib/knowledge/queries'
import { Badge } from './ui'

const statusTone = (s: string) =>
  s === 'confirmed' || s === 'done' ? 'ok' : s === 'proposed' || s === 'assumption' ? 'warn' : s === 'rejected' ? 'bad' : s === 'open' ? 'accent' : 'neutral'

/** A knowledge item with its status, source quote and anything later that replaced or contradicts it. */
export function ItemRow({ item, showConversation = true }: { item: ItemView; showConversation?: boolean }) {
  const outdated = !!item.supersededBy
  return (
    <li className={`px-4 py-3 ${outdated ? 'opacity-75' : ''}`}>
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs">
        <Badge>{KIND_LABEL[item.kind] ?? item.kind}</Badge>
        <Badge tone={statusTone(item.status)}>{STATUS_LABEL[item.status] ?? item.status}</Badge>
        {outdated && <Badge tone="bad">Outdated</Badge>}
        {item.contradicts.length > 0 && <Badge tone="bad">Conflict</Badge>}
        {item.possiblyChangedBy.length > 0 && <Badge tone="warn" title="A later statement on the same subject may replace this one">May have changed</Badge>}
        {item.due && <Badge tone="accent">Due: {item.due}</Badge>}
        {item.origin === 'live_capture' && <Badge title="Captured live; not yet confirmed by an official export">Live capture</Badge>}
        <span className="ml-auto tabular-nums text-ink-3">{fmtDate(item.date)}</span>
      </div>
      <p className={`text-sm text-ink ${outdated ? 'line-through decoration-ink-3' : ''}`}>{item.statement}</p>
      <Link href={`/conversations/${item.conversationId}#m-${item.messageId}`} className="mt-1 block text-xs text-ink-3 hover:text-accent">
        “{item.quote.length > 220 ? item.quote.slice(0, 217) + '…' : item.quote}”{showConversation && <> — {item.conversationTitle}</>}
      </Link>
      {item.supersededBy && (
        <p className="mt-1 text-xs text-bad">
          Replaced by:{' '}
          <Link className="underline" href={`/conversations/${item.supersededBy.conversationId}#m-${item.supersededBy.messageId}`}>
            {item.supersededBy.statement}
          </Link>
        </p>
      )}
      {item.contradicts.map((c) => (
        <p key={c.id} className="mt-1 text-xs text-bad">
          Conflicts with:{' '}
          <Link className="underline" href={`/conversations/${c.conversationId}#m-${c.messageId}`}>
            {c.statement}
          </Link>
        </p>
      ))}
      {item.possiblyChangedBy.map((c) => (
        <p key={c.id} className="mt-1 text-xs text-warn">
          Later statement to review:{' '}
          <Link className="underline" href={`/conversations/${c.conversationId}#m-${c.messageId}`}>
            {c.statement}
          </Link>
        </p>
      ))}
    </li>
  )
}

export function ItemList({ items, empty = 'Nothing recorded.', showConversation = true }: { items: ItemView[]; empty?: string; showConversation?: boolean }) {
  if (!items.length) return <p className="px-4 py-4 text-sm text-ink-3">{empty}</p>
  return (
    <ul className="divide-y divide-line">
      {items.map((i) => (
        <ItemRow key={i.id} item={i} showConversation={showConversation} />
      ))}
    </ul>
  )
}
