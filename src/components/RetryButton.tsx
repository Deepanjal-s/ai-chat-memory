'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { buttonClass } from './ui'

export function RetryButton({ batchId }: { batchId: number }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-sm text-bad">{error}</span>}
      <button
        className={buttonClass('secondary')}
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          const res = await fetch(`/api/imports/${batchId}/retry`, { method: 'POST' })
          setBusy(false)
          if (res.ok) router.refresh()
          else setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Retry failed')
        }}
      >
        {busy ? 'Retrying…' : 'Run import again'}
      </button>
    </div>
  )
}
