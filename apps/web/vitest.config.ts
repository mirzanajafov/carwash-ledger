import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname }, conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: { include: ['src/**/*.test.ts'] },
})
