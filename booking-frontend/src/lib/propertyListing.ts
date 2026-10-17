import type { GuestSiteProperty, GuestSiteStayService } from './guestSite'

export type BedroomFilter = 'any' | 'studio' | '1' | '2' | '3'
export type PropertyTypeFilter = 'all' | 'apartment' | 'house'

export type PropertyListingFilters = {
  area: string
  checkin: string
  checkout: string
  guests: string
  bedrooms: BedroomFilter
  type: PropertyTypeFilter
}

export type PropertyListingFeed = {
  status: 'ready' | 'empty' | 'error'
  properties: GuestSiteProperty[]
  message?: string
}

export const DEFAULT_PROPERTY_LISTING_FILTERS: PropertyListingFilters = {
  area: 'all-melbourne',
  checkin: '',
  checkout: '',
  guests: '',
  bedrooms: 'any',
  type: 'all',
}

const KNOWN_AREA_LABELS: Record<string, string> = {
  'all-melbourne': 'All Melbourne',
  'melbourne-cbd': 'Melbourne CBD',
  docklands: 'Docklands',
  'st-kilda': 'St Kilda',
}

const BEDROOM_FILTERS = new Set<BedroomFilter>(['any', 'studio', '1', '2', '3'])
const PROPERTY_TYPE_FILTERS = new Set<PropertyTypeFilter>(['all', 'apartment', 'house'])

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown, maxLength = 300) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function stringList(value: unknown, maxItems = 80) {
  return Array.isArray(value)
    ? value.map((item) => text(item, 500)).filter(Boolean).slice(0, maxItems)
    : []
}

function finiteNumber(value: unknown, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function optionalCount(value: unknown) {
  if (value == null || value === '') return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : undefined
}

function validIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, 12))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function stayServices(value: unknown): GuestSiteStayService[] | undefined {
  if (!Array.isArray(value)) return undefined
  const services = value.flatMap((item) => {
    const source = record(item)
    const key = text(source?.key)
    if (!source || !['early_checkin', 'late_checkout', 'baggage_dropoff'].includes(key)) return []
    return [{
      key: key as GuestSiteStayService['key'],
      enabled: source.enabled === true,
      title: text(source.title, 180),
      headline: text(source.headline, 240),
      description: text(source.description, 1000),
      fee_amount: source.fee_amount == null ? null : finiteNumber(source.fee_amount),
      fee_currency: text(source.fee_currency, 12),
      until_time: text(source.until_time, 20),
      requires_advance_request: source.requires_advance_request === true,
      manual_confirmation: source.manual_confirmation === true,
      guaranteed: source.guaranteed === true,
      grants_room_access: source.grants_room_access === true,
      payment_timing: text(source.payment_timing, 180),
    }]
  })
  return services.length ? services : undefined
}

export function sanitizeGuestSiteProperties(payload: unknown): GuestSiteProperty[] {
  const rows = Array.isArray(payload)
    ? payload
    : record(payload) && Array.isArray(record(payload)?.properties)
      ? record(payload)?.properties as unknown[]
      : []

  return rows.flatMap((item) => {
    const source = record(item)
    if (!source || source.is_published !== true || source.archived === true) return []
    const id = text(source.id, 160)
    const heroTitle = text(source.hero_title, 220)
    if (!id || !heroTitle) return []
    const publicCapacity = source.public_capacity_override == null
      ? null
      : Math.max(0, Math.round(finiteNumber(source.public_capacity_override)))
    const amenityItems = Array.isArray(source.amenity_items)
      ? source.amenity_items.flatMap((item) => {
        const amenity = record(item)
        if (!amenity) return []
        const key = text(amenity.key, 100)
        const label = text(amenity.label, 180)
        if (!key || !label) return []
        return [{ key, label, category: text(amenity.category, 100), icon: text(amenity.icon, 100) }]
      }).slice(0, 100)
      : undefined
    return [{
      id,
      type: text(source.type, 120),
      capacity: Math.max(0, Math.round(finiteNumber(source.capacity))),
      public_capacity_override: publicCapacity,
      public_region_label: text(source.public_region_label, 120),
      hero_title: heroTitle,
      short_description: text(source.short_description, 800),
      long_description: text(source.long_description, 8000),
      hero_image_url: text(source.hero_image_url, 1200),
      gallery_urls: stringList(source.gallery_urls, 40),
      feature_tags: stringList(source.feature_tags, 60),
      amenities: stringList(source.amenities, 100),
      amenity_items: amenityItems,
      house_rules: stringList(source.house_rules, 100),
      sort_order: Math.max(0, Math.round(finiteNumber(source.sort_order, 99999))),
      is_published: true,
      bedroom_count: optionalCount(source.bedroom_count),
      bathroom_count: optionalCount(source.bathroom_count),
      bed_count: optionalCount(source.bed_count),
      checkin_time: text(source.checkin_time, 20) || undefined,
      checkout_time: text(source.checkout_time, 20) || undefined,
      cancellation_policy: text(source.cancellation_policy, 4000) || undefined,
      stay_services: stayServices(source.stay_services),
      price_label: text(source.price_label, 120) || undefined,
      booking_highlights: stringList(source.booking_highlights, 60),
    }]
  }).sort((left, right) => left.sort_order - right.sort_order || left.hero_title.localeCompare(right.hero_title))
}

