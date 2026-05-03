import { Suspense } from 'react'
import BookingLayout from '../BookingLayout'
import PropertiesClient from './PropertiesClient'
import { loadGuestSiteProperties } from '../../lib/serverApi'

export default async function Page() {
  const initialProperties = await loadGuestSiteProperties('en').catch(() => [])

  return (
    <BookingLayout>
      <Suspense fallback={null}>
        <PropertiesClient initialProperties={initialProperties} />
      </Suspense>
    </BookingLayout>
  )
}
