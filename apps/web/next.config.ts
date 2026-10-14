import type { NextConfig } from 'next'

const config: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  allowedDevOrigins: ['127.0.0.1'],
  transpilePackages: ['@carwash/audit'],
  turbopack: { resolveAlias: { '@carwash/audit': '../../packages/audit/src/index.ts' } },
}

export default config
