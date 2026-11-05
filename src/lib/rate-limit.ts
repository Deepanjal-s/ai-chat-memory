const buckets = new Map<string, { count: number; reset: number }>()

/** Fixed-window limiter (per process). Returns true when the request is allowed. */
export function allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const b = buckets.get(key)
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs })
    return true
  }
  b.count++
  return b.count <= limit
}
