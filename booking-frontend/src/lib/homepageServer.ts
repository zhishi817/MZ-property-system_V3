import { homepageContentFromPayload, homepagePropertyFeedFromPayload, type HomepageContentFeed, type HomepagePropertyFeed } from './homepage'
import { loadGuestSiteConfig, loadGuestSiteProperties } from './serverApi'

type FetchLike = typeof fetch

function validatedEndpoint(raw: string, allowLoopback: boolean) {
  const candidate = String(raw || '').trim()
  if (!candidate) return ''
  try {
    const url = new URL(candidate)
    if (url.protocol === 'https:') return url.toString()
    if (allowLoopback && url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname)) return url.toString()
  } catch {
    return ''
  }
  return ''
}

export async function loadHomepagePropertyFeed(options: {
  fetchImpl?: FetchLike
  endpoint?: string
  allowLoopback?: boolean
  loadProperties?: () => Promise<unknown>
} = {}): Promise<HomepagePropertyFeed> {
  const fetchImpl = options.fetchImpl || fetch
  const endpoint = validatedEndpoint(
    options.endpoint ?? process.env.HOMEPAGE_PUBLIC_PROPERTY_FEED_URL ?? '',
    options.allowLoopback ?? process.env.NODE_ENV !== 'production',
  )
  try {
    if (!endpoint) {
      return homepagePropertyFeedFromPayload(await (options.loadProperties || (() => loadGuestSiteProperties('en', true)))())
    }
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return homepagePropertyFeedFromPayload(await response.json())
  } catch {
    return { status: 'error', properties: [], message: 'Published properties could not be loaded right now.' }
  }
}

export async function loadHomepageContent(options: {
  loadConfig?: () => Promise<unknown>
} = {}): Promise<HomepageContentFeed> {
  try {
    return homepageContentFromPayload(await (options.loadConfig || (() => loadGuestSiteConfig('en')))())
  } catch {
    return homepageContentFromPayload(null, 'error')
  }
}
