/**
 * Runs once when the server starts: resumes interrupted imports, starts watching the Downloads folder (or WATCH_DIR)
 * for new ChatGPT exports, and starts the background worker (knowledge extraction, indexing, documents, backups).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { resumeInterruptedImports, enqueueImport } = await import('./lib/importer/queue')
  const { startWatcher } = await import('./lib/importer/watcher')
  const { startPipeline } = await import('./lib/pipeline')
  const { getDb } = await import('./lib/db/client')
  resumeInterruptedImports().catch((e) => console.error('Could not resume imports:', e))
  startWatcher(getDb, enqueueImport)
  startPipeline(getDb)
}
