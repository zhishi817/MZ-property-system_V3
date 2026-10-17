export type HomepageProperty = {
  id: string
  title: string
  region: string
  imageUrl: string
  bedrooms: number | null
  bathrooms: number | null
  detailHref: string
}

export type HomepagePropertyFeed = {
  status: 'ready' | 'empty' | 'error'
  properties: HomepageProperty[]
  message?: string
}

export type HomepageContent = {
  heroTitle: string
  heroSubtitle: string
  heroImages: string[]
  storyIntro: string
  missionOwner: string
  missionGuest: string
  contactEmail: string
  contactPhone: string
  contactWhatsapp: string
  contactAddress: string
}

export type HomepageContentFeed = {
  status: 'ready' | 'fallback' | 'error'
  content: HomepageContent
}

export const DEFAULT_HOMEPAGE_CONTENT: HomepageContent = {
  heroTitle: 'Hosting Made Simple, Stay Made Memorable',
  heroSubtitle: 'Effortless Property Management for Owners, Exceptional Stays for Travellers',
  heroImages: ['/homepage/property-melbourne-web.jpeg'],
  storyIntro: 'Founded in Melbourne in October 2018, MZ Property connects property owners with travellers looking for a place to feel at home. Our work brings together two perspectives: the owner’s long-term investment and the guest’s experience of Melbourne.',
  missionOwner: 'For property owners, our goal is to make owning a home more rewarding, easier, and less stressful.',
  missionGuest: 'For guests, we aim to offer a welcoming home base that makes every Melbourne stay feel personal and memorable.',
  contactEmail: 'info@mzproperty.com.au',
  contactPhone: '+61 434 782 499',
  contactWhatsapp: '',
  contactAddress: '130 Gladstone St, South Melbourne, VIC 3205',
}

const LEGACY_CMS_COPY = new Set([
  '安心入住墨尔本',
  '精选短租房源，适合商务出行、家庭入住和长期停留。',
  'MZ Property 提供真实房源、清晰沟通和本地化服务，让客人在预订前就知道自己会住进什么样的空间。',
])

export type HomepageBusinessStats = {
  propertiesManagedToDate: number | null
  asOf: string
}

export type HomepageContactInput = {
  firstName: string
  lastName: string
  email: string
  message: string
}

export type HomepageContactErrors = Partial<Record<keyof HomepageContactInput, string>>

export const HOMEPAGE_SEARCH_AREAS = [
  { value: 'all-melbourne', label: 'All Melbourne' },
  { value: 'melbourne-cbd', label: 'Melbourne CBD' },
  { value: 'docklands', label: 'Docklands' },
  { value: 'st-kilda', label: 'St Kilda' },
] as const

export type HomepageSearchInput = {
  area: string
  checkin: string
  checkout: string
  guests: string
}

export type HomepageSearchErrors = Partial<Record<keyof HomepageSearchInput, string>>

export const DEFAULT_HOMEPAGE_SEARCH: HomepageSearchInput = {
  area: 'all-melbourne',
  checkin: '',
  checkout: '',
  guests: '2',
}

export const MZ_BUSINESS_START = { year: 2018, month: 10 } as const
export const HOMEPAGE_PROPERTIES_MANAGED_FALLBACK_COUNT = 121
export const HOMEPAGE_MANAGED_COUNT_SOURCE_ENV = 'HOMEPAGE_MANAGED_COUNT_SOURCE'

export function homepageManagedCountSourceEnabled(value = process.env.HOMEPAGE_MANAGED_COUNT_SOURCE) {
  return String(value || '').trim().toLowerCase() === 'guest-site'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, maxLength = 240) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function nonNegativeInteger(value: unknown) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 50 ? parsed : null
}

export function sanitizeHomepageBusinessStats(payload: unknown): HomepageBusinessStats {
  if (!isRecord(payload)) return { propertiesManagedToDate: null, asOf: '' }
  const propertyCount = Number(payload.properties_managed_to_date)
  const asOf = text(payload.as_of, 80)
  return {
    propertiesManagedToDate: Number.isInteger(propertyCount) && propertyCount >= 0 && propertyCount <= 1000000 ? propertyCount : null,
    asOf: /^\d{4}-\d{2}-\d{2}T/.test(asOf) ? asOf : '',
  }
}

