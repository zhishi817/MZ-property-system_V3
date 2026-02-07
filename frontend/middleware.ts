import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  const publicPaths = ['/login', '/_next', '/favicon', '/company-logo.png', '/mz-logo.png', '/public', '/public-cleaning-guide']
  if (publicPaths.some(p => pathname.startsWith(p))) return NextResponse.next()
  if (/\.[a-zA-Z0-9]+$/.test(pathname)) return NextResponse.next()
  const token = req.cookies.get('auth')?.value
  if (!token) {
    const url = req.nextUrl.clone(); url.pathname = '/login'
    return NextResponse.redirect(url)
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!api).*)']
}
