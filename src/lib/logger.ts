import fs from 'node:fs'
import path from 'node:path'
import { config } from './config'

type Level = 'info' | 'warn' | 'error'

/** JSON-lines application log in DATA_DIR/logs (one file per day), mirrored to the console. Never logs message content. */
export function log(level: Level, event: string, details: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ at: new Date().toISOString(), level, event, ...details })
  ;(level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line)
  try {
    fs.mkdirSync(config.logDir, { recursive: true })
    fs.appendFileSync(path.join(config.logDir, `app-${new Date().toISOString().slice(0, 10)}.log`), line + '\n')
  } catch {
    // Logging must never break the app.
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
