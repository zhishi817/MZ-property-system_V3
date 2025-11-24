/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== 'production'
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_BASE: isDev ? 'http://localhost:4000' : (process.env.NEXT_PUBLIC_API_BASE || 'https://mz-property-system-v3.onrender.com'),
  },
  async redirects() {
    return [
      { source: '/', destination: '/dashboard', permanent: false },
    ]
  },
}

module.exports = nextConfig
