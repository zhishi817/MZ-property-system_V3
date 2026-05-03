import { Router } from 'express'
import fs from 'fs'
import multer from 'multer'
import path from 'path'
import { z } from 'zod'
import { requirePerm } from '../auth'
import { hasPg, pgPool } from '../dbAdapter'
import { v4 as uuidv4 } from 'uuid'
import { createHash } from 'crypto'
import { hasR2, r2Upload } from '../r2'
import { resizeUploadImage } from '../lib/uploadImageResize'

type GuestSiteFaqItem = { question: string; answer: string }
type GuestSiteConfig = {
  banner_title: string
  banner_subtitle: string
  hero_background_urls: string[]
  primary_button_text: string
  primary_button_href: string
  secondary_button_text: string
  secondary_button_href: string
  brand_story: string
  contact_email: string
  contact_phone: string
  contact_whatsapp: string
  contact_address: string
  faq_items: GuestSiteFaqItem[]
}

type GuestSitePropertyDisplay = {
  property_id: string
  is_published: boolean
  hero_title: string
  short_description: string
  long_description: string
  hero_image_url: string
  gallery_urls: string[]
  feature_tags: string[]
  amenities: string[]
  house_rules: string[]
  sort_order: number
  public_region_label: string
  public_capacity_override: number | null
  bedroom_count: number | null
  bathroom_count: number | null
  bed_count: number | null
  checkin_time: string
  checkout_time: string
  location_note: string
  price_label: string
  booking_highlights: string[]
}

type GuestSiteInquiry = {
  id: string
  property_id: string
  property_code?: string | null
  property_address?: string | null
  guest_name: string
  guest_phone: string
  guest_email: string
  checkin: string
  checkout: string
  guest_count: number
  message: string
  status: 'new' | 'contacted' | 'converted' | 'closed'
  admin_note?: string | null
  created_at: string
  updated_at: string
}

type GuestSiteTranslationEntity = 'config' | 'property'

const DEFAULT_CONTENT_LOCALE = 'zh'
const SUPPORTED_TRANSLATION_LOCALES = new Set(['zh', 'en', 'de', 'es', 'fr', 'it', 'pt', 'ru', 'ja', 'ko', 'zh-Hant', 'th', 'ar'])

const DEFAULT_SITE_CONFIG: GuestSiteConfig = {
  banner_title: '安心入住墨尔本',
  banner_subtitle: '精选短租房源，适合商务出行、家庭入住和长期停留。',
  hero_background_urls: [],
  primary_button_text: '查看房源',
  primary_button_href: '/properties',
  secondary_button_text: '联系我们',
  secondary_button_href: '/#contact',
  brand_story:
    'MZ Property 提供真实房源、清晰沟通和本地化服务，让客人在预订前就知道自己会住进什么样的空间。',
  contact_email: '',
  contact_phone: '',
  contact_whatsapp: '',
  contact_address: '',
  faq_items: [
    { question: '如何确认预订？', answer: '先提交询单，我们的团队会根据日期与人数确认可订性并联系你。' },
    { question: '支持长租吗？', answer: '支持。请在询单里告诉我们你的入住日期、退房日期和人数。' },
  ],
}

const fallbackStore: {
  config: GuestSiteConfig
  displays: Record<string, GuestSitePropertyDisplay>
  inquiries: GuestSiteInquiry[]
} = {
  config: { ...DEFAULT_SITE_CONFIG },
  displays: {},
  inquiries: [],
}

const faqItemSchema = z.object({
  question: z.string().trim().min(1),
  answer: z.string().trim().min(1),
})

const siteConfigSchema = z.object({
  banner_title: z.string().trim().min(1),
  banner_subtitle: z.string().trim().min(1),
  hero_background_urls: z.array(z.string().trim().min(1)).max(12).default([]),
  primary_button_text: z.string().trim().min(1),
  primary_button_href: z.string().trim().min(1),
  secondary_button_text: z.string().trim().optional().default(''),
  secondary_button_href: z.string().trim().optional().default(''),
  brand_story: z.string().trim().min(1),
  contact_email: z.string().trim().optional().default(''),
  contact_phone: z.string().trim().optional().default(''),
  contact_whatsapp: z.string().trim().optional().default(''),
  contact_address: z.string().trim().optional().default(''),
  faq_items: z.array(faqItemSchema).max(20).default([]),
})

const propertyDisplaySchema = z.object({
  is_published: z.boolean(),
  hero_title: z.string().trim().optional().default(''),
  short_description: z.string().trim().optional().default(''),
  long_description: z.string().trim().optional().default(''),
  hero_image_url: z.string().trim().optional().default(''),
  gallery_urls: z.array(z.string().trim().min(1)).max(24).default([]),
  feature_tags: z.array(z.string().trim().min(1)).max(24).default([]),
  amenities: z.array(z.string().trim().min(1)).max(40).default([]),
  house_rules: z.array(z.string().trim().min(1)).max(40).default([]),
  sort_order: z.number().int().min(0).max(99999).default(0),
  public_region_label: z.string().trim().optional().default(''),
  public_capacity_override: z.number().int().min(1).max(100).nullable().optional().default(null),
  bedroom_count: z.number().int().min(0).max(20).nullable().optional().default(null),
  bathroom_count: z.number().int().min(0).max(20).nullable().optional().default(null),
  bed_count: z.number().int().min(0).max(20).nullable().optional().default(null),
  checkin_time: z.string().trim().optional().default(''),
  checkout_time: z.string().trim().optional().default(''),
  location_note: z.string().trim().optional().default(''),
  price_label: z.string().trim().optional().default(''),
  booking_highlights: z.array(z.string().trim().min(1)).max(20).default([]),
})

