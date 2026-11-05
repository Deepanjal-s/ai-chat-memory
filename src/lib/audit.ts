import { getDb } from './db/client'

export async function audit(action: string, target: string | null, ip: string | null, details: Record<string, unknown> = {}) {
  try {
    const db = await getDb()
    await db.query('INSERT INTO audit_log(action, target, ip, details) VALUES ($1, $2, $3, $4::jsonb)', [
      action,
      target,
      ip,
      JSON.stringify(details),
    ])
  } catch (e) {
    console.error('audit log write failed', e)
  }
}
