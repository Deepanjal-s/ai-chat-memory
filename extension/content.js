/*
 * Watches the open ChatGPT page. A few seconds after the page stops changing (and no reply is still being
 * generated), it takes a snapshot of the conversation and hands it to the background worker, which delivers it
 * to the Conversation Memory app. Identical snapshots are not sent twice.
 */
;(function () {
  const E = globalThis.AIMExtract
  if (!E) return
  let timer = null
  let lastHash = null
  let lastUrl = location.href

  async function digest(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
  }

  function schedule(delay) {
    clearTimeout(timer)
    timer = setTimeout(capture, delay || 2500)
  }

  async function capture(force) {
    let snap
    try {
      snap = E.extractConversation(document, location)
    } catch (e) {
      chrome.runtime.sendMessage({ type: 'extract_error', error: String(e && e.message) }).catch(() => {})
      return
    }
    if (!snap || snap.messages.length === 0) return
    if (snap.streaming) return schedule(3000) // wait until the reply is complete
    const payload = {
      conversationId: snap.conversationId,
      title: snap.title,
      url: snap.url,
      capturedAt: new Date().toISOString(),
      extensionVersion: chrome.runtime.getManifest().version,
      messages: snap.messages,
    }
    const h = await digest(JSON.stringify([payload.conversationId, payload.title, payload.messages]))
    if (h === lastHash && !force) return
    lastHash = h
    chrome.runtime.sendMessage({ type: 'capture', payload }).catch(() => {})
  }

  new MutationObserver(() => schedule()).observe(document.body, { childList: true, subtree: true, characterData: true })
  // ChatGPT is a single-page app: detect navigation between conversations.
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href
      lastHash = null
      schedule(2000)
    }
  }, 1000)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'capture_now') capture(true)
  })
  schedule(3000)
})()