const inquiryCreateSchema = z.object({
  property_id: z.string().trim().min(1),
  guest_name: z.string().trim().min(1).max(120),
  guest_phone: z.string().trim().min(3).max(60),
  guest_email: z.string().trim().email().max(180),
  checkin: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkout: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  guest_count: z.number().int().min(1).max(50),
  message: z.string().trim().max(2000).optional().default(''),
})

const inquiryPatchSchema = z.object({
  status: z.enum(['new', 'contacted', 'converted', 'closed']).optional(),
  admin_note: z.string().max(4000).nullable().optional(),
})

function stringList(v: any): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x || '').trim()).filter(Boolean)
}

function parseFaqList(v: any): GuestSiteFaqItem[] {
  if (!Array.isArray(v)) return []
  return v
    .map((item) => ({
      question: String(item?.question || '').trim(),
      answer: String(item?.answer || '').trim(),
    }))
    .filter((item) => item.question && item.answer)
}

function normalizeSiteConfig(v: any): GuestSiteConfig {
  return {
    banner_title: String(v?.banner_title || DEFAULT_SITE_CONFIG.banner_title),
    banner_subtitle: String(v?.banner_subtitle || DEFAULT_SITE_CONFIG.banner_subtitle),
    hero_background_urls: stringList(v?.hero_background_urls),
    primary_button_text: String(v?.primary_button_text || DEFAULT_SITE_CONFIG.primary_button_text),
    primary_button_href: String(v?.primary_button_href || DEFAULT_SITE_CONFIG.primary_button_href),
    secondary_button_text: String(v?.secondary_button_text || DEFAULT_SITE_CONFIG.secondary_button_text),
    secondary_button_href: String(v?.secondary_button_href || DEFAULT_SITE_CONFIG.secondary_button_href),
    brand_story: String(v?.brand_story || DEFAULT_SITE_CONFIG.brand_story),
    contact_email: String(v?.contact_email || ''),
    contact_phone: String(v?.contact_phone || ''),
    contact_whatsapp: String(v?.contact_whatsapp || ''),
    contact_address: String(v?.contact_address || ''),
    faq_items: parseFaqList(v?.faq_items),
  }
}

function normalizeDisplay(propertyId: string, v: any): GuestSitePropertyDisplay {
  return {
    property_id: propertyId,
    is_published: !!v?.is_published,
    hero_title: String(v?.hero_title || ''),
    short_description: String(v?.short_description || ''),
    long_description: String(v?.long_description || ''),
    hero_image_url: String(v?.hero_image_url || ''),
    gallery_urls: stringList(v?.gallery_urls),
    feature_tags: stringList(v?.feature_tags),
    amenities: stringList(v?.amenities),
    house_rules: stringList(v?.house_rules),
    sort_order: Number.isFinite(Number(v?.sort_order)) ? Number(v.sort_order) : 0,
    public_region_label: String(v?.public_region_label || ''),
    public_capacity_override:
      v?.public_capacity_override == null || v?.public_capacity_override === ''
        ? null
        : Number(v.public_capacity_override),
    bedroom_count: v?.bedroom_count == null || v?.bedroom_count === '' ? null : Number(v.bedroom_count),
    bathroom_count: v?.bathroom_count == null || v?.bathroom_count === '' ? null : Number(v.bathroom_count),
    bed_count: v?.bed_count == null || v?.bed_count === '' ? null : Number(v.bed_count),
    checkin_time: String(v?.checkin_time || ''),
    checkout_time: String(v?.checkout_time || ''),
    location_note: String(v?.location_note || ''),
    price_label: String(v?.price_label || ''),
    booking_highlights: stringList(v?.booking_highlights),
  }
}

const upload = multer({ storage: multer.memoryStorage() })

function dayOnly(v: any) {
  const s = String(v || '').trim()
  const m = /^\d{4}-\d{2}-\d{2}/.exec(s)
  return m ? m[0] : ''
}

function inferRoomCountsFromType(type: string) {
  const raw = String(type || '').trim()
  const map: Record<string, { bedroom_count: number; bathroom_count: number }> = {
    一房一卫: { bedroom_count: 1, bathroom_count: 1 },
    两房一卫: { bedroom_count: 2, bathroom_count: 1 },
    两房两卫: { bedroom_count: 2, bathroom_count: 2 },
    三房两卫: { bedroom_count: 3, bathroom_count: 2 },
    三房三卫: { bedroom_count: 3, bathroom_count: 3 },
  }
  return map[raw] || { bedroom_count: 0, bathroom_count: 0 }
}

