export const INSPECTION_ASSIGNMENT_CONFLICT_CONSTRAINT = 'inspection_assignment_property_date_conflict'

function text(value: unknown) {
  return String(value ?? '').trim()
}

export function inspectionAssignmentConflictPayload(error: any) {
  if (text(error?.constraint) !== INSPECTION_ASSIGNMENT_CONFLICT_CONSTRAINT) return null
  const detail = text(error?.detail)
  const fields = Object.fromEntries(
    Array.from(detail.matchAll(/([a-z_]+)=([^\s]+)/g)).map((match) => [match[1], match[2]]),
  )
  return {
    message: `同一房源同一检查日期只能有一位有效检查人员：${fields.property_id || '未知房源'} · ${fields.service_date || '未知日期'}`,
    code: INSPECTION_ASSIGNMENT_CONFLICT_CONSTRAINT,
    property_id: fields.property_id || null,
    service_date: fields.service_date || null,
    existing_inspector_id: fields.existing_inspector_id || null,
    requested_inspector_id: fields.requested_inspector_id || null,
  }
}
