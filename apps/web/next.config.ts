import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  reactStrictMode: true,
  poweredByHeader: false,
  allowedDevOrigins: ['127.0.0.1'],
  transpilePackages: ['@carwash/audit'],
  turbopack: { resolveAlias: { '@carwash/audit': '../../packages/audit/src/index.ts' } },
}

export default config
