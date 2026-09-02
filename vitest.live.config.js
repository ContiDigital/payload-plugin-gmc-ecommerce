import path from 'path'
import { loadEnv } from 'payload/node'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vitest/config'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default defineConfig(() => {
  loadEnv(path.resolve(dirname, './dev'))

  return {
    resolve: { tsconfigPaths: true },
    test: {
      environment: 'node',
      hookTimeout: 120_000,
      include: ['dev/v2.live.spec.ts'],
      testTimeout: 300_000,
    },
  }
})
