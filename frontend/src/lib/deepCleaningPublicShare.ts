export function canSubmitPublicDeepCleaning(record: Record<string, any> | null) {
  if (!record || String(record.review_status || '').toLowerCase() === 'approved') return false
  return ['pending', 'assigned', 'in_progress'].includes(String(record.status || 'pending').toLowerCase())
}

export function publicDeepCleaningPayload(values: Record<string, any>, media: { before: string[]; after: string[]; attachments: string[] }, submitForReview = false) {
  if (submitForReview && !media.after.length) throw new Error('请先上传清洁后照片')
  return {
    urgency: values.urgency,
    details: String(values.details || ''),
    repair_notes: String(values.repair_notes || ''),
    photo_urls: media.before,
    repair_photo_urls: media.after,
    attachment_urls: media.attachments,
    checklist: Array.isArray(values.checklist) ? values.checklist : [],
    ...(values.labor_minutes !== undefined && values.labor_minutes !== null ? { labor_minutes: Number(values.labor_minutes) } : {}),
    ...(submitForReview ? { status: 'pending_review' } : {}),
  }
}
