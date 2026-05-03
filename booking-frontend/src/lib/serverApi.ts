import type { GuestSiteConfig, GuestSiteProperty } from './guestSite'

function normalizeBase(raw: string) {
  return String(raw || '').trim().replace(/\/+$/g, '')
}

function getServerApiBase() {
  const raw =
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_DEV ||
    process.env.NEXT_PUBLIC_API_BASE ||
    ''
  const normalized = normalizeBase(raw)
  if (/^https?:\/\//i.test(normalized)) return normalized
  return process.env.INTERNAL_API_BASE_URL || 'http://127.0.0.1:4002'
}

async function serverRequest<T>(path: string, options?: { revalidate?: number; noStore?: boolean }) {
  const target = `${getServerApiBase()}${path.startsWith('/') ? path : `/${path}`}`
  const noStore = !!options?.noStore
  const res = await fetch(target, {
    cache: noStore ? 'no-store' : undefined,
    next: noStore ? undefined : { revalidate: options?.revalidate ?? 15 },
    headers: {
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

export function loadGuestSiteConfig(locale = 'en') {
  return serverRequest<GuestSiteConfig>(`/public/guest-site/config?locale=${encodeURIComponent(locale)}`)
}

export function loadGuestSiteProperties(locale = 'en', featuredOnly = false) {
  const params = new URLSearchParams()
  params.set('locale', locale)
  if (featuredOnly) params.set('featured', 'true')
  return serverRequest<GuestSiteProperty[]>(`/public/guest-site/properties?${params.toString()}`)
}

export function loadGuestSiteProperty(propertyId: string, locale = 'en', preview = false) {
  const params = new URLSearchParams()
  params.set('locale', locale)
  if (preview) params.set('preview', '1')
  return serverRequest<GuestSiteProperty>(
    `/public/guest-site/properties/${encodeURIComponent(propertyId)}?${params.toString()}`,
    { noStore: preview },
  )
}
