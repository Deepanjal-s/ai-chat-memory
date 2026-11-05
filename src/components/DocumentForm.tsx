'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { buttonClass, inputClass } from './ui'

const TYPES: [string, string, string][] = [
  ['project_report', 'Project report', 'Overview, timeline, decisions, requirements, problems, pending work, changes'],
  ['technical', 'Technical documentation', 'Overview, technical decisions, requirements, problems and solutions'],
  ['decision_record', 'Decision record', 'Confirmed vs suggested decisions and how they changed'],
  ['requirements', 'Requirements document', 'Requirements, preferences and changes to them'],
  ['pending_tasks', 'Pending-task report', 'Open tasks and deadlines with sources'],
  ['timeline', 'Project timeline', 'Every discussion in date order with summaries'],
]

export function DocumentForm({ entities, defaultEntityId }: { entities: { id: number; name: string; kind: string }[]; defaultEntityId?: number }) {
  const router = useRouter()
  const [entityId, setEntityId] = useState<string>(defaultEntityId ? String(defaultEntityId) : '')
  const [query, setQuery] = useState('')
  const [docType, setDocType] = useState('project_report')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [title, setTitle] = useState('')
  const [formats, setFormats] = useState<string[]>(['pdf', 'docx'])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    const res = await fetch('/api/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entityId: entityId ? Number(entityId) : null,
        query: query.trim() || undefined,
        docType,
        from: from || null,
        to: to || null,
        title: title.trim() || undefined,
        formats,
      }),
    })
    const json = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) return setMsg({ ok: false, text: json.error ?? 'Failed' })
    setMsg({ ok: true, text: 'Generating — the document appears in the list below when ready.' })
    router.refresh()
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-ink-2">Project or topic</span>
          <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className={inputClass}>
            <option value="">— Use the subject below —</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.kind})
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-ink-2">Subject (free text)</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. backend architecture" className={inputClass} maxLength={300} />
        </label>
      </div>
      <fieldset>
        <legend className="mb-1 text-sm font-medium text-ink-2">Document type</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {TYPES.map(([value, label, hint]) => (
            <label key={value} className={`cursor-pointer rounded-lg border p-3 text-sm ${docType === value ? 'border-accent bg-accent-soft' : 'border-line bg-panel hover:bg-panel-2'}`}>
              <input type="radio" name="docType" value={value} checked={docType === value} onChange={() => setDocType(value)} className="sr-only" />
              <span className="block font-medium text-ink">{label}</span>
              <span className="text-xs text-ink-3">{hint}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label>
          <span className="mb-1 block font-medium text-ink-2">From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`${inputClass} w-auto`} />
        </label>
        <label>
          <span className="mb-1 block font-medium text-ink-2">To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={`${inputClass} w-auto`} />
        </label>
        <label className="min-w-48 flex-1">
          <span className="mb-1 block font-medium text-ink-2">Title (optional)</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} maxLength={200} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm text-ink-2">
        {['pdf', 'docx', 'md'].map((f) => (
          <label key={f} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={formats.includes(f)}
              onChange={(e) => setFormats((cur) => (e.target.checked ? [...cur, f] : cur.filter((x) => x !== f)))}
            />
            {f === 'md' ? 'Markdown' : f.toUpperCase()}
          </label>
        ))}
        <button className={`${buttonClass()} ml-auto`} disabled={busy || formats.length === 0 || (!entityId && !query.trim())}>
          {busy ? 'Queuing…' : 'Generate document'}
        </button>
      </div>
      {msg && <p className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad'}`}>{msg.text}</p>}
    </form>
  )
}
