import Link from 'next/link'
import { AskBox } from '@/components/AskBox'
import { Card, CardHeader, PageHeader } from '@/components/ui'
import { aiDescription } from '@/lib/ai/llm'
import { getDb } from '@/lib/db/client'
import { fmtDateTime } from '@/lib/format'
import type { Answer } from '@/lib/qa'

type SP = Promise<Record<string, string | string[] | undefined>>

export default async function AskPage({ searchParams }: { searchParams: SP }) {
  const db = await getDb()
  const sp = await searchParams
  const id = Number(sp.id)
  const prefill =
    typeof sp.about === 'string'
      ? `What do we know about ${sp.about.slice(0, 200)}? Summarise decisions, requirements, open tasks and changes.`
      : typeof sp.q === 'string'
        ? sp.q.slice(0, 2000)
        : undefined
  const history = await db.query<{ id: number; question: string; mode: string; created_at: Date }>(
    'SELECT id, question, mode, created_at FROM qa_turns ORDER BY id DESC LIMIT 15',
  )
  let initial: Answer | null = null
  if (Number.isInteger(id) && id > 0) {
    const [row] = await db.query<{ answer: Answer }>('SELECT answer FROM qa_turns WHERE id = $1', [id])
    initial = row?.answer ?? null
  }
  const ai = aiDescription()
  return (
    <>
      <PageHeader
        title="Memory assistant"
        subtitle="Ask about past projects, decisions, requirements and tasks. Answers come only from your conversation history, with sources."
      />
      <div className="grid gap-6 lg:grid-cols-4">
        <div className="lg:col-span-3">
          <AskBox key={initial ? `a-${id}` : `new-${prefill ?? ''}`} aiEnabled={ai.enabled} initial={initial} prefill={prefill} />
        </div>
        <Card className="h-fit">
          <CardHeader title="Recent questions" action={<Link href="/ask" className="text-sm text-accent">New</Link>} />
          {history.length === 0 ? (
            <p className="px-4 py-4 text-sm text-ink-3">No questions yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {history.map((h) => (
                <li key={h.id}>
                  <Link href={`/ask?id=${h.id}`} className={`block px-4 py-2.5 hover:bg-panel-2 ${h.id === id ? 'bg-accent-soft' : ''}`}>
                    <span className="line-clamp-2 text-sm text-ink">{h.question}</span>
                    <span className="text-xs text-ink-3">{fmtDateTime(new Date(h.created_at).toISOString())} · {h.mode === 'ai' ? 'AI' : 'local'}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  )
}
