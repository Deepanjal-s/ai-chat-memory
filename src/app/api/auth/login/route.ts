import { audit } from '@/lib/audit'
import {
  SESSION_COOKIE,
  authConfigured,
  clearLoginFailures,
  clientIp,
  createSessionToken,
  isHttps,
  loginBlocked,
  recordLoginFailure,
  sameOrigin,
  verifyPassword,
} from '@/lib/auth'
import { config } from '@/lib/config'

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'Cross-site request refused' }, { status: 403 })
  if (!authConfigured()) {
    return Response.json({ error: 'Sign-in is not configured. Set APP_PASSWORD_HASH and SESSION_SECRET.' }, { status: 503 })
  }
  const ip = await clientIp()
  if (loginBlocked(ip)) {
    return Response.json({ error: 'Too many failed attempts. Try again in 15 minutes.' }, { status: 429 })
  }
  const body = (await request.json().catch(() => ({}))) as { password?: unknown }
  const password = typeof body.password === 'string' ? body.password : ''
  if (!password || !verifyPassword(password, config.passwordHash)) {
    recordLoginFailure(ip)
    await audit('login_failed', null, ip)
    return Response.json({ error: 'Incorrect password' }, { status: 401 })
  }
  clearLoginFailures(ip)
  await audit('login', null, ip)
  const { token, maxAgeSeconds } = createSessionToken()
  const secure = isHttps(request) ? '; Secure' : ''
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'content-type': 'application/json',
      'set-cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`,
    },
  })
}
