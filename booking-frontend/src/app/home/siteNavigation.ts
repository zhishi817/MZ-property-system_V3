export const SITE_NAV_ITEMS = [
  ['/#home', 'Home'],
  ['/properties', 'All Properties'],
  ['/our-story', 'Our Story'],
  ['/#testimonials', 'Reviews'],
  ['/contact', 'Contact us'],
] as const

export function isCurrentSiteNavigationItem(pathname: string, href: string) {
  if (href === '/#home') return pathname === '/'
  if (href === '/properties') {
    return pathname === '/properties'
      || pathname.startsWith('/properties/')
      || pathname === '/property-details'
      || pathname === '/property-preview'
  }
  return pathname === href
}
