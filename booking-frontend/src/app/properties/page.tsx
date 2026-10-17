import type { Metadata } from 'next'
import { Suspense } from 'react'
import PropertiesClient from './PropertiesClient'
import { loadGuestSiteProperties } from '../../lib/serverApi'
import { loadHomepageContent } from '../../lib/homepageServer'
import { propertyListingFeedFromPayload, type PropertyListingFeed } from '../../lib/propertyListing'
import Loading from './loading'

export const metadata: Metadata = {
  title: 'All Properties | MZ Property',
  description: 'Browse MZ Property’s published Melbourne stays and refine the collection by area, guests, bedrooms and property type.',
}

export default async function Page() {
  const [feed, content] = await Promise.all([
    loadGuestSiteProperties('en', false)
      .then(propertyListingFeedFromPayload)
      .catch((): PropertyListingFeed => ({
        status: 'error',
        properties: [],
        message: 'Published properties could not be loaded right now.',
      })),
    loadHomepageContent(),
  ])

  return (
    <Suspense fallback={<Loading />}>
      <PropertiesClient
        initialProperties={feed.properties}
        initialStatus={feed.status}
        footerContent={content.content}
      />
    </Suspense>
  )
}
