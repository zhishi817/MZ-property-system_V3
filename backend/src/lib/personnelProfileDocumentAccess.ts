const PERSONNEL_PROFILE_DOCUMENT_VIEW_ROLES = new Set(['admin', 'finance_staff'])

function normalizeRoleName(value: unknown) {
  return String(value || '').trim().toLowerCase().replace(/^role\./, '')
}

export function hasPersonnelProfileDocumentViewerRole(user: any) {
  const roles = [user?.role, ...(Array.isArray(user?.roles) ? user.roles : [])]
  return roles.some((role) => PERSONNEL_PROFILE_DOCUMENT_VIEW_ROLES.has(normalizeRoleName(role)))
}
