import { createHash } from 'crypto'
import { canonicalGuestSiteTime } from './guestSitePropertyDisplay'

export const GUEST_SITE_POLICY_SECTIONS = [
  'house_rules',
  'cancellation_policy',
  'stay_times',
  'stay_services',
] as const

export const GUEST_SITE_POLICY_MODES = ['legacy', 'follow_company', 'override'] as const

export type GuestSitePolicySection = typeof GUEST_SITE_POLICY_SECTIONS[number]
export type GuestSitePolicyMode = typeof GUEST_SITE_POLICY_MODES[number]

export type StayServicePolicy = {
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

export type GuestSitePolicyContent =
  | { items: string[] }
  | { body: string }
  | { checkin_time: string; checkout_time: string }
  | { services: StayServicePolicy[] }

export type GuestSiteEffectivePolicy = {
  house_rules: string[]
  cancellation_policy: string
  checkin_time: string
  checkout_time: string
  stay_services: StayServicePolicy[]
  section_sources: Record<GuestSitePolicySection, GuestSitePolicyMode | 'follow_unpublished' | 'override_unpublished'>
}

const SERVICE_KEYS: StayServicePolicy['key'][] = ['early_checkin', 'late_checkout', 'baggage_dropoff']

const text = (value: unknown, max = 4000) => String(value || '').trim().slice(0, max)
const list = (value: unknown, max = 40) => Array.isArray(value)
  ? value.map((item) => text(item, 500)).filter(Boolean).slice(0, max)
  : []

function containsHan(value: string) {
  return /[\u3400-\u9fff]/.test(value)
}

export function defaultStayServices(): StayServicePolicy[] {
  return [
    {
      key: 'early_checkin',
      enabled: true,
      title: 'Early check-in',
      headline: 'No fee · Advance request',
      description: 'Ask in advance. We will do our best to arrange an earlier arrival, but it is not guaranteed.',
      fee_amount: 0,
      fee_currency: 'AUD',
      until_time: '',
      requires_advance_request: true,
      manual_confirmation: true,
      guaranteed: false,
      grants_room_access: false,
      payment_timing: '',
    },
    {
      key: 'late_checkout',
      enabled: true,
      title: 'Late check-out',
      headline: 'Until 11:30AM · A$20',
      description: 'Ask in advance. Approval is manual and depends on availability.',
      fee_amount: 20,
      fee_currency: 'AUD',
      until_time: '11:30AM',
      requires_advance_request: true,
      manual_confirmation: true,
      guaranteed: false,
      grants_room_access: false,
      payment_timing: '',
    },
    {
      key: 'baggage_dropoff',
      enabled: true,
      title: 'Luggage drop-off',
      headline: 'Advance confirmation required',
      description: 'Ask the property team before arrival. Confirmed luggage drop-off does not mean the property is ready for check-in.',
      fee_amount: null,
      fee_currency: 'AUD',
      until_time: '',
      requires_advance_request: true,
      manual_confirmation: true,
      guaranteed: false,
      grants_room_access: false,
      payment_timing: '',
    },
  ]
}

export function emptyPolicyContent(section: GuestSitePolicySection): GuestSitePolicyContent {
  if (section === 'house_rules') return { items: [] }
  if (section === 'cancellation_policy') return { body: '' }
  if (section === 'stay_times') return { checkin_time: '3PM', checkout_time: '10AM' }
  return { services: defaultStayServices() }
}

export function normalizePolicyContent(section: GuestSitePolicySection, value: unknown): GuestSitePolicyContent {
  const raw = value && typeof value === 'object' ? value as Record<string, any> : {}
  if (section === 'house_rules') return { items: list(raw.items) }
  if (section === 'cancellation_policy') return { body: text(raw.body, 12000) }
  if (section === 'stay_times') {
    const checkin = canonicalGuestSiteTime(raw.checkin_time)
    const checkout = canonicalGuestSiteTime(raw.checkout_time)
    return {
      checkin_time: checkin || text(raw.checkin_time, 20),
      checkout_time: checkout || text(raw.checkout_time, 20),
    }
  }
  const byKey = new Map<string, any>((Array.isArray(raw.services) ? raw.services : []).map((item: any) => [String(item?.key || ''), item]))
  const defaults = new Map(defaultStayServices().map((item) => [item.key, item]))
  return {
    services: SERVICE_KEYS.map((key) => {
      const source = byKey.get(key) || defaults.get(key)!
      const feeRaw = source?.fee_amount
      const feeAmount = feeRaw == null || feeRaw === '' ? null : Number(feeRaw)
      return {
        key,
        enabled: source?.enabled !== false,
        title: text(source?.title, 120),
        headline: text(source?.headline, 220),
        description: text(source?.description, 1200),
        fee_amount: Number.isFinite(feeAmount) && Number(feeAmount) >= 0 ? Number(feeAmount) : null,
        fee_currency: text(source?.fee_currency || 'AUD', 8).toUpperCase(),
        until_time: canonicalGuestSiteTime(source?.until_time) || text(source?.until_time, 20),
        requires_advance_request: source?.requires_advance_request !== false,
        manual_confirmation: source?.manual_confirmation !== false,
        guaranteed: source?.guaranteed === true,
        grants_room_access: source?.grants_room_access === true,
        payment_timing: text(source?.payment_timing, 240),
      }
    }),
  }
}

export function policySectionReadiness(
  section: GuestSitePolicySection,
  content: unknown,
  scopeType: 'company' | 'property',
) {
  const normalized = normalizePolicyContent(section, content) as any
  const issues: string[] = []
  if (section === 'house_rules') {
    if (!normalized.items.length) issues.push('house_rules_required')
    if (normalized.items.some((item: string) => containsHan(item))) issues.push('public_english_required')
  } else if (section === 'cancellation_policy') {
    if (!normalized.body) issues.push('cancellation_policy_required')
    if (containsHan(normalized.body)) issues.push('public_english_required')
  } else if (section === 'stay_times') {
    const checkin = canonicalGuestSiteTime(normalized.checkin_time)
    const checkout = canonicalGuestSiteTime(normalized.checkout_time)
    if (!checkin || !checkout) issues.push('valid_compact_times_required')
    if (scopeType === 'company' && (checkin !== '3PM' || checkout !== '10AM')) issues.push('company_standard_times_required')
  } else {
    if (normalized.services.length !== SERVICE_KEYS.length) issues.push('all_stay_services_required')
    for (const service of normalized.services as StayServicePolicy[]) {
      if (!service.title || !service.headline || !service.description) issues.push(`${service.key}_english_copy_required`)
      if ([service.title, service.headline, service.description].some(containsHan)) issues.push(`${service.key}_public_english_required`)
      if (!service.requires_advance_request || !service.manual_confirmation || service.guaranteed) issues.push(`${service.key}_manual_request_contract_required`)
    }
    const late = (normalized.services as StayServicePolicy[]).find((item) => item.key === 'late_checkout')
    if (!late || late.fee_amount !== 20 || canonicalGuestSiteTime(late.until_time) !== '11:30AM') issues.push('late_checkout_standard_required')
    const early = (normalized.services as StayServicePolicy[]).find((item) => item.key === 'early_checkin')
    if (!early || early.fee_amount !== 0) issues.push('early_checkin_free_required')
    const baggage = (normalized.services as StayServicePolicy[]).find((item) => item.key === 'baggage_dropoff')
    if (!baggage || baggage.grants_room_access) issues.push('baggage_no_room_access_required')
  }
  return { ready: issues.length === 0, issues: Array.from(new Set(issues)), content: normalized as GuestSitePolicyContent }
}

export function stablePolicyHash(value: unknown) {
  const ordered = (input: any): any => {
    if (Array.isArray(input)) return input.map(ordered)
    if (!input || typeof input !== 'object') return input
    return Object.keys(input).sort().reduce((result, key) => ({ ...result, [key]: ordered(input[key]) }), {})
  }
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex')
}

export function resolveEffectivePolicy(input: {
  legacy?: { house_rules?: unknown; checkin_time?: unknown; checkout_time?: unknown }
  modes?: Partial<Record<GuestSitePolicySection, GuestSitePolicyMode>>
  company?: Partial<Record<GuestSitePolicySection, unknown>>
  overrides?: Partial<Record<GuestSitePolicySection, unknown>>
}): GuestSiteEffectivePolicy {
  const legacy = {
    house_rules: list(input.legacy?.house_rules),
    cancellation_policy: '',
    checkin_time: canonicalGuestSiteTime(input.legacy?.checkin_time) || '3PM',
    checkout_time: canonicalGuestSiteTime(input.legacy?.checkout_time) || '10AM',
    stay_services: defaultStayServices(),
  }
  const sources = {} as GuestSiteEffectivePolicy['section_sources']
  const resolved: Partial<Record<GuestSitePolicySection, any>> = {}
  for (const section of GUEST_SITE_POLICY_SECTIONS) {
    const mode = input.modes?.[section] || 'legacy'
    if (mode === 'legacy') {
      sources[section] = 'legacy'
      if (section === 'house_rules') resolved[section] = { items: legacy.house_rules }
      else if (section === 'cancellation_policy') resolved[section] = { body: legacy.cancellation_policy }
      else if (section === 'stay_times') resolved[section] = { checkin_time: legacy.checkin_time, checkout_time: legacy.checkout_time }
      else resolved[section] = { services: legacy.stay_services }
    } else if (mode === 'follow_company') {
      if (input.company?.[section]) {
        sources[section] = 'follow_company'
        resolved[section] = normalizePolicyContent(section, input.company[section])
      } else {
        sources[section] = 'follow_unpublished'
        resolved[section] = section === 'stay_times' ? { checkin_time: '', checkout_time: '' } : section === 'stay_services' ? { services: [] } : section === 'house_rules' ? { items: [] } : { body: '' }
      }
    } else if (input.overrides?.[section]) {
      sources[section] = 'override'
      resolved[section] = normalizePolicyContent(section, input.overrides[section])
    } else {
      sources[section] = 'override_unpublished'
      resolved[section] = section === 'stay_times' ? { checkin_time: '', checkout_time: '' } : section === 'stay_services' ? { services: [] } : section === 'house_rules' ? { items: [] } : { body: '' }
    }
  }
  return {
    house_rules: (resolved.house_rules as any).items,
    cancellation_policy: (resolved.cancellation_policy as any).body,
    checkin_time: (resolved.stay_times as any).checkin_time,
    checkout_time: (resolved.stay_times as any).checkout_time,
    stay_services: (resolved.stay_services as any).services,
    section_sources: sources,
  }
}
