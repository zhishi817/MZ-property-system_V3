export type PresentableAmenity = {
  key: string
  category: string
  label: string
  icon: string
}

export const PUBLIC_AMENITY_CATEGORY_ORDER = [
  'Kitchen appliances',
  'Coffee',
  'Kitchenware',
  'Laundry',
  'Internet & work',
  'Parking',
  'Heating & cooling',
  'Bathroom',
  'Bedroom & linen',
  'Building facilities',
  'Baby amenities',
  'Amenities',
  'Other',
] as const

export const DESKTOP_AMENITY_SUMMARY_LIMIT = 15
export const MOBILE_AMENITY_SUMMARY_LIMIT = 10

const categoryRank = new Map<string, number>(PUBLIC_AMENITY_CATEGORY_ORDER.map((category, index) => [category, index]))

const summaryBuckets: Array<{ categories: string[]; preferredKeys?: string[] }> = [
  { categories: ['Kitchen appliances', 'Coffee', 'Kitchenware'] },
  { categories: ['Laundry'], preferredKeys: ['washing-machine', 'separate-dryer', 'washer-dryer-combo'] },
  { categories: ['Internet & work'], preferredKeys: ['wifi'] },
  { categories: ['Parking'], preferredKeys: ['free-parking', 'paid-parking'] },
  { categories: ['Heating & cooling'] },
  { categories: ['Bathroom', 'Bedroom & linen'] },
  { categories: ['Building facilities'] },
]

export function sortAmenitiesForDisplay<T extends PresentableAmenity>(items: T[]): T[] {
  const unique = Array.from(new Map(items.filter((item) => item?.key).map((item) => [item.key, item])).values())
  return unique
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (categoryRank.get(a.item.category) ?? PUBLIC_AMENITY_CATEGORY_ORDER.length) - (categoryRank.get(b.item.category) ?? PUBLIC_AMENITY_CATEGORY_ORDER.length) || a.index - b.index)
    .map(({ item }) => item)
}

export function amenitySummaryKeys(items: PresentableAmenity[], limit: number): string[] {
  const sorted = sortAmenitiesForDisplay(items)
  const selected: PresentableAmenity[] = []
  const selectedKeys = new Set<string>()
  const take = (item: PresentableAmenity | undefined) => {
    if (!item || selectedKeys.has(item.key) || selected.length >= limit) return
    selected.push(item)
    selectedKeys.add(item.key)
  }

  for (const bucket of summaryBuckets) {
    const preferred = bucket.preferredKeys?.map((key) => sorted.find((item) => item.key === key)).find(Boolean)
    take(preferred || sorted.find((item) => bucket.categories.includes(item.category)))
  }
  for (const item of sorted) {
    if (item.category !== 'Baby amenities') take(item)
  }
  for (const item of sorted) take(item)
  return selected.map((item) => item.key)
}
