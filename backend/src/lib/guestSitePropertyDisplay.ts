import { z } from 'zod'

export const GUEST_SITE_AMENITY_STATUSES = ['provided', 'not_provided', 'pending'] as const
export type GuestSiteAmenityStatus = typeof GUEST_SITE_AMENITY_STATUSES[number]

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

export type GuestSiteAmenitySelection = {
  key: string
  status: GuestSiteAmenityStatus
  custom_label?: string
  custom_category?: string
}

export type GuestSiteAmenityTemplateCandidate = Omit<GuestSiteAmenitySelection, 'status'>

export type GuestSitePublicAmenity = {
  key: string
  category: string
  label: string
  icon: string
}

export const STANDARD_GUEST_CHECKIN_TIME = '3PM'
export const STANDARD_GUEST_CHECKOUT_TIME = '10AM'
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

const category = (key: string, zh: string, en: string) => ({ key, zh, en })

export const GUEST_SITE_AMENITY_CATEGORIES = [
  category('kitchen-appliances', '厨房电器', 'Kitchen appliances'),
  category('coffee', '咖啡设备', 'Coffee'),
  category('kitchenware', '厨房用品', 'Kitchenware'),
  category('laundry', '洗衣', 'Laundry'),
  category('bathroom', '卫浴', 'Bathroom'),
  category('bedding', '床品', 'Bedroom & linen'),
  category('network', '网络与工作', 'Internet & work'),
  category('climate', '冷暖', 'Heating & cooling'),
  category('parking', '停车', 'Parking'),
  category('building', '楼宇设施', 'Building facilities'),
  category('baby-amenities', '婴幼儿用品', 'Baby amenities'),
] as const

function amenity(
  key: string,
  categoryKey: string,
  labelZh: string,
  labelEn: string,
  icon: string,
): GuestSiteAmenityCatalogItem {
  const group = GUEST_SITE_AMENITY_CATEGORIES.find((item) => item.key === categoryKey)
  if (!group) throw new Error(`unknown_amenity_category:${categoryKey}`)
  return {
    key,
    category_key: group.key,
    category_label_zh: group.zh,
    category_label_en: group.en,
    label_zh: labelZh,
    label_en: labelEn,
    icon,
  }
}

