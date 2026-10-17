"use client"

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { resolveAssetUrl } from '../../../lib/api'
import {
  DESKTOP_AMENITY_SUMMARY_LIMIT,
  MOBILE_AMENITY_SUMMARY_LIMIT,
  amenitySummaryKeys,
  sortAmenitiesForDisplay,
} from '../../../lib/amenityPresentation'
import type { GuestSiteAvailability, GuestSiteConfig, GuestSiteProperty, GuestSiteStayService } from '../../../lib/guestSite'
import HomeHeader from '../../home/HomeHeader'
import { SITE_NAV_ITEMS } from '../../home/siteNavigation'
import styles from './propertyDetail.module.css'

type DialogName = 'dates' | 'photos' | 'rules' | 'cancellation' | null
type DateField = 'checkin' | 'checkout'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const PROPERTY_TYPE_ENGLISH: Record<string, string> = {
  一房一卫: 'One-bedroom, one-bathroom apartment',
  两房一卫: 'Two-bedroom, one-bathroom apartment',
}

const PUBLIC_TEXT_ENGLISH: Record<string, string> = {
  整套房源: 'Entire apartment',
  自行入住: 'Self check-in',
  自助入住: 'Self check-in',
  免费停车: 'Free parking',
  游泳池: 'Swimming pool',
  健身房: 'Gym',
  桑拿房: 'Sauna',
  禁止带宠物: 'No pets',
  禁止吸烟: 'No smoking',
  支持长住咨询: 'Long-stay enquiries welcome',
}

const LEGACY_STAY_SERVICES: GuestSiteStayService[] = [
  {
    key: 'early_checkin', enabled: true, title: 'Early check-in', headline: 'No fee · Advance request',
    description: 'Ask in advance. We will do our best to arrange an earlier arrival, but it is not guaranteed.',
    fee_amount: 0, fee_currency: 'AUD', until_time: '', requires_advance_request: true,
    manual_confirmation: true, guaranteed: false, grants_room_access: false, payment_timing: '',
  },
  {
    key: 'late_checkout', enabled: true, title: 'Late check-out', headline: 'Until 11:30AM · A$20',
    description: 'Ask in advance. Approval is manual and depends on availability.',
    fee_amount: 20, fee_currency: 'AUD', until_time: '11:30AM', requires_advance_request: true,
    manual_confirmation: true, guaranteed: false, grants_room_access: false, payment_timing: '',
  },
  {
    key: 'baggage_dropoff', enabled: true, title: 'Luggage drop-off', headline: 'Advance confirmation required',
    description: 'Ask the property team before arrival. Confirmed luggage drop-off does not mean the property is ready for check-in.',
    fee_amount: null, fee_currency: 'AUD', until_time: '', requires_advance_request: true,
    manual_confirmation: true, guaranteed: false, grants_room_access: false, payment_timing: '',
  },
]

const STAY_SERVICE_QUESTIONS: Record<GuestSiteStayService['key'], string> = {
  early_checkin: 'Can I check in early?',
  late_checkout: 'Can I check out late?',
  baggage_dropoff: 'Can I drop off my luggage before check-in?',
}

function containsHan(value: string) {
  return /[\u3400-\u9fff]/.test(value)
}

function publicStayServices(value: GuestSiteProperty['stay_services']) {
  const source = Array.isArray(value) ? value : LEGACY_STAY_SERVICES
  const seen = new Set<string>()
  return source.flatMap((service) => {
    if (!service?.enabled || seen.has(service.key)) return []
    const title = String(service.title || '').trim()
    const headline = String(service.headline || '').trim()
    const description = String(service.description || '').trim()
    if (!title || !headline || !description || [title, headline, description].some(containsHan)) return []
    seen.add(service.key)
    return [{ ...service, title, headline, description }]
  })
}

function propertyTypeInEnglish(value: string, bedrooms: number, bathrooms: number) {
  const clean = String(value || '').trim()
  if (PROPERTY_TYPE_ENGLISH[clean]) return PROPERTY_TYPE_ENGLISH[clean]
  if (!containsHan(clean)) return clean || 'Property overview'
  if (bedrooms > 0) {
    const bedroomLabel = bedrooms === 1 ? 'One-bedroom' : `${bedrooms}-bedroom`
    const bathroomLabel = bathrooms > 0 ? `, ${bathrooms === 1 ? 'one-bathroom' : `${bathrooms}-bathroom`}` : ''
    return `${bedroomLabel}${bathroomLabel} apartment`
  }
  return 'Apartment — English property type pending'
}

function publicListInEnglish(items: string[], pendingLabel: string) {
  let pending = 0
  const translated = items.flatMap((item) => {
    const clean = String(item || '').trim()
    if (!clean) return []
    const mapped = PUBLIC_TEXT_ENGLISH[clean]
    if (mapped) return [mapped]
    if (!containsHan(clean)) return [clean]
    pending += 1
    return []
  })
  if (pending) translated.push(`${pendingLabel} pending English publication; please confirm with the property team.`)
  return translated
}

function shortDescriptionInEnglish(value: string, typeLabel: string) {
  let clean = String(value || '').trim()
  for (const [source, translated] of Object.entries(PROPERTY_TYPE_ENGLISH)) clean = clean.replaceAll(source, translated)
  return containsHan(clean) ? '' : clean || typeLabel
}

function formatListingTime(value: string) {
  const clean = String(value || '').trim().toUpperCase()
  const twelveHour = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/.exec(clean)
  let hour24: number
  let minute: number
  if (twelveHour) {
    const hour12 = Number(twelveHour[1])
    minute = Number(twelveHour[2] || 0)
    if (hour12 < 1 || hour12 > 12 || minute > 59) return ''
    hour24 = hour12 % 12 + (twelveHour[3] === 'PM' ? 12 : 0)
  } else {
    const twentyFourHour = /^(\d{1,2}):(\d{2})$/.exec(clean)
    if (!twentyFourHour) return ''
    hour24 = Number(twentyFourHour[1])
    minute = Number(twentyFourHour[2])
    if (hour24 > 23 || minute > 59) return ''
  }
  const period = hour24 >= 12 ? 'PM' : 'AM'
  const hour12 = hour24 % 12 || 12
  return minute ? `${hour12}:${String(minute).padStart(2, '0')}${period}` : `${hour12}${period}`
}

function toIsoDate(date: Date) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function addMonths(date: Date, amount: number) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1)
}

function sameDay(a: Date | null, b: Date | null) {
  return !!a && !!b && toIsoDate(a) === toIsoDate(b)
}

function buildMonthDays(month: Date) {
  const first = startOfMonth(month)
  const start = new Date(first)
  start.setDate(1 - first.getDay())
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start)
    day.setDate(start.getDate() + index)
    return day
  })
}

function formatMonthTitle(date: Date) {
  return new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric' }).format(date)
}

