import assert from 'assert'
import fs from 'fs'
import path from 'path'
import {
  GUEST_SITE_AMENITY_CATALOG,
  GUEST_SITE_AMENITY_TEMPLATES,
  amenityCatalogPayload,
  canonicalGuestSiteTime,
  companyDefaultAmenityConflicts,
  companyDefaultAmenityItems,
  guestSiteTimeForStorage,
  legacyAmenityCandidateSelections,
  normalizeAmenityTemplateCandidates,
  normalizeAmenitySelections,
  publicAmenityItems,
  publishReadiness,
  sortPublicAmenityItems,
} from '../../src/lib/guestSitePropertyDisplay'

const keys = GUEST_SITE_AMENITY_CATALOG.map((item) => item.key)
assert.equal(new Set(keys).size, keys.length, 'amenity catalog keys must be unique')
assert.ok(GUEST_SITE_AMENITY_CATALOG.every((item) => item.label_en && item.icon && item.category_key), 'every catalog item needs English copy, an icon and a category')
assert.ok(GUEST_SITE_AMENITY_TEMPLATES.every((template) => template.amenity_keys.every((key) => keys.includes(key))), 'templates may only reference catalog keys')
assert.deepEqual(companyDefaultAmenityItems().map((item) => item.label), ['Baby cot', 'High chair'])

assert.equal(canonicalGuestSiteTime('3PM'), '3PM')
assert.equal(canonicalGuestSiteTime('3 PM'), '3PM')
assert.equal(canonicalGuestSiteTime('3:00 pm'), '3PM')
assert.equal(canonicalGuestSiteTime('15:00'), '3PM')
assert.equal(canonicalGuestSiteTime('11:30 AM'), '11:30AM')
assert.equal(canonicalGuestSiteTime('3:75PM'), null)
assert.equal(canonicalGuestSiteTime('25:00'), null)
assert.equal(guestSiteTimeForStorage(' 4:00 PM '), '4PM')
assert.equal(guestSiteTimeForStorage('3:75PM'), '3:75PM')

const legacy = normalizeAmenitySelections(undefined, ['免费停车', '游泳池', 'Unknown 中文设施', 'Portable cot'])
assert.deepEqual(legacy.slice(0, 2), [{ key: 'free-parking', status: 'pending' }, { key: 'swimming-pool', status: 'pending' }])
assert.equal(legacy[2].status, 'pending', 'unknown Chinese legacy values must never be public by default')
assert.equal(legacy[3].status, 'pending', 'existing English legacy values still require manual confirmation')
assert.deepEqual(normalizeAmenitySelections([], ['免费停车', 'Portable cot']), [], 'an explicit empty structured list must not resurrect legacy amenities')
assert.deepEqual(legacyAmenityCandidateSelections(['免费停车', 'Portable cot']), [
  { key: 'free-parking', status: 'pending' },
  { key: 'custom:portable-cot', status: 'pending', custom_label: 'Portable cot', custom_category: 'Other' },
])
assert.deepEqual(publicAmenityItems(undefined, ['免费停车', 'Portable cot']).map((item) => item.label), ['Baby cot', 'High chair'], 'legacy candidates must stay private while company defaults remain public')
assert.deepEqual(publicAmenityItems([]).map((item) => item.label), ['Baby cot', 'High chair'], 'an empty per-property selection must not remove company defaults')

