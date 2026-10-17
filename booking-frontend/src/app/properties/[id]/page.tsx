import { Suspense } from 'react'
import PropertyDetailClient from './PropertyDetailClient'
import { loadGuestSiteConfig, loadGuestSiteProperty } from '../../../lib/serverApi'
import { SiteCopyProvider } from '../../siteContext'

export default async function Page({
  params,
}: {
  params: { id: string }
}) {
  const [initialProperty, initialConfig] = await Promise.all([
    loadGuestSiteProperty(params.id, 'en').catch(() => null),
    loadGuestSiteConfig('en').catch(() => null),
  ])

  return (
    <SiteCopyProvider>
      <Suspense fallback={null}>
        <PropertyDetailClient propertyId={params.id} initialProperty={initialProperty} initialConfig={initialConfig} />
      </Suspense>
    </SiteCopyProvider>
  )
}
