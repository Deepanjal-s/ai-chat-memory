import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Answer } from '@/lib/qa'
import { Badge } from './ui'

const CONFIDENCE: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  high: { label: 'Well supported', tone: 'ok' },
  medium: { label: 'Partly supported', tone: 'warn' },
  low: { label: 'Weakly supported', tone: 'bad' },
  insufficient: { label: 'Not enough information', tone: 'bad' },
  not_assessed: { label: 'Verified records (no AI)', tone: 'neutral' },
}

const roleName = (r: string | null) => (r === 'user' ? 'You' : r === 'assistant' ? 'ChatGPT' : r ?? 'Message')

/** Renders an answer; every [S#] becomes a link to the exact message it came from. */
export function AnswerView({ answer }: { answer: Answer }) {
  const link = (n: number) => {
    const s = answer.sources[n - 1]
    return s ? `/conversations/${s.conversationId}#m-${s.messageId}` : '#'
  }
  const md = answer.answer.replace(/\[S(\d+)\]/g, (_m, d: string) => `[[S${d}]](${link(Number(d))})`)
  const c = CONFIDENCE[answer.confidence] ?? CONFIDENCE.not_assessed
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={c.tone}>{c.label}</Badge>
        {answer.mode === 'ai' ? (
          <Badge tone="accent" title="Excerpts of the sources below were sent to this AI provider to write the answer">
            Written by AI ({answer.provider}) from {answer.sources.length} sources
          </Badge>
        ) : (
          <Badge>Local only: nothing left this server</Badge>
        )}
        {answer.entities.map((e) => (
          <a key={e.id} href={`/projects/${e.id}`} className="text-accent underline">
            {e.name}
          </a>
        ))}
        {answer.timeWindowFrom && <Badge>Since {answer.timeWindowFrom}</Badge>}
        {answer.removedCitations > 0 && <Badge tone="warn">{answer.removedCitations} invalid reference(s) removed</Badge>}
      </div>
      <div className="prose-chat text-[15px] text-ink">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
      </div>
      {answer.conflicts.length > 0 && (
        <div className="rounded-lg border border-bad bg-bad-soft px-3 py-2 text-sm">
          <div className="mb-1 font-semibold text-bad">Conflicting information</div>
          <ul className="list-disc space-y-1 pl-5 text-ink">
            {answer.conflicts.map((c, i) => (
              <li key={i}>
                {c.description}{' '}
                {c.sources.map((n) => (
                  <a key={n} href={link(n)} className="text-accent">
                    [S{n}]
                  </a>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
      {answer.sources.length > 0 && (
        <details className="rounded-lg border border-line bg-panel-2 text-sm">
          <summary className="cursor-pointer px-3 py-2 text-ink-2">Sources ({answer.sources.length})</summary>
          <ol className="divide-y divide-line">
            {answer.sources.map((s) => (
              <li key={s.n} id={`src-${s.n}`} className="px-3 py-2">
                <a href={link(s.n)} className="font-medium text-accent">
                  [S{s.n}] {s.conversationTitle}
                </a>
                <span className="text-ink-3"> · {s.date ? s.date.slice(0, 10) : 'undated'}</span>
                {s.origin === 'live_capture' && <span className="text-ink-3"> · live capture</span>}
                <p className="mt-0.5 text-ink-2">
                  {s.type === 'item' ? (
                    <>
                      <b>{s.kind}</b> ({s.status}
                      {s.supersededBy ? ', outdated' : ''}): {s.statement}
                    </>
                  ) : (
                    <>
                      {roleName(s.role)}: {s.text.replace(/\s+/g, ' ').slice(0, 240)}
                      {s.text.length > 240 ? '…' : ''}
                    </>
                  )}
                </p>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  )
}
