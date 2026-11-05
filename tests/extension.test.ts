import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CapturePayloadSchema, ingestCapture } from '../src/lib/capture/ingest'
import { openDb, type Db } from '../src/lib/db/client'

/**
 * These tests run the extension's code against a SIMULATED ChatGPT page modelled on the structure chatgpt.com uses
 * (data-message-author-role / data-message-id attributes). They are not a substitute for a check on the real site.
 */
const extractSrc = fs.readFileSync(path.join(import.meta.dirname, '..', 'extension', 'extract.js'), 'utf8')
const backgroundSrc = fs.readFileSync(path.join(import.meta.dirname, '..', 'extension', 'background.js'), 'utf8')

const CONV = '6720a1b2-0c3d-8000-9e4f-1a2b3c4d5e6f'
const page = (opts: { streaming?: boolean; variant?: string } = {}) => `<!doctype html><html><head><title>VK7SPORTS launch plan | ChatGPT</title></head><body>
<nav><a href="/c/${CONV}">VK7SPORTS launch plan</a><a href="/c/other-conversation-1">Other chat</a></nav>
<main>
  <article data-testid="conversation-turn-1">
    <div data-message-author-role="user" data-message-id="aaa-111"><div class="whitespace-pre-wrap">When should VK7SPORTS launch?</div></div>
  </article>
  <article data-testid="conversation-turn-2">
    <div data-message-author-role="assistant" data-message-id="bbb-222" data-message-model-slug="gpt-5">
      <div class="markdown prose"><p>I suggest a <strong>phased</strong> launch:</p><ul><li>Beta in April</li><li>Public in June</li></ul>
      <pre><div>python<button>Copy code</button></div><code class="language-python">print("launch")\n</code></pre></div>
    </div>
    ${opts.variant ? `<div class="flex"><button>‹</button><div>${opts.variant}</div><button>›</button></div>` : ''}
  </article>
  ${opts.streaming ? '<button data-testid="stop-button">Stop</button>' : ''}
</main></body></html>`

function extract(html: string, url = `https://chatgpt.com/c/${CONV}`) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' })
  dom.window.eval(extractSrc)
  const E = (dom.window as unknown as { AIMExtract: { extractConversation: (d: Document, l: Location) => any } }).AIMExtract
  return E.extractConversation(dom.window.document, dom.window.location)
}

describe('extension page reader (simulated ChatGPT page)', () => {
  it('reads conversation id, title, roles, ids, model and formatted text', () => {
    const snap = extract(page())
    expect(snap.conversationId).toBe(CONV)
    expect(snap.title).toBe('VK7SPORTS launch plan')
    expect(snap.streaming).toBe(false)
    expect(snap.messages).toHaveLength(2)
    expect(snap.messages[0]).toMatchObject({ id: 'aaa-111', role: 'user', text: 'When should VK7SPORTS launch?' })
    const a = snap.messages[1]
    expect(a).toMatchObject({ id: 'bbb-222', role: 'assistant', model: 'gpt-5' })
    expect(a.text).toContain('I suggest a phased launch:')
    expect(a.text).toContain('- Beta in April')
    expect(a.text).toContain('```python\nprint("launch")\n```')
    expect(a.text).not.toContain('Copy code')
  })

  it('detects streaming replies and regeneration variants', () => {
    expect(extract(page({ streaming: true })).streaming).toBe(true)
    expect(extract(page({ variant: '2/3' })).messages[1].variant).toEqual({ index: 2, count: 3 })
  })

  it('ignores pages that are not a conversation', () => {
    expect(extract(page(), 'https://chatgpt.com/')).toBeNull()
    expect(extract(page(), 'https://chatgpt.com/g/g-abc123/c/' + CONV).conversationId).toBe(CONV)
  })

  it('produces payloads the app accepts and stores', async () => {
    const snap = extract(page({ variant: '2/2' }))
    const payload = { conversationId: snap.conversationId, title: snap.title, url: snap.url, capturedAt: new Date().toISOString(), extensionVersion: '1.0.0', messages: snap.messages }
    const parsed = CapturePayloadSchema.parse(payload)
    const db = await openDb({ embeddingDim: 8 })
    try {
      const r = await ingestCapture(db, parsed)
      expect(r).toMatchObject({ created: true, added: 2 })
      const [m] = await db.query<{ sibling_index: number; sibling_count: number; model_slug: string }>(
        "SELECT sibling_index, sibling_count, model_slug FROM messages WHERE node_external_id = 'bbb-222'",
      )
      expect(m).toEqual({ sibling_index: 1, sibling_count: 2, model_slug: 'gpt-5' })
    } finally {
      await db.close()
    }
  })
})

describe('extension delivery queue (simulated browser)', () => {
  let store: Record<string, unknown>
  let fetchCalls: { url: string; body: any }[]
  let online: boolean
  let listeners: Record<string, ((...a: any[]) => any)[]>
  let ctx: vm.Context

  beforeEach(() => {
    store = { serverUrl: 'http://localhost:3000', token: 'aim_' + 'x'.repeat(40) }
    fetchCalls = []
    online = false
    listeners = {}
    const on = (name: string) => ({ addListener: (fn: any) => ((listeners[name] ??= []).push(fn)) })
    const chrome = {
      storage: {
        local: {
          get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
          set: async (obj: Record<string, unknown>) => Object.assign(store, structuredClone(obj)),
        },
      },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      alarms: { create: () => {}, onAlarm: on('alarm') },
      runtime: { onMessage: on('message'), onStartup: on('startup'), onInstalled: on('installed'), openOptionsPage: () => {} },
    }
    const fetch = async (url: string, init: any) => {
      if (!online) throw new TypeError('fetch failed')
      fetchCalls.push({ url, body: JSON.parse(init.body) })
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    ctx = vm.createContext({ chrome, fetch, console })
    vm.runInContext(backgroundSrc, ctx)
  })
  afterEach(() => vm.runInContext('null', ctx))

  const send = async (payload: unknown) => {
    for (const fn of listeners.message) fn({ type: 'capture', payload }, {}, () => {})
    await new Promise((r) => setTimeout(r, 20))
  }
  const alarm = async () => {
    for (const fn of listeners.alarm) await fn({ name: 'flush' })
  }

  it('keeps captures while the app is offline and delivers them when it is back', async () => {
    await send({ conversationId: 'c-1', capturedAt: '1', messages: [] })
    await send({ conversationId: 'c-2', capturedAt: '2', messages: [] })
    await send({ conversationId: 'c-1', capturedAt: '3', messages: [] }) // newer snapshot replaces the older one
    expect((store.queue as any[]).map((p) => p.capturedAt)).toEqual(['2', '3'])
    expect((store.status as any).state).toBe('offline')

    online = true
    await alarm()
    expect(fetchCalls.map((c) => c.body.conversationId)).toEqual(['c-2', 'c-1'])
    expect(fetchCalls[0].url).toBe('http://localhost:3000/api/capture')
    expect(store.queue).toEqual([])
    expect((store.status as any).state).toBe('ok')
  })

  it('reports a missing configuration instead of sending anywhere', async () => {
    delete store.token
    online = true
    await send({ conversationId: 'c-1', capturedAt: '1', messages: [] })
    expect(fetchCalls).toHaveLength(0)
    expect((store.status as any).state).toBe('not_configured')
  })
})
