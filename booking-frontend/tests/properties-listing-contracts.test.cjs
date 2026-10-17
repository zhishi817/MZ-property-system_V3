const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const client = fs.readFileSync(path.resolve(__dirname, '../src/app/properties/PropertiesClient.tsx'), 'utf8')
const page = fs.readFileSync(path.resolve(__dirname, '../src/app/properties/page.tsx'), 'utf8')
const route = fs.readFileSync(path.resolve(__dirname, '../src/app/api/properties/route.ts'), 'utf8')
const navigation = fs.readFileSync(path.resolve(__dirname, '../src/app/home/siteNavigation.ts'), 'utf8')
const showcase = fs.readFileSync(path.resolve(__dirname, '../src/app/home/PropertyShowcase.tsx'), 'utf8')
const listing = fs.readFileSync(path.resolve(__dirname, '../src/lib/propertyListing.ts'), 'utf8')
const serverApi = fs.readFileSync(path.resolve(__dirname, '../src/lib/serverApi.ts'), 'utf8')

test('formal listing reuses the existing public published-property boundary', () => {
  assert.match(page, /loadGuestSiteProperties\('en', false\)/)
  assert.doesNotMatch(page, /noStore|forceRefresh/)
  assert.match(page, /propertyListingFeedFromPayload/)
  assert.match(serverApi, /options\?\.forceRefresh \? \{ noStore: true \} : \{ revalidate: 15 \}/)
  assert.match(route, /export async function GET\(request: Request\)/)
  assert.match(route, /searchParams\.get\('refresh'\) === '1'/)
  assert.match(route, /forceRefresh \? \{ forceRefresh: true \} : undefined/)
  assert.match(client, /fetch\('\/api\/properties\?refresh=1', \{ method: 'GET', cache: 'no-store' \}\)/)
  assert.doesNotMatch(route, /POST|PUT|PATCH|DELETE/)
})

test('the listing is privacy-safe and does not query availability or expose prices', () => {
  assert.doesNotMatch(client, /property\.address|property\?\.address|location_note|price_label|Hostex.*fetch/)
  assert.doesNotMatch(client, /property-detail-data|\/availability/)
  assert.match(client, /live Hostex availability and pricing are not connected/)
  assert.match(client, /They do not filter this list by live availability/)
  assert.doesNotMatch(client, /Nightly rate|per night|A\$\d|\$\d/)
  assert.match(listing, /source\.archived === true/)
  assert.doesNotMatch(listing, /address:|notes:|location_note:/)
})

test('all approved filter and state surfaces are present', () => {
  for (const token of ['Area', 'Check-in', 'Check-out', 'Guests', 'Bedrooms', 'Property type', 'Clear all']) {
    assert.match(client, new RegExp(token))
  }
  assert.match(client, /propertyMatchesListingFilters/)
  assert.match(client, /propertyListingFiltersToSearchParams/)
  assert.match(client, /router\.push/)
  assert.match(client, /role="dialog"/)
  assert.match(client, /aria-modal="true"/)
  assert.match(client, /<EnglishSelect/)
  assert.doesNotMatch(client, /<select/)
  assert.match(client, /Cancel filters/)
  assert.match(client, /No properties match these filters/)
  assert.match(client, /Published properties could not be loaded/)
})

test('home and shared navigation enter the formal list', () => {
  assert.match(navigation, /\['\/properties', 'All Properties'\]/)
  assert.match(showcase, /href="\/properties"/)
  assert.match(showcase, /View All Properties/)
})
