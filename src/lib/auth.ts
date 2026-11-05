import crypto from 'node:crypto'
import { cookies, headers } from 'next/headers'
import { config } from './config'

export const SESSION_COOKIE = 'aim_session'

export { hashPassword, verifyPassword } from './password'

// ---- Sessions (HMAC-signed, stateless) ----------------------------------------

export function authConfigured(): boolean {
  return Boolean(config.passwordHash && config.sessionSecret && config.sessionSecret.length >= 32)
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url')
}

export function createSessionToken(now = Date.now()): { token: string; maxAgeSeconds: number } {
  const maxAgeSeconds = Math.round(config.sessionTtlHours * 3600)
  const payload = Buffer.from(
    JSON.stringify({ exp: now + maxAgeSeconds * 1000, n: crypto.randomBytes(8).toString('hex') }),
  ).toString('base64url')
  return { token: `${payload}.${sign(payload)}`, maxAgeSeconds }
}

export function verifySessionToken(token: string | undefined, now = Date.now()): boolean {
  if (!token || !authConfigured()) return false
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return false
  const expected = Buffer.from(sign(payload))
  const given = Buffer.from(sig)
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return false
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp: number }
    return typeof exp === 'number' && exp > now
  } catch {
    return false
  }
}

/** For server components and pages. */
export async function isAuthenticated(): Promise<boolean> {
  return verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value)
}

/**
 * For route handlers. Returns an error response when the request must be refused, otherwise null.
 * State-changing requests must also come from this site (Origin check) to block cross-site request forgery.
 */
export async function guardApi(request: Request): Promise<Response | null> {
  if (!(await isAuthenticated())) return Response.json({ error: 'Not signed in' }, { status: 401 })
  if (request.method !== 'GET' && request.method !== 'HEAD' && !sameOrigin(request)) {
    return Response.json({ error: 'Cross-site request refused' }, { status: 403 })
  }
  return null
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return false
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export function isHttps(request: Request): boolean {
  return request.headers.get('x-forwarded-proto') === 'https' || new URL(request.url).protocol === 'https:'
}

export async function clientIp(): Promise<string> {
  const h = await headers()
  return h.get('x-forwarded-for')?.split(',')[0].trim() || h.get('x-real-ip') || 'local'
}

// ---- Login throttling -------------------------------------------------------------

const attempts = new Map<string, { count: number; first: number }>()
const WINDOW_MS = 15 * 60 * 1000
const MAX_FAILURES = 5

export function loginBlocked(ip: string, now = Date.now()): boolean {
  const a = attempts.get(ip)
  if (!a || now - a.first > WINDOW_MS) return false
  return a.count >= MAX_FAILURES
}

export function recordLoginFailure(ip: string, now = Date.now()): void {
  const a = attempts.get(ip)
  if (!a || now - a.first > WINDOW_MS) attempts.set(ip, { count: 1, first: now })
  else a.count++
}

export function clearLoginFailures(ip: string): void {
  attempts.delete(ip)
}
