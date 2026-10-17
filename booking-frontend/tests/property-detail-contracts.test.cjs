const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const clientPath = path.resolve(__dirname, '../src/app/properties/[id]/PropertyDetailClient.tsx')
const pagePath = path.resolve(__dirname, '../src/app/properties/[id]/page.tsx')
const placeholderPath = path.resolve(__dirname, '../src/app/property-details/page.tsx')
const availabilityRoutePath = path.resolve(__dirname, '../src/app/property-detail-data/[id]/route.ts')
const previewPagePath = path.resolve(__dirname, '../src/app/property-preview/page.tsx')
const previewClientPath = path.resolve(__dirname, '../src/app/property-preview/PropertyPreviewClient.tsx')
const client = fs.readFileSync(clientPath, 'utf8')
const page = fs.readFileSync(pagePath, 'utf8')
const placeholder = fs.readFileSync(placeholderPath, 'utf8')
const availabilityRoute = fs.readFileSync(availabilityRoutePath, 'utf8')
const previewPage = fs.readFileSync(previewPagePath, 'utf8')
const previewClient = fs.readFileSync(previewClientPath, 'utf8')

test('property detail is read-only and does not expose booking or inquiry writes', () => {
  assert.doesNotMatch(client, /postJSON|\/public\/guest-site\/inquiries|Request Booking|Submit request/)
  assert.match(client, /Selecting dates does not make a reservation/)
  assert.match(client, /Selecting dates does not create a booking/)
  assert.match(client, /Availability and all requests need confirmation/)
})

test('property detail preserves listing filters in its return link', () => {
  assert.match(client, /listingBackParams/)
  assert.match(client, /\['area', 'checkin', 'checkout', 'guests', 'bedrooms', 'type'\]/)
  assert.match(client, /href=\{listingBackHref\}/)
})

