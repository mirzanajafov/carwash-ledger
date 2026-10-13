import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    include: ['test/**/*.db.test.ts'],
    globalSetup: ['../testkit/src/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