function inferBedCount(bedConfig: string) {
  const raw = String(bedConfig || '').trim()
  if (!raw) return 0
  return raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean).length
}

function isInactiveOrderStatus(v: any) {
  const s = String(v || '').trim().toLowerCase()
  return s.includes('cancel') || s.includes('void') || s.includes('invalid')
}

function normalizeLocale(v: any) {
  const raw = String(v || '').trim()
  if (!raw) return DEFAULT_CONTENT_LOCALE
  if (SUPPORTED_TRANSLATION_LOCALES.has(raw)) return raw
  const lower = raw.toLowerCase()
  if (lower === 'zh-hans' || lower === 'zh-cn') return 'zh'
  if (lower === 'zh-hant' || lower === 'zh-tw' || lower === 'zh-hk') return 'zh-Hant'
  if (SUPPORTED_TRANSLATION_LOCALES.has(lower)) return lower
  return DEFAULT_CONTENT_LOCALE
}

function stableHash(value: any) {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')
}

function getTranslatorConfig() {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim()
  const model = String(process.env.GUEST_SITE_TRANSLATION_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini').trim()
  const baseUrl = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/g, '')
  return { apiKey, model, baseUrl }
}

async function ensureTranslationTable() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS guest_site_translations (
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    locale text NOT NULL,
    source_hash text NOT NULL,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (entity_type, entity_id, locale)
  );`)
}

async function readCachedTranslation(entityType: GuestSiteTranslationEntity, entityId: string, locale: string, sourceHash: string) {
  if (!hasPg || !pgPool) return null
  await ensureTranslationTable()
  const rs = await pgPool.query(
    `SELECT data
     FROM guest_site_translations
     WHERE entity_type=$1 AND entity_id=$2 AND locale=$3 AND source_hash=$4
     LIMIT 1`,
    [entityType, entityId, locale, sourceHash],
  )
  return rs?.rows?.[0]?.data || null
}

async function saveCachedTranslation(entityType: GuestSiteTranslationEntity, entityId: string, locale: string, sourceHash: string, data: any) {
  if (!hasPg || !pgPool) return
  await ensureTranslationTable()
  await pgPool.query(
    `INSERT INTO guest_site_translations (entity_type, entity_id, locale, source_hash, data, updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,now())
     ON CONFLICT (entity_type, entity_id, locale) DO UPDATE SET
       source_hash = EXCLUDED.source_hash,
       data = EXCLUDED.data,
       updated_at = now()`,
    [entityType, entityId, locale, sourceHash, JSON.stringify(data ?? {})],
  )
}

async function translateStructuredPayload(entityType: GuestSiteTranslationEntity, entityId: string, locale: string, payload: any) {
  const targetLocale = normalizeLocale(locale)
  if (!payload || targetLocale === DEFAULT_CONTENT_LOCALE) return payload
  const sourceHash = stableHash(payload)
  const cached = await readCachedTranslation(entityType, entityId, targetLocale, sourceHash)
  if (cached) return cached

  const { apiKey, model, baseUrl } = getTranslatorConfig()
  if (!apiKey) return payload

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are a professional translation engine for a property booking website. Translate the JSON values into the target locale while preserving JSON keys, array shapes, numbers, URLs, codes, and brand names such as MZ Property. Return valid JSON only.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: `Translate this ${entityType} content into locale ${targetLocale}.`,
            locale: targetLocale,
            payload,
          }),
        },
      ],
    }),
  })
  if (!res.ok) return payload
  const json = await res.json().catch(() => null) as any
  const content = String(json?.choices?.[0]?.message?.content || '').trim()
  if (!content) return payload
  let translated: any = null
  try {
    translated = JSON.parse(content)
  } catch {
    return payload
  }
  if (!translated || typeof translated !== 'object') return payload
  await saveCachedTranslation(entityType, entityId, targetLocale, sourceHash, translated)
  return translated
}

async function ensureGuestSiteTables() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS guest_site_configs (
    id text PRIMARY KEY,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text
  );`)
  await pgPool.query(`CREATE TABLE IF NOT EXISTS guest_site_property_displays (
    property_id text PRIMARY KEY,
    is_published boolean NOT NULL DEFAULT false,
    hero_title text,
    short_description text,
    long_description text,
    hero_image_url text,
    gallery_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
    feature_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
    amenities jsonb NOT NULL DEFAULT '[]'::jsonb,
    house_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
    sort_order integer NOT NULL DEFAULT 0,
    public_region_label text,
    public_capacity_override integer,
    bedroom_count integer,
    bathroom_count integer,
    bed_count integer,
    checkin_time text,
    checkout_time text,
    location_note text,
    price_label text,
    booking_highlights jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text
  );`)
  await pgPool.query(`ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS amenities jsonb NOT NULL DEFAULT '[]'::jsonb;`)
  await pgPool.query(`ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS house_rules jsonb NOT NULL DEFAULT '[]'::jsonb;`)
  await pgPool.query(`ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS bedroom_count integer;`)
  await pgPool.query(`ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS bathroom_count integer;`)
  await pgPool.query(`ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS bed_count integer;`)
  await pgPool.query(`ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS checkin_time text;`)
  await pgPool.query(`ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS checkout_time text;`)
  await pgPool.query(`ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS location_note text;`)
  await pgPool.query(`ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS price_label text;`)
  await pgPool.query(`ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS booking_highlights jsonb NOT NULL DEFAULT '[]'::jsonb;`)
  await pgPool.query(`CREATE TABLE IF NOT EXISTS guest_site_inquiries (
    id text PRIMARY KEY,
    property_id text NOT NULL,
    guest_name text NOT NULL,
    guest_phone text NOT NULL,
    guest_email text NOT NULL,
    checkin date NOT NULL,
    checkout date NOT NULL,
    guest_count integer NOT NULL,
    message text,
    status text NOT NULL DEFAULT 'new',
    admin_note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_guest_site_property_displays_published ON guest_site_property_displays(is_published, sort_order, updated_at DESC);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_guest_site_inquiries_status ON guest_site_inquiries(status, created_at DESC);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_guest_site_inquiries_property ON guest_site_inquiries(property_id, created_at DESC);`)
  await ensureTranslationTable()
}

