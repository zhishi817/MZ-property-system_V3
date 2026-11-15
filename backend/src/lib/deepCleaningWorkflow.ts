/** Deep cleaning accepts every existing user except customer service (including mixed roles).
 * User existence is checked separately; no invented active/disabled or finance restriction. */
export const isDeepCleaningExecutorEligibleRoleNames = (roles: unknown[]) => !(roles || []).some(role => String(role || '').trim().toLowerCase() === 'customer_service')
/** Deep-cleaning workflow contract. No schema writes or settlement integration. */
export const DEEP_CLEANING_PROTECTED_FIELDS = new Set([
  'status','assignee_id','worker_name','eta',
  'completed_at','completion_photo_urls',
  'labor_cost','total_cost','pay_method','gst_type',
  'review_status','reviewed_by','reviewed_at','review_notes','project_items',
])
export const deepCleaningIsAdmin = (user: any) => [user?.role, ...(Array.isArray(user?.roles) ? user.roles : [])].some(x => x === 'admin')
export function deepCleaningStatus(row: any): string {
  const status = String(row?.status || 'pending').toLowerCase()
  if (row?.review_status === 'pending' && ['completed','done','ready','closed'].includes(status)) return 'pending_review'
  if (row?.review_status === 'approved' || ['closed','completed','done','ready'].includes(status)) return 'completed'
  if (['pending_review','review_pending','awaiting_review'].includes(status)) return 'pending_review'
  return status
}
export function deepCleaningAvailableActions(row: any, user: any, canAssign = false): string[] {
  const status = deepCleaningStatus(row)
  const active = ['pending','pending_assignment','open','todo','assigned','in_progress'].includes(status)
  const actions: string[] = []
  if (active && canAssign) actions.push('assign')
  if (active && row?.assignee_id && String(row.assignee_id) === String(user?.sub || user?.id || '')) actions.push('complete')
  if (status === 'pending_review' && deepCleaningIsAdmin(user)) actions.push('review')
  return actions
}
export function deepCleaningWorkflowResponse(row: any, user: any, canAssign = false) {
  const status = deepCleaningStatus(row)
  const terminal = ['pending_review','completed','cancelled','canceled'].includes(status)
  const actions = deepCleaningAvailableActions(row, user, canAssign)
  const roles = [user?.role,...(Array.isArray(user?.roles) ? user.roles : [])]
  const financial = roles.some(role => ['admin','finance_staff'].includes(role))
  const fieldKeys = ['id','property_id','property_code','work_no','areas','details','project_desc','status','review_status','assignee_id','worker_name','eta','occurred_at','photo_urls','repair_photo_urls','attachment_urls','repair_notes','started_at','ended_at','duration_minutes','completed_at','created_at','updated_at','urgency','media_access_work_task_id']
  const visible = financial ? {...row} : Object.fromEntries(fieldKeys.filter(key => key in row).map(key => [key,row[key]]))
  return { ...visible, ok: true, workflow_status: status, available_actions: actions,
    can_assign: actions.includes('assign'), can_review: actions.includes('review'),
    deep_cleaning_workflow: { status, available_actions: actions },
    work_record_state: status === 'completed' ? 'completed' : status === 'pending_review' ? 'pending_review' : 'active',
    work_record_read_only: terminal, counts_as_active_task: !terminal,
  }
}
export type DeepCleaningPrice = { version: 1; pricing_mode: 'total' | 'items'; total_amount: number; price_items: Array<{id:string;description:string;amount:number}>; pay_method: string; gst_type: string }
export function deepCleaningReviewPrice(body: any): DeepCleaningPrice {
  const money = (v: any) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || !Number.isSafeInteger(Math.round(v * 100)) || Math.abs(v * 100 - Math.round(v * 100)) > 0.000001) throw new Error('deep_cleaning_price_invalid')
    return Math.round(v * 100)
  }
  if (!['company_pay','landlord_pay','rent_deduction','tenant_pay','other_pay'].includes(body.pay_method)) throw new Error('deep_cleaning_pay_method_required')
  if (!['GST_INCLUDED_10','GST_10','GST_FREE','INPUT_TAXED'].includes(body.gst_type)) throw new Error('deep_cleaning_gst_type_required')
  let cents: number
  let items: DeepCleaningPrice['price_items'] = []
  if (body.pricing_mode === 'total') {
    if (body.price_items != null && (!Array.isArray(body.price_items) || body.price_items.length)) throw new Error('deep_cleaning_price_mode_conflict')
    cents = money(body.total_amount)
  } else if (body.pricing_mode === 'items') {
    if (body.total_amount != null || !Array.isArray(body.price_items) || !body.price_items.length) throw new Error('deep_cleaning_price_mode_conflict')
    const ids = new Set<string>()
    cents = 0
    items = body.price_items.map((x: any) => {
      if (!x || typeof x.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(x.id) || ids.has(x.id) || typeof x.description !== 'string' || !x.description.trim()) throw new Error('deep_cleaning_price_item_invalid')
      ids.add(x.id); const amount = money(x.amount); cents += amount
      return {id:x.id,description:x.description.trim(),amount:amount/100}
    })
    if (!Number.isSafeInteger(cents)) throw new Error('deep_cleaning_price_invalid')
  } else throw new Error('deep_cleaning_pricing_mode_required')
  // Whole-order price already includes materials; preserve existing GST semantics.
  return {version:1,pricing_mode:body.pricing_mode,total_amount:cents/100,price_items:items,pay_method:body.pay_method,gst_type:body.gst_type}
}
export async function deepCleaningMediaContexts(client:any, rows:any[]) {
  if (!rows.length) return new Map<string,string>()
  const result=await client.query(`SELECT w.id::text AS id,w.source_id::text AS source_id FROM work_tasks w JOIN property_deep_cleaning d ON d.id::text=w.source_id::text AND d.property_id::text=w.property_id::text WHERE w.source_type='property_deep_cleaning' AND d.deleted_at IS NULL AND w.source_id::text = ANY($1::text[])`,[rows.map(row=>String(row.id))])
  return new Map<string,string>((result.rows || []).map((row:any)=>[String(row.source_id),String(row.id)]))
}
export async function enrichDeepCleaningWorkflowRows(client: any, rows: any[], user: any, canAssign = false) {
  if (!rows.length) return rows
  const ids = rows.map(row => String(row.id))
  // Creator fallback is display-only and resolves IDs, never free-text names or executors.
  const creatorIds = [...new Set(rows.flatMap(row => [row.created_by_user_id, row.created_by]).map(value => String(value || '').trim()).filter(Boolean))]
  const creators = new Map<string,string>()
  if (creatorIds.length) {
    const result = await client.query('SELECT id, username FROM users WHERE id = ANY($1::text[])', [creatorIds])
    for (const entry of result.rows || []) {
      const name = String(entry.username || '').trim()
      if (name) creators.set(String(entry.id), name)
    }
  }
  const mediaContexts=await deepCleaningMediaContexts(client,rows)
  // Financial audit records are not broadcast/replayed to task assignees through SSE.
  const events = await client.query(`SELECT DISTINCT ON (entity_id) entity_id, after_json->'deep_cleaning_review' AS review
    FROM audit_logs WHERE entity='property_deep_cleaning' AND action='deep_cleaning_review'
      AND entity_id = ANY($1::text[]) AND after_json->'deep_cleaning_review'->>'version'='1'
    ORDER BY entity_id, created_at DESC, id DESC`, [ids])
  const prices = new Map((events.rows || []).map((e: any) => [String(e.entity_id), e.review]))
  // Only called after the existing CRUD read authorization. Preserve that read
  // contract's full record; the field allowlist is for mutation/receipt responses,
  // not a new role-based restriction on previously authorized Web reads.
  return rows.map(row => {
    const enriched = {...row, ...(prices.get(String(row.id)) as any || {}),media_access_work_task_id:mediaContexts.get(String(row.id)) || null}
    const recorded = String(row.submitter_name || '').trim()
    const creatorUser = creators.get(String(row.created_by_user_id || '').trim())
    const creator = creators.get(String(row.created_by || '').trim())
    return {...enriched, ...deepCleaningWorkflowResponse(enriched,user,canAssign),
      submitter_display_name: recorded || creatorUser || creator || null,
      submitter_display_source: recorded ? 'recorded' : creatorUser ? 'created_by_user_id' : creator ? 'created_by' : 'unknown'}
  })
}
