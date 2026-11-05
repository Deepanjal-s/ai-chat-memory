import { defineConfig } from 'vitest/config'
import os from 'node:os'
import path from 'node:path'

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // Keep test logs, documents and backups out of the real data folder.
    env: { DATA_DIR: path.join(os.tmpdir(), 'aim-vitest-data') },
  },
})
