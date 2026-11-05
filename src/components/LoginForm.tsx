'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { buttonClass, inputClass } from './ui'

export function LoginForm() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    setBusy(false)
    if (res.ok) {
      router.replace('/')
      router.refresh()
    } else {
      setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Sign-in failed')
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-2">Password</span>
        <input
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputClass}
        />
      </label>
      {error && (
        <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy} className={`${buttonClass()} w-full`}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}
