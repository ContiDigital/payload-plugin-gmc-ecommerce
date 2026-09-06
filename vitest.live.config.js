import path from 'path'
import { loadEnv } from 'payload/node'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vitest/config'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default defineConfig(() => {
  loadEnv(path.resolve(dirname, './dev'))

  return {
    // The live smoke is the only suite that must exercise the *published*
    // surface: `pnpm test:live` builds first, and these aliases make the spec's
    // package-name imports resolve to `dist/`, exactly as a host's would. With
    // tsconfig paths the same imports would silently resolve back to `src/`,
    // and the suite would prove nothing about what npm ships.
    resolve: {
      alias: [
        {
          find: /^payload-plugin-gmc-ecommerce\/v2$/,
          replacement: path.resolve(dirname, './dist/exports/v2.js'),
        },
        {
          find: /^payload-plugin-gmc-ecommerce$/,
          replacement: path.resolve(dirname, './dist/index.js'),
        },
      ],
    },
    test: {
      environment: 'node',
      hookTimeout: 120_000,
      include: ['dev/v2.live.spec.ts'],
      testTimeout: 300_000,
    },
  }
})