async function getSiteConfigRecord() {
  if (!hasPg || !pgPool) return { ...fallbackStore.config }
  await ensureGuestSiteTables()
  const rs = await pgPool.query('SELECT data FROM guest_site_configs WHERE id=$1 LIMIT 1', ['home'])
  const row = rs?.rows?.[0]
  if (!row?.data) return { ...DEFAULT_SITE_CONFIG }
  return normalizeSiteConfig(row.data)
}

async function saveSiteConfigRecord(data: GuestSiteConfig, userId: string | null) {
  if (!hasPg || !pgPool) {
    fallbackStore.config = { ...data }
    return fallbackStore.config
  }
  await ensureGuestSiteTables()
  const rs = await pgPool.query(
    `INSERT INTO guest_site_configs (id, data, updated_at, updated_by)
     VALUES ($1, $2::jsonb, now(), $3)
     ON CONFLICT (id) DO UPDATE SET
       data = EXCLUDED.data,
       updated_at = now(),
       updated_by = EXCLUDED.updated_by
     RETURNING data`,
    ['home', JSON.stringify(data), userId],
  )
  return normalizeSiteConfig(rs?.rows?.[0]?.data)
}

async function listPropertiesWithDisplay(includeUnpublished: boolean) {
  if (hasPg && pgPool) {
    await ensureGuestSiteTables()
    const visibilityWhere = includeUnpublished ? '' : 'AND COALESCE(d.is_published, false)=true'
    const rs = await pgPool.query(
      `SELECT
         p.id,
         p.code,
         p.address,
         p.type,
         p.capacity,
         p.region,
         p.area_sqm,
         p.building_name,
         p.building_facilities,
         p.bed_config,
         p.notes,
         p.airbnb_listing_name,
         p.booking_listing_name,
         d.is_published,
         d.hero_title,
         d.short_description,
         d.long_description,
         d.hero_image_url,
         d.gallery_urls,
         d.feature_tags,
         d.amenities,
         d.house_rules,
         d.sort_order,
         d.public_region_label,
         d.public_capacity_override,
         d.bedroom_count,
         d.bathroom_count,
         d.bed_count,
         d.checkin_time,
         d.checkout_time,
         d.location_note,
         d.price_label,
         d.booking_highlights,
         d.updated_at
       FROM properties p
       LEFT JOIN guest_site_property_displays d ON d.property_id = p.id
       WHERE COALESCE(p.archived, false) = false
       ${visibilityWhere}
       ORDER BY COALESCE(NULLIF(d.public_region_label, ''), NULLIF(p.region, ''), '未分区') ASC, COALESCE(d.sort_order, 99999) ASC, p.code ASC, p.address ASC`,
    )
    return Array.isArray(rs?.rows) ? rs.rows : []
  }
  const { db } = require('../store')
  const props = Array.isArray(db?.properties) ? db.properties : []
  return props
    .filter((p: any) => !p?.archived)
    .map((p: any) => ({ ...p, ...(fallbackStore.displays[String(p.id)] || { property_id: String(p.id), is_published: false }) }))
    .filter((row: any) => includeUnpublished || !!row.is_published)
    .sort((a: any, b: any) => {
      const regionA = String(a.public_region_label || a.region || '未分区')
      const regionB = String(b.public_region_label || b.region || '未分区')
      if (regionA !== regionB) return regionA.localeCompare(regionB)
      const sortGap = Number(a.sort_order || 99999) - Number(b.sort_order || 99999)
      if (sortGap) return sortGap
      return String(a.code || a.address || '').localeCompare(String(b.code || b.address || ''))
    })
}

async function getPropertyWithDisplay(propertyId: string, includeUnpublished: boolean) {
  const rows = await listPropertiesWithDisplay(includeUnpublished)
  return rows.find((row: any) => String(row.id) === propertyId || String(row.code || '') === propertyId) || null
}

