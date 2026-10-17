export const STAY_POLICY_SECTIONS = ['house_rules', 'cancellation_policy', 'stay_times', 'stay_services'] as const

export type StayPolicySection = typeof STAY_POLICY_SECTIONS[number]
export type StayPolicyMode = 'legacy' | 'follow_company' | 'override'

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

export type StayPolicyContent =
  | { items: string[] }
  | { body: string }
  | { checkin_time: string; checkout_time: string }
  | { services: StayServicePolicy[] }

export type StayPolicyVersion = {
  id: string
  scope_type: 'company' | 'property'
  property_id: string | null
  section: StayPolicySection
  status: 'draft' | 'published' | 'archived'
  revision: number
  content: StayPolicyContent
  updated_at: string
  updated_by: string | null
  published_at: string | null
  published_by: string | null
}

export type StayPolicyReadiness = {
  ready: boolean
  issues: string[]
  content: StayPolicyContent
}

export type StayPolicyModeRecord = {
  property_id: string
  section: StayPolicySection
  mode: StayPolicyMode
  revision: number
}

export type StayPolicySectionOverview = {
  section: StayPolicySection
  mode?: StayPolicyModeRecord | null
  draft: StayPolicyVersion | null
  published: StayPolicyVersion | null
  default_draft: StayPolicyContent | null
  readiness: StayPolicyReadiness
  company_published?: StayPolicyContent | null
  history: StayPolicyVersion[]
}

export type CompanyStayPolicyOverview = {
  schema_ready: boolean
  sections: StayPolicySectionOverview[]
}

export type PropertyStayPolicyOverview = {
  property_id: string
  sections: StayPolicySectionOverview[]
  effective_policy: Record<string, unknown>
  public_property: Record<string, unknown>
}

export type CompanyPolicyImpact = {
  section: StayPolicySection
  draft_revision: number
  impact_hash: string
  changed_count: number
  properties: Array<{
    property_id: string
    property_code: string
    property_title: string
    is_published: boolean
    mode: StayPolicyMode
    mode_revision: number
    override_revision: number
    changed: boolean
    before: StayPolicyContent
    after: StayPolicyContent
  }>
}

export type StayPolicyPreview = {
  property_id: string
  section: StayPolicySection
  current_mode: StayPolicyMode
  applies_without_mode_change: boolean
  current_property: Record<string, unknown>
  candidate_property: Record<string, unknown>
}

export const STAY_POLICY_META: Record<StayPolicySection, { title: string; summary: string }> = {
  house_rules: { title: '房屋守则', summary: '逐条维护公开英文规则。' },
  cancellation_policy: { title: '取消政策', summary: '只发布已确认的英文取消条款；未知时保持未发布。' },
  stay_times: { title: '入住与退房时间', summary: '公司标准为入住 3PM、退房 10AM。' },
  stay_services: { title: '入住服务', summary: '早入住、晚退房及提前放行李的公开说明。' },
}

export function defaultStayServices(): StayServicePolicy[] {
  return [
    { key: 'early_checkin', enabled: true, title: 'Early check-in', headline: 'No fee · Advance request', description: 'Ask in advance. We will do our best to arrange an earlier arrival, but it is not guaranteed.', fee_amount: 0, fee_currency: 'AUD', until_time: '', requires_advance_request: true, manual_confirmation: true, guaranteed: false, grants_room_access: false, payment_timing: '' },
    { key: 'late_checkout', enabled: true, title: 'Late check-out', headline: 'Until 11:30AM · A$20', description: 'Ask in advance. Approval is manual and depends on availability.', fee_amount: 20, fee_currency: 'AUD', until_time: '11:30AM', requires_advance_request: true, manual_confirmation: true, guaranteed: false, grants_room_access: false, payment_timing: '' },
    { key: 'baggage_dropoff', enabled: true, title: 'Luggage drop-off', headline: 'Advance confirmation required', description: 'Ask the property team before arrival. Confirmed luggage drop-off does not mean the property is ready for check-in.', fee_amount: null, fee_currency: 'AUD', until_time: '', requires_advance_request: true, manual_confirmation: true, guaranteed: false, grants_room_access: false, payment_timing: '' },
  ]
}

export function emptyPolicyContent(section: StayPolicySection): StayPolicyContent {
  if (section === 'house_rules') return { items: [] }
  if (section === 'cancellation_policy') return { body: '' }
  if (section === 'stay_times') return { checkin_time: '3PM', checkout_time: '10AM' }
  return { services: defaultStayServices() }
}

export function editablePolicyContent(section: StayPolicySection, overview: StayPolicySectionOverview): StayPolicyContent {
  return JSON.parse(JSON.stringify(overview.draft?.content || overview.published?.content || overview.default_draft || emptyPolicyContent(section)))
}

export function summarizePolicyContent(section: StayPolicySection, content: StayPolicyContent) {
  if (section === 'house_rules') return `${(content as { items: string[] }).items.length} 条规则`
  if (section === 'cancellation_policy') return (content as { body: string }).body || '未填写'
  if (section === 'stay_times') {
    const value = content as { checkin_time: string; checkout_time: string }
    return `${value.checkin_time || '—'} / ${value.checkout_time || '—'}`
  }
  return `${(content as { services: StayServicePolicy[] }).services.filter((item) => item.enabled).length} 项服务`
}