function formatDateDisplay(value: string) {
  const date = parseIsoDate(value)
  return date ? new Intl.DateTimeFormat('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }).format(date) : 'Add date'
}

function compactText(value: string, max = 220) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const slice = clean.slice(0, max)
  return `${slice.slice(0, Math.max(slice.lastIndexOf(' '), max - 24)).trim()}…`
}

function compactDescriptionPreview(value: string, max = 220) {
  const paragraphs = String(value || '').split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean)
  return compactText(paragraphs.slice(0, 2).join(' '), max)
}

type MapPoint = { latitude: number; longitude: number }

const MAP_TILE_SIZE = 256
const MAP_DEFAULT_ZOOM = 13
const MAP_MIN_ZOOM = 11
const MAP_MAX_ZOOM = 15
const MAP_AREA_RADIUS_METRES = 500

function approximateMapCentre(region: string): MapPoint {
  const label = region.toLowerCase()
  const [latitude, longitude] = label.includes('docklands')
    ? [-37.817, 144.946]
    : label.includes('southbank')
      ? [-37.824, 144.965]
      : label.includes('st kilda')
        ? [-37.867, 144.98]
        : label.includes('cbd')
        ? [-37.813, 144.963]
        : [-37.814, 144.963]
  return { latitude, longitude }
}

function projectMapPoint(point: MapPoint, zoom: number) {
  const scale = MAP_TILE_SIZE * 2 ** zoom
  const latitude = Math.min(Math.max(point.latitude, -85.05112878), 85.05112878)
  const latitudeRadians = latitude * Math.PI / 180
  return {
    x: (point.longitude + 180) / 360 * scale,
    y: (1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * scale,
  }
}

function unprojectMapPoint(x: number, y: number, zoom: number): MapPoint {
  const scale = MAP_TILE_SIZE * 2 ** zoom
  const mercator = Math.PI - 2 * Math.PI * y / scale
  return {
    latitude: 180 / Math.PI * Math.atan(Math.sinh(mercator)),
    longitude: x / scale * 360 - 180,
  }
}

function ApproximateAreaMap({ region }: { region: string }) {
  const publicCentre = useMemo(() => approximateMapCentre(region), [region])
  const [centre, setCentre] = useState(publicCentre)
  const [zoom, setZoom] = useState(MAP_DEFAULT_ZOOM)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const mapRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ pointerId: number; x: number; y: number; centreX: number; centreY: number } | null>(null)

  useEffect(() => {
    setCentre(publicCentre)
    setZoom(MAP_DEFAULT_ZOOM)
  }, [publicCentre])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const update = () => setSize({ width: map.clientWidth, height: map.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(map)
    return () => observer.disconnect()
  }, [])

  const tiles = useMemo(() => {
    if (!size.width || !size.height) return []
    const centrePixels = projectMapPoint(centre, zoom)
    const left = centrePixels.x - size.width / 2
    const top = centrePixels.y - size.height / 2
    const firstX = Math.floor(left / MAP_TILE_SIZE) - 1
    const lastX = Math.floor((left + size.width) / MAP_TILE_SIZE) + 1
    const firstY = Math.max(0, Math.floor(top / MAP_TILE_SIZE) - 1)
    const lastY = Math.min(2 ** zoom - 1, Math.floor((top + size.height) / MAP_TILE_SIZE) + 1)
    const row = []
    const worldTiles = 2 ** zoom
    for (let tileY = firstY; tileY <= lastY; tileY += 1) {
      for (let tileX = firstX; tileX <= lastX; tileX += 1) {
        const wrappedX = ((tileX % worldTiles) + worldTiles) % worldTiles
        row.push({
          key: `${zoom}-${tileX}-${tileY}`,
          url: `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${tileY}.png`,
          left: tileX * MAP_TILE_SIZE - left,
          top: tileY * MAP_TILE_SIZE - top,
        })
      }
    }
    return row
  }, [centre, size.height, size.width, zoom])

  const publicCentrePixels = projectMapPoint(publicCentre, zoom)
  const viewCentrePixels = projectMapPoint(centre, zoom)
  const circleLeft = size.width / 2 + publicCentrePixels.x - viewCentrePixels.x
  const circleTop = size.height / 2 + publicCentrePixels.y - viewCentrePixels.y
  const metresPerPixel = Math.cos(publicCentre.latitude * Math.PI / 180) * 2 * Math.PI * 6378137 / (MAP_TILE_SIZE * 2 ** zoom)
  const circleDiameter = MAP_AREA_RADIUS_METRES * 2 / metresPerPixel

  function panBy(deltaX: number, deltaY: number) {
    const current = projectMapPoint(centre, zoom)
    setCentre(unprojectMapPoint(current.x + deltaX, current.y + deltaY, zoom))
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    const projected = projectMapPoint(centre, zoom)
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, centreX: projected.x, centreY: projected.y }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.dataset.dragging = 'true'
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    setCentre(unprojectMapPoint(drag.centreX - (event.clientX - drag.x), drag.centreY - (event.clientY - drag.y), zoom))
  }

  function finishPointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    delete event.currentTarget.dataset.dragging
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function handleMapKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const actions: Record<string, () => void> = {
      ArrowLeft: () => panBy(-80, 0),
      ArrowRight: () => panBy(80, 0),
      ArrowUp: () => panBy(0, -80),
      ArrowDown: () => panBy(0, 80),
      '+': () => setZoom((current) => Math.min(current + 1, MAP_MAX_ZOOM)),
      '=': () => setZoom((current) => Math.min(current + 1, MAP_MAX_ZOOM)),
      '-': () => setZoom((current) => Math.max(current - 1, MAP_MIN_ZOOM)),
      Home: () => { setCentre(publicCentre); setZoom(MAP_DEFAULT_ZOOM) },
    }
    const action = actions[event.key]
    if (!action) return
    event.preventDefault()
    action()
  }

  return (
    <div
      ref={mapRef}
      className={styles.mapWrap}
      data-interactive-map
      data-zoom={zoom}
      role="region"
      tabIndex={0}
      aria-label={`Interactive approximate area map of ${region}`}
      aria-describedby="approximate-map-instructions"
      onKeyDown={handleMapKey}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
    >
      <div className={styles.mapTiles} aria-hidden="true">{tiles.map((tile) => <img src={tile.url} alt="" draggable="false" loading="lazy" key={tile.key} style={{ left: tile.left, top: tile.top }} />)}</div>
      {size.width ? <div className={styles.mapRadius} aria-hidden="true" style={{ left: circleLeft, top: circleTop, width: circleDiameter, height: circleDiameter }} /> : null}
      <div className={styles.mapControls} aria-label="Map controls">
        <button type="button" aria-label="Zoom in" disabled={zoom >= MAP_MAX_ZOOM} onClick={() => setZoom((current) => Math.min(current + 1, MAP_MAX_ZOOM))}>+</button>
        <button type="button" aria-label="Zoom out" disabled={zoom <= MAP_MIN_ZOOM} onClick={() => setZoom((current) => Math.max(current - 1, MAP_MIN_ZOOM))}>−</button>
        <button type="button" aria-label="Reset map" onClick={() => { setCentre(publicCentre); setZoom(MAP_DEFAULT_ZOOM) }}>↺</button>
      </div>
      <span className={styles.mapBadge}>Suburb-centre reference · 500 m</span>
      <span className={styles.srOnly} id="approximate-map-instructions">Use the arrow keys to pan, plus and minus to zoom, and Home to reset. The circle shows 500 metres around the public suburb centre. It is not the property location and does not claim the property is inside the circle.</span>
    </div>
  )
}