export function propertyListingFeedFromPayload(payload: unknown): PropertyListingFeed {
  const properties = sanitizeGuestSiteProperties(payload)
  return properties.length
    ? { status: 'ready', properties }
    : { status: 'empty', properties: [] }
}

export function propertyListingFiltersFromSearchParams(searchParams: URLSearchParams): PropertyListingFilters {
  const rawArea = text(searchParams.get('area'), 120)
  const rawGuests = Number(searchParams.get('guests'))
  const rawBedrooms = text(searchParams.get('bedrooms'), 20).toLowerCase() as BedroomFilter
  const rawType = text(searchParams.get('type'), 20).toLowerCase() as PropertyTypeFilter
  const checkin = text(searchParams.get('checkin'), 10)
  const checkout = text(searchParams.get('checkout'), 10)
  return {
    area: rawArea || DEFAULT_PROPERTY_LISTING_FILTERS.area,
    checkin: validIsoDate(checkin) ? checkin : '',
    checkout: validIsoDate(checkout) ? checkout : '',
    guests: Number.isInteger(rawGuests) && rawGuests >= 1 && rawGuests <= 8 ? String(rawGuests) : '',
    bedrooms: BEDROOM_FILTERS.has(rawBedrooms) ? rawBedrooms : 'any',
    type: PROPERTY_TYPE_FILTERS.has(rawType) ? rawType : 'all',
  }
}

export function propertyListingFiltersToSearchParams(filters: PropertyListingFilters) {
  const params = new URLSearchParams()
  if (filters.area && filters.area !== 'all-melbourne') params.set('area', filters.area)
  if (filters.checkin) params.set('checkin', filters.checkin)
  if (filters.checkout) params.set('checkout', filters.checkout)
  if (filters.guests) params.set('guests', filters.guests)
  if (filters.bedrooms !== 'any') params.set('bedrooms', filters.bedrooms)
  if (filters.type !== 'all') params.set('type', filters.type)
  return params
}

export function propertyListingAreaLabel(area: string) {
  return KNOWN_AREA_LABELS[area] || area || KNOWN_AREA_LABELS['all-melbourne']
}

export function propertyListingDateErrors(filters: PropertyListingFilters, today: string) {
  const errors: Partial<Record<'checkin' | 'checkout', string>> = {}
  if (filters.checkin && filters.checkin < today) errors.checkin = 'Check-in cannot be before today in Melbourne.'
  if (filters.checkout && !filters.checkin) errors.checkin = 'Choose a check-in date first.'
  if (filters.checkin && !filters.checkout) errors.checkout = 'Choose a check-out date.'
  if (filters.checkin && filters.checkout && filters.checkout <= filters.checkin) errors.checkout = 'Check-out must be after check-in.'
  return errors
}

function propertyCapacity(property: GuestSiteProperty) {
  const capacity = property.public_capacity_override ?? property.capacity
  return Math.max(0, Number(capacity) || 0)
}

function areaMatches(property: GuestSiteProperty, selectedArea: string) {
  if (!selectedArea || selectedArea === 'all-melbourne') return true
  const label = property.public_region_label.trim().toLowerCase()
  const selectedLabel = propertyListingAreaLabel(selectedArea).trim().toLowerCase()
  if (KNOWN_AREA_LABELS[selectedArea]) return label === selectedLabel || label.startsWith(`${selectedLabel},`)
  return label === selectedLabel
}

function typeMatches(property: GuestSiteProperty, selectedType: PropertyTypeFilter) {
  if (selectedType === 'all') return true
  const type = property.type.trim().toLowerCase()
  if (selectedType === 'apartment') return type.includes('apartment') || type === 'unit'
  return type.includes('house') || type.includes('townhome') || type.includes('townhouse')
}

export function propertyMatchesListingFilters(property: GuestSiteProperty, filters: PropertyListingFilters) {
  if (!areaMatches(property, filters.area)) return false
  if (filters.guests && propertyCapacity(property) < Number(filters.guests)) return false
  if (!typeMatches(property, filters.type)) return false
  if (filters.bedrooms !== 'any') {
    const count = property.bedroom_count
    if (count == null) return false
    if (filters.bedrooms === 'studio') return count === 0
    return count === Number(filters.bedrooms)
  }
  return true
}

export function propertyListingSummary(filters: PropertyListingFilters) {
  const parts = [propertyListingAreaLabel(filters.area)]
  parts.push(filters.checkin && filters.checkout ? `${filters.checkin} – ${filters.checkout}` : 'Any dates')
  parts.push(filters.guests ? `${filters.guests} ${filters.guests === '1' ? 'guest' : 'guests'}` : 'Any guests')
  return parts.join(' · ')
}

export function propertyDetailHref(propertyId: string, filters: PropertyListingFilters) {
  const params = propertyListingFiltersToSearchParams(filters)
  const query = params.toString()
  return `/properties/${encodeURIComponent(propertyId)}${query ? `?${query}` : ''}`
}
