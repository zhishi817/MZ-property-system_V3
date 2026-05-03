/** @type {import('next').NextConfig} */
const fs = require('fs')
const path = require('path')

function loadEnvLocalIntoProcessEnv() {
  try {
    const p = path.resolve(__dirname, '.env.local')
    if (!fs.existsSync(p)) return
    const txt = fs.readFileSync(p, 'utf8')
    const lines = txt.split(/\r?\n/g)
    for (const line of lines) {
      const s = String(line || '').trim()
      if (!s || s.startsWith('#')) continue
      const i = s.indexOf('=')
      if (i <= 0) continue
      const k = s.slice(0, i).trim()
      let v = s.slice(i + 1).trim()
      if (!k || process.env[k] != null) continue
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      process.env[k] = v
    }
  } catch {}
}

loadEnvLocalIntoProcessEnv()

const isDev = process.env.NODE_ENV !== 'production' || process.env.VERCEL_ENV === 'development'
const envName = process.env.RENDER_ENV || (isDev ? 'dev' : 'prod')
const vercelEnv = process.env.VERCEL_ENV
const apiBase = (() => {
  if (isDev) return process.env.NEXT_PUBLIC_API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_DEV || '/api'
  if (process.env.NEXT_PUBLIC_API_BASE) return process.env.NEXT_PUBLIC_API_BASE
  if (vercelEnv === 'preview') return process.env.NEXT_PUBLIC_API_BASE_PREVIEW || 'https://mz-property-system-v3-1.onrender.com'
  if (vercelEnv === 'production') return process.env.NEXT_PUBLIC_API_BASE_PROD || 'https://mz-property-system-v3.onrender.com'
  if (envName === 'dev' && process.env.NEXT_PUBLIC_API_BASE_DEV) return process.env.NEXT_PUBLIC_API_BASE_DEV
  if (envName === 'prod' && process.env.NEXT_PUBLIC_API_BASE_PROD) return process.env.NEXT_PUBLIC_API_BASE_PROD
  return 'https://mz-property-system-v3.onrender.com'
})()

if (!apiBase) {
  throw new Error('NEXT_PUBLIC_API_BASE is required')
}
if (!isDev && /^http:\/\//.test(apiBase)) {
  throw new Error(`Production and preview builds must use HTTPS API base. Current: ${apiBase}`)
}
if (!isDev && /localhost/.test(apiBase)) {
  throw new Error('Production and preview builds cannot use localhost API base')
}

const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_BASE: apiBase,
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL || '',
    NEXT_PUBLIC_API_BASE_DEV: process.env.NEXT_PUBLIC_API_BASE_DEV || '',
    NEXT_PUBLIC_COMMIT_SHA:
      process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_REF || process.env.RENDER_GIT_COMMIT || '',
  },
  async rewrites() {
    if (!isDev) return []
    const normalizeTarget = (raw) => {
      const s = String(raw || '').trim().replace(/\/+$/g, '')
      if (!s) return ''
      if (s.startsWith('/')) return ''
      try {
        const u = new URL(s)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
        const basePath = String(u.pathname || '').replace(/\/+$/g, '')
        const stripped = basePath.replace(/\/(api|auth)$/i, '')
        return `${u.origin}${stripped}`
      } catch {
        return ''
      }
    }
    const desired = normalizeTarget(process.env.NEXT_PUBLIC_API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_DEV || '')
    const destination = desired || 'http://localhost:4002'
    return [{ source: '/api/:path*', destination: `${destination}/:path*` }]
  },
}

module.exports = nextConfig
