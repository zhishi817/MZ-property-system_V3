import { Suspense } from 'react'
import BookingLayout from '../../BookingLayout'
import PropertyDetailClient from './PropertyDetailClient'
import { loadGuestSiteProperty } from '../../../lib/serverApi'

export default async function Page({
  params,
  searchParams,
}: {
  params: { id: string }
  searchParams?: Record<string, string | string[] | undefined>
}) {
  const preview = String(searchParams?.preview || '') === '1'
  const initialProperty = await loadGuestSiteProperty(params.id, 'en', preview).catch(() => null)

  return (
    <BookingLayout>
      <Suspense fallback={null}>
        <PropertyDetailClient propertyId={params.id} initialProperty={initialProperty} />
      </Suspense>
    </BookingLayout>
  )
}