function shapePropertySummary(row: any) {
  const inferred = inferRoomCountsFromType(String(row?.type || ''))
  const capacity = Number(row?.public_capacity_override || row?.capacity || 0) || 0
  const fuzzyLocationBase =
    String(row?.location_note || '').trim() ||
    String(row?.public_region_label || '').trim() ||
    String(row?.region || '').trim()
  const fuzzyLocation = [fuzzyLocationBase, 'Melbourne, Victoria, Australia'].filter(Boolean)
  const heroTitle =
    String(row?.hero_title || '').trim() ||
    String(row?.airbnb_listing_name || '').trim() ||
    String(row?.address || '').trim() ||
    String(row?.code || '').trim()
  const shortDescription =
    String(row?.short_description || '').trim() ||
    [String(row?.type || '').trim(), String(row?.region || '').trim()].filter(Boolean).join(' in ')
  const galleryUrls = stringList(row?.gallery_urls)
  const heroImageUrl = String(row?.hero_image_url || '').trim() || galleryUrls[0] || ''
  const amenities = stringList(row?.amenities)
  const houseRules = stringList(row?.house_rules)
  const bookingHighlights = stringList(row?.booking_highlights)
  return {
    id: String(row?.id || ''),
    code: String(row?.code || ''),
    address: String(row?.address || ''),
    type: String(row?.type || ''),
    capacity,
    region: String(row?.region || ''),
    public_region_label: String(row?.public_region_label || row?.region || ''),
    hero_title: heroTitle,
    short_description: shortDescription,
    long_description: String(row?.long_description || '').trim(),
    hero_image_url: heroImageUrl,
    gallery_urls: heroImageUrl ? Array.from(new Set([heroImageUrl, ...galleryUrls])) : galleryUrls,
    feature_tags: stringList(row?.feature_tags),
    amenities: amenities.length ? amenities : Array.isArray(row?.building_facilities) ? row.building_facilities.map((item: any) => String(item || '').trim()).filter(Boolean) : [],
    house_rules: houseRules,
    sort_order: Number(row?.sort_order || 0),
    is_published: !!row?.is_published,
    building_name: String(row?.building_name || ''),
    building_facilities: Array.isArray(row?.building_facilities) ? row.building_facilities : [],
    bed_config: String(row?.bed_config || ''),
    notes: String(row?.notes || ''),
    airbnb_listing_name: String(row?.airbnb_listing_name || ''),
    booking_listing_name: String(row?.booking_listing_name || ''),
    bedroom_count: row?.bedroom_count == null ? inferred.bedroom_count : Number(row?.bedroom_count || 0),
    bathroom_count: row?.bathroom_count == null ? inferred.bathroom_count : Number(row?.bathroom_count || 0),
    bed_count: row?.bed_count == null ? inferBedCount(String(row?.bed_config || '')) : Number(row?.bed_count || 0),
    checkin_time: String(row?.checkin_time || ''),
    checkout_time: String(row?.checkout_time || ''),
    location_note: fuzzyLocation.join(', '),
    price_label: String(row?.price_label || ''),
    booking_highlights: bookingHighlights,
  }
}

async function translateSiteConfig(config: GuestSiteConfig, locale: string) {
  const targetLocale = normalizeLocale(locale)
  if (targetLocale === DEFAULT_CONTENT_LOCALE || targetLocale === 'en') return config
  const translated = await translateStructuredPayload('config', 'home', targetLocale, {
    banner_title: config.banner_title,
    banner_subtitle: config.banner_subtitle,
    primary_button_text: config.primary_button_text,
    secondary_button_text: config.secondary_button_text,
    brand_story: config.brand_story,
    faq_items: config.faq_items,
  })
  return {
    ...config,
    banner_title: String(translated?.banner_title || config.banner_title),
    banner_subtitle: String(translated?.banner_subtitle || config.banner_subtitle),
    primary_button_text: String(translated?.primary_button_text || config.primary_button_text),
    secondary_button_text: String(translated?.secondary_button_text || config.secondary_button_text),
    brand_story: String(translated?.brand_story || config.brand_story),
    faq_items: Array.isArray(translated?.faq_items) ? parseFaqList(translated.faq_items) : config.faq_items,
  }
}

