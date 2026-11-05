/*
 * Delivers captured conversations to the Conversation Memory app.
 * Captures wait in a persistent queue (chrome.storage.local) until the app confirms them, so nothing is lost when
 * the app is offline, the laptop sleeps or the browser restarts. Retries every minute.
 */
const MAX_QUEUE = 300
let flushing = false

async function getConfig() {
  const { serverUrl, token } = await chrome.storage.local.get(['serverUrl', 'token'])
  return { serverUrl: (serverUrl || '').replace(/\/+$/, ''), token: token || '' }
}

async function setStatus(patch) {
  const { status = {} } = await chrome.storage.local.get('status')
  const next = { ...status, ...patch, updatedAt: new Date().toISOString() }
  await chrome.storage.local.set({ status: next })
  const { queue = [] } = await chrome.storage.local.get('queue')
  const bad = ['not_configured', 'bad_token', 'disabled', 'offline', 'error'].includes(next.state)
  await chrome.action.setBadgeBackgroundColor({ color: bad ? '#c0282d' : '#1f4fd1' })
  await chrome.action.setBadgeText({ text: bad ? '!' : queue.length ? String(Math.min(queue.length, 99)) : '' })
}

async function enqueue(payload) {
  const { queue = [] } = await chrome.storage.local.get('queue')
  // A newer snapshot of the same conversation contains the whole visible thread: it replaces the older one.
  const next = queue.filter((p) => p.conversationId !== payload.conversationId)
  next.push(payload)
  while (next.length > MAX_QUEUE) next.shift()
  await chrome.storage.local.set({ queue: next })
  await flush()
}

async function flush() {
  if (flushing) return
  flushing = true
  try {
    const { serverUrl, token } = await getConfig()
    if (!serverUrl || !token) return await setStatus({ state: 'not_configured' })
    for (;;) {
      const { queue = [] } = await chrome.storage.local.get('queue')
      if (!queue.length) return await setStatus({ state: 'ok' })
      const payload = queue[0]
      let res
      try {
        res = await fetch(serverUrl + '/api/capture', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
          body: JSON.stringify(payload),
        })
      } catch (e) {
        return await setStatus({ state: 'offline', lastError: 'Cannot reach ' + serverUrl })
      }
      if (res.ok) {
        const { queue: q = [] } = await chrome.storage.local.get('queue')
        await chrome.storage.local.set({ queue: q.filter((p) => p !== payload && !(p.conversationId === payload.conversationId && p.capturedAt === payload.capturedAt)) })
        await setStatus({ state: 'ok', lastSentAt: new Date().toISOString(), lastTitle: payload.title, lastError: null })
        continue
      }
      const body = await res.json().catch(() => ({}))
      if (res.status === 401) return await setStatus({ state: 'bad_token', lastError: body.error || 'Token rejected' })
      if (res.status === 403) return await setStatus({ state: 'disabled', lastError: body.error || 'Live capture is turned off in the app' })
      if (res.status === 400 || res.status === 413) {
        // The app refused this snapshot (invalid or too large): drop it so the queue keeps moving.
        const { queue: q = [] } = await chrome.storage.local.get('queue')
        await chrome.storage.local.set({ queue: q.slice(1) })
        await setStatus({ state: 'error', lastError: 'A capture was rejected: ' + (body.error || res.status) })
        continue
      }
      return await setStatus({ state: 'error', lastError: body.error || 'Server error ' + res.status })
    }
  } finally {
    flushing = false
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'capture' && msg.payload) enqueue(msg.payload)
  if (msg && msg.type === 'extract_error') setStatus({ state: 'error', lastError: 'Could not read the page: ' + msg.error })
  if (msg && msg.type === 'flush') flush().then(() => sendResponse({ ok: true }))
  return msg && msg.type === 'flush'
})
chrome.alarms.create('flush', { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener((a) => a.name === 'flush' && flush())
chrome.runtime.onStartup.addListener(flush)
chrome.runtime.onInstalled.addListener(() => {
  flush()
  chrome.runtime.openOptionsPage()
})
