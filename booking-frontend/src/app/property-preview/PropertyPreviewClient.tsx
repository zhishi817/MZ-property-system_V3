"use client"

import { useEffect, useMemo, useState } from 'react'
import type { GuestSiteProperty, GuestSiteStayService } from '../../lib/guestSite'
import PropertyDetailClient from '../properties/[id]/PropertyDetailClient'
import styles from './propertyPreview.module.css'

type PreviewMessage = {
  type?: string
  nonce?: string
  property?: unknown
}

function allowedAdminOrigin() {
  const configured = process.env.NEXT_PUBLIC_ADMIN_FRONTEND_URL || 'http://localhost:3006'
  try { return new URL(configured).origin } catch { return '' }
}

const strings = (value: unknown) => Array.isArray(value)
  ? value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 100)
  : []

function finiteNumber(value: unknown, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const STAY_SERVICE_KEYS = new Set<GuestSiteStayService['key']>(['early_checkin', 'late_checkout', 'baggage_dropoff'])

function stayServices(value: unknown): GuestSiteStayService[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((item: any) => {
    const key = String(item?.key || '') as GuestSiteStayService['key']
    if (!STAY_SERVICE_KEYS.has(key)) return []
    const fee = item?.fee_amount == null || item?.fee_amount === '' ? null : finiteNumber(item.fee_amount, -1)
    return [{
      key,
      enabled: item?.enabled !== false,
      title: String(item?.title || '').trim(),
      headline: String(item?.headline || '').trim(),
      description: String(item?.description || '').trim(),
      fee_amount: fee != null && fee >= 0 ? fee : null,
      fee_currency: String(item?.fee_currency || 'AUD').trim().toUpperCase().slice(0, 8),
      until_time: String(item?.until_time || '').trim(),
      requires_advance_request: item?.requires_advance_request !== false,
      manual_confirmation: item?.manual_confirmation !== false,
      guaranteed: item?.guaranteed === true,
      grants_room_access: item?.grants_room_access === true,
      payment_timing: String(item?.payment_timing || '').trim(),
    }]
  }).slice(0, 3)
}

function sanitizedProperty(value: unknown): GuestSiteProperty | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, any>
  const id = String(raw.id || '').trim()
  const title = String(raw.hero_title || '').trim()
  if (!id || !title) return null
  const amenityItems = Array.isArray(raw.amenity_items) ? raw.amenity_items.flatMap((item: any) => {
    const key = String(item?.key || '').trim()
    const label = String(item?.label || '').trim()
    if (!key || !label) return []
    return [{ key, label, category: String(item?.category || 'Other').trim() || 'Other', icon: String(item?.icon || 'sparkles').trim() || 'sparkles' }]
  }).slice(0, 80) : []
  return {
    id,
    type: String(raw.type || ''),
    capacity: Math.max(0, finiteNumber(raw.capacity)),
    public_capacity_override: raw.public_capacity_override == null ? null : Math.max(0, finiteNumber(raw.public_capacity_override)),
    public_region_label: String(raw.public_region_label || '').trim(),
    hero_title: title,
    short_description: String(raw.short_description || '').trim(),
    long_description: String(raw.long_description || '').trim(),
    hero_image_url: String(raw.hero_image_url || '').trim(),
    gallery_urls: strings(raw.gallery_urls),
    feature_tags: strings(raw.feature_tags),
    amenities: amenityItems.map((item) => item.label),
    amenity_items: amenityItems,
    house_rules: strings(raw.house_rules),
    sort_order: finiteNumber(raw.sort_order),
    is_published: false,
    bedroom_count: raw.bedroom_count == null ? undefined : Math.max(0, finiteNumber(raw.bedroom_count)),
    bathroom_count: raw.bathroom_count == null ? undefined : Math.max(0, finiteNumber(raw.bathroom_count)),
    bed_count: raw.bed_count == null ? undefined : Math.max(0, finiteNumber(raw.bed_count)),
    checkin_time: String(raw.checkin_time || '').trim(),
    checkout_time: String(raw.checkout_time || '').trim(),
    cancellation_policy: String(raw.cancellation_policy || '').trim(),
    stay_services: stayServices(raw.stay_services),
    price_label: String(raw.price_label || '').trim(),
    booking_highlights: strings(raw.booking_highlights),
  }
}

export default function PropertyPreviewClient() {
  const [property, setProperty] = useState<GuestSiteProperty | null>(null)
  const [rejected, setRejected] = useState(false)
  const adminOrigin = useMemo(allowedAdminOrigin, [])

  useEffect(() => {
    const nonce = window.location.hash.replace(/^#/, '')
    if (!adminOrigin || !/^[a-zA-Z0-9-]{16,128}$/.test(nonce)) {
      setRejected(true)
      return
    }
    const receive = (event: MessageEvent<PreviewMessage>) => {
      if (event.origin !== adminOrigin || event.source !== window.parent) return
      if (event.data?.type !== 'mz-admin-property-preview' || event.data?.nonce !== nonce) return
      const next = sanitizedProperty(event.data.property)
      if (!next) { setRejected(true); return }
      setProperty(next)
      setRejected(false)
    }
    window.addEventListener('message', receive)
    window.parent.postMessage({ type: 'mz-property-preview-ready', nonce }, adminOrigin)
    return () => window.removeEventListener('message', receive)
  }, [adminOrigin])

  if (rejected) return <main className={styles.waiting}><h1>Preview unavailable</h1><p>Open this preview from the authenticated property editor.</p></main>
  if (!property) return <main className={styles.waiting}><h1>Waiting for draft preview</h1><p>No unpublished property content is stored or fetched by this route.</p></main>

  return (
    <div className={styles.previewShell} onClickCapture={(event) => {
      if (event.target instanceof Element && event.target.closest('a')) event.preventDefault()
    }}>
      <PropertyDetailClient propertyId={property.id} initialProperty={property} initialConfig={null} previewMode />
    </div>
  )
}
