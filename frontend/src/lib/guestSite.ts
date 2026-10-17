export type GuestSiteFaqItem = {
  question: string
  answer: string
}

export type GuestSiteConfig = {
  banner_title: string
  banner_subtitle: string
  hero_background_urls: string[]
  primary_button_text: string
  primary_button_href: string
  secondary_button_text: string
  secondary_button_href: string
  brand_story: string
  contact_email: string
  contact_phone: string
  contact_whatsapp: string
  contact_address: string
  faq_items: GuestSiteFaqItem[]
}

export type GuestSiteAmenityStatus = 'provided' | 'not_provided' | 'pending'

export type GuestSiteAmenitySelection = {
  key: string
  status: GuestSiteAmenityStatus
  custom_label?: string
  custom_category?: string
}

export type GuestSiteAmenityTemplateCandidate = Omit<GuestSiteAmenitySelection, 'status'>

export type GuestSiteAmenityTemplate = {
  id: string
  scope: 'company' | 'building'
  scope_key: string
  name: string
  amenity_candidates: GuestSiteAmenityTemplateCandidate[]
  is_active: boolean
  created_at: string
  updated_at: string
}

export type GuestSiteAmenityTemplateList = {
  schema_ready: boolean
  templates: GuestSiteAmenityTemplate[]
}

export type GuestSiteAmenityCatalogItem = {
  key: string
  category_key: string
  category_label_zh: string
  category_label_en: string
  label_zh: string
  label_en: string
  icon: string
  company_default_status?: 'provided'
}

export type GuestSiteAmenityCatalog = {
  statuses: GuestSiteAmenityStatus[]
  categories: Array<{ key: string; label_zh: string; label_en: string }>
  items: GuestSiteAmenityCatalogItem[]
  templates: Array<{ id: string; name_zh: string; description_zh: string; amenity_keys: string[] }>
}

export type GuestSitePublishReadiness = {
  ready: boolean
  items: Array<{ key: string; label: string; ready: boolean; message: string }>
}

export type GuestSiteStayService = {
  key: 'early_checkin' | 'late_checkout' | 'baggage_dropoff'
  enabled: boolean
  title: string
  headline: string
  description: string
  fee_amount: number | null
  fee_currency: string
  until_time: string
  requires_advance_request: boolean
  manual_confirmation: boolean
  guaranteed: boolean
  grants_room_access: boolean
  payment_timing: string
}

export type GuestSiteProperty = {
  id: string
  code: string
  address: string
  type: string
  capacity: number
  public_capacity_override?: number | null
  region: string
  public_region_label: string
  hero_title: string
  short_description: string
  long_description: string
  hero_image_url: string
  gallery_urls: string[]
  feature_tags: string[]
  amenities: string[]
  amenity_selections?: GuestSiteAmenitySelection[]
  company_default_amenity_conflicts?: Array<{ key: string; status: GuestSiteAmenityStatus }>
  legacy_amenity_candidates?: GuestSiteAmenitySelection[]
  house_rules: string[]
  sort_order: number
  is_published: boolean
  bedroom_count?: number
  bathroom_count?: number
  bed_count?: number
  checkin_time?: string
  checkout_time?: string
  cancellation_policy?: string
  stay_services?: GuestSiteStayService[]
  location_note?: string
  price_label?: string
  booking_highlights?: string[]
  building_name?: string
  building_facilities?: string[]
  bed_config?: string
  notes?: string
  airbnb_listing_name?: string
  booking_listing_name?: string
  publish_readiness?: GuestSitePublishReadiness
}

export type GuestSiteAvailability = {
  property_id: string
  available: boolean | null
  blocked_ranges: Array<{ checkin: string; checkout: string }>
}

export type GuestSiteInquiry = {
  id: string
  property_id: string
  property_code?: string | null
  property_address?: string | null
  guest_name: string
  guest_phone: string
  guest_email: string
  checkin: string
  checkout: string
  guest_count: number
  message: string
  status: 'new' | 'contacted' | 'converted' | 'closed'
  admin_note?: string | null
  created_at: string
  updated_at?: string
}

export type GuestSiteContactMessage = {
  id: string
  submission_id: string
  guest_name: string
  guest_email: string
  message: string
  status: 'new' | 'contacted' | 'closed'
  admin_note?: string | null
  handled_by?: string | null
  handled_at?: string | null
  created_at: string
  updated_at?: string
}

export function parseLineList(value: string) {
  return String(value || '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function formatLineList(items: string[] | undefined) {
  return Array.isArray(items) ? items.join('\n') : ''
}
