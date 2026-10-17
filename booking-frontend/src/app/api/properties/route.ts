import { NextResponse } from 'next/server'
import { loadGuestSiteProperties } from '../../../lib/serverApi'
import { propertyListingFeedFromPayload } from '../../../lib/propertyListing'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const forceRefresh = new URL(request.url).searchParams.get('refresh') === '1'
    const feed = propertyListingFeedFromPayload(await loadGuestSiteProperties(
      'en',
      false,
      forceRefresh ? { forceRefresh: true } : undefined,
    ))
    return NextResponse.json(feed)
  } catch {
    return NextResponse.json(
      { status: 'error', properties: [], message: 'Published properties could not be loaded right now.' },
      { status: 502 },
    )
  }
}
