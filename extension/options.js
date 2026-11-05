const $ = (id) => document.getElementById(id)
const show = (text, ok) => {
  $('msg').className = 'msg ' + (ok ? 'ok' : 'bad')
  $('msg').textContent = text
}

chrome.storage.local.get(['serverUrl', 'token']).then(({ serverUrl, token }) => {
  $('server').value = serverUrl || 'http://localhost:3000'
  $('token').value = token || ''
})

function originOf(url) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) return { error: 'Use https:// for anything other than this computer (localhost).' }
    return { origin: u.origin }
  } catch {
    return { error: 'Enter a valid address, e.g. http://localhost:3000' }
  }
}

$('save').addEventListener('click', async () => {
  const serverUrl = $('server').value.trim().replace(/\/+$/, '')
  const token = $('token').value.trim()
  const { origin, error } = originOf(serverUrl)
  if (error) return show(error, false)
  if (!/^aim_[A-Za-z0-9_-]{20,}$/.test(token)) return show('That does not look like a pairing token (it starts with aim_).', false)
  const local = ['localhost', '127.0.0.1'].includes(new URL(origin).hostname)
  if (!local) {
    const granted = await chrome.permissions.request({ origins: [origin + '/*'] })
    if (!granted) return show('Permission to contact ' + origin + ' was not granted.', false)
  }
  await chrome.storage.local.set({ serverUrl, token })
  show('Saved. Captures will be delivered to ' + origin + '.', true)
  chrome.runtime.sendMessage({ type: 'flush' }).catch(() => {})
})

$('test').addEventListener('click', async () => {
  const serverUrl = $('server').value.trim().replace(/\/+$/, '')
  const token = $('token').value.trim()
  try {
    const res = await fetch(serverUrl + '/api/capture/health', { headers: { authorization: 'Bearer ' + token } })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return show('Connected, but: ' + (body.error || res.status), false)
    show(body.captureEnabled ? 'Connected. Live capture is ON in the app.' : 'Connected, but live capture is OFF in the app (Settings).', body.captureEnabled)
  } catch {
    show('Cannot reach ' + serverUrl + '. Is the app running?', false)
  }
})
