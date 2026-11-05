'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { buttonClass } from './ui'

/** A button that POSTs (or DELETEs) to an API route, shows the outcome, and refreshes the page. */
export function ActionButton({
  url,
  method = 'POST',
  body,
  label,
  busyLabel,
  confirm,
  variant = 'secondary',
  done,
}: {
  url: string
  method?: 'POST' | 'DELETE'
  body?: unknown
  label: string
  busyLabel?: string
  confirm?: string
  variant?: 'primary' | 'secondary'
  /** Message shown on success; {field} is replaced with that field of the JSON response. */
  done?: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        className={buttonClass(variant)}
        disabled={busy}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return
          setBusy(true)
          setMsg(null)
          try {
            const res = await fetch(url, {
              method,
              headers: body ? { 'content-type': 'application/json' } : undefined,
              body: body ? JSON.stringify(body) : undefined,
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(json.error ?? `Failed (${res.status})`)
            setMsg(done ? { ok: true, text: done.replace(/\{(\w+)\}/g, (_m, k: string) => String(json[k] ?? '')) } : null)
            router.refresh()
          } catch (e) {
            setMsg({ ok: false, text: (e as Error).message })
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? busyLabel ?? 'Working…' : label}
      </button>
      {msg && <span className={`text-sm ${msg.ok ? 'text-ok' : 'text-bad'}`}>{msg.text}</span>}
    </span>
  )
}

/** Creates an extension pairing token and shows it once. */
export function TokenCreator() {
  const router = useRouter()
  const [token, setToken] = useState<string | null>(null)
  const [label, setLabel] = useState('Chrome on office PC')
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} className="min-w-0 flex-1 rounded-lg border border-line bg-panel px-3 py-2 text-sm" aria-label="Token label" />
        <button
          className={buttonClass()}
          onClick={async () => {
            setError(null)
            const res = await fetch('/api/extension-tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label }) })
            const json = await res.json()
            if (!res.ok) return setError(json.error ?? 'Failed')
            setToken(json.token)
            router.refresh()
          }}
        >
          Create pairing token
        </button>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {token && (
        <div className="rounded-lg border border-ok bg-ok-soft p-3 text-sm">
          <p className="mb-1 font-medium text-ok">Copy this token into the extension’s settings now. It will not be shown again.</p>
          <code className="block break-all rounded bg-panel px-2 py-1 text-ink">{token}</code>
          <button className="mt-2 text-sm text-accent underline" onClick={() => navigator.clipboard.writeText(token)}>
            Copy to clipboard
          </button>
        </div>
      )}
    </div>
  )
}

/** Live capture is opt-in: turning it on requires acknowledging the terms-of-service note. */
export function CaptureToggle({ enabled }: { enabled: boolean }) {
  const router = useRouter()
  const [ack, setAck] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = async (on: boolean) => {
    setError(null)
    const res = await fetch('/api/settings/capture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: on, acknowledged: ack }) })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) setError(json.error ?? 'Failed')
    router.refresh()
  }
  if (enabled) {
    return (
      <button className={buttonClass('secondary')} onClick={() => set(false)}>
        Turn live capture off
      </button>
    )
  }
  return (
    <div className="space-y-2">
      <label className="flex items-start gap-2 text-sm text-ink-2">
        <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>I have read the note above and the company accepts responsibility for using automatic capture with this ChatGPT account.</span>
      </label>
      <button className={buttonClass()} disabled={!ack} onClick={() => set(true)}>
        Turn live capture on
      </button>
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  )
}
