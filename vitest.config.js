import path from 'path'
import { loadEnv } from 'payload/node'
import { fileURLToPath } from 'url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default defineConfig(() => {
  loadEnv(path.resolve(dirname, './dev'))

  return {
    plugins: [
      tsconfigPaths({
        ignoreConfigErrors: true,
      }),
    ],
    test: {
      coverage: {
        exclude: ['dev/**', 'dist/**', 'node_modules/**', '**/*.spec.*', '**/__tests__/**'],
        include: ['src/**/*.ts'],
        provider: 'v8',
      },
      environment: 'node',
      exclude: ['**/e2e.spec.*', '**/live.spec.*', '**/node_modules/**'],
      hookTimeout: 30_000,
      testTimeout: 30_000,
    },
  }
})
