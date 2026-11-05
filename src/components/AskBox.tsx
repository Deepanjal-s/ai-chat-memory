'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { Answer } from '@/lib/qa'
import { AnswerView } from './AnswerView'
import { buttonClass, inputClass } from './ui'

const EXAMPLES = [
  'What did we decide about the backend architecture?',
  'What are the pending tasks?',
  'What changed in the requirements over the last six months?',
  'What problems did we run into, and how were they solved?',
]

export function AskBox({ aiEnabled, initial, prefill }: { aiEnabled: boolean; initial?: Answer | null; prefill?: string }) {
  const router = useRouter()
  const [question, setQuestion] = useState(initial?.question ?? prefill ?? '')
  const [answer, setAnswer] = useState<Answer | null>(initial ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function ask(q = question) {
    if (q.trim().length < 3) return
    setQuestion(q)
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q }) })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Request failed')
      setAnswer(body)
      router.refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void ask()
        }}
        className="space-y-2"
      >
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void ask()
            }
          }}
          rows={3}
          maxLength={2000}
          placeholder="Ask anything about your past conversations…"
          className={`${inputClass} resize-y text-base`}
          aria-label="Question"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-ink-3">
            {aiEnabled
              ? 'Relevant excerpts are sent to the configured AI provider to write the answer. Every statement links to its source.'
              : 'AI answering is off: you get the verified records and passages, and nothing leaves this server.'}
          </p>
          <button className={buttonClass()} disabled={busy || question.trim().length < 3}>
            {busy ? 'Searching your history…' : 'Ask'}
          </button>
        </div>
      </form>
      {!answer && !busy && (
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((q) => (
            <button key={q} onClick={() => ask(q)} className="rounded-full border border-line bg-panel px-3 py-1.5 text-sm text-ink-2 hover:bg-panel-2">
              {q}
            </button>
          ))}
        </div>
      )}
      {error && <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{error}</p>}
      {busy && <div className="h-1 animate-pulse rounded bg-accent-soft" />}
      {answer && !busy && (
        <div className="rounded-xl border border-line bg-panel p-5">
          <AnswerView answer={answer} />
        </div>
      )}
    </div>
  )
}
