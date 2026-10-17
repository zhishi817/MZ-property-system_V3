import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_PROPERTY_LISTING_FILTERS,
  propertyDetailHref,
  propertyListingDateErrors,
  propertyListingFiltersFromSearchParams,
  propertyListingFiltersToSearchParams,
  propertyMatchesListingFilters,
  sanitizeGuestSiteProperties,
} from '../src/lib/propertyListing.ts'

function property(overrides = {}) {
  return {
    id: 'fixture',
    type: 'Apartment',
    capacity: 4,
    public_capacity_override: null,
    public_region_label: 'Docklands',
    hero_title: 'Fixture stay',
    short_description: 'Public description',
    long_description: '',
    hero_image_url: '/homepage/property-docklands.avif',
    gallery_urls: [],
    feature_tags: [],
    amenities: [],
    house_rules: [],
    sort_order: 1,
    is_published: true,
    bedroom_count: 2,
    bathroom_count: 1,
    bed_count: 2,
    ...overrides,
  }
}

test('public listing sanitizer excludes unpublished and archived rows and drops private fields', () => {
  const result = sanitizeGuestSiteProperties([
    property({ id: 'published', address: 'Private exact address', notes: 'Private note' }),
    property({ id: 'draft', is_published: false }),
    property({ id: 'archived', archived: true }),
  ])
  assert.equal(result.length, 1)
  assert.equal(result[0].id, 'published')
  assert.equal('address' in result[0], false)
  assert.equal('notes' in result[0], false)
  assert.equal('location_note' in result[0], false)
})

test('default listing filters retain every published property', () => {
  assert.equal(propertyMatchesListingFilters(property({ capacity: 1 }), DEFAULT_PROPERTY_LISTING_FILTERS), true)
  assert.equal(propertyMatchesListingFilters(property({ bedroom_count: 0, type: 'House' }), DEFAULT_PROPERTY_LISTING_FILTERS), true)
})

test('combined filters enforce public area, capacity, bedroom and type rules', () => {
  const filters = {
    ...DEFAULT_PROPERTY_LISTING_FILTERS,
    area: 'docklands',
    guests: '4',
    bedrooms: '2',
    type: 'apartment',
  }
  assert.equal(propertyMatchesListingFilters(property({ capacity: 4 }), filters), true)
  assert.equal(propertyMatchesListingFilters(property({ capacity: 3 }), filters), false)
  assert.equal(propertyMatchesListingFilters(property({ bedroom_count: 1 }), filters), false)
  assert.equal(propertyMatchesListingFilters(property({ type: 'House' }), filters), false)
  assert.equal(propertyMatchesListingFilters(property({ public_region_label: 'St Kilda' }), filters), false)
})

test('Studio and conservative public type aliases are supported without changing stored data', () => {
  assert.equal(propertyMatchesListingFilters(
    property({ bedroom_count: 0, type: 'Unit' }),
    { ...DEFAULT_PROPERTY_LISTING_FILTERS, bedrooms: 'studio', type: 'apartment' },
  ), true)
  assert.equal(propertyMatchesListingFilters(
    property({ bedroom_count: 3, type: 'Townhouse' }),
    { ...DEFAULT_PROPERTY_LISTING_FILTERS, bedrooms: '3', type: 'house' },
  ), true)
})

test('URL filters round-trip and detail links preserve the listing return state', () => {
  const source = new URLSearchParams({
    area: 'Docklands',
    checkin: '2026-12-10',
    checkout: '2026-12-14',
    guests: '4',
    bedrooms: '2',
    type: 'apartment',
  })
  const filters = propertyListingFiltersFromSearchParams(source)
  assert.equal(propertyListingFiltersToSearchParams(filters).toString(), source.toString())
  const href = propertyDetailHref('property/id', filters)
  assert.match(href, /^\/properties\/property%2Fid\?/)
  const detailParams = new URL(href, 'http://example.test').searchParams
  for (const key of source.keys()) assert.equal(detailParams.get(key), source.get(key))
})

test('date validation is explicit and never claims availability', () => {
  assert.deepEqual(propertyListingDateErrors(
    { ...DEFAULT_PROPERTY_LISTING_FILTERS, checkin: '2026-12-10', checkout: '' },
    '2026-10-07',
  ), { checkout: 'Choose a check-out date.' })
  assert.deepEqual(propertyListingDateErrors(
    { ...DEFAULT_PROPERTY_LISTING_FILTERS, checkin: '2026-12-10', checkout: '2026-12-09' },
    '2026-10-07',
  ), { checkout: 'Check-out must be after check-in.' })
})