test('guest controls avoid native menus and public location uses only the fuzzy region label', () => {
  assert.match(client, /function GuestStepper/)
  assert.doesNotMatch(client, /<select[^>]*Guests|property\?\.location_note|property\.location_note|property\?\.address|property\.address/)
  assert.match(client, /const mapRegion = String\(property\?\.public_region_label/)
  assert.match(client, /<ApproximateAreaMap region=\{mapRegion\}/)
  assert.match(client, /MAP_AREA_RADIUS_METRES = 500/)
  assert.match(client, /does not claim the property is inside the circle/)
  assert.match(client, /tile\.openstreetmap\.org/)
  assert.doesNotMatch(client, /geocod|location_note/)
})

test('unconfigured public data remains explicit instead of being invented', () => {
  assert.match(client, /Live PMS price/)
  assert.match(client, /Not connected/)
  assert.match(client, /Property reviews will appear here/)
  assert.match(client, /Cancellation terms vary by stay/)
  assert.match(client, /Confirm before booking/)
  assert.doesNotMatch(client, /not configured in the public listing data|No policy inferred/)
  assert.match(client, /no property has been selected automatically/)
})

test('current Chinese source labels have deterministic English display mappings', () => {
  for (const pair of [
    ['一房一卫', 'One-bedroom, one-bathroom apartment'],
    ['两房一卫', 'Two-bedroom, one-bathroom apartment'],
    ['整套房源', 'Entire apartment'],
    ['自行入住', 'Self check-in'],
    ['自助入住', 'Self check-in'],
    ['免费停车', 'Free parking'],
    ['游泳池', 'Swimming pool'],
    ['健身房', 'Gym'],
    ['桑拿房', 'Sauna'],
    ['禁止带宠物', 'No pets'],
    ['禁止吸烟', 'No smoking'],
    ['支持长住咨询', 'Long-stay enquiries welcome'],
  ]) {
    assert.match(client, new RegExp(`${pair[0]}: '${pair[1]}'`))
  }
  assert.match(client, /English property description pending/)
  assert.doesNotMatch(client, /\{property\.type \|\| 'Property overview'\}/)
  assert.match(client, /property\?\.booking_highlights/)
  assert.match(client, /overviewTags\.join/)
  assert.match(client, /const overviewTags = featureTags/)
  assert.doesNotMatch(client, /overviewTags = \[\.\.\.featureTags, \.\.\.bookingHighlights\]/)
  assert.match(client, /<h3>Booking notes<\/h3>/)
})

test('confirmed amenity DTO is grouped and booking rules remain request-only', () => {
  assert.match(client, /property\?\.amenity_items/)
  assert.match(client, /amenityGroups/)
  assert.match(client, /What this place offers/)
  assert.match(client, /id="before-arrival"/)
  assert.match(client, /Standard check-in and check-out times/)
  assert.match(client, /Early check-in/)
  assert.match(client, /No fee · Advance request/)
  assert.doesNotMatch(client, /From 11:30AM/)
  assert.match(client, /Late check-out/)
  assert.match(client, /Until 11:30AM · A\$20/)
  assert.match(client, /Luggage drop-off/)
  assert.doesNotMatch(client, /Payment timing|nothing is charged here/)
  assert.match(client, /Confirmed luggage drop-off does not mean the property is ready for check-in/)
  assert.match(client, /Frequently asked questions/)
  assert.match(client, /Can I check in early\?/)
  assert.match(client, /Can I check out late\?/)
  assert.match(client, /Can I drop off my luggage before check-in\?/)
  assert.match(client, /<span>Q&amp;A<\/span><h4>\{STAY_SERVICE_QUESTIONS\[service\.key\] \|\| service\.title\}<\/h4>/)
  assert.doesNotMatch(client, /<h4>\{service\.title\}<\/h4>/)
  assert.doesNotMatch(client, /Ask before you arrive|Optional stay requests/)
  assert.doesNotMatch(client, /Request confirmed|Payment successful|charged automatically/)
})

test('effective stay policy drives services and the shared preview allowlist', () => {
  assert.match(client, /property\?\.stay_services/)
  assert.match(client, /publicStayServices/)
  assert.match(client, /stayServices\.map\(\(service\)/)
  assert.match(client, /Optional stay-request information has not been published for this property/)
  assert.match(client, /Array\.isArray\(value\) \? value : LEGACY_STAY_SERVICES/)
  assert.match(previewClient, /stay_services: stayServices\(raw\.stay_services\)/)
  assert.match(previewClient, /cancellation_policy: String\(raw\.cancellation_policy/)
  assert.match(previewClient, /STAY_SERVICE_KEYS/)
  assert.doesNotMatch(previewClient, /address:|location_note:|notes:/)
})

test('public pricing is not represented as live before the PMS integration', () => {
  assert.match(client, /Live PMS price/)
  assert.match(client, /Not connected/)
  assert.match(client, /Price confirmed by the team/)
  assert.doesNotMatch(client, /Nightly rate/)
  assert.doesNotMatch(client, /\{priceLabel \|\|/)
})

test('confirmed standard arrival times are displayed without mutating property data', () => {
  assert.match(client, /formatListingTime\(String\(property\?\.checkin_time \|\| ''\)\) \|\| '3PM'/)
  assert.match(client, /formatListingTime\(String\(property\?\.checkout_time \|\| ''\)\) \|\| '10AM'/)
  assert.doesNotMatch(client, /3:00 PM|10:00 AM|11:30 AM/)
})

test('amenities use semantic line icons instead of generic text glyphs', () => {
  assert.match(client, /function AmenityIcon/)
  for (const icon of ['kettle', 'toaster', 'microwave', 'oven', 'dishwasher', 'coffee-pod', 'pan', 'cutlery', 'plate', 'glass', 'utensils', 'knife', 'cutting-board', 'washing-machine', 'dryer', 'drying-rack', 'detergent', 'baby-cot', 'high-chair']) {
    assert.match(client, new RegExp(`['"]?${icon.replace('-', '\\-')}['"]?:`), `missing semantic ${icon} icon`)
  }
  assert.match(client, /data-amenity-summary/)
  assert.match(client, /data-amenity-expanded/)
  assert.match(client, /DESKTOP_AMENITY_SUMMARY_LIMIT/)
  assert.match(client, /MOBILE_AMENITY_SUMMARY_LIMIT/)
  assert.doesNotMatch(client, /amenityGroupHiddenDesktop|amenityGroupHiddenMobile/)
  assert.doesNotMatch(client, /return '[⌁❄◉◌◇⌑≈]'/)
})

test('dynamic route reads only the requested public property plus public contact config', () => {
  assert.match(page, /loadGuestSiteProperty\(params\.id, 'en'\)/)
  assert.match(page, /loadGuestSiteConfig\('en'\)/)
  assert.doesNotMatch(page, /loadGuestSiteProperties/)
})

test('date checks use a validated same-origin read-only availability route', () => {
  assert.match(client, /\/property-detail-data\//)
  assert.match(availabilityRoute, /export async function GET/)
  assert.doesNotMatch(availabilityRoute, /POST|PUT|PATCH|DELETE/)
  assert.match(availabilityRoute, /checkout <= checkin/)
})

test('admin draft preview reuses the detail renderer without a public draft fetch or persistent token', () => {
  assert.match(previewPage, /PropertyPreviewClient/)
  assert.match(previewClient, /<PropertyDetailClient[^>]+previewMode/)
  assert.match(previewClient, /event\.origin !== adminOrigin \|\| event\.source !== window\.parent/)
  assert.match(previewClient, /event\.data\?\.nonce !== nonce/)
  assert.match(previewClient, /window\.parent\.postMessage/)
  assert.match(previewClient, /is_published: false/)
  assert.match(previewClient, /No unpublished property content is stored or fetched by this route/)
  assert.doesNotMatch(`${previewPage}\n${previewClient}`, /loadGuestSiteProperty|loadGuestSiteConfig|localStorage|sessionStorage/)
  assert.match(client, /if \(previewMode\) \{ setAvailability\(null\); setAvailabilityPending\(false\); return \}/)
})

test('homepage search no-id route preserves its honest placeholder contract', () => {
  assert.match(placeholder, /Property details are coming soon\./)
  assert.match(placeholder, /No availability search, reservation or payment has been performed\./)
})
