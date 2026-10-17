import HomePage from './home/HomePage'
import { homepageManagedCountSourceEnabled, homepageSearchFromQuery, mzYearsInBusiness, sanitizeHomepageBusinessStats } from '../lib/homepage'
import { loadHomepageContent, loadHomepagePropertyFeed } from '../lib/homepageServer'
import { loadGuestSiteStats } from '../lib/serverApi'

export default async function Page({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const useManagedCountSource = homepageManagedCountSourceEnabled()
  const [initialContent, initialFeed, rawStats] = await Promise.all([
    loadHomepageContent(),
    loadHomepagePropertyFeed(),
    useManagedCountSource ? loadGuestSiteStats().catch(() => null) : Promise.resolve(null),
  ])
  return <HomePage initialContent={initialContent} initialFeed={initialFeed} initialSearch={homepageSearchFromQuery(searchParams)} initialYearsInBusiness={mzYearsInBusiness()} initialBusinessStats={sanitizeHomepageBusinessStats(rawStats)} />
}
