/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== 'production' || process.env.VERCEL_ENV === 'development'
const envName = process.env.RENDER_ENV || (isDev ? 'dev' : 'prod')
const vercelEnv = process.env.VERCEL_ENV
const apiBase = (() => {
  if (isDev) return 'http://localhost:4001'
  if (process.env.NEXT_PUBLIC_API_BASE) return process.env.NEXT_PUBLIC_API_BASE
  if (vercelEnv === 'preview') return process.env.NEXT_PUBLIC_API_BASE_PREVIEW || 'https://mz-property-system-v3-1.onrender.com'
  if (vercelEnv === 'production') return process.env.NEXT_PUBLIC_API_BASE_PROD || 'https://mz-property-system-v3.onrender.com'
  if (envName === 'dev' && process.env.NEXT_PUBLIC_API_BASE_DEV) return process.env.NEXT_PUBLIC_API_BASE_DEV
  if (envName === 'prod' && process.env.NEXT_PUBLIC_API_BASE_PROD) return process.env.NEXT_PUBLIC_API_BASE_PROD
  return 'https://mz-property-system-v3.onrender.com'
})()

const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_BASE: apiBase,
  },
  async redirects() {
    return [
      { source: '/', destination: '/dashboard', permanent: false },
    ]
  },
}

module.exports = nextConfig