function publicImageUrl(value: unknown) {
  const candidate = text(value, 1200)
  if (!candidate) return ''
  if (candidate.startsWith('/') || /^https:\/\//i.test(candidate)) return candidate
  if (process.env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(candidate)) return candidate
  return ''
}

function configuredCopy(value: unknown, fallback: string, maxLength: number) {
  const candidate = text(value, maxLength)
  return candidate && !LEGACY_CMS_COPY.has(candidate) ? candidate : fallback
}

function configuredAddress(value: unknown) {
  const candidate = text(value, 300)
  if (!candidate) return DEFAULT_HOMEPAGE_CONTENT.contactAddress
  const normalized = candidate.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (normalized.startsWith('87 gladstone st ') || normalized === '87 gladstone st') {
    return DEFAULT_HOMEPAGE_CONTENT.contactAddress
  }
  return candidate
}

export function homepageContentFromPayload(payload: unknown, status: HomepageContentFeed['status'] = 'ready'): HomepageContentFeed {
  if (!isRecord(payload)) return { status: status === 'error' ? 'error' : 'fallback', content: { ...DEFAULT_HOMEPAGE_CONTENT } }
  const heroImages = Array.isArray(payload.hero_background_urls)
    ? payload.hero_background_urls.map(publicImageUrl).filter(Boolean).slice(0, 12)
    : []
  const emailCandidate = text(payload.contact_email, 180).toLowerCase()
  const contactEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailCandidate)
    ? emailCandidate
    : DEFAULT_HOMEPAGE_CONTENT.contactEmail
  const content = {
    heroTitle: configuredCopy(payload.banner_title, DEFAULT_HOMEPAGE_CONTENT.heroTitle, 180),
    heroSubtitle: configuredCopy(payload.banner_subtitle, DEFAULT_HOMEPAGE_CONTENT.heroSubtitle, 360),
    heroImages: heroImages.length ? heroImages : [...DEFAULT_HOMEPAGE_CONTENT.heroImages],
    storyIntro: configuredCopy(payload.brand_story, DEFAULT_HOMEPAGE_CONTENT.storyIntro, 1400),
    missionOwner: DEFAULT_HOMEPAGE_CONTENT.missionOwner,
    missionGuest: DEFAULT_HOMEPAGE_CONTENT.missionGuest,
    contactEmail,
    contactPhone: text(payload.contact_phone, 80) || DEFAULT_HOMEPAGE_CONTENT.contactPhone,
    contactWhatsapp: text(payload.contact_whatsapp, 80),
    contactAddress: configuredAddress(payload.contact_address),
  }
  const usesCmsValue = (Object.keys(content) as Array<keyof HomepageContent>).some((key) => {
    if (key === 'missionOwner' || key === 'missionGuest') return false
    if (key === 'heroImages') return content.heroImages.join('\n') !== DEFAULT_HOMEPAGE_CONTENT.heroImages.join('\n')
    return content[key] !== DEFAULT_HOMEPAGE_CONTENT[key]
  })
  return { status: status === 'error' ? 'error' : usesCmsValue ? 'ready' : 'fallback', content }
}

export function homepagePropertyFeedFromPayload(payload: unknown): HomepagePropertyFeed {
  const properties = sanitizeHomepagePropertyFeed(payload)
  return properties.length ? { status: 'ready', properties } : { status: 'empty', properties: [] }
}

export function sanitizeHomepagePropertyFeed(payload: unknown): HomepageProperty[] {
  const rows = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.properties)
      ? payload.properties
      : []

  return rows
    .filter(isRecord)
    .filter((row) => row.is_published === true)
    .sort((left, right) => {
      const leftOrder = Number(left.sort_order)
      const rightOrder = Number(right.sort_order)
      const safeLeft = Number.isInteger(leftOrder) && leftOrder >= 0 ? leftOrder : 99999
      const safeRight = Number.isInteger(rightOrder) && rightOrder >= 0 ? rightOrder : 99999
      return safeLeft - safeRight
    })
    .map((row) => {
      const id = text(row.id, 160)
      const title = text(row.hero_title, 180)
      return {
        id,
        title,
        region: text(row.public_region_label, 100),
        imageUrl: publicImageUrl(row.hero_image_url),
        bedrooms: nonNegativeInteger(row.bedroom_count),
        bathrooms: nonNegativeInteger(row.bathroom_count),
        detailHref: id ? `/properties/${encodeURIComponent(id)}` : '',
      }
    })
    .filter((property) => property.id && property.title)
    .slice(0, 3)
}

