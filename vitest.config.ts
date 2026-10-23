import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

const packages = '{apps,packages,tools}/*'

export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: [`${packages}/test/**/*.test.ts`, 'deploy/test/*.test.ts'], exclude: [...configDefaults.exclude, '**/*.db.test.ts'] },
      },
      {
        extends: true,
        resolve: {
          alias: {
            '@': fileURLToPath(new URL('apps/web/src', import.meta.url)),
            'server-only': fileURLToPath(new URL('apps/web/node_modules/server-only/empty.js', import.meta.url)),
          },
        },
        test: { name: 'web', include: ['apps/web/src/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'db',
          include: [`${packages}/test/**/*.db.test.ts`],
          globalSetup: ['packages/testkit/src/global-setup.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
})
