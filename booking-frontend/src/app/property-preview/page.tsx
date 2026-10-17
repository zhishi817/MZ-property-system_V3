import { Suspense } from 'react'
import { SiteCopyProvider } from '../siteContext'
import PropertyPreviewClient from './PropertyPreviewClient'

export default function Page() {
  return (
    <SiteCopyProvider>
      <Suspense fallback={null}>
        <PropertyPreviewClient />
      </Suspense>
    </SiteCopyProvider>
  )
}
