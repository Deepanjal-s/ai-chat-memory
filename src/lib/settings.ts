import crypto from 'node:crypto'
import type { Queryable } from './db/client'
import { sha256 } from './hash'

export async function getSetting<T>(q: Queryable, key: string, fallback: T): Promise<T> {
  const [row] = await q.query<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key])
  return row ? row.value : fallback
}

export async function setSetting(q: Queryable, key: string, value: unknown): Promise<void> {
  await q.query(
    'INSERT INTO settings(key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, JSON.stringify(value)],
  )
}

/** Live capture is off until the owner turns it on (see the terms-of-service note in Settings). */
export const captureEnabled = (q: Queryable) => getSetting<boolean>(q, 'capture_enabled', false)

// ---- Browser extension pairing tokens (only a SHA-256 of each token is stored) -----------

export async function createExtensionToken(q: Queryable, label: string): Promise<{ id: number; token: string }> {
  const token = `aim_${crypto.randomBytes(32).toString('base64url')}`
  const [row] = await q.query<{ id: number }>('INSERT INTO extension_tokens(label, token_hash) VALUES ($1, $2) RETURNING id', [
    label.slice(0, 100) || 'Browser extension',
    sha256(token),
  ])
  return { id: row.id, token }
}

export async function verifyExtensionToken(q: Queryable, authorization: string | null): Promise<number | null> {
  const token = authorization?.match(/^Bearer\s+(aim_[A-Za-z0-9_-]{20,})$/)?.[1]
  if (!token) return null
  const [row] = await q.query<{ id: number }>(
    'UPDATE extension_tokens SET last_used_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id',
    [sha256(token)],
  )
  return row?.id ?? null
}

export async function revokeExtensionToken(q: Queryable, id: number): Promise<void> {
  await q.query('UPDATE extension_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id])
}
