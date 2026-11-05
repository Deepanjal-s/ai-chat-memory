import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  // Native/WASM and streaming packages must load from node_modules at runtime, not be bundled.
  serverExternalPackages: ['@electric-sql/pglite', '@electric-sql/pglite-pgvector', 'pg', 'yauzl', 'stream-json', 'stream-chain', 'pdfkit'],
  // pdfkit reads its built-in font metrics from disk at runtime.
  outputFileTracingIncludes: { '/*': ['./node_modules/pdfkit/js/data/**'] },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
          },
        ],
      },
    ]
  },
}

export default nextConfig