const projected = publicAmenityItems([
  { key: 'wifi', status: 'provided' },
  { key: 'free-parking', status: 'pending' },
  { key: 'separate-dryer', status: 'not_provided' },
  { key: 'custom:portable-cot', status: 'provided', custom_label: 'Portable cot', custom_category: 'Bedroom & linen' },
  { key: 'custom:unknown', status: 'provided', custom_label: '未知设施', custom_category: 'Other' },
])
assert.deepEqual(projected.map((item) => item.label), ['Wi-Fi', 'Portable cot', 'Baby cot', 'High chair'], 'public DTO must merge company defaults with confirmed English property amenities in display order')
assert.deepEqual(publicAmenityItems([
  { key: 'wifi', status: 'not_provided' },
  { key: 'free-parking', status: 'pending' },
]).map((item) => item.label), ['Baby cot', 'High chair'], 'not-provided and pending structured amenities must remain private without removing defaults')
assert.deepEqual(publicAmenityItems([{ key: 'wifi', status: 'provided' }]).map((item) => item.label), ['Wi-Fi', 'Baby cot', 'High chair'], 'manual confirmation must publish the selected item before lower-priority defaults')
assert.deepEqual(publicAmenityItems([
  { key: 'baby-cot', status: 'provided' },
  { key: 'high-chair', status: 'provided' },
]).map((item) => item.label), ['Baby cot', 'High chair'], 'redundant per-property markers must not duplicate company defaults')
assert.deepEqual(companyDefaultAmenityConflicts([
  { key: 'baby-cot', status: 'not_provided' },
  { key: 'high-chair', status: 'pending' },
]), [
  { key: 'baby-cot', status: 'not_provided' },
  { key: 'high-chair', status: 'pending' },
], 'conflicting legacy per-property markers must be reported without overriding company truth')
assert.deepEqual(publicAmenityItems([{ key: 'baby-cot', status: 'not_provided' }]).map((item) => item.label), ['Baby cot', 'High chair'], 'company defaults remain authoritative in the public projection')
assert.deepEqual(sortPublicAmenityItems([
  { key: 'baby-cot', category: 'Baby amenities', label: 'Baby cot', icon: 'baby-cot' },
  { key: 'wifi', category: 'Internet & work', label: 'Wi-Fi', icon: 'wifi' },
  { key: 'kettle', category: 'Kitchen appliances', label: 'Kettle', icon: 'kettle' },
  { key: 'washing-machine', category: 'Laundry', label: 'Washing machine', icon: 'washing-machine' },
  { key: 'free-parking', category: 'Parking', label: 'Free parking', icon: 'parking' },
  { key: 'kettle', category: 'Kitchen appliances', label: 'Duplicate kettle', icon: 'kettle' },
]).map((item) => item.key), ['kettle', 'washing-machine', 'wifi', 'free-parking', 'baby-cot'], 'display ordering must be stable by category, keep Baby amenities late, and deduplicate keys')

const reusableTemplateCandidates = normalizeAmenityTemplateCandidates([
  { key: 'wifi' },
  { key: 'custom:portable-cot', custom_label: 'Portable cot', custom_category: 'Bedroom & linen' },
])
assert.deepEqual(reusableTemplateCandidates, [
  { key: 'wifi' },
  { key: 'custom:portable-cot', custom_label: 'Portable cot', custom_category: 'Bedroom & linen' },
], 'reusable templates must store candidate identity without a property status')
assert.deepEqual(normalizeAmenityTemplateCandidates([{ key: 'custom:unknown', custom_label: '未知设施' }]), [], 'custom template candidates must have an English label')
assert.deepEqual(normalizeAmenityTemplateCandidates([{ key: 'wifi' }, { key: 'wifi' }]), [{ key: 'wifi' }], 'duplicate candidates must normalize to one item')
assert.deepEqual(normalizeAmenityTemplateCandidates([{ key: 'baby-cot' }, { key: 'high-chair' }, { key: 'wifi' }]), [{ key: 'wifi' }], 'templates must not store company-default markers')

