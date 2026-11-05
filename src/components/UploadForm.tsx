'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { fmtBytes } from '@/lib/format'
import { buttonClass, inputClass } from './ui'

/** Streams the export file to the server with upload progress (XHR, so progress events are available). */
export function UploadForm() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [label, setLabel] = useState('ChatGPT')
  const [progress, setProgress] = useState<number | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad' | 'neutral'; text: string } | null>(null)
  const [dragging, setDragging] = useState(false)

  function pick(f: File | undefined | null) {
    if (!f) return
    if (!/\.(zip|json)$/i.test(f.name)) {
      setMessage({ tone: 'bad', text: 'Choose the .zip file from your ChatGPT export (or the conversations.json inside it).' })
      return
    }
    setMessage(null)
    setFile(f)
  }

  function upload() {
    if (!file) return
    setProgress(0)
    setMessage(null)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/imports')
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name))
    xhr.setRequestHeader('x-source-label', label)
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => e.lengthComputable && setProgress(e.loaded / e.total)
    xhr.onload = () => {
      setProgress(null)
      let body: { batchId?: number; duplicateOf?: number | null; error?: string } = {}
      try {
        body = JSON.parse(xhr.responseText)
      } catch {}
      if (xhr.status === 202) {
        setFile(null)
        if (inputRef.current) inputRef.current.value = ''
        setMessage(
          body.duplicateOf
            ? { tone: 'neutral', text: `This exact file was already imported (import #${body.duplicateOf}). Nothing to do.` }
            : { tone: 'ok', text: `Uploaded. Import #${body.batchId} is running — progress appears below.` },
        )
        router.refresh()
      } else {
        setMessage({ tone: 'bad', text: body.error ?? `Upload failed (${xhr.status})` })
      }
    }
    xhr.onerror = () => {
      setProgress(null)
      setMessage({ tone: 'bad', text: 'Upload failed — check your connection and try again.' })
    }
    xhr.send(file)
  }

  const busy = progress !== null
  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          pick(e.dataTransfer.files[0])
        }}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${
          dragging ? 'border-accent bg-accent-soft' : 'border-line hover:bg-panel-2'
        }`}
      >
        <input ref={inputRef} type="file" accept=".zip,.json" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
        {file ? (
          <div>
            <div className="font-medium text-ink">{file.name}</div>
            <div className="text-sm text-ink-3">{fmtBytes(file.size)}</div>
          </div>
        ) : (
          <div>
            <div className="font-medium text-ink">Drop your ChatGPT export here</div>
            <div className="mt-1 text-sm text-ink-3">or click to choose the .zip file</div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="block flex-1">
          <span className="mb-1 block text-sm font-medium text-ink-2">Account label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} className={inputClass} maxLength={100} disabled={busy} />
        </label>
        <button onClick={upload} disabled={!file || busy} className={buttonClass()}>
          {busy ? `Uploading ${Math.round((progress ?? 0) * 100)}%` : 'Upload & import'}
        </button>
      </div>

      {busy && (
        <div className="h-1.5 overflow-hidden rounded-full bg-panel-2">
          <div className="h-full bg-accent transition-all" style={{ width: `${(progress ?? 0) * 100}%` }} />
        </div>
      )}
      {message && (
        <p
          role="status"
          className={`rounded-lg px-3 py-2 text-sm ${
            message.tone === 'ok' ? 'bg-ok-soft text-ok' : message.tone === 'bad' ? 'bg-bad-soft text-bad' : 'bg-panel-2 text-ink-2'
          }`}
        >
          {message.text}
        </p>
      )}
    </div>
  )
}
