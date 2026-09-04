export const PDF_RENDER_SERVICE_SUBJECT = 'u-pdf-job'
export const PDF_RENDER_SERVICE_USERNAME = 'pdf_job'
export const PDF_RENDER_SERVICE_TOKEN_USE = 'service'
export const PDF_RENDER_SERVICE_NAME = 'pdf-render'
export const PDF_RENDER_SERVICE_SCOPE = 'monthly-statement:render'
export const PDF_RENDER_SERVICE_AUDIENCE = 'mz-pdf-render'

const ALLOWED_GET_PATHS = new Set([
  '/auth/me',
  '/properties',
  '/orders',
  '/landlords',
  '/finance',
  '/finance/rent-segments',
  '/crud/property_expenses',
  '/crud/recurring_payments',
  '/crud/property_deep_cleaning',
  '/crud/property_maintenance',
])

function normalizedPath(value: unknown): string {
  const raw = String(value || '').split('?')[0].trim()
  if (!raw) return '/'
  const withoutTrailingSlash = raw.replace(/\/+$/g, '')
  return withoutTrailingSlash || '/'
}

function audiencesOf(decoded: any): string[] {
  const values = Array.isArray(decoded?.aud) ? decoded.aud : [decoded?.aud]
  return values.map((value: any) => String(value || '').trim()).filter(Boolean)
}

export function pdfRenderServiceClaims() {
  return {
    sub: PDF_RENDER_SERVICE_SUBJECT,
    username: PDF_RENDER_SERVICE_USERNAME,
    token_use: PDF_RENDER_SERVICE_TOKEN_USE,
    service: PDF_RENDER_SERVICE_NAME,
    scope: PDF_RENDER_SERVICE_SCOPE,
    aud: PDF_RENDER_SERVICE_AUDIENCE,
  }
}

export function hasPdfRenderServiceIntent(decoded: any): boolean {
  return String(decoded?.sub || '').trim() === PDF_RENDER_SERVICE_SUBJECT
    || String(decoded?.token_use || '').trim() === PDF_RENDER_SERVICE_TOKEN_USE
}

export function isPdfRenderServiceClaims(decoded: any): boolean {
  return String(decoded?.sub || '').trim() === PDF_RENDER_SERVICE_SUBJECT
    && String(decoded?.username || '').trim() === PDF_RENDER_SERVICE_USERNAME
    && String(decoded?.token_use || '').trim() === PDF_RENDER_SERVICE_TOKEN_USE
    && String(decoded?.service || '').trim() === PDF_RENDER_SERVICE_NAME
    && String(decoded?.scope || '').trim() === PDF_RENDER_SERVICE_SCOPE
    && audiencesOf(decoded).includes(PDF_RENDER_SERVICE_AUDIENCE)
}

export function isPdfRenderServiceRequestAllowed(method: unknown, path: unknown): boolean {
  return String(method || '').trim().toUpperCase() === 'GET'
    && ALLOWED_GET_PATHS.has(normalizedPath(path))
}

export function pdfRenderServiceUser() {
  return {
    ...pdfRenderServiceClaims(),
    role: 'admin',
    roles: ['admin'],
  }
}

export function isPdfRenderServiceUser(user: any): boolean {
  return isPdfRenderServiceClaims(user)
}