const ready = publishReadiness({
  hero_title: 'Waterfront apartment',
  short_description: 'A calm one-bedroom stay.',
  long_description: '',
  hero_image_url: '/uploads/cover.jpg',
  gallery_urls: [],
  public_region_label: 'Docklands',
  capacity: 2,
  checkin_time: '3PM',
  checkout_time: '10AM',
  feature_tags: ['Entire apartment'],
  house_rules: ['No smoking'],
  booking_highlights: ['Long-stay enquiries welcome'],
  amenity_selections: [{ key: 'wifi', status: 'provided' }],
})
assert.equal(ready.ready, true)
assert.equal(publishReadiness({ ...readyInput(), checkin_time: '3:00 PM', checkout_time: '10 AM' }).ready, true, 'legacy 12-hour equivalents must remain publishable')
assert.equal(publishReadiness({ ...readyInput(), checkin_time: '15:00', checkout_time: '10:00' }).ready, true, 'valid 24-hour equivalents must remain publishable')
assert.equal(publishReadiness({ ...readyInput(), checkin_time: '3:75PM' }).ready, false, 'invalid minutes must block publish')
assert.equal(publishReadiness({ ...readyInput(), checkout_time: '25:00' }).ready, false, 'invalid 24-hour values must block publish')
assert.equal(publishReadiness({ ...readyInput(), checkout_time: '10:00 PM' }).ready, false, 'wrong checkout time must block publish')
assert.equal(publishReadiness({ ...readyInput(), hero_title: '中文标题' }).ready, false, 'unmapped Chinese public copy must block publish')
assert.equal(publishReadiness({ ...readyInput(), feature_tags: ['自行入住', '自助入住'] }).ready, true, 'both legacy self check-in labels must be accepted as mapped public copy')
assert.equal(publishReadiness({ ...readyInput(), amenity_selections: [{ key: 'wifi', status: 'pending' }] }).ready, false, 'pending amenities must not satisfy publish checks')
assert.equal(publishReadiness({ ...readyInput(), amenity_selections: legacy }).ready, false, 'legacy candidates must not satisfy publish checks')
assert.equal(publishReadiness({ ...readyInput(), amenity_selections: [{ key: 'wifi', status: 'not_provided' }] }).ready, false, 'not-provided amenities must not satisfy publish checks')
assert.equal(publishReadiness({ ...readyInput(), amenity_selections: [] }).ready, false, 'company defaults alone must not satisfy the per-property amenity publish check')
assert.equal(publishReadiness({ ...readyInput(), amenity_selections: [{ key: 'baby-cot', status: 'provided' }] }).ready, false, 'redundant company-default markers must not satisfy the per-property amenity publish check')
assert.equal(publishReadiness({ ...readyInput(), amenity_selections: [{ key: 'wifi', status: 'provided' }, { key: 'baby-cot', status: 'not_provided' }] }).ready, false, 'conflicting company-default markers must block publish until removed')

const catalog = amenityCatalogPayload()
assert.ok(catalog.categories.some((item) => item.key === 'coffee'))
assert.ok(catalog.items.some((item) => item.key === 'coffee-pods-provided'), 'coffee equipment and pod supply must be distinct')
assert.ok(catalog.items.some((item) => item.key === 'separate-dryer'))
assert.ok(catalog.items.some((item) => item.key === 'washer-dryer-combo'))
assert.ok(catalog.categories.some((item) => item.key === 'baby-amenities' && item.label_en === 'Baby amenities'))
assert.deepEqual(catalog.items.filter((item) => item.company_default_status === 'provided').map((item) => [item.key, item.icon]), [
  ['baby-cot', 'baby-cot'],
  ['high-chair', 'high-chair'],
])

const moduleSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/guest_site.ts'), 'utf8')
const schemaSource = fs.readFileSync(path.resolve(__dirname, '../../src/lib/guestSiteSchema.ts'), 'utf8')
const templateMigrationSource = fs.readFileSync(path.resolve(__dirname, '../migrations/20261002_guest_site_amenity_templates.sql'), 'utf8')
assert.match(moduleSource, /property_not_ready_to_publish/)
assert.match(moduleSource, /requirePerm\('guest_site_properties\.view'\).*amenity-catalog|amenity-catalog'[\s\S]*requirePerm\('guest_site_properties\.view'\)/)
assert.match(moduleSource, /amenity_selections = EXCLUDED\.amenity_selections/)
assert.match(moduleSource, /checkin_time: guestSiteTimeForStorage\(v\?\.checkin_time\)/, 'saved check-in values must use the compact canonical format')
assert.match(moduleSource, /checkout_time: guestSiteTimeForStorage\(v\?\.checkout_time\)/, 'saved check-out values must use the compact canonical format')
assert.match(moduleSource, /legacy_amenity_candidates: legacyAmenityCandidateSelections\(amenities\)/)
assert.match(moduleSource, /company_default_amenity_conflicts: companyDefaultAmenityConflicts\(amenitySelections\)/)
assert.match(moduleSource, /'\[\]'::jsonb AS amenity_selections/, 'pre-migration reads must keep using the legacy public schema')
assert.match(moduleSource, /assertGuestSiteAmenitySelectionsSchemaReady\(\)/, 'structured amenity writes must fail closed before the new migration')
assert.match(moduleSource, /guest-site\/amenity-templates'[\s\S]*requirePerm\('guest_site_properties\.view'\)/, 'template reads must reuse the property-view permission')
assert.match(moduleSource, /guest-site\/amenity-templates'[\s\S]*requirePerm\('guest_site_properties\.write'\)/, 'template writes must reuse the property-write permission')
assert.match(moduleSource, /schema_ready: false, templates: \[\]/, 'unmigrated environments must return an explicit empty compatible template list')
assert.match(moduleSource, /assertGuestSiteAmenityTemplatesSchemaReady\(\)/, 'template writes must fail closed before the separately approved migration')
assert.match(moduleSource, /BTRIM\(COALESCE\(building_name, ''\)\)=\$1/, 'building templates must use an exact trimmed existing building name')
assert.doesNotMatch(moduleSource, /fuzzyLocation\.join/)
assert.match(moduleSource, /a\.sort_order \?\? 99999/, 'fallback sorting must preserve sort_order 0')
assert.match(schemaSource, /20261001_guest_site_public_content_schema/)
assert.match(schemaSource, /20261002_guest_site_amenity_selections/)
assert.match(schemaSource, /20261002_guest_site_amenity_templates/)
assert.match(schemaSource, /markers\.has\(GUEST_SITE_PUBLIC_CONTENT_SCHEMA_MIGRATION\)/)
assert.match(templateMigrationSource, /CREATE TABLE IF NOT EXISTS guest_site_amenity_templates/)
assert.match(templateMigrationSource, /CHECK \(scope IN \('company', 'building'\)\)/)
assert.match(templateMigrationSource, /scope = 'company' AND scope_key = ''/)
assert.match(templateMigrationSource, /scope = 'building' AND scope_key <> ''/)
assert.match(templateMigrationSource, /jsonb_typeof\(amenity_candidates\) = 'array'/)
assert.match(templateMigrationSource, /UNIQUE INDEX[\s\S]*scope, LOWER\(scope_key\), LOWER\(name\)/)
assert.match(templateMigrationSource, /scope, scope_key, is_active, updated_at DESC/)
assert.match(templateMigrationSource, /VALUES \('20261002_guest_site_amenity_templates'\)/)
assert.doesNotMatch(templateMigrationSource, /\bINSERT\s+INTO\s+guest_site_amenity_templates\b/i, 'template migration must not seed business data')
assert.doesNotMatch(templateMigrationSource, /\bUPDATE\s+(?:guest_site_property_displays|properties)\b/i, 'template migration must not backfill property data')

console.log('guest-site property merchandising contract: ok')

function readyInput() {
  return {
    hero_title: 'Waterfront apartment',
    short_description: 'A calm one-bedroom stay.',
    long_description: '',
    hero_image_url: '/uploads/cover.jpg',
    gallery_urls: [] as string[],
    public_region_label: 'Docklands',
    capacity: 2,
    checkin_time: '3PM',
    checkout_time: '10AM',
    feature_tags: ['Entire apartment'],
    house_rules: ['No smoking'],
    booking_highlights: ['Long-stay enquiries welcome'],
    amenity_selections: [{ key: 'wifi', status: 'provided' as const }],
  }
}
