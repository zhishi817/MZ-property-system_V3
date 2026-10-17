import type { GuestSiteAmenityCatalogItem, GuestSiteAmenitySelection, GuestSiteProperty } from './guestSite'
import { isCompanyDefaultAmenityKey, isReasonableEnglishLabel, sortPublicAmenityItems } from './guestSitePropertyEditor'

export type GuestSiteDraftPreviewProperty = {
  id: string
  type: string
  capacity: number
  public_capacity_override: number | null
  public_region_label: string
  hero_title: string
  short_description: string
  long_description: string
  hero_image_url: string
  gallery_urls: string[]
  feature_tags: string[]
  amenities: string[]
  amenity_items: Array<{ key: string; category: string; label: string; icon: string }>
  house_rules: string[]
  sort_order: number
  is_published: boolean
  bedroom_count: number | null
  bathroom_count: number | null
  bed_count: number | null
  checkin_time: string
  checkout_time: string
  price_label: string
  booking_highlights: string[]
}

export type GuestSiteDraftPreviewInput = {
  hero_title?: string
  short_description?: string
  long_description?: string
  hero_image_url?: string
  gallery_urls?: string[]
  feature_tags?: string[]
  amenity_selections?: GuestSiteAmenitySelection[]
  house_rules?: string[]
  sort_order?: number
  public_region_label?: string
  public_capacity_override?: number | null
  bedroom_count?: number | null
  bathroom_count?: number | null
  bed_count?: number | null
  checkin_time?: string
  checkout_time?: string
  price_label?: string
  booking_highlights?: string[]
}

const cleanList = (value: unknown) => Array.isArray(value)
  ? value.map((item) => String(item || '').trim()).filter(Boolean)
  : []

/**
 * Builds the same public allowlist consumed by the booking detail renderer.
 * Internal property fields (address, code, notes, building data) cannot enter
 * the cross-app preview message because they are not represented here.
 */
export function buildGuestSiteDraftPreview(
  row: GuestSiteProperty,
  draft: GuestSiteDraftPreviewInput,
  catalog: GuestSiteAmenityCatalogItem[],
): GuestSiteDraftPreviewProperty {
  const catalogByKey = new Map(catalog.map((item) => [item.key, item]))
  const companyDefaults = catalog
    .filter((item) => item.company_default_status === 'provided')
    .map((item) => ({ key: item.key, category: item.category_label_en, label: item.label_en, icon: item.icon }))
  const propertyItems = (draft.amenity_selections || []).flatMap((selection) => {
    if (selection.status !== 'provided' || isCompanyDefaultAmenityKey(selection.key)) return []
    const item = catalogByKey.get(selection.key)
    if (item) return [{ key: item.key, category: item.category_label_en, label: item.label_en, icon: item.icon }]
    const label = String(selection.custom_label || '').trim()
    if (!isReasonableEnglishLabel(label)) return []
    return [{
      key: selection.key,
      category: String(selection.custom_category || 'Other').trim() || 'Other',
      label,
      icon: 'sparkles',
    }]
  })
  const amenityItems = sortPublicAmenityItems([...companyDefaults, ...propertyItems])
  const gallery = cleanList(draft.gallery_urls)
  const heroImage = String(draft.hero_image_url || '').trim() || gallery[0] || ''

  return {
    id: `admin-draft-${row.id}`,
    type: String(row.type || ''),
    capacity: Number(row.capacity || 0),
    public_capacity_override: draft.public_capacity_override == null ? null : Number(draft.public_capacity_override),
    public_region_label: String(draft.public_region_label || '').trim(),
    hero_title: String(draft.hero_title || '').trim(),
    short_description: String(draft.short_description || '').trim(),
    long_description: String(draft.long_description || '').trim(),
    hero_image_url: heroImage,
    gallery_urls: heroImage ? Array.from(new Set([heroImage, ...gallery])) : gallery,
    feature_tags: cleanList(draft.feature_tags),
    amenities: amenityItems.map((item) => item.label),
    amenity_items: amenityItems,
    house_rules: cleanList(draft.house_rules),
    sort_order: Number(draft.sort_order ?? row.sort_order ?? 0),
    is_published: false,
    bedroom_count: draft.bedroom_count == null ? null : Number(draft.bedroom_count),
    bathroom_count: draft.bathroom_count == null ? null : Number(draft.bathroom_count),
    bed_count: draft.bed_count == null ? null : Number(draft.bed_count),
    checkin_time: String(draft.checkin_time || '').trim(),
    checkout_time: String(draft.checkout_time || '').trim(),
    price_label: String(draft.price_label || '').trim(),
    booking_highlights: cleanList(draft.booking_highlights),
  }
}
