import os from 'node:os'
import path from 'node:path'

function env(name: string, fallback = ''): string {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

export const config = {
  get dataDir() {
    return path.resolve(env('DATA_DIR', './data'))
  },
  get databaseUrl() {
    return env('DATABASE_URL')
  },
  get rawDir() {
    return path.join(this.dataDir, 'raw')
  },
  get uploadDir() {
    return path.join(this.dataDir, 'uploads')
  },
  get pgliteDir() {
    return path.join(this.dataDir, 'pglite')
  },
  get passwordHash() {
    return env('APP_PASSWORD_HASH')
  },
  get sessionSecret() {
    return env('SESSION_SECRET')
  },
  get sessionTtlHours() {
    return Number(env('SESSION_TTL_HOURS', '12'))
  },
  get embeddingProvider() {
    return env('EMBEDDING_PROVIDER', 'none') as 'none' | 'voyage'
  },
  get embeddingModel() {
    return env('EMBEDDING_MODEL', 'voyage-3.5')
  },
  get embeddingDim() {
    return Number(env('EMBEDDING_DIM', '1024'))
  },
  get voyageApiKey() {
    return env('VOYAGE_API_KEY')
  },
  /** Folder checked for new ChatGPT export ZIPs. Defaults to the user's Downloads folder. */
  get watchDir() {
    return path.resolve(env('WATCH_DIR', path.join(os.homedir(), 'Downloads')))
  },
  get watchEnabled() {
    return env('WATCH_ENABLED', 'true') !== 'false'
  },
  get watchIntervalSeconds() {
    return Math.max(10, Number(env('WATCH_INTERVAL_SECONDS', '30')))
  },
  get watchSourceLabel() {
    return env('WATCH_SOURCE_LABEL', 'ChatGPT')
  },
  /**
   * 'anthropic' (Claude) or 'gemini' (Google) receive conversation excerpts for extraction, answers and documents;
   * 'none' keeps all data local.
   */
  get aiProvider() {
    return env('AI_PROVIDER', 'none') as 'none' | 'anthropic' | 'gemini'
  },
  get aiModel() {
    return env('AI_MODEL', this.aiProvider === 'gemini' ? 'gemini-3.5-flash' : 'claude-opus-5-5')
  },
  get anthropicApiKey() {
    return env('ANTHROPIC_API_KEY')
  },
  get geminiApiKey() {
    return env('GEMINI_API_KEY')
  },
  get backupDir() {
    return path.resolve(env('BACKUP_DIR', path.join(this.dataDir, 'backups')))
  },
  get backupKeep() {
    return Math.max(1, Number(env('BACKUP_KEEP', '7')))
  },
  get documentsDir() {
    return path.join(this.dataDir, 'documents')
  },
  get logDir() {
    return path.join(this.dataDir, 'logs')
  },
  /** Dashboard reminds the user to request a fresh export after this many days. */
  get exportReminderDays() {
    return Number(env('EXPORT_REMINDER_DAYS', '30'))
  },
}
