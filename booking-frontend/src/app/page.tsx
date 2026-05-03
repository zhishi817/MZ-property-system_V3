import BookingLayout from './BookingLayout'
import HomeClient from './HomeClient'
import { loadGuestSiteConfig, loadGuestSiteProperties } from '../lib/serverApi'

export default async function Page() {
  const [initialConfig, initialProperties] = await Promise.all([
    loadGuestSiteConfig('en').catch(() => null),
    loadGuestSiteProperties('en', true).catch(() => []),
  ])

  return (
    <BookingLayout>
      <HomeClient initialConfig={initialConfig} initialProperties={initialProperties} />
    </BookingLayout>
  )
}
