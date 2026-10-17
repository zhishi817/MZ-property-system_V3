import { describe, expect, it } from 'vitest'
import type { GuestSiteProperty } from './guestSite'
import {
  COMPANY_DEFAULT_AMENITY_KEYS,
  addCustomAmenity,
  amenityTemplateCandidatesFromKeys,
  buildingFacilityCandidateKeys,
  canonicalGuestSiteTime,
  clientPublishReadiness,
  companyDefaultAmenityConflicts,
  copySafePropertyFields,
  guestSiteTimeForEditor,
  guestSiteTimeForStorage,
  guestSiteTimeOptions,
  mergeAmenityCandidates,
  mergeAmenitySelectionCandidates,
  pendingSelectionsFromTemplate,
  selectionWithStatus,
  sortPublicAmenityItems,
} from './guestSitePropertyEditor'
import { buildGuestSiteDraftPreview } from './guestSitePropertyPreview'

describe('guest-site property editor helpers', () => {
  it('canonicalises valid equivalent times without accepting invalid clocks', () => {
    expect(canonicalGuestSiteTime('3PM')).toBe('3PM')
    expect(canonicalGuestSiteTime('3 PM')).toBe('3PM')
    expect(canonicalGuestSiteTime('3:00 pm')).toBe('3PM')
    expect(canonicalGuestSiteTime('15:00')).toBe('3PM')
    expect(canonicalGuestSiteTime('11:30 AM')).toBe('11:30AM')
    expect(canonicalGuestSiteTime('3:75PM')).toBeNull()
    expect(canonicalGuestSiteTime('25:00')).toBeNull()
    expect(guestSiteTimeForStorage(' 4:00 PM ')).toBe('4PM')
    expect(guestSiteTimeForStorage('3:75PM')).toBe('3:75PM')
    expect(guestSiteTimeForEditor('', '3PM')).toBe('3PM')
    expect(guestSiteTimeOptions('4 PM', '3PM')).toEqual([
      { value: '4PM', label: '4PM（现有非标准值）' },
      { value: '3PM', label: '3PM（公司标准）' },
    ])
  })

  it('applies candidates as pending, preserves exceptions, and is idempotent', () => {
    const first = mergeAmenityCandidates([{ key: 'wifi', status: 'provided' }], ['wifi', 'kettle'])
    expect(first.selections).toEqual([{ key: 'wifi', status: 'provided' }, { key: 'kettle', status: 'pending' }])
    expect(first.added).toEqual(['kettle'])
    expect(first.preserved).toEqual(['wifi'])
    const second = mergeAmenityCandidates(first.selections, ['wifi', 'kettle'])
    expect(second.selections).toEqual(first.selections)
    expect(second.added).toEqual([])
  })

  it('stores templates without property status and applies every candidate as pending', () => {
    const candidates = amenityTemplateCandidatesFromKeys(
      ['wifi', 'custom:cot'],
      [{ key: 'wifi', category_key: 'network', category_label_zh: '网络与工作', category_label_en: 'Internet & work', label_zh: '无线网络', label_en: 'Wi-Fi', icon: 'wifi' }],
      [{ key: 'wifi', status: 'provided' }, { key: 'custom:cot', status: 'not_provided', custom_label: 'Portable cot', custom_category: 'Bedroom & linen' }],
    )
    expect(candidates).toEqual([{ key: 'wifi' }, { key: 'custom:cot', custom_label: 'Portable cot', custom_category: 'Bedroom & linen' }])
    expect(pendingSelectionsFromTemplate(candidates)).toEqual([
      { key: 'wifi', status: 'pending' },
      { key: 'custom:cot', status: 'pending', custom_label: 'Portable cot', custom_category: 'Bedroom & linen' },
    ])
    expect(mergeAmenitySelectionCandidates([{ key: 'wifi', status: 'not_provided' }], pendingSelectionsFromTemplate(candidates)).selections).toEqual([
      { key: 'wifi', status: 'not_provided' },
      { key: 'custom:cot', status: 'pending', custom_label: 'Portable cot', custom_category: 'Bedroom & linen' },
    ])
  })

  it('keeps company defaults out of property and template selection state', () => {
    const catalog = [
      { key: 'baby-cot', category_key: 'baby-amenities', category_label_zh: '婴幼儿用品', category_label_en: 'Baby amenities', label_zh: '婴儿床', label_en: 'Baby cot', icon: 'baby-cot', company_default_status: 'provided' as const },
      { key: 'high-chair', category_key: 'baby-amenities', category_label_zh: '婴幼儿用品', category_label_en: 'Baby amenities', label_zh: '婴儿餐椅', label_en: 'High chair', icon: 'high-chair', company_default_status: 'provided' as const },
      { key: 'wifi', category_key: 'network', category_label_zh: '网络与工作', category_label_en: 'Internet & work', label_zh: '无线网络', label_en: 'Wi-Fi', icon: 'wifi' },
    ]
    expect(COMPANY_DEFAULT_AMENITY_KEYS).toEqual(['baby-cot', 'high-chair'])
    expect(amenityTemplateCandidatesFromKeys(['baby-cot', 'high-chair', 'wifi'], catalog, [])).toEqual([{ key: 'wifi' }])
    expect(pendingSelectionsFromTemplate([{ key: 'baby-cot' }, { key: 'wifi' }])).toEqual([{ key: 'wifi', status: 'pending' }])
    expect(mergeAmenitySelectionCandidates([], [
      { key: 'baby-cot', status: 'pending' },
      { key: 'wifi', status: 'pending' },
    ])).toEqual({ selections: [{ key: 'wifi', status: 'pending' }], added: ['wifi'], preserved: ['baby-cot'] })
  })

  it('imports mixed legacy selections as pending without replacing current decisions', () => {
    const candidates = [
      { key: 'free-parking', status: 'pending' as const },
      { key: 'custom:portable-cot', status: 'pending' as const, custom_label: 'Portable cot', custom_category: 'Other' },
    ]
    const first = mergeAmenitySelectionCandidates([{ key: 'free-parking', status: 'not_provided' }], candidates)
    expect(first.selections).toEqual([
      { key: 'free-parking', status: 'not_provided' },
      { key: 'custom:portable-cot', status: 'pending', custom_label: 'Portable cot', custom_category: 'Other' },
    ])
    expect(first.preserved).toEqual(['free-parking'])
    expect(mergeAmenitySelectionCandidates(first.selections, candidates).added).toEqual([])
  })

  it('distinguishes provided, unavailable, pending and unset', () => {
    const pending = selectionWithStatus([], 'dryer', 'pending')
    const unavailable = selectionWithStatus(pending, 'dryer', 'not_provided')
    expect(unavailable).toEqual([{ key: 'dryer', status: 'not_provided' }])
    expect(selectionWithStatus(unavailable, 'dryer', 'unset')).toEqual([])
  })

  it('only maps explicitly recognised building facilities to pending candidates', () => {
    const catalog = [
      { key: 'gym', category_key: 'building', category_label_zh: '楼宇设施', category_label_en: 'Building facilities', label_zh: '健身房', label_en: 'Gym', icon: 'gym' },
    ]
    expect(buildingFacilityCandidateKeys(['健身房', '未知停车说明'], catalog)).toEqual(['gym'])
  })

  it('copies only selected empty shared fields and preserves unique content', () => {
    const source = {
      id: 'source', feature_tags: ['Entire apartment'], amenity_selections: [{ key: 'baby-cot', status: 'provided' }, { key: 'wifi', status: 'provided' }],
      house_rules: ['No smoking'], booking_highlights: ['Ask about long stays'], checkin_time: '3PM', checkout_time: '10AM',
    } as GuestSiteProperty
    const target = { hero_title: 'Keep my title', feature_tags_text: '', house_rules_text: 'Keep my rule', amenity_selections: [] }
    const copied = copySafePropertyFields(target, source, ['feature_tags_text', 'house_rules_text', 'amenity_selections'])
    expect(copied.values.hero_title).toBe('Keep my title')
    expect(copied.values.feature_tags_text).toBe('Entire apartment')
    expect(copied.values.house_rules_text).toBe('Keep my rule')
    expect(copied.values.amenity_selections).toEqual([{ key: 'wifi', status: 'provided' }])
    expect(copied.copied).toEqual(['feature_tags_text', 'amenity_selections'])
  })

  it('adds only reasonable English custom amenities as pending', () => {
    expect(addCustomAmenity([], 'Portable cot', 'Bedroom & linen')).toEqual({
      selections: [{ key: 'custom:portable-cot', status: 'pending', custom_label: 'Portable cot', custom_category: 'Bedroom & linen' }],
      added: true,
    })
    expect(addCustomAmenity([], '便携婴儿床', 'Other').added).toBe(false)
  })

  it('blocks publishing until confirmed amenities and fixed times are present', () => {
    const input = {
      hero_title: 'Waterfront apartment', short_description: 'A calm place to stay.', hero_image_url: '/cover.jpg',
      public_region_label: 'Docklands', capacity: 2, checkin_time: '3PM', checkout_time: '10AM',
      amenity_selections: [{ key: 'wifi', status: 'provided' as const }],
    }
    expect(clientPublishReadiness(input).ready).toBe(true)
    expect(clientPublishReadiness({ ...input, checkin_time: '3:00 PM', checkout_time: '10 AM' }).ready).toBe(true)
    expect(clientPublishReadiness({ ...input, checkin_time: '15:00', checkout_time: '10:00' }).ready).toBe(true)
    expect(clientPublishReadiness({ ...input, checkin_time: '3:75PM' }).ready).toBe(false)
    expect(clientPublishReadiness({ ...input, checkout_time: '25:00' }).ready).toBe(false)
    expect(clientPublishReadiness({ ...input, feature_tags_text: '自行入住\n自助入住' }).ready).toBe(true)
    expect(clientPublishReadiness({ ...input, checkout_time: '10:00 PM' }).ready).toBe(false)
    expect(clientPublishReadiness({ ...input, amenity_selections: [{ key: 'wifi', status: 'pending' }] }).ready).toBe(false)
    expect(clientPublishReadiness({ ...input, amenity_selections: [] }).ready).toBe(false)
    expect(clientPublishReadiness({ ...input, amenity_selections: [{ key: 'baby-cot', status: 'provided' }] }).ready).toBe(false)
    expect(clientPublishReadiness({ ...input, amenity_selections: [{ key: 'wifi', status: 'provided' }, { key: 'high-chair', status: 'pending' }] }).ready).toBe(false)
    expect(companyDefaultAmenityConflicts([{ key: 'baby-cot', status: 'not_provided' }, { key: 'high-chair', status: 'provided' }])).toEqual([{ key: 'baby-cot', status: 'not_provided' }])
  })

  it('builds a public-field-only draft preview and exposes only confirmed amenities', () => {
    const row = {
      id: 'property-1', code: 'PRIVATE-1', address: '1 Secret Street', notes: 'internal note', building_name: 'Private Tower',
      type: '一房一卫', capacity: 2, region: 'Internal region', public_region_label: '', hero_title: '', short_description: '',
      long_description: '', hero_image_url: '', gallery_urls: [], feature_tags: [], amenities: [], house_rules: [], sort_order: 0, is_published: false,
    } as GuestSiteProperty
    const preview = buildGuestSiteDraftPreview(row, {
      hero_title: 'Draft waterfront stay', public_region_label: 'Docklands', gallery_urls: ['/one.jpg'],
      amenity_selections: [
        { key: 'wifi', status: 'provided' },
        { key: 'gym', status: 'pending' },
        { key: 'custom:cot', status: 'provided', custom_label: 'Portable cot', custom_category: 'Bedroom & linen' },
      ],
    }, [
      { key: 'baby-cot', category_key: 'baby-amenities', category_label_zh: '婴幼儿用品', category_label_en: 'Baby amenities', label_zh: '婴儿床', label_en: 'Baby cot', icon: 'baby-cot', company_default_status: 'provided' },
      { key: 'high-chair', category_key: 'baby-amenities', category_label_zh: '婴幼儿用品', category_label_en: 'Baby amenities', label_zh: '婴儿餐椅', label_en: 'High chair', icon: 'high-chair', company_default_status: 'provided' },
      { key: 'wifi', category_key: 'network', category_label_zh: '网络与工作', category_label_en: 'Internet & work', label_zh: '无线网络', label_en: 'Wi-Fi', icon: 'wifi' },
      { key: 'gym', category_key: 'building', category_label_zh: '楼宇设施', category_label_en: 'Building facilities', label_zh: '健身房', label_en: 'Gym', icon: 'gym' },
    ])
    expect(preview.amenity_items.map((item) => item.label)).toEqual(['Wi-Fi', 'Portable cot', 'Baby cot', 'High chair'])
    expect(preview.hero_image_url).toBe('/one.jpg')
    expect(preview.is_published).toBe(false)
    expect(preview).not.toHaveProperty('cancellation_policy')
    expect(preview).not.toHaveProperty('stay_services')
    expect(preview).not.toHaveProperty('address')
    expect(preview).not.toHaveProperty('code')
    expect(preview).not.toHaveProperty('notes')
    expect(preview).not.toHaveProperty('building_name')
  })

  it('keeps company defaults in an empty draft preview', () => {
    const row = { id: 'property-2', type: 'Apartment', capacity: 2, sort_order: 0 } as GuestSiteProperty
    const preview = buildGuestSiteDraftPreview(row, { amenity_selections: [] }, [
      { key: 'baby-cot', category_key: 'baby-amenities', category_label_zh: '婴幼儿用品', category_label_en: 'Baby amenities', label_zh: '婴儿床', label_en: 'Baby cot', icon: 'baby-cot', company_default_status: 'provided' },
      { key: 'high-chair', category_key: 'baby-amenities', category_label_zh: '婴幼儿用品', category_label_en: 'Baby amenities', label_zh: '婴儿餐椅', label_en: 'High chair', icon: 'high-chair', company_default_status: 'provided' },
    ])
    expect(preview.amenity_items.map((item) => item.key)).toEqual(['baby-cot', 'high-chair'])
  })

  it('sorts public amenities by stable category priority without duplicates', () => {
    const item = (key: string, category: string) => ({ key, category })
    expect(sortPublicAmenityItems([
      item('baby-cot', 'Baby amenities'),
      item('wifi', 'Internet & work'),
      item('kettle', 'Kitchen appliances'),
      item('washing-machine', 'Laundry'),
      item('free-parking', 'Parking'),
      item('kettle', 'Kitchen appliances'),
    ])).toEqual([
      item('kettle', 'Kitchen appliances'),
      item('washing-machine', 'Laundry'),
      item('wifi', 'Internet & work'),
      item('free-parking', 'Parking'),
      item('baby-cot', 'Baby amenities'),
    ])
  })
})