async function translatePropertySummary(summary: ReturnType<typeof shapePropertySummary>, locale: string) {
  const targetLocale = normalizeLocale(locale)
  if (targetLocale === DEFAULT_CONTENT_LOCALE || targetLocale === 'en') return summary
  const translated = await translateStructuredPayload('property', summary.id, targetLocale, {
    hero_title: summary.hero_title,
    short_description: summary.short_description,
    long_description: summary.long_description,
    feature_tags: summary.feature_tags,
    amenities: summary.amenities,
    house_rules: summary.house_rules,
    public_region_label: summary.public_region_label,
    type: summary.type,
    building_name: summary.building_name,
    building_facilities: summary.building_facilities,
    bed_config: summary.bed_config,
    notes: summary.notes,
    location_note: summary.location_note,
    price_label: summary.price_label,
    booking_highlights: summary.booking_highlights,
  })
  return {
    ...summary,
    hero_title: String(translated?.hero_title || summary.hero_title),
    short_description: String(translated?.short_description || summary.short_description),
    long_description: String(translated?.long_description || summary.long_description),
    feature_tags: stringList(translated?.feature_tags).length ? stringList(translated?.feature_tags) : summary.feature_tags,
    amenities: stringList(translated?.amenities).length ? stringList(translated?.amenities) : summary.amenities,
    house_rules: stringList(translated?.house_rules).length ? stringList(translated?.house_rules) : summary.house_rules,
    public_region_label: String(translated?.public_region_label || summary.public_region_label),
    type: String(translated?.type || summary.type),
    building_name: String(translated?.building_name || summary.building_name || ''),
    building_facilities: Array.isArray(translated?.building_facilities) ? translated.building_facilities.map((item: any) => String(item || '').trim()).filter(Boolean) : summary.building_facilities,
    bed_config: String(translated?.bed_config || summary.bed_config || ''),
    notes: String(translated?.notes || summary.notes || ''),
    location_note: String(translated?.location_note || summary.location_note || ''),
    price_label: String(translated?.price_label || summary.price_label || ''),
    booking_highlights: stringList(translated?.booking_highlights).length ? stringList(translated?.booking_highlights) : summary.booking_highlights,
  }
}

async function getBlockedDateRanges(propertyId: string) {
  if (hasPg && pgPool) {
    const rs = await pgPool.query(
      `SELECT checkin, checkout
       FROM orders
       WHERE property_id=$1
         AND COALESCE(status, '') !~* 'cancel|void|invalid'
         AND checkin IS NOT NULL
         AND checkout IS NOT NULL
       ORDER BY checkin ASC`,
      [propertyId],
    )
    return (rs?.rows || [])
      .map((row: any) => ({ checkin: dayOnly(row.checkin), checkout: dayOnly(row.checkout) }))
      .filter((row: any) => row.checkin && row.checkout)
  }
  const { db } = require('../store')
  return (Array.isArray(db?.orders) ? db.orders : [])
    .filter((row: any) => String(row?.property_id || '') === propertyId && !isInactiveOrderStatus(row?.status))
    .map((row: any) => ({ checkin: dayOnly(row?.checkin), checkout: dayOnly(row?.checkout) }))
    .filter((row: any) => row.checkin && row.checkout)
}

function hasRequestedOverlap(blocked: Array<{ checkin: string; checkout: string }>, checkin: string, checkout: string) {
  if (!checkin || !checkout) return null
  const inTs = Date.parse(`${checkin}T00:00:00Z`)
  const outTs = Date.parse(`${checkout}T00:00:00Z`)
  if (!Number.isFinite(inTs) || !Number.isFinite(outTs) || outTs <= inTs) return null
  return !blocked.every((row) => {
    const bIn = Date.parse(`${row.checkin}T00:00:00Z`)
    const bOut = Date.parse(`${row.checkout}T00:00:00Z`)
    return !Number.isFinite(bIn) || !Number.isFinite(bOut) || outTs <= bIn || inTs >= bOut
  })
}

async function uploadGuestSiteHeroImage(file: Express.Multer.File) {
  const img = await resizeUploadImage({ buffer: file.buffer, contentType: file.mimetype, originalName: file.originalname })
  const ext = img.ext || path.extname(String(file.originalname || '')).toLowerCase() || '.jpg'
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
  if (hasR2) {
    const key = `guest-site/hero/${filename}`
    const url = await r2Upload(key, img.contentType || file.mimetype || 'application/octet-stream', img.buffer)
    return url
  }
  const dir = path.join(process.cwd(), 'uploads', 'guest-site', 'hero')
  await fs.promises.mkdir(dir, { recursive: true })
  await fs.promises.writeFile(path.join(dir, filename), img.buffer)
  return `/uploads/guest-site/hero/${filename}`
}

async function uploadGuestSitePropertyImage(file: Express.Multer.File) {
  const img = await resizeUploadImage({ buffer: file.buffer, contentType: file.mimetype, originalName: file.originalname })
  const ext = img.ext || path.extname(String(file.originalname || '')).toLowerCase() || '.jpg'
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
  if (hasR2) {
    const key = `guest-site/properties/${filename}`
    const url = await r2Upload(key, img.contentType || file.mimetype || 'application/octet-stream', img.buffer)
    return url
  }
  const dir = path.join(process.cwd(), 'uploads', 'guest-site', 'properties')
  await fs.promises.mkdir(dir, { recursive: true })
  await fs.promises.writeFile(path.join(dir, filename), img.buffer)
  return `/uploads/guest-site/properties/${filename}`
}

export const publicRouter = Router()
export const adminRouter = Router()

publicRouter.get('/guest-site/config', async (_req, res) => {
  try {
    const locale = normalizeLocale((_req.query as any)?.locale)
    const data = await translateSiteConfig(await getSiteConfigRecord(), locale)
    return res.json(data)
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'guest_site_config_failed') })
  }
})

publicRouter.get('/guest-site/properties', async (req, res) => {
  try {
    const featuredOnly = String((req.query as any)?.featured || '').trim() === 'true'
    const locale = normalizeLocale((req.query as any)?.locale)
    const rows = await listPropertiesWithDisplay(false)
    const list = await Promise.all(rows.map((row: any) => translatePropertySummary(shapePropertySummary(row), locale)))
    const out = featuredOnly ? list.slice(0, 6) : list
    return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'guest_site_properties_failed') })
  }
})

