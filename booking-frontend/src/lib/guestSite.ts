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
  house_rules: string[]
  sort_order: number
  is_published: boolean
  bedroom_count?: number
  bathroom_count?: number
  bed_count?: number
  checkin_time?: string
  checkout_time?: string
  location_note?: string
  price_label?: string
  booking_highlights?: string[]
  building_name?: string
  building_facilities?: string[]
  bed_config?: string
  notes?: string
  airbnb_listing_name?: string
  booking_listing_name?: string
}

export type GuestSiteAvailability = {
  property_id: string
  available: boolean | null
  blocked_ranges: Array<{ checkin: string; checkout: string }>
}
