const LABEL = {
  ok: ['Capturing normally', true],
  not_configured: ['Not connected: open Settings to pair with the app', false],
  bad_token: ['Pairing token rejected: create a new one in the app', false],
  disabled: ['Live capture is turned off in the app', false],
  offline: ['App not reachable: captures are queued and will be sent later', false],
  error: ['Problem: see details', false],
}

async function render() {
  const { status = {}, queue = [] } = await chrome.storage.local.get(['status', 'queue'])
  const [text, ok] = LABEL[status.state] || ['Waiting for the first capture', true]
  const el = document.getElementById('state')
  el.textContent = text
  el.className = 'state ' + (ok ? 'ok' : 'bad')
  const lines = []
  if (queue.length) lines.push(queue.length + ' capture(s) waiting to be sent')
  if (status.lastSentAt) lines.push('Last saved: ' + new Date(status.lastSentAt).toLocaleString() + (status.lastTitle ? ' (' + status.lastTitle + ')' : ''))
  if (status.lastError) lines.push(status.lastError)
  document.getElementById('details').textContent = lines.join(' · ')
}

document.getElementById('now').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab && tab.url && tab.url.startsWith('https://chatgpt.com/')) {
    await chrome.tabs.sendMessage(tab.id, { type: 'capture_now' }).catch(() => {})
  }
  await chrome.runtime.sendMessage({ type: 'flush' }).catch(() => {})
  setTimeout(render, 1500)
})
document.getElementById('opts').addEventListener('click', (e) => {
  e.preventDefault()
  chrome.runtime.openOptionsPage()
})
render()