publicRouter.get('/guest-site/properties/:id', async (req, res) => {
  try {
    const locale = normalizeLocale((req.query as any)?.locale)
    const allowPreview = String((req.query as any)?.preview || '').trim() === '1'
    const row = await getPropertyWithDisplay(String(req.params.id || ''), allowPreview)
    if (!row) return res.status(404).json({ message: 'property_not_found' })
    return res.json(await translatePropertySummary(shapePropertySummary(row), locale))
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'guest_site_property_failed') })
  }
})

publicRouter.get('/guest-site/properties/:id/availability', async (req, res) => {
  try {
    const propertyId = String(req.params.id || '').trim()
    const allowPreview = String((req.query as any)?.preview || '').trim() === '1'
    const row = await getPropertyWithDisplay(propertyId, allowPreview)
    if (!row) return res.status(404).json({ message: 'property_not_found' })
    const blocked = await getBlockedDateRanges(propertyId)
    const checkin = String((req.query as any)?.checkin || '').trim()
    const checkout = String((req.query as any)?.checkout || '').trim()
    const overlap = hasRequestedOverlap(blocked, checkin, checkout)
    return res.json({
      property_id: propertyId,
      available: overlap == null ? null : !overlap,
      blocked_ranges: blocked,
    })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'guest_site_availability_failed') })
  }
})

publicRouter.post('/guest-site/inquiries', async (req, res) => {
  const parsed = inquiryCreateSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const payload = parsed.data
  if (payload.checkout <= payload.checkin) return res.status(400).json({ message: 'checkout_must_be_after_checkin' })
  try {
    const row = await getPropertyWithDisplay(payload.property_id, false)
    if (!row) return res.status(404).json({ message: 'property_not_found' })
    const blocked = await getBlockedDateRanges(payload.property_id)
    const overlap = hasRequestedOverlap(blocked, payload.checkin, payload.checkout)
    if (overlap) return res.status(400).json({ message: 'selected_dates_unavailable' })

    const next: GuestSiteInquiry = {
      id: uuidv4(),
      property_id: payload.property_id,
      property_code: String(row?.code || ''),
      property_address: String(row?.address || ''),
      guest_name: payload.guest_name,
      guest_phone: payload.guest_phone,
      guest_email: payload.guest_email,
      checkin: payload.checkin,
      checkout: payload.checkout,
      guest_count: payload.guest_count,
      message: payload.message,
      status: 'new',
      admin_note: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    if (hasPg && pgPool) {
      await ensureGuestSiteTables()
      await pgPool.query(
        `INSERT INTO guest_site_inquiries
          (id, property_id, guest_name, guest_phone, guest_email, checkin, checkout, guest_count, message, status, admin_note, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now())`,
        [
          next.id,
          next.property_id,
          next.guest_name,
          next.guest_phone,
          next.guest_email,
          next.checkin,
          next.checkout,
          next.guest_count,
          next.message || '',
          next.status,
          next.admin_note || '',
        ],
      )
    } else {
      fallbackStore.inquiries.unshift(next)
    }
    return res.status(201).json({ ok: true, id: next.id })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'guest_site_inquiry_failed') })
  }
})

adminRouter.get('/guest-site/config', requirePerm('guest_site_settings.view'), async (_req, res) => {
  try {
    return res.json(await getSiteConfigRecord())
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'guest_site_config_failed') })
  }
})

adminRouter.put('/guest-site/config', requirePerm('guest_site_settings.write'), async (req, res) => {
  const parsed = siteConfigSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    const userId = String((req as any)?.user?.sub || '').trim() || null
    return res.json(await saveSiteConfigRecord(parsed.data, userId))
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'guest_site_config_save_failed') })
  }
})

adminRouter.post('/guest-site/config/hero-images/upload', requirePerm('guest_site_settings.write'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'missing_file' })
    const url = await uploadGuestSiteHeroImage(req.file as Express.Multer.File)
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'guest_site_hero_upload_failed') })
  }
})

adminRouter.get('/guest-site/properties', requirePerm('guest_site_properties.view'), async (_req, res) => {
  try {
    const rows = await listPropertiesWithDisplay(true)
    return res.json(rows.map(shapePropertySummary))
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'guest_site_property_list_failed') })
  }
})

