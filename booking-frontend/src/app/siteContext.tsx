"use client"

import { createContext, useContext, useMemo, type ReactNode } from 'react'

export type SiteLocale = 'en' | 'zh' | 'zh-Hant'

type SiteCopy = {
  locale: SiteLocale
  setLocale: (_value: SiteLocale) => void
  t: Record<string, string>
}

const translations = {
  navHome: 'Home',
  navProperties: 'Properties',
  navStory: 'Our Story',
  navListing: 'Listing with us',
  navContact: 'Contact us',
  heroEyebrow: 'Melbourne Short Stay',
  heroTitle: 'Stay in Melbourne with confidence',
  heroSubtitle: 'Curated short stay homes for business trips, family stays, and longer visits.',
  browseProperties: 'Browse Properties',
  contactUs: 'Contact Us',
  location: 'Location',
  allCities: 'All cities',
  checkin: 'Check in',
  checkout: 'Check out',
  addDates: 'Add dates',
  guests: 'Guests',
  addGuests: 'Add guests',
  adults: 'Adults',
  adultsHint: 'Ages 18+',
  children: 'Children',
  childrenHint: 'Ages 2-17',
  infants: 'Infants',
  infantsHint: 'Under 2',
  pets: 'Pets',
  petsHint: '',
  search: 'Search',
  clearDates: 'Clear dates',
  listingsTitle: 'My listings',
  listingsSubtitle: 'Explore our thoughtfully managed short-stay homes and find the right fit for your trip.',
  all: 'All',
  loadingProperties: 'Loading properties...',
  noListings: 'No listings are published yet.',
  guestsUnit: 'guests',
  inquiryOnly: 'Inquiry only',
  viewDetails: 'View details',
  locationTitle: 'You can find us here.',
  locationSubtitle: 'Use the address and contact details below to locate our stay management base and contact point.',
  addressPending: 'Please add a contact address from the admin guest website settings.',
  contactPending: 'Please set phone or email details in the backend to complete this section.',
  aboutTitle: 'Our story',
  aboutFallback: 'We focus on a clear inquiry flow: discover a property, check basic date availability, and contact the team to confirm the stay quickly.',
  email: 'Email',
  phoneWhatsApp: 'Phone / WhatsApp',
  notSetYet: 'Not set yet',
  propertiesPageTitle: 'Find Your Stay',
  propertiesPageSubtitle: 'Filter by region, guest count, and keywords; your selected dates will carry into the detail page for availability checks and inquiries.',
  searchKeyword: 'Search by title, address, or keyword',
  allRegions: 'All regions',
  noMatchedProperties: 'No properties match your current filters.',
  backToProperties: 'Back to properties',
  exclusiveStay: 'Exclusive stay',
  propertyOverview: 'Property Overview',
  overviewFallback: 'Detailed descriptions will be maintained from the admin guest website configuration.',
  facilities: 'Facilities',
  highlights: 'Highlights',
  availabilityInquiry: 'Availability & Inquiry',
  availabilityNote: 'Phase one uses your existing order data to block clearly occupied dates before the team confirms the stay manually.',
  availableText: 'Selected dates look available',
  blockedText: 'Those dates are already blocked',
  chooseDatesText: 'Choose dates to check simple availability',
  fullName: 'Full name',
  phone: 'Phone',
  emailPlaceholder: 'Email',
  messagePlaceholder: 'Tell us about your trip, preferences, or questions',
  submitting: 'Submitting...',
  sendInquiry: 'Send Inquiry',
  submitError: 'Failed to submit inquiry',
  propertyNotFound: 'Property not found.',
  inquiryReceived: 'We received it',
  inquirySent: 'Inquiry Sent',
  inquirySentSubtitle: 'Your inquiry has been submitted to the MZ Property backend. The team will review your dates, guest count, and message before confirming the next step.',
  browseMore: 'Browse More Properties',
  backHome: 'Back Home',
  footerTitle: 'MZ Property Guest Website',
  footerSubtitle: 'Property information and availability content are synced from the MZ Property backend.',
} as const

const SiteCopyContext = createContext<SiteCopy | null>(null)

export function SiteCopyProvider({ children }: { children: ReactNode }) {
  const value = useMemo(
    () => ({
      locale: 'en' as const,
      setLocale: () => {},
      t: translations,
    }),
    [],
  )
  return <SiteCopyContext.Provider value={value}>{children}</SiteCopyContext.Provider>
}

export function useSiteCopy() {
  const ctx = useContext(SiteCopyContext)
  if (!ctx) throw new Error('useSiteCopy must be used inside SiteCopyProvider')
  return ctx
}

export function resolveConfiguredText(value: string | undefined, _zhFallback: string, enFallback: string, _locale: SiteLocale) {
  const raw = String(value || '').trim()
  if (!raw) return enFallback
  return raw
}
