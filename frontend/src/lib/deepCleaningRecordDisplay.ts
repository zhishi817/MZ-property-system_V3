import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import { API_BASE, authHeaders } from './api'
import { maintenanceFeedbackMediaProxyUrl } from './maintenanceFeedbackMedia'

dayjs.extend(utc)
dayjs.extend(timezone)
const RECORD_TIMEZONE = 'Australia/Melbourne'

export function deepCleaningDate(value: unknown, format = 'YYYY-MM-DD') {
  if (!value) return '-'
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? dayjs.tz(String(value), RECORD_TIMEZONE) : dayjs(String(value)).tz(RECORD_TIMEZONE)
  return date.isValid() ? date.format(format) : '-'
}

export function deepCleaningDateBound(value: any, end = false) {
  const date = dayjs.tz(dayjs(value).format('YYYY-MM-DD'), RECORD_TIMEZONE)
  return (end ? date.endOf('day') : date.startOf('day')).toISOString()
}

export const DEEP_CLEANING_AREAS = ['入户走廊', '客厅', '厨房', '卧室', '阳台', '浴室', '全屋', '其他']

export function deepCleaningAreas(record: { category?: unknown; project_desc?: unknown }) {
  const category = String(record.category || '').trim()
  if (category) return category
  const parts = String(record.project_desc || '').split('、').map(x => x.trim()).filter(Boolean)
  return parts.length && parts.every(x => DEEP_CLEANING_AREAS.includes(x)) ? parts.join('、') : ''
}

export function deepCleaningDetails(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') {
    try { return deepCleaningDetails(JSON.parse(value)) } catch { return value.trim() }
  }
  if (Array.isArray(value)) return value.map(item => {
    if (typeof item === 'string') return item
    return String(item?.content || item?.item || item?.desc || '').trim()
  }).filter(Boolean).join('\n')
  if (typeof value === 'object') {
    const item = value as Record<string, unknown>
    return String(item.content || item.item || item.desc || '').trim() || JSON.stringify(value)
  }
  return String(value)
}

export function deepCleaningSummary(record: { details?: unknown; project_desc?: unknown; category?: unknown }) {
  const details = deepCleaningDetails(record.details)
  if (details) return details
  const project = String(record.project_desc || '').trim()
  return !record.category && deepCleaningAreas(record) ? '' : project
}

export function deepCleaningDisplayCost(record: { total_cost?: unknown; labor_cost?: unknown; consumables?: unknown }) {
  const numeric = (value: unknown) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
  const total = numeric(record.total_cost)
  if (total !== null) return total
  const labor = numeric(record.labor_cost)
  let consumables = record.consumables
  if (typeof consumables === 'string') { try { consumables = JSON.parse(consumables) } catch { consumables = null } }
  const costs = Array.isArray(consumables) ? consumables.map(item => numeric(item?.cost)).filter((x): x is number => x !== null) : []
  if (labor === null && !costs.length) return null
  return Math.round(((labor || 0) + costs.reduce((sum, cost) => sum + cost, 0) + Number.EPSILON) * 100) / 100
}

export function deepCleaningMediaReferences(value: unknown): string[] {
  if (typeof value === 'string') { try { return deepCleaningMediaReferences(JSON.parse(value)) } catch { return value.trim() ? [value.trim()] : [] } }
  return Array.isArray(value) ? Array.from(new Set(value.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean))) : []
}

// Keep R2 authority intact: only the server may resolve its storage identity.
export function deepCleaningMediaRequest(reference: string) {
  const proxy = maintenanceFeedbackMediaProxyUrl(reference)
  if (proxy) return { url: proxy, authenticated: true }
  if (/^r2:\/\//i.test(reference) && API_BASE) {
    return { url: `${API_BASE}/cleaning-app/media/image?${new URLSearchParams({ url: reference })}`, authenticated: true }
  }
  if (/^https?:\/\//i.test(reference) || /^\/uploads\//.test(reference)) return { url: reference, authenticated: false }
  return null
}

export async function loadDeepCleaningMedia(reference: string, signal?: AbortSignal) {
  const request = deepCleaningMediaRequest(reference)
  if (!request) throw new Error('unsupported_media_reference')
  if (!request.authenticated) return { src: request.url, revoke: false }
  const response = await fetch(request.url, { headers: authHeaders(), signal })
  if (!response.ok) throw new Error(`deep_cleaning_media_${response.status}`)
  const blob = await response.blob()
  if (!blob.type.startsWith('image/')) throw new Error('invalid_image_response')
  return { src: URL.createObjectURL(blob), revoke: true }
}

// Previously supported HTTP video/file links remain links; never send them to
// the image-only transcoder or attach credentials to their origin.
export function deepCleaningNonImageLink(reference: string) {
  if (!/^https?:\/\//i.test(reference) && !/^\/uploads\//.test(reference)) return ''
  const path = reference.split(/[?#]/)[0]
  const extension = path.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase()
  return extension && !['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif', 'avif', 'tif', 'tiff'].includes(extension) ? reference : ''
}
