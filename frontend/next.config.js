/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== 'production' || process.env.VERCEL_ENV === 'development'
const envName = process.env.RENDER_ENV || (isDev ? 'dev' : 'prod')
const vercelEnv = process.env.VERCEL_ENV
const apiBase = (() => {
  if (isDev) return process.env.NEXT_PUBLIC_API_BASE_DEV || 'http://localhost:4001'
  if (process.env.NEXT_PUBLIC_API_BASE) return process.env.NEXT_PUBLIC_API_BASE
  if (vercelEnv === 'preview') return process.env.NEXT_PUBLIC_API_BASE_PREVIEW || 'https://mz-property-system-v3-1.onrender.com'
  if (vercelEnv === 'production') return process.env.NEXT_PUBLIC_API_BASE_PROD || 'https://mz-property-system-v3.onrender.com'
  if (envName === 'dev' && process.env.NEXT_PUBLIC_API_BASE_DEV) return process.env.NEXT_PUBLIC_API_BASE_DEV
  if (envName === 'prod' && process.env.NEXT_PUBLIC_API_BASE_PROD) return process.env.NEXT_PUBLIC_API_BASE_PROD
  return 'https://mz-property-system-v3.onrender.com'
})()

// 防呆检查：确保环境变量正确并避免生产使用 http
if (!apiBase) {
  throw new Error('NEXT_PUBLIC_API_BASE 未设置：请配置 NEXT_PUBLIC_API_BASE 或 NEXT_PUBLIC_API_BASE_DEV/PROD')
}
if (!isDev && /^http:\/\//.test(apiBase)) {
  throw new Error(`生产/预览环境必须使用 HTTPS 的后端地址，当前为: ${apiBase}`)
}
if (!isDev && /localhost/.test(apiBase)) {
  throw new Error('生产/预览环境禁止使用 localhost 作为后端地址，请设置 NEXT_PUBLIC_API_BASE_PROD')
}

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
