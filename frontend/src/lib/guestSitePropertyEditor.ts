import type {
  GuestSiteAmenityCatalogItem,
  GuestSiteAmenitySelection,
  GuestSiteAmenityTemplateCandidate,
  GuestSiteProperty,
  GuestSitePublishReadiness,
} from './guestSite'

export const STANDARD_CHECKIN_TIME = '3PM'
export const STANDARD_CHECKOUT_TIME = '10AM'
export const COMPANY_DEFAULT_AMENITY_KEYS = ['baby-cot', 'high-chair'] as const
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
  'Other',
] as const

const companyDefaultAmenityKeySet = new Set<string>(COMPANY_DEFAULT_AMENITY_KEYS)
const publicAmenityCategoryRank = new Map<string, number>(PUBLIC_AMENITY_CATEGORY_ORDER.map((category, index) => [category, index]))

export function isCompanyDefaultAmenityKey(key: unknown) {
  return companyDefaultAmenityKeySet.has(String(key || '').trim())
}

export function companyDefaultAmenityConflicts(selections: GuestSiteAmenitySelection[] | undefined) {
  return (selections || []).filter((item) => isCompanyDefaultAmenityKey(item.key) && item.status !== 'provided')
}

export function sortPublicAmenityItems<T extends { key: string; category: string }>(items: T[]) {
  const unique = Array.from(new Map(items.map((item) => [item.key, item])).values())
  return unique
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (publicAmenityCategoryRank.get(a.item.category) ?? PUBLIC_AMENITY_CATEGORY_ORDER.length) - (publicAmenityCategoryRank.get(b.item.category) ?? PUBLIC_AMENITY_CATEGORY_ORDER.length) || a.index - b.index)
    .map(({ item }) => item)
}

export function canonicalGuestSiteTime(value: unknown): string | null {
  const clean = String(value || '').trim().toUpperCase()
  if (!clean) return null
  const twelveHour = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/.exec(clean)
  let hour24: number
  let minute: number
  if (twelveHour) {
    const hour12 = Number(twelveHour[1])
    minute = Number(twelveHour[2] || 0)
    if (hour12 < 1 || hour12 > 12 || minute > 59) return null
    hour24 = hour12 % 12 + (twelveHour[3] === 'PM' ? 12 : 0)
  } else {
    const twentyFourHour = /^(\d{1,2}):(\d{2})$/.exec(clean)
    if (!twentyFourHour) return null
    hour24 = Number(twentyFourHour[1])
    minute = Number(twentyFourHour[2])
    if (hour24 > 23 || minute > 59) return null
  }
  const period = hour24 >= 12 ? 'PM' : 'AM'
  const hour12 = hour24 % 12 || 12
  return minute ? `${hour12}:${String(minute).padStart(2, '0')}${period}` : `${hour12}${period}`
}

export function guestSiteTimeForStorage(value: unknown) {
  const clean = String(value || '').trim()
  return canonicalGuestSiteTime(clean) || clean
}

export function guestSiteTimeForEditor(value: unknown, standard: string) {
  const clean = String(value || '').trim()
  return clean ? guestSiteTimeForStorage(clean) : standard
}

export function guestSiteTimeOptions(value: unknown, standard: string) {
  const current = guestSiteTimeForStorage(value)
  const options = [{ value: standard, label: `${standard}（公司标准）` }]
  if (current && current !== standard) options.unshift({ value: current, label: `${current}（现有非标准值）` })
  return options
}

export const SAFE_COPY_FIELDS = [
  { key: 'feature_tags_text', label: '房源概览标签' },
  { key: 'amenity_selections', label: '设施确认状态' },
  { key: 'house_rules_text', label: '房屋守则' },
  { key: 'booking_highlights_text', label: '预订提示' },
  { key: 'checkin_time', label: '入住时间' },
  { key: 'checkout_time', label: '退房时间' },
] as const

export type SafeCopyField = typeof SAFE_COPY_FIELDS[number]['key']

export function containsHan(value: string) {
  return /[\u3400-\u9fff]/.test(String(value || ''))
}

export function isReasonableEnglishLabel(value: string) {
  const clean = String(value || '').trim()
  return clean.length >= 2 && clean.length <= 80 && !containsHan(clean) && /[A-Za-z]/.test(clean)
}

