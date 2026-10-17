import { NextResponse } from 'next/server'
import { loadHomepagePropertyFeed } from '../../../../lib/homepageServer'

export const dynamic = 'force-dynamic'

export async function GET() {
  const feed = await loadHomepagePropertyFeed()
  return NextResponse.json(feed, { status: feed.status === 'error' ? 502 : 200 })
}
