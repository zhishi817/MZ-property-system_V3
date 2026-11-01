const PASSWORD_VALUE_KEYS = new Set([
  'old_code',
  'new_code',
  'wifi_password',
  'guest_phone',
  'oldcode',
  'newcode',
  'wifipassword',
  'guestphone',
])

export type RedactedPasswordAudit = {
  value: any
  redactedFields: string[]
}

export function redactPasswordAuditValues(input: any): RedactedPasswordAudit {
  const redactedFields = new Set<string>()

  const visit = (value: any, path: string): any => {
    if (Array.isArray(value)) return value.map((item, index) => visit(item, `${path}[${index}]`))
    if (!value || typeof value !== 'object' || value instanceof Date) return value

    const next: Record<string, any> = {}
    const decisionField = String((value as any)?.field || '').trim().toLowerCase().replace(/[_-]/g, '')
    const passwordDecision = PASSWORD_VALUE_KEYS.has(decisionField)
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = String(key || '').trim().toLowerCase()
      const compactKey = normalizedKey.replace(/[_-]/g, '')
      const childPath = path ? `${path}.${key}` : key
      if (passwordDecision && (normalizedKey === 'canonical_value' || normalizedKey === 'manual_value')) {
        redactedFields.add(childPath)
        next[`${key}_present`] = String(child ?? '').trim().length > 0
        continue
      }
      if (PASSWORD_VALUE_KEYS.has(normalizedKey) || PASSWORD_VALUE_KEYS.has(compactKey)) {
        redactedFields.add(childPath)
        next[`${key}_present`] = String(child ?? '').trim().length > 0
        continue
      }
      if (normalizedKey === 'supersede_conflicts' && typeof child === 'string') {
        try {
          next[key] = JSON.stringify(visit(JSON.parse(child), childPath))
          continue
        } catch {}
      }
      next[key] = visit(child, childPath)
    }
    return next
  }

  return {
    value: visit(input, ''),
    redactedFields: Array.from(redactedFields).sort(),
  }
}

export function passwordAuditChangedFields(fields: unknown, redactedFields: string[]) {
  const changedFields = Array.from(new Set(
    (Array.isArray(fields) ? fields : [])
      .map((field) => String(field || '').trim())
      .filter(Boolean),
  ))
  const hasPasswordField = changedFields.some((field) => {
    const key = field.split('.').pop()?.toLowerCase() || ''
    return PASSWORD_VALUE_KEYS.has(key)
  }) || redactedFields.length > 0
  if (hasPasswordField && !changedFields.includes('password_authority')) changedFields.push('password_authority')
  return changedFields
}