export const GUEST_SITE_AMENITY_CATALOG: GuestSiteAmenityCatalogItem[] = [
  amenity('kettle', 'kitchen-appliances', '热水壶', 'Kettle', 'kettle'),
  amenity('toaster', 'kitchen-appliances', '烤面包机', 'Toaster', 'toaster'),
  amenity('microwave', 'kitchen-appliances', '微波炉', 'Microwave', 'microwave'),
  amenity('oven', 'kitchen-appliances', '烤箱', 'Oven', 'oven'),
  amenity('dishwasher', 'kitchen-appliances', '洗碗机', 'Dishwasher', 'dishwasher'),
  amenity('pod-coffee-machine', 'coffee', '胶囊咖啡机', 'Pod coffee machine', 'coffee'),
  amenity('espresso-machine', 'coffee', '意式咖啡机', 'Espresso machine', 'coffee'),
  amenity('filter-coffee-maker', 'coffee', '滴滤咖啡机', 'Filter coffee maker', 'coffee'),
  amenity('french-press', 'coffee', '法压壶', 'French press', 'coffee'),
  amenity('coffee-pods-provided', 'coffee', '提供咖啡胶囊', 'Coffee pods provided', 'coffee-pod'),
  amenity('pots-and-pans', 'kitchenware', '锅具', 'Pots and pans', 'pan'),
  amenity('cutlery', 'kitchenware', '餐具', 'Cutlery', 'cutlery'),
  amenity('plates-and-bowls', 'kitchenware', '盘碗', 'Plates and bowls', 'plate'),
  amenity('glassware', 'kitchenware', '杯具', 'Glassware', 'glass'),
  amenity('cooking-utensils', 'kitchenware', '烹饪用具', 'Cooking utensils', 'utensils'),
  amenity('kitchen-knives', 'kitchenware', '厨房刀具', 'Kitchen knives', 'knife'),
  amenity('cutting-board', 'kitchenware', '砧板', 'Cutting board', 'cutting-board'),
  amenity('washing-machine', 'laundry', '洗衣机', 'Washing machine', 'washing-machine'),
  amenity('separate-dryer', 'laundry', '独立烘干机', 'Separate dryer', 'dryer'),
  amenity('washer-dryer-combo', 'laundry', '洗烘一体机', 'Washer-dryer combo', 'washer-dryer'),
  amenity('drying-rack', 'laundry', '晾衣架', 'Drying rack', 'drying-rack'),
  amenity('laundry-detergent', 'laundry', '洗衣液', 'Laundry detergent', 'detergent'),
  amenity('shampoo', 'bathroom', '洗发水', 'Shampoo', 'bottle'),
  amenity('conditioner', 'bathroom', '护发素', 'Conditioner', 'bottle'),
  amenity('body-wash', 'bathroom', '沐浴露', 'Body wash', 'bottle'),
  amenity('hair-dryer', 'bathroom', '吹风机', 'Hair dryer', 'hair-dryer'),
  amenity('towels', 'bathroom', '毛巾', 'Towels', 'towel'),
  amenity('toilet-paper', 'bathroom', '卫生纸', 'Toilet paper', 'toilet-paper'),
  amenity('bed-linen', 'bedding', '床品', 'Bed linen', 'bed-linen'),
  amenity('extra-pillows-blankets', 'bedding', '额外枕头和毯子', 'Extra pillows and blankets', 'blanket'),
  amenity('blackout-shades', 'bedding', '遮光窗帘', 'Blackout shades', 'curtain'),
  amenity('wifi', 'network', '无线网络', 'Wi-Fi', 'wifi'),
  amenity('dedicated-workspace', 'network', '专用工作区', 'Dedicated workspace', 'workspace'),
  amenity('smart-tv', 'network', '智能电视', 'Smart TV', 'tv'),
  amenity('air-conditioning', 'climate', '空调', 'Air conditioning', 'snowflake'),
  amenity('heating', 'climate', '暖气', 'Heating', 'heating'),
  amenity('fan', 'climate', '风扇', 'Fan', 'fan'),
  amenity('free-parking', 'parking', '免费停车', 'Free parking', 'parking'),
  amenity('paid-parking', 'parking', '付费停车', 'Paid parking', 'parking-paid'),
  amenity('swimming-pool', 'building', '游泳池', 'Swimming pool', 'pool'),
  amenity('gym', 'building', '健身房', 'Gym', 'gym'),
  amenity('sauna', 'building', '桑拿房', 'Sauna', 'sauna'),
  amenity('elevator', 'building', '电梯', 'Elevator', 'elevator'),
  { ...amenity('baby-cot', 'baby-amenities', '婴儿床', 'Baby cot', 'baby-cot'), company_default_status: 'provided' },
  { ...amenity('high-chair', 'baby-amenities', '婴儿餐椅', 'High chair', 'high-chair'), company_default_status: 'provided' },
]

export const GUEST_SITE_AMENITY_TEMPLATES = [
  {
    id: 'standard-apartment-candidates',
    name_zh: '标准公寓候选',
    description_zh: '只把常见项目加入“待确认”，不会公开，也不会覆盖当前选择。',
    amenity_keys: [
      'kettle', 'toaster', 'microwave', 'oven', 'dishwasher',
      'pots-and-pans', 'cutlery', 'plates-and-bowls', 'glassware', 'cooking-utensils',
      'kitchen-knives', 'cutting-board', 'washing-machine', 'drying-rack',
      'hair-dryer', 'towels', 'bed-linen', 'wifi', 'heating',
    ],
  },
] as const

const catalogByKey = new Map(GUEST_SITE_AMENITY_CATALOG.map((item) => [item.key, item]))
const catalogByAlias = new Map<string, GuestSiteAmenityCatalogItem>()
for (const item of GUEST_SITE_AMENITY_CATALOG) {
  catalogByAlias.set(item.label_zh.trim().toLowerCase(), item)
  catalogByAlias.set(item.label_en.trim().toLowerCase(), item)
}

export const amenitySelectionSchema = z.object({
  key: z.string().trim().min(2).max(80).regex(/^[a-z0-9][a-z0-9:_-]*$/),
  status: z.enum(GUEST_SITE_AMENITY_STATUSES),
  custom_label: z.string().trim().max(80).optional().default(''),
  custom_category: z.string().trim().max(80).optional().default(''),
})

function containsHan(value: string) {
  return /[\u3400-\u9fff]/.test(value)
}