adminRouter.patch('/guest-site/properties/:propertyId', requirePerm('guest_site_properties.write'), async (req, res) => {
  const propertyId = String(req.params.propertyId || '').trim()
  const parsed = propertyDisplaySchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    const property = await getPropertyWithDisplay(propertyId, true)
    if (!property) return res.status(404).json({ message: 'property_not_found' })
    const next = normalizeDisplay(propertyId, parsed.data)
    const userId = String((req as any)?.user?.sub || '').trim() || null
    if (hasPg && pgPool) {
      await ensureGuestSiteTables()
      const rs = await pgPool.query(
        `INSERT INTO guest_site_property_displays
          (property_id, is_published, hero_title, short_description, long_description, hero_image_url, gallery_urls, feature_tags, amenities, house_rules, sort_order, public_region_label, public_capacity_override, bedroom_count, bathroom_count, bed_count, checkin_time, checkout_time, location_note, price_label, booking_highlights, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,now(),$22)
         ON CONFLICT (property_id) DO UPDATE SET
           is_published = EXCLUDED.is_published,
           hero_title = EXCLUDED.hero_title,
           short_description = EXCLUDED.short_description,
           long_description = EXCLUDED.long_description,
           hero_image_url = EXCLUDED.hero_image_url,
           gallery_urls = EXCLUDED.gallery_urls,
           feature_tags = EXCLUDED.feature_tags,
           amenities = EXCLUDED.amenities,
           house_rules = EXCLUDED.house_rules,
           sort_order = EXCLUDED.sort_order,
           public_region_label = EXCLUDED.public_region_label,
           public_capacity_override = EXCLUDED.public_capacity_override,
           bedroom_count = EXCLUDED.bedroom_count,
           bathroom_count = EXCLUDED.bathroom_count,
           bed_count = EXCLUDED.bed_count,
           checkin_time = EXCLUDED.checkin_time,
           checkout_time = EXCLUDED.checkout_time,
           location_note = EXCLUDED.location_note,
           price_label = EXCLUDED.price_label,
           booking_highlights = EXCLUDED.booking_highlights,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by
         RETURNING *`,
        [
          propertyId,
          next.is_published,
          next.hero_title,
          next.short_description,
          next.long_description,
          next.hero_image_url,
          JSON.stringify(next.gallery_urls),
          JSON.stringify(next.feature_tags),
          JSON.stringify(next.amenities),
          JSON.stringify(next.house_rules),
          next.sort_order,
          next.public_region_label,
          next.public_capacity_override,
          next.bedroom_count,
          next.bathroom_count,
          next.bed_count,
          next.checkin_time,
          next.checkout_time,
          next.location_note,
          next.price_label,
          JSON.stringify(next.booking_highlights),
          userId,
        ],
      )
      const saved = rs?.rows?.[0] || next
      return res.json({ ...shapePropertySummary(property), ...shapePropertySummary({ ...property, ...saved }) })
    }
    fallbackStore.displays[propertyId] = next
    return res.json({ ...shapePropertySummary(property), ...next })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'guest_site_property_save_failed') })
  }
})

adminRouter.post('/guest-site/properties/upload-image', requirePerm('guest_site_properties.write'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'missing_file' })
    const url = await uploadGuestSitePropertyImage(req.file as Express.Multer.File)
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'guest_site_property_upload_failed') })
  }
})

adminRouter.get('/guest-site/inquiries', requirePerm('guest_site_inquiries.view'), async (req, res) => {
  try {
    const status = String((req.query as any)?.status || '').trim()
    if (hasPg && pgPool) {
      await ensureGuestSiteTables()
      const rs = status
        ? await pgPool.query(
            `SELECT i.*, p.code AS property_code, p.address AS property_address
             FROM guest_site_inquiries i
             LEFT JOIN properties p ON p.id = i.property_id
             WHERE i.status=$1
             ORDER BY i.created_at DESC`,
            [status],
          )
        : await pgPool.query(
            `SELECT i.*, p.code AS property_code, p.address AS property_address
             FROM guest_site_inquiries i
             LEFT JOIN properties p ON p.id = i.property_id
             ORDER BY i.created_at DESC`,
          )
      return res.json(Array.isArray(rs?.rows) ? rs.rows : [])
    }
    const list = status ? fallbackStore.inquiries.filter((row) => row.status === status) : fallbackStore.inquiries
    return res.json(list)
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'guest_site_inquiry_list_failed') })
  }
})

adminRouter.patch('/guest-site/inquiries/:id', requirePerm('guest_site_inquiries.write'), async (req, res) => {
  const inquiryId = String(req.params.id || '').trim()
  const parsed = inquiryPatchSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg && pgPool) {
      await ensureGuestSiteTables()
      const rs = await pgPool.query(
        `UPDATE guest_site_inquiries
         SET status = COALESCE($2, status),
             admin_note = CASE WHEN $3::text IS NULL THEN admin_note ELSE $3 END,
             updated_at = now()
         WHERE id=$1
         RETURNING *`,
        [inquiryId, parsed.data.status || null, parsed.data.admin_note === undefined ? null : parsed.data.admin_note],
      )
      const row = rs?.rows?.[0]
      if (!row) return res.status(404).json({ message: 'inquiry_not_found' })
      return res.json(row)
    }
    const idx = fallbackStore.inquiries.findIndex((row) => row.id === inquiryId)
    if (idx < 0) return res.status(404).json({ message: 'inquiry_not_found' })
    fallbackStore.inquiries[idx] = {
      ...fallbackStore.inquiries[idx],
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.admin_note !== undefined ? { admin_note: parsed.data.admin_note || '' } : {}),
      updated_at: new Date().toISOString(),
    }
    return res.json(fallbackStore.inquiries[idx])
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'guest_site_inquiry_save_failed') })
  }
})
