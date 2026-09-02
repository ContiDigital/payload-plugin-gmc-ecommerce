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
      coverage: {
        exclude: ['dev/**', 'dist/**', 'node_modules/**', '**/*.spec.*', '**/__tests__/**'],
        include: ['src/**/*.ts'],
        provider: 'v8',
        thresholds: {
          branches: 74,
          functions: 85,
          lines: 80,
          statements: 80,
          'src/v2/**': {
            branches: 80,
            functions: 95,
            lines: 83,
            statements: 83,
          },
        },
      },
      environment: 'node',
      exclude: ['**/e2e.spec.*', '**/live.spec.*', '**/*.live.spec.*', '**/node_modules/**'],
      hookTimeout: 30_000,
      testTimeout: 30_000,
    },
  }
})