function customKey(label: string, index: number) {
  const slug = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
  return `custom:${slug || `legacy-${index + 1}`}`
}

export function amenityCatalogItem(key: string) {
  return catalogByKey.get(String(key || '').trim()) || null
}

export function normalizeAmenityTemplateCandidates(value: unknown): GuestSiteAmenityTemplateCandidate[] {
  if (!Array.isArray(value)) return []
  const normalized = normalizeAmenitySelections(
    value.map((candidate) => ({ ...(candidate && typeof candidate === 'object' ? candidate : {}), status: 'pending' })),
    [],
  )
  return normalized.flatMap(({ status: _status, ...candidate }) => {
    if (companyDefaultAmenityKeySet.has(candidate.key)) return []
    if (amenityCatalogItem(candidate.key)) return [candidate]
    const label = String(candidate.custom_label || '').trim()
    if (!label || containsHan(label)) return []
    return [{ ...candidate, custom_label: label, custom_category: String(candidate.custom_category || 'Other').trim() || 'Other' }]
  })
}

export function legacyAmenityCandidateSelections(legacyAmenities: unknown): GuestSiteAmenitySelection[] {
  if (!Array.isArray(legacyAmenities)) return []
  const candidates: GuestSiteAmenitySelection[] = []
  const seen = new Set<string>()

  legacyAmenities.forEach((raw, index) => {
    const label = String(raw || '').trim()
    if (!label) return
    const item = catalogByAlias.get(label.toLowerCase())
    const key = item?.key || customKey(label, index)
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(item
      ? { key, status: 'pending' }
      : { key, status: 'pending', custom_label: label, custom_category: 'Other' })
  })
  return candidates
}

export function normalizeAmenitySelections(value: unknown, legacyAmenities: unknown = []): GuestSiteAmenitySelection[] {
  if (!Array.isArray(value)) return legacyAmenityCandidateSelections(legacyAmenities)

  const normalized: GuestSiteAmenitySelection[] = []
  const seen = new Set<string>()

  value.forEach((raw) => {
    const parsed = amenitySelectionSchema.safeParse(raw)
    if (!parsed.success || seen.has(parsed.data.key)) return
    const item = catalogByKey.get(parsed.data.key)
    const customLabel = String(parsed.data.custom_label || '').trim()
    if (!item && !customLabel) return
    seen.add(parsed.data.key)
    normalized.push({
      key: parsed.data.key,
      status: parsed.data.status,
      ...(item ? {} : { custom_label: customLabel, custom_category: String(parsed.data.custom_category || '').trim() }),
    })
  })
  return normalized
}

function publicAmenityFromSelection(selection: GuestSiteAmenitySelection): GuestSitePublicAmenity | null {
  const item = catalogByKey.get(selection.key)
  if (item) return { key: item.key, category: item.category_label_en, label: item.label_en, icon: item.icon }
  const label = String(selection.custom_label || '').trim()
  if (!label || containsHan(label)) return null
  return {
    key: selection.key,
    category: String(selection.custom_category || 'Other').trim() || 'Other',
    label,
    icon: 'sparkles',
  }
}

export function companyDefaultAmenityItems(): GuestSitePublicAmenity[] {
  return COMPANY_DEFAULT_AMENITY_KEYS.flatMap((key) => {
    const item = catalogByKey.get(key)
    return item ? [{ key: item.key, category: item.category_label_en, label: item.label_en, icon: item.icon }] : []
  })
}

export function companyDefaultAmenityConflicts(value: unknown, legacyAmenities: unknown = []) {
  return normalizeAmenitySelections(value, legacyAmenities)
    .filter((selection) => companyDefaultAmenityKeySet.has(selection.key) && selection.status !== 'provided')
    .map((selection) => ({ key: selection.key, status: selection.status }))
}

export function propertyConfirmedAmenityItems(value: unknown, legacyAmenities: unknown = []): GuestSitePublicAmenity[] {
  return normalizeAmenitySelections(value, legacyAmenities).flatMap((selection) => {
    if (selection.status !== 'provided' || companyDefaultAmenityKeySet.has(selection.key)) return []
    const item = publicAmenityFromSelection(selection)
    return item ? [item] : []
  })
}