function Icon({ name }: { name: 'heart' | 'share' | 'users' | 'bedroom' | 'bed' | 'bath' | 'calendar' | 'map' | 'clock' | 'home' | 'document' | 'support' | 'close' | 'arrow' | 'menu' | 'check' }) {
  const paths: Record<typeof name, ReactNode> = {
    heart: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21.3l7.8-7.8 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" />,
    share: <><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><path d="M20 8v6m3-3h-6" /></>,
    bedroom: <><path d="M3 5v14M21 19V9a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v10M3 15h18" /><path d="M7 11h14" /></>,
    bed: <><path d="M2 18v-7h20v7M4 11V7h6a3 3 0 0 1 3 3v1M13 11V6h6a3 3 0 0 1 3 3v2" /><path d="M2 18h20M4 18v3m16-3v3" /></>,
    bath: <><path d="M4 12h16v2a7 7 0 0 1-7 7h-2a7 7 0 0 1-7-7v-2Z" /><path d="M7 12V5a3 3 0 0 1 6 0M4 16H2m20 0h-2" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></>,
    map: <><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z" /><path d="M9 3v15m6-12v15" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6l4 2" /></>,
    home: <><path d="m3 11 9-8 9 8" /><path d="M5 10v11h14V10M9 21v-7h6v7" /></>,
    document: <><path d="M6 2h8l4 4v16H6V2Z" /><path d="M14 2v5h5M9 12h6M9 16h6" /></>,
    support: <><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><path d="M4 14a2 2 0 0 0 2 2h1v-5H6a2 2 0 0 0-2 2v1Zm16 0a2 2 0 0 1-2 2h-1v-5h1a2 2 0 0 1 2 2v1ZM17 18c-1 2-3 3-5 3" /></>,
    close: <path d="M5 5l14 14M19 5 5 19" />,
    arrow: <><path d="M5 12h14" /><path d="m14 7 5 5-5 5" /></>,
    menu: <path d="M3 6h18M3 12h18M3 18h18" />,
    check: <path d="m5 12 4 4L19 6" />,
  }
  return <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function AmenityIcon({ name }: { name: string }) {
  const iconName = String(name || '').trim().toLowerCase()
  const paths: Record<string, ReactNode> = {
    kettle: <><path d="M7 8h8v9a3 3 0 0 1-3 3H9a2 2 0 0 1-2-2V8Z" /><path d="M9 5h4M8 8l-3 3M15 10h1a4 4 0 0 1 0 8h-1" /></>,
    toaster: <><path d="M4 10c0-3 2-5 5-5h6c3 0 5 2 5 5v9H4v-9Z" /><path d="M8 9h8M7 19v2m10-2v2m3-7h2" /></>,
    microwave: <><rect x="3" y="5" width="18" height="14" rx="2" /><rect x="6" y="8" width="10" height="8" rx="1" /><circle cx="18.5" cy="9" r=".7" /><circle cx="18.5" cy="13" r=".7" /></>,
    oven: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M4 8h16M8 5h.01M12 5h.01M16 5h.01" /><rect x="7" y="11" width="10" height="7" rx="1" /></>,
    dishwasher: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M5 8h14M8 5h.01M11 5h.01M8 16c1-3 7-3 8 0M8 18h8" /></>,
    coffee: <><path d="M5 9h11v5a5 5 0 0 1-5 5H9a4 4 0 0 1-4-4V9Z" /><path d="M16 11h2a3 3 0 0 1 0 6h-3M7 5c1 1 0 2 1 3m4-3c1 1 0 2 1 3" /></>,
    'coffee-pod': <><path d="M8 4h8l-1 15H9L8 4Z" /><path d="M7 4h10M9 16h6" /></>,
    pan: <><path d="M4 11h12v3a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5v-3Z" /><path d="M16 12h6M7 8h6" /></>,
    cutlery: <><path d="M7 3v7m-2-7v4a2 2 0 0 0 4 0V3M7 10v11" /><path d="M16 3v18M16 3c3 2 3 7 0 9" /></>,
    plate: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /></>,
    glass: <><path d="M7 3h10l-1 6a4 4 0 0 1-8 0L7 3Z" /><path d="M12 13v6m-4 2h8" /></>,
    utensils: <><path d="M6 3v7m-2-7v4a2 2 0 0 0 4 0V3M6 10v11" /><path d="M16 3c-3 2-3 7 0 9v9M16 3v9" /></>,
    knife: <><path d="M5 14 17 3c1 4 0 7-3 9l-4 3M5 14l5 5-2 2-5-5 2-2Z" /></>,
    'cutting-board': <><rect x="5" y="3" width="14" height="18" rx="2" /><circle cx="15.5" cy="6.5" r="1" /></>,
    'washing-machine': <><rect x="4" y="3" width="16" height="18" rx="2" /><circle cx="12" cy="13" r="5" /><path d="M7 6h.01M10 6h5" /></>,
    dryer: <><rect x="4" y="3" width="16" height="18" rx="2" /><circle cx="12" cy="13" r="5" /><path d="M8 14c2-3 6-3 8 0M7 6h.01M10 6h5" /></>,
    'washer-dryer': <><rect x="4" y="3" width="16" height="18" rx="2" /><circle cx="12" cy="13" r="5" /><path d="M8 12c1-2 3-3 4-1s3 1 4-1M7 6h.01M10 6h5" /></>,
    'drying-rack': <><path d="m5 21 3-15m11 15L16 6M7 11h10M6 16h12M8 6h8" /></>,
    detergent: <><path d="M9 4h6v3l2 2v11H7V9l2-2V4Z" /><path d="M9 4h6M10 13h4" /></>,
    bottle: <><path d="M9 3h6v4l2 3v10H7V10l2-3V3Z" /><path d="M9 12h8" /></>,
    'hair-dryer': <><path d="M4 7h10a4 4 0 0 1 0 8H4V7Z" /><path d="m8 15 2 6h4l-2-6M18 9l3-2v8l-3-2" /></>,
    towel: <><path d="M5 4h14v16H5V4Z" /><path d="M9 4v16M9 9h10" /></>,
    'toilet-paper': <><ellipse cx="9" cy="9" rx="5" ry="6" /><path d="M9 3h7c3 0 4 3 4 6v9h-8v-4M9 7v4" /></>,
    'bed-linen': <><path d="M3 18V9h18v9M5 9V6h6a3 3 0 0 1 3 3M3 15h18M5 18v3m14-3v3" /></>,
    blanket: <><path d="M5 4h14v16H8a3 3 0 0 1-3-3V4Z" /><path d="M8 4v16M12 4v16" /></>,
    curtain: <><path d="M4 4h16M6 4v17m12-17v17M6 6c4 2 4 11 0 13m12-13c-4 2-4 11 0 13" /></>,
    wifi: <><path d="M3 9a14 14 0 0 1 18 0M6 13a9 9 0 0 1 12 0M9 17a4 4 0 0 1 6 0" /><circle cx="12" cy="20" r="1" /></>,
    workspace: <><path d="M4 5h16v11H4V5ZM2 20h20M9 16v4m6-4v4" /></>,
    tv: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m9 2 3 3 3-3" /></>,
    snowflake: <><path d="M12 2v20M4 6l16 12M20 6 4 18" /><path d="m9 4 3 3 3-3M9 20l3-3 3 3" /></>,
    heating: <><path d="M7 21V9a5 5 0 0 1 10 0v12M7 15h10M4 12h3m10 0h3" /></>,
    fan: <><circle cx="12" cy="12" r="2" /><path d="M12 10c-1-5 2-7 5-6 2 2 1 6-3 8M14 12c5-1 7 2 6 5-2 2-6 1-8-3M12 14c1 5-2 7-5 6-2-2-1-6 3-8M10 12c-5 1-7-2-6-5 2-2 6-1 8 3" /></>,
    parking: <><circle cx="12" cy="12" r="9" /><path d="M10 17V7h3a3 3 0 0 1 0 6h-3" /></>,
    'parking-paid': <><circle cx="12" cy="12" r="9" /><path d="M10 17V7h3a3 3 0 0 1 0 6h-3M17 16h3m-1.5-1.5v3" /></>,
    pool: <><path d="M3 10c2 2 4 2 6 0s4-2 6 0 4 2 6 0M3 15c2 2 4 2 6 0s4-2 6 0 4 2 6 0M7 9V4h4m3 5V4h4" /></>,
    gym: <><path d="M3 9v6m3-8v10m12-10v10m3-8v6M6 12h12" /></>,
    sauna: <><path d="M5 20V9h14v11M8 9V5h8v4M9 14h6M9 17h6" /><path d="M8 3c1-1 2-1 3 0m2 0c1-1 2-1 3 0" /></>,
    elevator: <><rect x="5" y="3" width="14" height="18" rx="1" /><path d="M12 3v18M8 8l2-2 2 2m4 8-2 2-2-2" /></>,
    'baby-cot': <><path d="M4 12h16v7H4v-7Z" /><path d="M6 12V8a3 3 0 0 1 3-3h2v7M4 19v2m16-2v2M4 15h16" /><path d="M14 7h4a2 2 0 0 1 2 2v3" /></>,
    'high-chair': <><path d="M8 4h8v7H8V4Z" /><path d="M6 11h12M9 11 6 21m9-10 3 10M8 16h8M12 4V2" /></>,
    sparkles: <><path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z" /><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" /></>,
  }
  return <svg className={styles.amenityIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[iconName] || paths.sparkles}</svg>
}

function GuestStepper({ id, value, maximum, onChange }: { id: string; value: number; maximum: number; onChange: (value: number) => void }) {
  const count = Math.min(Math.max(Math.round(value) || 1, 1), maximum)
  return (
    <div className={styles.guestStepper} role="group" aria-labelledby={id} data-guest-stepper>
      <button type="button" aria-label="Decrease guests" disabled={count <= 1} onClick={() => onChange(count - 1)}><span aria-hidden="true">−</span></button>
      <output aria-live="polite" aria-atomic="true"><strong>{count}</strong><small>{count === 1 ? 'guest' : 'guests'}</small></output>
      <button type="button" aria-label="Increase guests" disabled={count >= maximum} onClick={() => onChange(count + 1)}><span aria-hidden="true">+</span></button>
    </div>
  )
}

export default function PropertyDetailClient({
  propertyId,
  initialProperty,
  initialConfig,
  previewMode = false,
}: {
  propertyId: string
  initialProperty: GuestSiteProperty | null
  initialConfig: GuestSiteConfig | null
  previewMode?: boolean
}) {
  const searchParams = useSearchParams()
  const listingBackParams = new URLSearchParams()
  for (const key of ['area', 'checkin', 'checkout', 'guests', 'bedrooms', 'type']) {
    const value = String(searchParams.get(key) || '').trim()
    if (value && value.length <= 120) listingBackParams.set(key, value)
  }
  const listingBackHref = `/properties${listingBackParams.size ? `?${listingBackParams.toString()}` : ''}`
  const initialGuests = Number(searchParams.get('guests'))
  const [saved, setSaved] = useState(false)
  const [shareMessage, setShareMessage] = useState('')
  const [descriptionExpanded, setDescriptionExpanded] = useState(false)
  const [amenitiesExpanded, setAmenitiesExpanded] = useState(false)
  const [dialog, setDialog] = useState<DialogName>(null)
  const [activeGallery, setActiveGallery] = useState(0)
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(new Date()))
  const [activeDateField, setActiveDateField] = useState<DateField>('checkin')
  const [availability, setAvailability] = useState<GuestSiteAvailability | null>(null)
  const [availabilityPending, setAvailabilityPending] = useState(false)
  const [form, setForm] = useState({
    checkin: parseIsoDate(searchParams.get('checkin') || '') ? searchParams.get('checkin') || '' : '',
    checkout: parseIsoDate(searchParams.get('checkout') || '') ? searchParams.get('checkout') || '' : '',
    guests: Number.isInteger(initialGuests) && initialGuests > 0 ? String(initialGuests) : '1',
  })
  const galleryScrollerRef = useRef<HTMLDivElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const scrollPositionRef = useRef(0)

  const property = initialProperty
  const gallery = useMemo(() => {
    const source = Array.isArray(property?.gallery_urls) ? property.gallery_urls : []
    const hero = property?.hero_image_url ? [property.hero_image_url] : []
    return [...new Set([...hero, ...source].map(resolveAssetUrl).filter(Boolean))]
  }, [property])
  const guestsCapacity = Math.max(1, Number(property?.public_capacity_override || property?.capacity || 1))
  const bedroomCount = Number(property?.bedroom_count || 0)
  const bathroomCount = Number(property?.bathroom_count || 0)
  const bedCount = Number(property?.bed_count || 0)
  const checkinDate = parseIsoDate(form.checkin)
  const checkoutDate = parseIsoDate(form.checkout)
  const months = [visibleMonth, addMonths(visibleMonth, 1)]
  const rawShortDescription = String(property?.short_description || '').trim()
  const rawFullDescription = String(property?.long_description || '').trim()
  const propertyTypeLabel = propertyTypeInEnglish(String(property?.type || ''), bedroomCount, bathroomCount)
  const featureTags = publicListInEnglish(Array.isArray(property?.feature_tags) ? property.feature_tags.filter(Boolean) : [], 'Additional property information is')
  const bookingHighlights = publicListInEnglish(Array.isArray(property?.booking_highlights) ? property.booking_highlights.filter(Boolean) : [], 'Additional booking information is')
  const overviewTags = featureTags
  const overviewTitle = featureTags.includes('Entire apartment') ? 'Entire apartment' : propertyTypeLabel
  const localizedShortDescription = shortDescriptionInEnglish(rawShortDescription, propertyTypeLabel)
  const fullDescription = containsHan(rawFullDescription) ? '' : rawFullDescription
  const descriptionSource = containsHan(rawShortDescription) && fullDescription
    ? fullDescription
    : localizedShortDescription || fullDescription || 'English property description pending; please contact the property team.'
  const descriptionSummary = compactDescriptionPreview(descriptionSource, 210)
  const hasMoreDescription = !!fullDescription && fullDescription !== descriptionSummary
  const legacyAmenities = publicListInEnglish(Array.isArray(property?.amenities) ? property.amenities.filter(Boolean) : [], 'Additional amenity information is')
  const amenityItems = sortAmenitiesForDisplay(Array.isArray(property?.amenity_items) && property.amenity_items.length
    ? property.amenity_items.filter((item) => item && item.key && item.label).map((item) => ({ ...item }))
    : legacyAmenities.map((label, index) => ({ key: `legacy-${index}`, category: 'Amenities', label, icon: label })))
  const amenityGroups = Array.from(new Set(amenityItems.map((item) => item.category))).map((category) => ({ category, items: amenityItems.filter((item) => item.category === category) }))
  const desktopAmenitySummaryKeys = amenitySummaryKeys(amenityItems, DESKTOP_AMENITY_SUMMARY_LIMIT)
  const mobileAmenitySummaryKeys = new Set(amenitySummaryKeys(amenityItems, MOBILE_AMENITY_SUMMARY_LIMIT))
  const amenitySummaryItems = desktopAmenitySummaryKeys.flatMap((key) => {
    const item = amenityItems.find((candidate) => candidate.key === key)
    return item ? [item] : []
  })
  const houseRules = publicListInEnglish(Array.isArray(property?.house_rules) ? property.house_rules.filter(Boolean) : [], 'Additional house-rule information is')
  const rawCancellationPolicy = String(property?.cancellation_policy || '').trim()
  const cancellationPolicy = containsHan(rawCancellationPolicy) ? '' : rawCancellationPolicy
  const cancellationSummary = cancellationPolicy
    ? compactText(cancellationPolicy, 180)
    : 'Cancellation terms vary by stay. Ask the property team for the terms that would apply before making a decision.'
  const locationLabel = String(property?.public_region_label || 'Location not configured').trim()
  const mapRegion = String(property?.public_region_label || 'Melbourne, Victoria').trim()
  const checkinTime = formatListingTime(String(property?.checkin_time || '')) || '3PM'
  const checkoutTime = formatListingTime(String(property?.checkout_time || '')) || '10AM'
  const stayServices = publicStayServices(property?.stay_services)
  const contactEmail = String(initialConfig?.contact_email || 'info@mzproperty.com.au').trim()
  const contactPhone = String(initialConfig?.contact_phone || '+61 434 782 499').trim()
  const contactAddress = String(initialConfig?.contact_address || '130 Gladstone St, South Melbourne, VIC 3205').trim()

  useEffect(() => {
    const selected = Number(form.guests)
    if (!Number.isInteger(selected) || selected < 1 || selected > guestsCapacity) setForm((current) => ({ ...current, guests: String(Math.min(Math.max(selected || 1, 1), guestsCapacity)) }))
  }, [form.guests, guestsCapacity])

  useEffect(() => {
    if (previewMode) { setAvailability(null); setAvailabilityPending(false); return }
    if (!form.checkin || !form.checkout) { setAvailability(null); setAvailabilityPending(false); return }
    let active = true
    setAvailabilityPending(true)
    const params = new URLSearchParams({ checkin: form.checkin, checkout: form.checkout })
    fetch(`/property-detail-data/${encodeURIComponent(propertyId)}?${params.toString()}`, { method: 'GET', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<GuestSiteAvailability>
      })
      .then((value) => { if (active) setAvailability(value) })
      .catch(() => { if (active) setAvailability(null) })
      .finally(() => { if (active) setAvailabilityPending(false) })
    return () => { active = false }
  }, [form.checkin, form.checkout, previewMode, propertyId])

  useEffect(() => {
    if (!dialog) return
    scrollPositionRef.current = window.scrollY
    const body = document.body
    const previous = { position: body.style.position, top: body.style.top, width: body.style.width, overflow: body.style.overflow }
    body.style.position = 'fixed'; body.style.top = `-${scrollPositionRef.current}px`; body.style.width = '100%'; body.style.overflow = 'hidden'
    const focusables = () => [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], select:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])]
    window.requestAnimationFrame(() => focusables()[0]?.focus())
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setDialog(null)
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => returnFocusRef.current?.focus()))
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (items.length < 2) return
      const first = items[0]; const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      body.style.position = previous.position; body.style.top = previous.top; body.style.width = previous.width; body.style.overflow = previous.overflow
      const root = document.documentElement
      const previousScrollBehavior = root.style.scrollBehavior
      root.style.scrollBehavior = 'auto'
      window.scrollTo(0, scrollPositionRef.current)
      window.requestAnimationFrame(() => { root.style.scrollBehavior = previousScrollBehavior })
    }
  }, [dialog])

  function openDialog(name: Exclude<DialogName, null>, trigger?: HTMLElement | null, field?: DateField) {
    returnFocusRef.current = trigger || document.activeElement as HTMLElement | null
    if (field) setActiveDateField(field)
    setDialog(name)
  }
  function closeDialog() { setDialog(null); window.requestAnimationFrame(() => window.requestAnimationFrame(() => returnFocusRef.current?.focus())) }
  function handleDatePick(date: Date) {
    if (startOfDay(date) < startOfDay(new Date())) return
    const picked = toIsoDate(date)
    setForm((current) => activeDateField === 'checkin'
      ? { ...current, checkin: picked, checkout: current.checkout && current.checkout <= picked ? '' : current.checkout }
      : !current.checkin || picked <= current.checkin ? { ...current, checkin: picked, checkout: '' } : { ...current, checkout: picked })
    setActiveDateField((current) => current === 'checkin' ? 'checkout' : 'checkin')
  }
  function clearDates() { setForm((current) => ({ ...current, checkin: '', checkout: '' })); setActiveDateField('checkin') }
  function setGuests(nextGuests: number) { setForm((current) => ({ ...current, guests: String(Math.min(Math.max(nextGuests, 1), guestsCapacity)) })) }
  function isInRange(day: Date) { return !!checkinDate && !!checkoutDate && day > checkinDate && day < checkoutDate }
  function moveGallery(direction: number) {
    const scroller = galleryScrollerRef.current
    if (!scroller) return
    const renderedIndex = scroller.clientWidth ? Math.round(scroller.scrollLeft / scroller.clientWidth) : activeGallery
    const next = Math.min(Math.max(renderedIndex + direction, 0), Math.max(gallery.length - 1, 0))
    scroller.scrollTo({ left: next * scroller.clientWidth, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    setActiveGallery(next)
  }
  function handleGalleryKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowRight') { event.preventDefault(); moveGallery(1) }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); moveGallery(-1) }
  }
  async function shareProperty() {
    const data = { title: property?.hero_title || 'MZ Property', url: window.location.href }
    try {
      if (navigator.share) await navigator.share(data)
      else if (navigator.clipboard) { await navigator.clipboard.writeText(data.url); setShareMessage('Link copied') }
      else setShareMessage('Use your browser address bar to copy this link')
    } catch (error) { if ((error as Error)?.name !== 'AbortError') setShareMessage('Sharing was not completed') }
    window.setTimeout(() => setShareMessage(''), 2400)
  }

  if (!property) return <div className={styles.page}><HomeHeader /><main className={styles.notFound}><p className={styles.eyebrow}>Property details</p><h1>This property is not available.</h1><p>No published property matches this link. Choose a property from the public list; no property has been selected automatically.</p><Link className={styles.primaryButton} href={listingBackHref}>View properties <Icon name="arrow" /></Link></main></div>

  return (
    <div className={styles.page} data-property-detail data-admin-draft-preview={previewMode ? 'true' : undefined}>
      <a className={styles.skipLink} href="#property-content">Skip to property details</a>
      <HomeHeader />
      <main id="property-content">
        <div className={styles.titleShell}>
          {previewMode ? <span className={styles.backLink}><span aria-hidden="true">←</span> Admin draft preview</span> : <Link className={styles.backLink} href={listingBackHref}><span aria-hidden="true">←</span> All Properties</Link>}
          <div className={styles.titleRow}><div><h1>{property.hero_title}</h1><p>{property.public_region_label || 'Melbourne'}</p></div>{previewMode ? <div className={styles.previewBadge}>Unpublished · admin only</div> : <div className={styles.titleActions}><button type="button" data-local-save aria-pressed={saved} onClick={() => setSaved((value) => !value)}><Icon name="heart" />{saved ? 'Saved locally' : 'Save'}</button><button type="button" onClick={shareProperty}><Icon name="share" />Share</button></div>}</div>
          <div className={styles.liveMessage} aria-live="polite">{shareMessage}</div>
        </div>

        <section className={styles.gallerySection} aria-label="Property photos">
          {gallery.length ? <><div ref={galleryScrollerRef} className={styles.galleryScroller} tabIndex={0} onKeyDown={handleGalleryKey} onScroll={(event) => { const width = event.currentTarget.clientWidth; if (width) setActiveGallery(Math.round(event.currentTarget.scrollLeft / width)) }}>{gallery.map((url, index) => <figure className={styles.mobileGallerySlide} key={`${url}-${index}`}><img src={url} alt={`${property.hero_title}, photo ${index + 1}`} /></figure>)}</div><div className={`${styles.desktopGallery} ${gallery.length < 2 ? styles.singlePhoto : ''}`}><button type="button" className={styles.galleryMain} onClick={(event) => openDialog('photos', event.currentTarget)} aria-label="View all property photos"><img src={gallery[0]} alt={`${property.hero_title}, main view`} /></button>{gallery.length > 1 ? <div className={styles.gallerySide}>{gallery.slice(1, 3).map((url, index) => <button type="button" key={`${url}-side`} onClick={(event) => openDialog('photos', event.currentTarget)}><img src={url} alt={`${property.hero_title}, view ${index + 2}`} /></button>)}</div> : null}</div><div className={styles.galleryCaption}><span>{gallery.length} {gallery.length === 1 ? 'photo' : 'photos'}</span><button type="button" onClick={(event) => openDialog('photos', event.currentTarget)}>{activeGallery + 1} / {gallery.length} <span aria-hidden="true">·</span> View photos <Icon name="arrow" /></button></div></> : <div className={styles.photoEmpty}>Property photography has not been configured.</div>}
        </section>

        <nav className={styles.sectionNav} aria-label="Property sections"><a href="#overview">Overview</a><a href="#amenities">Amenities</a><a href="#location">Location</a><a href="#before-arrival">Before you arrive</a></nav>
        <div className={styles.contentShell}>
          <div className={styles.mainColumn}>
            <section className={styles.overviewSection} id="overview" aria-labelledby="overview-title"><h2 id="overview-title">{overviewTitle}</h2><dl className={styles.metaGrid}><div><dt><Icon name="users" /></dt><dd>{guestsCapacity} {guestsCapacity === 1 ? 'guest' : 'guests'}</dd></div>{bedroomCount > 0 ? <div><dt><Icon name="bedroom" /></dt><dd>{bedroomCount} {bedroomCount === 1 ? 'bedroom' : 'bedrooms'}</dd></div> : null}{bedCount > 0 ? <div><dt><Icon name="bed" /></dt><dd>{bedCount} {bedCount === 1 ? 'bed' : 'beds'}</dd></div> : null}{bathroomCount > 0 ? <div><dt><Icon name="bath" /></dt><dd>{bathroomCount} {bathroomCount === 1 ? 'bathroom' : 'bathrooms'}</dd></div> : null}</dl>{overviewTags.length ? <p className={styles.detailNote}>{overviewTags.join(' · ')}</p> : null}</section>
            <section className={styles.contentSection} aria-labelledby="space-title"><h2 id="space-title">Space to settle in</h2><p>{descriptionSummary}</p>{hasMoreDescription ? <div className={`${styles.fullDescription} ${descriptionExpanded ? styles.expanded : ''}`}><p>{fullDescription}</p></div> : null}{hasMoreDescription ? <button className={styles.textButton} type="button" aria-expanded={descriptionExpanded} onClick={() => setDescriptionExpanded((value) => !value)}>{descriptionExpanded ? 'Show less' : 'Read more'} <Icon name="arrow" /></button> : null}</section>
            <section className={styles.contentSection} id="amenities" aria-labelledby="amenities-title">
              <h2 id="amenities-title">What this place offers</h2>
              {amenityItems.length ? (
                amenitiesExpanded ? (
                  <div className={styles.amenityGroups} data-amenity-expanded>
                    {amenityGroups.map((group) => (
                      <section className={styles.amenityGroup} key={group.category} aria-label={group.category}>
                        <h3>{group.category}</h3>
                        <div className={styles.amenityGrid}>
                          {group.items.map((item) => <div className={styles.amenity} data-amenity-item={item.key} key={item.key}><span aria-hidden="true"><AmenityIcon name={item.icon || item.label} /></span><span>{item.label}</span></div>)}
                        </div>
                      </section>
                    ))}
                  </div>
                ) : (
                  <div className={styles.amenitySummaryGrid} data-amenity-summary>
                    {amenitySummaryItems.map((item) => <div className={`${styles.amenity} ${styles.amenitySummaryItem} ${mobileAmenitySummaryKeys.has(item.key) ? '' : styles.amenitySummaryMobileHidden}`} data-amenity-item={item.key} key={item.key}><span aria-hidden="true"><AmenityIcon name={item.icon || item.label} /></span><span>{item.label}</span></div>)}
                  </div>
                )
              ) : <p className={styles.muted}>No amenities have been confirmed as provided for this public listing.</p>}
              {amenityItems.length > MOBILE_AMENITY_SUMMARY_LIMIT ? <button className={styles.outlineButton} type="button" aria-expanded={amenitiesExpanded} onClick={() => setAmenitiesExpanded((value) => !value)}>{amenitiesExpanded ? 'Show fewer amenities' : 'View all amenities'} <Icon name="arrow" /></button> : null}
            </section>
            <section className={styles.contentSection} aria-labelledby="reviews-title"><div className={styles.reviewsHeading}><h2 id="reviews-title">Guest reviews</h2><span>Not available yet</span></div><div className={styles.reviewEmpty}><span aria-hidden="true">☆</span><div><strong>Property reviews will appear here</strong><p>No property-specific review data is connected to this public listing.</p></div></div></section>
          </div>
          <aside className={styles.bookingAside} aria-label="Plan your stay">
            <div className={styles.bookingCard}>
              <h2>Plan your stay</h2>
              <p>Select dates to prepare an enquiry</p>
              <div className={styles.dateFields}><button type="button" onClick={(event) => openDialog('dates', event.currentTarget, 'checkin')}><span>Check-in</span><strong>{formatDateDisplay(form.checkin)}</strong><Icon name="calendar" /></button><button type="button" onClick={(event) => openDialog('dates', event.currentTarget, 'checkout')}><span>Check-out</span><strong>{formatDateDisplay(form.checkout)}</strong><Icon name="calendar" /></button></div>
              <div className={styles.guestField}><span id="sidebar-guests-label">Guests</span><GuestStepper id="sidebar-guests-label" value={Number(form.guests)} maximum={guestsCapacity} onChange={setGuests} /></div>
              <button className={styles.primaryButton} data-date-dialog-trigger type="button" onClick={(event) => openDialog('dates', event.currentTarget)}>{form.checkin && form.checkout ? 'Review dates' : 'Select dates'} <Icon name="arrow" /></button>
              <p className={styles.bookingDisclaimer}>Selecting dates does not create a booking. Availability and all requests need confirmation from the property team.</p>
              <div className={styles.priceRows}><div><span>Live PMS price</span><strong>Not connected</strong></div><div><span>Fees</span><strong>—</strong></div><div className={styles.priceTotal}><span>Total</span><strong>—</strong></div></div>
              <p className={styles.priceStatus}>Pricing is confirmed by the property team; no static label is presented as a live rate.</p>
              {bookingHighlights.length ? <div className={styles.bookingNotes}><h3>Booking notes</h3><ul>{bookingHighlights.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
              <a className={styles.helpLink} href="/#contact"><Icon name="support" /><span><small>Need help?</small>Contact our team</span><Icon name="arrow" /></a>
            </div>
          </aside>
        </div>

        <section className={styles.locationSection} id="location" aria-labelledby="location-title"><div className={styles.wideShell}><h2 id="location-title">The neighbourhood</h2><p className={styles.locationName}>{locationLabel}</p><ApproximateAreaMap region={mapRegion} /><p className={styles.mapNote}>This is a 500 m reference area around the public suburb centre. It is not the property location and does not claim the property is inside the circle. No exact address or property coordinates are used. <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a></p></div></section>

        <section className={styles.arrivalSection} id="before-arrival" aria-labelledby="arrival-title">
          <div className={styles.wideShell}>
            <div className={styles.arrivalHeader}><p className={styles.eyebrow}>Stay essentials</p><h2 id="arrival-title">Before you arrive</h2><p>Standard arrival times, optional requests and the key information to review before your stay.</p></div>
            <div className={styles.arrivalTimes} aria-label="Standard check-in and check-out times"><div><span>Check-in</span><strong>{checkinTime}</strong></div><div><span>Check-out</span><strong>{checkoutTime}</strong></div></div>
            <div className={styles.arrivalRequests} id="stay-requests" aria-labelledby="stay-requests-title">
              <div className={styles.arrivalRequestHeading}><h3 id="stay-requests-title">Frequently asked questions</h3><p>{stayServices.length ? 'Ask in advance. Each request is confirmed manually and depends on availability.' : 'Optional stay-request information has not been published for this property.'}</p></div>
              {stayServices.length ? <div className={styles.arrivalRequestGrid}>
                {stayServices.map((service) => <article key={service.key}><span>Q&amp;A</span><h4>{STAY_SERVICE_QUESTIONS[service.key] || service.title}</h4><strong>{service.headline}</strong><p>{service.description}</p><a href="/#contact">Ask the property team <Icon name="arrow" /></a></article>)}
              </div> : <p className={styles.arrivalServiceEmpty}>Please ask the property team which optional requests are available before making plans.</p>}
            </div>
            {bookingHighlights.length ? <div className={styles.mobileBookingNotes}><strong>Property booking notes</strong><ul>{bookingHighlights.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
            <div className={styles.arrivalDetails}>
              <article className={styles.arrivalRow} id="house-rules"><Icon name="home" /><div><h3>House rules</h3>{houseRules.length ? <ul>{houseRules.slice(0, 2).map((rule) => <li key={rule}>{rule}</li>)}</ul> : <p>Please ask the property team if you need property-specific guidance before arrival.</p>}<button className={styles.textButton} type="button" onClick={(event) => openDialog('rules', event.currentTarget)}>Read all house rules <Icon name="arrow" /></button></div></article>
              <article className={styles.arrivalRow}><Icon name="document" /><div><h3>Cancellation policy</h3><p>{cancellationSummary}</p><button className={styles.textButton} type="button" onClick={(event) => openDialog('cancellation', event.currentTarget)}>View cancellation information <Icon name="arrow" /></button></div></article>
            </div>
            <div className={styles.contactStrip}><Icon name="support" /><div><strong>A little help with your stay?</strong><span>Our team can help with questions about this listing.</span></div><a href="/#contact">Contact us <Icon name="arrow" /></a></div>
          </div>
        </section>
      </main>

      <footer className={styles.footer}><div className={styles.footerGrid}><Link className={styles.footerBrand} href="/"><img src="/homepage/brand-source.png" alt="MZ Property" /></Link><div><h2>Menu</h2>{SITE_NAV_ITEMS.map(([href, label]) => <a key={href} href={href}>{label}</a>)}</div><div><h2>Contact</h2><a href={`mailto:${contactEmail}`}>{contactEmail}</a><a href={`tel:${contactPhone.replace(/[^+\d]/g, '')}`}>{contactPhone}</a><address>{contactAddress}</address></div><div><h2>Legal</h2><span>Terms &amp; Conditions — coming soon</span><span>Privacy Policy — coming soon</span></div></div><div className={styles.footerBottom}>© 2026 MZ Property Pty Ltd <span>Property detail preview</span></div></footer>
      <div className={styles.mobileStayBar} data-mobile-stay-bar><button type="button" onClick={(event) => openDialog('dates', event.currentTarget)}><span>{form.checkin && form.checkout ? `${formatDateDisplay(form.checkin)} – ${formatDateDisplay(form.checkout)}` : 'Choose dates'}</span><small>Price confirmed by the team</small></button><button className={styles.primaryButton} data-date-dialog-trigger type="button" onClick={(event) => openDialog('dates', event.currentTarget)}>Select dates <Icon name="arrow" /></button></div>

      {dialog ? <div className={styles.dialogOverlay} onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog() }}><div ref={dialogRef} className={`${styles.dialog} ${dialog === 'dates' ? styles.dateDialog : ''} ${dialog === 'photos' ? styles.photoDialog : ''}`} role="dialog" aria-modal="true" aria-labelledby="property-dialog-title"><button className={styles.dialogClose} type="button" onClick={closeDialog}>Close <Icon name="close" /></button>
        {dialog === 'dates' ? <><p className={styles.eyebrow}>Plan your stay</p><h2 id="property-dialog-title">Choose dates &amp; guests</h2><div className={styles.dialogDateFields}><button className={activeDateField === 'checkin' ? styles.active : ''} type="button" onClick={() => setActiveDateField('checkin')}><span>Check-in</span><strong>{formatDateDisplay(form.checkin)}</strong></button><button className={activeDateField === 'checkout' ? styles.active : ''} type="button" onClick={() => setActiveDateField('checkout')}><span>Check-out</span><strong>{formatDateDisplay(form.checkout)}</strong></button><div className={`${styles.guestField} ${styles.dialogGuestField}`}><span id="dialog-guests-label">Guests</span><GuestStepper id="dialog-guests-label" value={Number(form.guests)} maximum={guestsCapacity} onChange={setGuests} /></div></div><div className={styles.calendarHeader}><button type="button" onClick={() => setVisibleMonth((current) => addMonths(current, -1))} aria-label="Previous month">←</button><button type="button" onClick={() => setVisibleMonth((current) => addMonths(current, 1))} aria-label="Next month">→</button></div><div className={styles.calendarMonths}>{months.map((month) => <div className={styles.calendarMonth} key={toIsoDate(month)}><h3>{formatMonthTitle(month)}</h3><div className={styles.weekdays}>{WEEKDAYS.map((day) => <span key={day}>{day}</span>)}</div><div className={styles.days}>{buildMonthDays(month).map((day) => { const outside = day.getMonth() !== month.getMonth(); const past = startOfDay(day) < startOfDay(new Date()); const selected = sameDay(day, checkinDate) || sameDay(day, checkoutDate); return <button key={toIsoDate(day)} type="button" data-date={toIsoDate(day)} disabled={past} className={`${outside ? styles.outside : ''} ${selected ? styles.selected : ''} ${isInRange(day) ? styles.inRange : ''}`} onClick={() => handleDatePick(day)} aria-label={new Intl.DateTimeFormat('en-AU', { dateStyle: 'full' }).format(day)}>{day.getDate()}</button> })}</div></div>)}</div><div className={styles.availabilityMessage} aria-live="polite">{previewMode ? 'Admin draft preview: availability is not requested.' : availabilityPending ? 'Checking the public availability feed…' : availability?.available === false ? 'These dates overlap a blocked range.' : availability?.available === true ? 'No known conflict was returned. The property team must still confirm availability and price.' : form.checkin && form.checkout ? 'Availability could not be confirmed.' : 'Choose check-in and check-out dates. Selecting dates does not make a reservation.'}</div><div className={styles.dialogFooter}><button className={styles.textButton} type="button" onClick={clearDates}>Clear dates</button><button className={styles.primaryButton} type="button" onClick={closeDialog}>Done <Icon name="check" /></button></div></> : null}
        {dialog === 'photos' ? <><p className={styles.eyebrow}>Property gallery</p><h2 id="property-dialog-title">{property.hero_title}</h2><div className={styles.photoDialogGrid}>{gallery.map((url, index) => <img key={`${url}-modal`} src={url} alt={`${property.hero_title}, photo ${index + 1}`} />)}</div></> : null}
        {dialog === 'rules' ? <><p className={styles.eyebrow}>Before you arrive</p><h2 id="property-dialog-title">House rules</h2><p className={styles.dialogIntro}>{houseRules.length ? 'Review the house rules supplied for this property before your stay.' : 'No property-specific house rules are shown here. Please ask the property team if you need guidance before arrival.'}</p><div className={styles.readingBody}>{houseRules.length ? houseRules.map((rule, index) => <section key={rule}><span>{String(index + 1).padStart(2, '0')}</span><div><h3>Property guidance</h3><p>{rule}</p></div></section>) : <section><span>—</span><div><h3>Need guidance?</h3><p>Please contact the property team if you need guidance before your stay.</p></div></section>}</div><div className={styles.readingFooter}><span>Before your stay</span><button className={styles.outlineButton} type="button" onClick={closeDialog}>Back to property</button></div></> : null}
        {dialog === 'cancellation' ? <><p className={styles.eyebrow}>Before you arrive</p><h2 id="property-dialog-title">Cancellation policy</h2><p className={styles.dialogIntro}>{cancellationPolicy ? 'Review the cancellation terms supplied for this property.' : 'Cancellation terms for this property are not shown here.'}</p><div className={styles.readingBody}><section><span>—</span><div><h3>{cancellationPolicy ? 'Cancellation terms' : 'Confirm before booking'}</h3><p>{cancellationPolicy || 'Please ask the property team for the cancellation and refund terms that would apply to your stay before making a decision.'}</p></div></section></div><div className={styles.readingFooter}><span>Before your stay</span><button className={styles.outlineButton} type="button" onClick={closeDialog}>Back to property</button></div></> : null}
      </div></div> : null}
    </div>
  )
}
