import { v4 as uuidv4 } from 'uuid'
import { maintenanceWorkTaskStatus, normalizeMaintenanceWorkflowStatus } from './maintenanceWorkflow'
import { MAINTENANCE_WORK_TASK_SOURCE_TYPES } from './maintenanceWorkflowSchema'

export type MaintenanceWorkflowDomain = 'internal' | 'external'

export function maintenanceWorkflowSourceType(domain: MaintenanceWorkflowDomain): string {
  return MAINTENANCE_WORK_TASK_SOURCE_TYPES[domain]
}

function dateOnly(value: any): string | null {
  const raw = String(value || '').trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

export function maintenanceTaskSummaryFromDetails(value: any): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    const items = Array.isArray(parsed) ? parsed : [parsed]
    const summary = items
      .map((item: any) => {
        if (typeof item === 'string') return item.trim()
        if (!item || typeof item !== 'object') return ''
        return String(item.content || item.detail || item.text || item.name || '').trim()
      })
      .filter(Boolean)
      .join('；')
    return summary || raw
  } catch {
    return raw
  }
}

function maintenanceCompletionPhotoUrls(value: any): string[] {
  const values = Array.isArray(value)
    ? value
    : (() => {
        try {
          const parsed = JSON.parse(String(value || ''))
          return Array.isArray(parsed) ? parsed : []
        } catch {
          return []
        }
      })()
  return Array.from(new Set(values.map((item) => String(item || '').trim()).filter(Boolean)))
}

export async function upsertMaintenanceWorkTask(client: any, domain: MaintenanceWorkflowDomain, row: any) {
  const sourceType = maintenanceWorkflowSourceType(domain)
  const sourceId = String(row?.id || '').trim()
  if (!sourceId) throw new Error('maintenance_record_id_missing')
  const status = normalizeMaintenanceWorkflowStatus(row?.status, row?.review_status)
  const reference = String(domain === 'internal' ? row?.work_no : row?.order_no || '').trim() || sourceId
  const title = `${domain === 'internal' ? '内部维修' : '外部维修'} ${reference}`
  const scheduledDate = domain === 'internal' ? dateOnly(row?.eta) : dateOnly(row?.scheduled_date)
  const propertyId = domain === 'internal' ? (String(row?.property_id || '').trim() || null) : null
  const summary = maintenanceTaskSummaryFromDetails(row?.details)
  const completionPhotoUrls = maintenanceCompletionPhotoUrls(row?.completion_photo_urls)
  const completionNote = domain === 'internal'
    ? (String(row?.repair_notes || '').trim() || null)
    : (String(row?.completion_notes || '').trim() || null)
  const completionReason = String(row?.completion_reason || '').trim() || null
  await client.query(
    `INSERT INTO work_tasks(
       id, task_kind, source_type, source_id, property_id, title, summary,
       scheduled_date, assignee_id, status, urgency, completion_photo_urls, completion_note, completion_reason,
       created_by, updated_by, created_at, updated_at
     ) VALUES($1,'maintenance',$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,COALESCE($16::timestamptz, now()),now())
     ON CONFLICT (source_type, source_id) DO UPDATE SET
       task_kind=EXCLUDED.task_kind,
       property_id=EXCLUDED.property_id,
       title=EXCLUDED.title,
       summary=EXCLUDED.summary,
       scheduled_date=EXCLUDED.scheduled_date,
       assignee_id=EXCLUDED.assignee_id,
       status=EXCLUDED.status,
       urgency=EXCLUDED.urgency,
       completion_photo_urls=EXCLUDED.completion_photo_urls,
       completion_note=EXCLUDED.completion_note,
       completion_reason=EXCLUDED.completion_reason,
       updated_by=EXCLUDED.updated_by,
       updated_at=now()`,
    [
      `${sourceType}:${sourceId}`,
      sourceType,
      sourceId,
      propertyId,
      title,
      summary,
      scheduledDate,
      String(row?.assignee_id || '').trim() || null,
      maintenanceWorkTaskStatus(status),
      String(row?.urgency || '').trim() || 'medium',
      JSON.stringify(completionPhotoUrls),
      completionNote,
      completionReason,
      String(row?.created_by || '').trim() || null,
      String(row?.updated_by || '').trim() || null,
      row?.created_at || null,
    ],
  )
}

export async function insertMaintenanceWorkflowEvent(client: any, input: {
  domain: MaintenanceWorkflowDomain
  recordId: string
  eventType: string
  fromStatus: string
  toStatus: string
  actorUserId: string
  actorName: string | null
  reason: string | null
  payload?: Record<string, any>
}) {
  await client.query(
    `INSERT INTO maintenance_workflow_events(
       id, maintenance_domain, record_id, event_type, from_status, to_status,
       actor_user_id, actor_name, reason, payload, created_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,now())`,
    [
      uuidv4(),
      input.domain,
      input.recordId,
      input.eventType,
      input.fromStatus,
      input.toStatus,
      input.actorUserId || null,
      input.actorName,
      input.reason,
      JSON.stringify(input.payload || {}),
    ],
  )
}