export function sortPublicAmenityItems(items: GuestSitePublicAmenity[]) {
  const unique = Array.from(new Map(items.map((item) => [item.key, item])).values())
  return unique
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (publicAmenityCategoryRank.get(a.item.category) ?? PUBLIC_AMENITY_CATEGORY_ORDER.length) - (publicAmenityCategoryRank.get(b.item.category) ?? PUBLIC_AMENITY_CATEGORY_ORDER.length) || a.index - b.index)
    .map(({ item }) => item)
}

export function publicAmenityItems(value: unknown, legacyAmenities: unknown = []): GuestSitePublicAmenity[] {
  const items = [...companyDefaultAmenityItems(), ...propertyConfirmedAmenityItems(value, legacyAmenities)]
  return sortPublicAmenityItems(items)
}

export function amenityCatalogPayload() {
  return {
    statuses: [...GUEST_SITE_AMENITY_STATUSES],
    categories: GUEST_SITE_AMENITY_CATEGORIES.map((item) => ({ key: item.key, label_zh: item.zh, label_en: item.en })),
    items: GUEST_SITE_AMENITY_CATALOG.map((item) => ({ ...item })),
    templates: GUEST_SITE_AMENITY_TEMPLATES.map((template) => ({ ...template, amenity_keys: [...template.amenity_keys] })),
  }
}

export type PublishReadinessInput = {
  hero_title: string
  short_description: string
  long_description: string
  hero_image_url: string
  gallery_urls: string[]
  public_region_label: string
  capacity: number
  checkin_time: string
  checkout_time: string
  feature_tags: string[]
  house_rules: string[]
  booking_highlights: string[]
  amenity_selections: GuestSiteAmenitySelection[]
}

export type PublishReadinessItem = { key: string; label: string; ready: boolean; message: string }

const PUBLIC_TEXT_ENGLISH = new Set([
  '整套房源', '自行入住', '自助入住', '免费停车', '游泳池', '健身房', '桑拿房',
  '禁止带宠物', '禁止吸烟', '支持长住咨询',
])

function listIsEnglishReady(items: string[]) {
  return items.every((item) => !containsHan(item) || PUBLIC_TEXT_ENGLISH.has(item.trim()))
}

export function publishReadiness(input: PublishReadinessInput) {
  const propertyAmenities = propertyConfirmedAmenityItems(input.amenity_selections)
  const companyDefaultConflicts = companyDefaultAmenityConflicts(input.amenity_selections)
  const englishReady = [input.hero_title, input.short_description, input.long_description]
    .filter(Boolean)
    .every((value) => !containsHan(value))
    && listIsEnglishReady(input.feature_tags)
    && listIsEnglishReady(input.house_rules)
    && listIsEnglishReady(input.booking_highlights)
  const items: PublishReadinessItem[] = [
    { key: 'title', label: '英文标题', ready: !!input.hero_title.trim() && !containsHan(input.hero_title), message: '填写面向英文网站的房源标题' },
    { key: 'description', label: '英文简介', ready: !!input.short_description.trim() && !containsHan(input.short_description), message: '填写简短英文介绍' },
    { key: 'cover', label: '封面图片', ready: !!(input.hero_image_url.trim() || input.gallery_urls.length), message: '上传并选择至少一张封面图片' },
    { key: 'region', label: '公开区域', ready: !!input.public_region_label.trim() && !containsHan(input.public_region_label), message: '填写不含精确地址的英文区域名称' },
    { key: 'capacity', label: '入住人数', ready: Number.isInteger(input.capacity) && input.capacity > 0, message: '确认主房源人数或填写前台人数覆盖' },
    { key: 'amenities', label: '已确认单套设施', ready: propertyAmenities.length > 0, message: '除公司默认婴儿设施外，至少确认一项该房源实际提供的设施' },
    { key: 'company-default-amenities', label: '公司默认婴儿设施', ready: companyDefaultConflicts.length === 0, message: '移除与全房默认 Baby cot / High chair 冲突的单套记录' },
    { key: 'times', label: '入住退房时间', ready: canonicalGuestSiteTime(input.checkin_time) === STANDARD_GUEST_CHECKIN_TIME && canonicalGuestSiteTime(input.checkout_time) === STANDARD_GUEST_CHECKOUT_TIME, message: '请选择公司标准：入住 3PM、退房 10AM' },
    { key: 'english', label: '英文公开内容', ready: englishReady, message: '处理未映射的中文公开文案' },
  ]
  return { ready: items.every((item) => item.ready), items }
}
