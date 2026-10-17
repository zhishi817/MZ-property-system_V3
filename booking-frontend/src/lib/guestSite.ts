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

export type GuestSitePublicAmenity = {
  key: string
  category: string
  label: string
  icon: string
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
  type: string
  capacity: number
  public_capacity_override?: number | null
  public_region_label: string
  hero_title: string
  short_description: string
  long_description: string
  hero_image_url: string
  gallery_urls: string[]
  feature_tags: string[]
  amenities: string[]
  amenity_items?: GuestSitePublicAmenity[]
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
  price_label?: string
  booking_highlights?: string[]
}

export type GuestSiteAvailability = {
  property_id: string
  available: boolean | null
  blocked_ranges: Array<{ checkin: string; checkout: string }>
}