export function customAmenityKey(label: string) {
  const slug = String(label || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
  return slug ? `custom:${slug}` : ''
}

export function mergeAmenityCandidates(
  current: GuestSiteAmenitySelection[] | undefined,
  candidateKeys: string[],
) {
  return mergeAmenitySelectionCandidates(current, candidateKeys.map((key) => ({ key, status: 'pending' as const })))
}

export function mergeAmenitySelectionCandidates(
  current: GuestSiteAmenitySelection[] | undefined,
  candidates: GuestSiteAmenitySelection[],
) {
  const next = Array.isArray(current) ? current.map((item) => ({ ...item })) : []
  const existing = new Set(next.map((item) => item.key))
  const added: string[] = []
  const preserved: string[] = []
  for (const candidate of candidates) {
    if (isCompanyDefaultAmenityKey(candidate.key)) {
      preserved.push(candidate.key)
      continue
    }
    if (existing.has(candidate.key)) {
      preserved.push(candidate.key)
      continue
    }
    next.push({ ...candidate, status: 'pending' })
    existing.add(candidate.key)
    added.push(candidate.key)
  }
  return { selections: next, added, preserved }
}

export function pendingSelectionsFromTemplate(candidates: GuestSiteAmenityTemplateCandidate[]) {
  return (candidates || [])
    .filter((candidate) => !isCompanyDefaultAmenityKey(candidate.key))
    .map((candidate) => ({ ...candidate, status: 'pending' as const }))
}

export function amenityTemplateCandidatesFromKeys(
  keys: string[],
  catalog: GuestSiteAmenityCatalogItem[],
  selections: GuestSiteAmenitySelection[],
): GuestSiteAmenityTemplateCandidate[] {
  const catalogKeys = new Set(catalog.map((item) => item.key))
  const selectionsByKey = new Map(selections.map((item) => [item.key, item]))
  return Array.from(new Set(keys)).flatMap((key) => {
    if (isCompanyDefaultAmenityKey(key)) return []
    if (catalogKeys.has(key)) return [{ key }]
    const selection = selectionsByKey.get(key)
    const label = String(selection?.custom_label || '').trim()
    if (!selection || !isReasonableEnglishLabel(label)) return []
    return [{ key, custom_label: label, custom_category: String(selection.custom_category || 'Other').trim() || 'Other' }]
  })
}

export function buildingFacilityCandidateKeys(
  facilities: string[] | undefined,
  catalog: GuestSiteAmenityCatalogItem[],
) {
  const aliases = new Map<string, string>()
  catalog.forEach((item) => {
    aliases.set(item.label_zh.trim().toLowerCase(), item.key)
    aliases.set(item.label_en.trim().toLowerCase(), item.key)
  })
  return Array.from(new Set((facilities || [])
    .map((item) => aliases.get(String(item || '').trim().toLowerCase()) || '')
    .filter(Boolean)))
}

export function selectionWithStatus(
  current: GuestSiteAmenitySelection[] | undefined,
  key: string,
  status: GuestSiteAmenitySelection['status'] | 'unset',
) {
  const next = (current || []).filter((item) => item.key !== key).map((item) => ({ ...item }))
  if (status !== 'unset') next.push({ key, status })
  return next
}

export function addCustomAmenity(
  current: GuestSiteAmenitySelection[] | undefined,
  label: string,
  category: string,
) {
  const cleanLabel = String(label || '').trim()
  const key = customAmenityKey(cleanLabel)
  if (!key || !isReasonableEnglishLabel(cleanLabel)) return { selections: current || [], added: false }
  if ((current || []).some((item) => item.key === key)) return { selections: current || [], added: false }
  return {
    selections: [...(current || []), { key, status: 'pending' as const, custom_label: cleanLabel, custom_category: String(category || 'Other').trim() || 'Other' }],
    added: true,
  }
}

export function copySafePropertyFields(
  target: Record<string, any>,
  source: GuestSiteProperty,
  fields: SafeCopyField[],
) {
  const next = { ...target }
  const copied: SafeCopyField[] = []
  const preserved: SafeCopyField[] = []
  for (const field of fields) {
    const currentValue = next[field]
    const sourceValue = field === 'feature_tags_text'
      ? (source.feature_tags || []).join('\n')
      : field === 'house_rules_text'
        ? (source.house_rules || []).join('\n')
        : field === 'booking_highlights_text'
          ? (source.booking_highlights || []).join('\n')
          : field === 'amenity_selections'
            ? (source.amenity_selections || []).filter((item) => !isCompanyDefaultAmenityKey(item.key))
            : source[field as keyof GuestSiteProperty]
    const currentEmpty = Array.isArray(currentValue) ? currentValue.length === 0 : currentValue == null || currentValue === ''
    const sourceEmpty = Array.isArray(sourceValue) ? sourceValue.length === 0 : sourceValue == null || sourceValue === ''
    if (!currentEmpty || sourceEmpty) {
      preserved.push(field)
      continue
    }
    next[field] = Array.isArray(sourceValue) ? sourceValue.map((item) => typeof item === 'object' ? { ...item } : item) : sourceValue
    copied.push(field)
  }
  return { values: next, copied, preserved }
}

const PUBLIC_TEXT_CHINESE = new Set([
  '整套房源', '自行入住', '自助入住', '免费停车', '游泳池', '健身房', '桑拿房',
  '禁止带宠物', '禁止吸烟', '支持长住咨询',
])

function mappedEnglishList(items: string[]) {
  return items.every((item) => !containsHan(item) || PUBLIC_TEXT_CHINESE.has(item.trim()))
}

export function clientPublishReadiness(input: {
  hero_title?: string
  short_description?: string
  long_description?: string
  hero_image_url?: string
  gallery_urls_text?: string
  public_region_label?: string
  capacity?: number
  public_capacity_override?: number | null
  checkin_time?: string
  checkout_time?: string
  feature_tags_text?: string
  house_rules_text?: string
  booking_highlights_text?: string
  amenity_selections?: GuestSiteAmenitySelection[]
}): GuestSitePublishReadiness {
  const lines = (value?: string) => String(value || '').split('\n').map((item) => item.trim()).filter(Boolean)
  const title = String(input.hero_title || '').trim()
  const description = String(input.short_description || '').trim()
  const longDescription = String(input.long_description || '').trim()
  const region = String(input.public_region_label || '').trim()
  const capacity = Number(input.public_capacity_override || input.capacity || 0)
  const selections = input.amenity_selections || []
  const confirmedAmenities = selections.filter((item) => !isCompanyDefaultAmenityKey(item.key) && item.status === 'provided' && (!item.key.startsWith('custom:') || isReasonableEnglishLabel(item.custom_label || '')))
  const companyDefaultConflicts = companyDefaultAmenityConflicts(selections)
  const englishReady = [title, description, longDescription].filter(Boolean).every((value) => !containsHan(value))
    && mappedEnglishList(lines(input.feature_tags_text))
    && mappedEnglishList(lines(input.house_rules_text))
    && mappedEnglishList(lines(input.booking_highlights_text))
  const items = [
    { key: 'title', label: '英文标题', ready: !!title && !containsHan(title), message: '填写面向英文网站的房源标题' },
    { key: 'description', label: '英文简介', ready: !!description && !containsHan(description), message: '填写简短英文介绍' },
    { key: 'cover', label: '封面图片', ready: !!String(input.hero_image_url || '').trim() || lines(input.gallery_urls_text).length > 0, message: '上传并选择至少一张封面图片' },
    { key: 'region', label: '公开区域', ready: !!region && !containsHan(region), message: '填写不含精确地址的英文区域名称' },
    { key: 'capacity', label: '入住人数', ready: Number.isInteger(capacity) && capacity > 0, message: '确认主房源人数或填写前台人数覆盖' },
    { key: 'amenities', label: '已确认单套设施', ready: confirmedAmenities.length > 0, message: '除公司默认婴儿设施外，至少确认一项该房源实际提供的设施' },
    { key: 'company-default-amenities', label: '公司默认婴儿设施', ready: companyDefaultConflicts.length === 0, message: '移除与全房默认 Baby cot / High chair 冲突的单套记录' },
    { key: 'times', label: '入住退房时间', ready: canonicalGuestSiteTime(input.checkin_time) === STANDARD_CHECKIN_TIME && canonicalGuestSiteTime(input.checkout_time) === STANDARD_CHECKOUT_TIME, message: '请选择公司标准：入住 3PM、退房 10AM' },
    { key: 'english', label: '英文公开内容', ready: englishReady, message: '处理未映射的中文公开文案' },
  ]
  return { ready: items.every((item) => item.ready), items }
}
