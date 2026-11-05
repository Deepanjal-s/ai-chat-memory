import Link from 'next/link'
import { fmtDate } from '@/lib/format'

/** Nudges the director to request a fresh ChatGPT export; the watcher imports it automatically once downloaded. */
export function ExportReminder({
  ageDays,
  exportAsOf,
  watchEnabled,
  watchDir,
}: {
  ageDays: number | null
  exportAsOf: string | null
  watchEnabled: boolean
  watchDir: string
}) {
  return (
    <div className="mb-6 rounded-xl border border-warn bg-warn-soft px-4 py-3 text-sm text-ink">
      <div className="font-semibold text-warn">
        {ageDays === null ? 'No ChatGPT export imported yet' : `Your archive was last updated from ChatGPT ${ageDays} day${ageDays === 1 ? '' : 's'} ago`}
        {exportAsOf && <span className="font-normal text-ink-2"> · covers conversations up to {fmtDate(exportAsOf)}</span>}
      </div>
      <p className="mt-1 text-ink-2">
        In ChatGPT open <b>Settings → Data controls → Export data</b>, then click the download link in OpenAI&apos;s email.
        {watchEnabled ? (
          <> The file is imported automatically once it lands in <code className="break-all">{watchDir}</code>.</>
        ) : (
          <> Then <Link href="/import" className="text-accent underline">upload it here</Link>.</>
        )}
      </p>
    </div>
  )
}