export function validateHomepageContact(input: HomepageContactInput): HomepageContactErrors {
  const errors: HomepageContactErrors = {}
  const firstName = input.firstName.trim()
  const lastName = input.lastName.trim()
  const email = input.email.trim()
  const message = input.message.trim()

  if (!firstName) errors.firstName = 'Enter your first name.'
  else if (firstName.length > 80) errors.firstName = 'First name is too long.'
  if (!lastName) errors.lastName = 'Enter your last name.'
  else if (lastName.length > 80) errors.lastName = 'Last name is too long.'
  if (!email) errors.email = 'Enter your email address.'
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 180) errors.email = 'Enter a valid email address.'
  if (!message) errors.message = 'Tell us how we can help.'
  else if (message.length > 2000) errors.message = 'Message must be 2,000 characters or fewer.'

  return errors
}

export function normalizeHomepageContact(input: HomepageContactInput): HomepageContactInput {
  return {
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    email: input.email.trim().toLowerCase(),
    message: input.message.trim(),
  }
}

function queryText(value: string | string[] | undefined) {
  return String(Array.isArray(value) ? value[0] || '' : value || '').trim()
}

function validIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day, 12))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

export function melbourneTodayISO(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

export function mzYearsInBusiness(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now)
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value || 0)
  const years = value('year') - MZ_BUSINESS_START.year - (value('month') < MZ_BUSINESS_START.month ? 1 : 0)
  return Math.max(0, years)
}

export function addIsoCalendarDays(value: string, days: number) {
  if (!validIsoDate(value)) return ''
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days, 12))
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
    .join('-')
}

export function formatHomepageStayDate(value: string) {
  if (!validIsoDate(value)) return 'Select date'
  const [year, month, day] = value.split('-').map(Number)
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, day, 12)))
}

export function normalizeHomepageSearch(input: Partial<HomepageSearchInput>): HomepageSearchInput {
  const area = HOMEPAGE_SEARCH_AREAS.some((option) => option.value === input.area)
    ? String(input.area)
    : DEFAULT_HOMEPAGE_SEARCH.area
  const guestCount = Number(input.guests)
  return {
    area,
    checkin: validIsoDate(String(input.checkin || '')) ? String(input.checkin) : '',
    checkout: validIsoDate(String(input.checkout || '')) ? String(input.checkout) : '',
    guests: Number.isInteger(guestCount) && guestCount >= 1 && guestCount <= 8 ? String(guestCount) : DEFAULT_HOMEPAGE_SEARCH.guests,
  }
}

export function homepageSearchFromQuery(query: Record<string, string | string[] | undefined> | undefined) {
  return normalizeHomepageSearch({
    area: queryText(query?.area),
    checkin: queryText(query?.checkin),
    checkout: queryText(query?.checkout),
    guests: queryText(query?.guests),
  })
}

export function validateHomepageSearch(input: HomepageSearchInput, today = melbourneTodayISO()): HomepageSearchErrors {
  const normalized = normalizeHomepageSearch(input)
  const errors: HomepageSearchErrors = {}
  if (!HOMEPAGE_SEARCH_AREAS.some((option) => option.value === input.area)) errors.area = 'Choose a Melbourne area.'
  if (!input.checkin || !validIsoDate(input.checkin)) errors.checkin = 'Choose a check-in date.'
  else if (input.checkin < today) errors.checkin = 'Check-in cannot be before today in Melbourne.'
  if (!input.checkout || !validIsoDate(input.checkout)) errors.checkout = 'Choose a check-out date.'
  else if (input.checkin && input.checkout <= input.checkin) errors.checkout = 'Check-out must be after check-in.'
  if (String(input.guests) !== normalized.guests) errors.guests = 'Choose between 1 and 8 guests.'
  return errors
}

export function homepageSearchQuery(input: HomepageSearchInput) {
  const normalized = normalizeHomepageSearch(input)
  return new URLSearchParams(normalized).toString()
}
