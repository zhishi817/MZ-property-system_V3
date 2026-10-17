import { NextResponse } from 'next/server'
import { loadGuestSiteAvailability } from '../../../lib/serverApi'

export const dynamic = 'force-dynamic'

function isoDate(value: string | null) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''
}

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const url = new URL(request.url)
  const checkin = isoDate(url.searchParams.get('checkin'))
  const checkout = isoDate(url.searchParams.get('checkout'))
  if (!checkin || !checkout || checkout <= checkin) {
    return NextResponse.json({ error: 'Valid check-in and check-out dates are required.' }, { status: 400 })
  }
  try {
    const availability = await loadGuestSiteAvailability(params.id, checkin, checkout)
    return NextResponse.json(availability)
  } catch {
    return NextResponse.json({ error: 'Availability could not be read.' }, { status: 502 })
  }
}
