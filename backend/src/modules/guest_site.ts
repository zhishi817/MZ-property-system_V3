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
import {
  assertGuestSiteAmenitySelectionsSchemaReady,
  assertGuestSiteAmenityTemplatesSchemaReady,
  assertGuestSiteContactMessagesSchemaReady,
  assertGuestSiteSchemaReady,
  GuestSiteAmenitySchemaNotReady,
  GuestSiteAmenityTemplatesSchemaNotReady,
  GuestSiteContactMessagesSchemaNotReady,
  GuestSiteSchemaNotReady,
  GuestSiteStayPoliciesSchemaNotReady,
  isGuestSiteAmenitySelectionsSchemaReady,
  isGuestSiteAmenityTemplatesSchemaReady,
  isGuestSiteStayPoliciesSchemaReady,
  assertGuestSiteStayPoliciesSchemaReady,
} from '../lib/guestSiteSchema'
import {
  amenityCatalogPayload,
  amenitySelectionSchema,
  companyDefaultAmenityConflicts,
  guestSiteTimeForStorage,
  legacyAmenityCandidateSelections,
  normalizeAmenityTemplateCandidates,
  normalizeAmenitySelections,
  publicAmenityItems,
  publishReadiness,
  type GuestSiteAmenitySelection,
  type GuestSiteAmenityTemplateCandidate,
} from '../lib/guestSitePropertyDisplay'
import {
  GUEST_SITE_POLICY_SECTIONS,
  normalizePolicyContent,
  resolveEffectivePolicy,
  type GuestSiteEffectivePolicy,
  type GuestSitePolicyMode,
  type GuestSitePolicySection,
} from '../lib/guestSiteStayPolicy'
import {
  GuestSitePolicyConflict,
  GuestSitePolicyNotFound,
  GuestSitePolicyValidationError,
  bulkSetPropertyPoliciesToFollow,
  getCompanyPolicyImpact,
  getCompanyPolicyOverview,
  getPropertyPolicyOverview,
  publishCompanyPolicy,
  publishPropertyOverride,
  readPolicyVersion,
  resolveEffectivePoliciesForRows,
  savePolicyDraft,
  setPropertyPolicyMode,
} from '../lib/guestSiteStayPolicyStore'

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
  amenity_selections: GuestSiteAmenitySelection[]
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

type GuestSiteAmenityTemplate = {
  id: string
  scope: 'company' | 'building'
  scope_key: string
  name: string
  amenity_candidates: GuestSiteAmenityTemplateCandidate[]
  is_active: boolean
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
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

type GuestSiteContactMessage = {
  id: string
  submission_id: string
  guest_name: string
  guest_email: string
  message: string
  status: 'new' | 'contacted' | 'closed'
  admin_note?: string | null
  handled_by?: string | null
  handled_at?: string | null
  created_at: string
  updated_at: string
}

type GuestSiteTranslationEntity = 'config' | 'property'

const DEFAULT_CONTENT_LOCALE = 'zh'
const SUPPORTED_TRANSLATION_LOCALES = new Set(['zh', 'en', 'de', 'es', 'fr', 'it', 'pt', 'ru', 'ja', 'ko', 'zh-Hant', 'th', 'ar'])
const RUNTIME_TRANSLATION_CACHE_MAX = 256
const RUNTIME_TRANSLATION_CACHE_TTL_MS = 15 * 60 * 1000
const RUNTIME_TRANSLATION_FALLBACK_TTL_MS = 60 * 1000
const RUNTIME_TRANSLATION_RATE_WINDOW_MS = 60 * 1000
const RUNTIME_TRANSLATION_RATE_LIMIT = 20

type RuntimeTranslationCacheEntry = { expiresAt: number; value: any }
const runtimeTranslationCache = new Map<string, RuntimeTranslationCacheEntry>()
const runtimeTranslationInFlight = new Map<string, Promise<any>>()
let runtimeTranslationWindowStartedAt = 0
let runtimeTranslationWindowCount = 0

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
  amenityTemplates: GuestSiteAmenityTemplate[]
} = {
  config: { ...DEFAULT_SITE_CONFIG },
  displays: {},
  inquiries: [],
  amenityTemplates: [],
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
  amenity_selections: z.array(amenitySelectionSchema).max(80).default([]),
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

const amenityTemplateCandidateSchema = amenitySelectionSchema.omit({ status: true })
const amenityTemplateCandidatesSchema = z.array(amenityTemplateCandidateSchema).max(80).superRefine((value, context) => {
  if (normalizeAmenityTemplateCandidates(value).length !== value.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid_or_duplicate_amenity_candidate' })
  }
}).transform((value) => normalizeAmenityTemplateCandidates(value))

const amenityTemplateCreateSchema = z.object({
  scope: z.enum(['company', 'building']),
  scope_key: z.string().trim().max(180).optional().default(''),
  name: z.string().trim().min(1).max(120),
  amenity_candidates: amenityTemplateCandidatesSchema,
}).superRefine((value, context) => {
  if (value.scope === 'company' && value.scope_key) context.addIssue({ code: z.ZodIssueCode.custom, path: ['scope_key'], message: 'company_scope_key_must_be_empty' })
  if (value.scope === 'building' && !value.scope_key) context.addIssue({ code: z.ZodIssueCode.custom, path: ['scope_key'], message: 'building_scope_key_required' })
})

const amenityTemplatePatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  amenity_candidates: amenityTemplateCandidatesSchema.optional(),
  is_active: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'no_changes' })

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

const homepageContactMessageCreateSchema = z.object({
  submission_id: z.string().trim().uuid(),
  first_name: z.string().trim().min(1).max(80),
  last_name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(180),
  message: z.string().trim().min(1).max(2000),
})

const propertyManagementContactMessageCreateSchema = z.object({
  submission_id: z.string().trim().uuid(),
  inquiry_type: z.literal('property_management'),
  name: z.string().trim().min(1).max(161).regex(/^[^\r\n]+$/),
  email: z.string().trim().email().max(180),
  phone: z.string().trim().max(60).regex(/^[^\r\n]*$/).optional().default(''),
  property_area: z.string().trim().min(1).max(120).regex(/^[^\r\n]+$/),
  property_type: z.enum(['Apartment', 'Townhouse', 'House', 'Other']),
  current_use: z.enum(['Short-term rental', 'Long-term rental', 'Owner-occupied', 'Vacant or preparing', 'Other']),
  message: z.string().trim().min(10).max(1500),
})

const contactMessageCreateSchema = z.union([
  propertyManagementContactMessageCreateSchema,
  homepageContactMessageCreateSchema,
])

const contactMessagePatchSchema = z.object({
  status: z.enum(['new', 'contacted', 'closed']).optional(),
  admin_note: z.string().max(4000).nullable().optional(),
}).refine((value) => value.status !== undefined || value.admin_note !== undefined, {
  message: 'no_changes',
})

const contactMessageStatusSchema = z.enum(['new', 'contacted', 'closed'])

const stayPolicySectionSchema = z.enum(GUEST_SITE_POLICY_SECTIONS)
const stayPolicyDraftSchema = z.object({
  expected_revision: z.number().int().min(0),
  content: z.record(z.any()),
})
const stayPolicyRevisionSchema = z.object({
  expected_revision: z.number().int().min(1),
})
const stayPolicyPublishSchema = stayPolicyRevisionSchema.extend({
  impact_hash: z.string().trim().regex(/^[a-f0-9]{64}$/i),
})
const stayPolicyPropertyPublishSchema = stayPolicyRevisionSchema.extend({
  expected_mode_revision: z.number().int().min(0),
})
const stayPolicyPreviewSchema = stayPolicyRevisionSchema.extend({
  property_id: z.string().trim().min(1),
})
const stayPolicyModeSchema = z.object({
  mode: z.enum(['legacy', 'follow_company']),
  expected_revision: z.number().int().min(0),
})
const stayPolicyBulkFollowSchema = z.object({
  items: z.array(z.object({
    property_id: z.string().trim().min(1),
    expected_revision: z.number().int().min(0),
  })).min(1).max(500),
})

function normalizeContactDedupeText(value: string) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function contactMessageDedupeHash(input: { guestName: string; guestEmail: string; message: string }) {
  return createHash('sha256')
    .update([
      normalizeContactDedupeText(input.guestName),
      normalizeContactDedupeText(input.guestEmail),
      normalizeContactDedupeText(input.message),
    ].join('\n'))
    .digest('hex')
}

function propertyManagementContactMessage(payload: z.infer<typeof propertyManagementContactMessageCreateSchema>) {
  return [
    'Property management enquiry',
    `Phone: ${payload.phone || 'Not provided'}`,
    `Property area / suburb: ${payload.property_area}`,
    `Property type: ${payload.property_type}`,
    `Current use: ${payload.current_use}`,
    '',
    'Enquiry details:',
    payload.message,
  ].join('\n')
}

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
  const amenitySelections = normalizeAmenitySelections(v?.amenity_selections, v?.amenities)
  const publicAmenities = publicAmenityItems(amenitySelections).map((item) => item.label)
  return {
    property_id: propertyId,
    is_published: !!v?.is_published,
    hero_title: String(v?.hero_title || ''),
    short_description: String(v?.short_description || ''),
    long_description: String(v?.long_description || ''),
    hero_image_url: String(v?.hero_image_url || ''),
    gallery_urls: stringList(v?.gallery_urls),
    feature_tags: stringList(v?.feature_tags),
    amenities: amenitySelections.length ? publicAmenities : stringList(v?.amenities),
    amenity_selections: amenitySelections,
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
    checkin_time: guestSiteTimeForStorage(v?.checkin_time),
    checkout_time: guestSiteTimeForStorage(v?.checkout_time),
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

function readRuntimeTranslation(key: string) {
  const entry = runtimeTranslationCache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    runtimeTranslationCache.delete(key)
    return null
  }
  runtimeTranslationCache.delete(key)
  runtimeTranslationCache.set(key, entry)
  return entry.value
}

function writeRuntimeTranslation(key: string, value: any, ttlMs: number) {
  runtimeTranslationCache.delete(key)
  runtimeTranslationCache.set(key, { expiresAt: Date.now() + ttlMs, value })
  while (runtimeTranslationCache.size > RUNTIME_TRANSLATION_CACHE_MAX) {
    const oldest = runtimeTranslationCache.keys().next().value
    if (typeof oldest !== 'string') break
    runtimeTranslationCache.delete(oldest)
  }
}

function reserveRuntimeTranslationRequest() {
  const now = Date.now()
  if (!runtimeTranslationWindowStartedAt || now - runtimeTranslationWindowStartedAt >= RUNTIME_TRANSLATION_RATE_WINDOW_MS) {
    runtimeTranslationWindowStartedAt = now
    runtimeTranslationWindowCount = 0
  }
  if (runtimeTranslationWindowCount >= RUNTIME_TRANSLATION_RATE_LIMIT) return false
  runtimeTranslationWindowCount += 1
  return true
}

async function readCachedTranslation(entityType: GuestSiteTranslationEntity, entityId: string, locale: string, sourceHash: string) {
  if (!hasPg || !pgPool) return null
  assertGuestSiteSchemaReady()
  const rs = await pgPool.query(
    `SELECT data
     FROM guest_site_translations
     WHERE entity_type=$1 AND entity_id=$2 AND locale=$3 AND source_hash=$4
     LIMIT 1`,
    [entityType, entityId, locale, sourceHash],
  )
  return rs?.rows?.[0]?.data || null
}

async function readTranslatedPayload(entityType: GuestSiteTranslationEntity, entityId: string, locale: string, payload: any) {
  const targetLocale = normalizeLocale(locale)
  if (!payload || targetLocale === DEFAULT_CONTENT_LOCALE) return payload
  const sourceHash = stableHash(payload)
  const cached = await readCachedTranslation(entityType, entityId, targetLocale, sourceHash)
  if (cached) return cached

  const { apiKey, model, baseUrl } = getTranslatorConfig()
  if (!apiKey) return payload
  const runtimeKey = `${entityType}:${entityId}:${targetLocale}:${sourceHash}`
  const runtimeCached = readRuntimeTranslation(runtimeKey)
  if (runtimeCached) return runtimeCached
  const pending = runtimeTranslationInFlight.get(runtimeKey)
  if (pending) return pending
  if (!reserveRuntimeTranslationRequest()) {
    writeRuntimeTranslation(runtimeKey, payload, RUNTIME_TRANSLATION_FALLBACK_TTL_MS)
    return payload
  }

  const generation = (async () => {
    let result = payload
    let ttlMs = RUNTIME_TRANSLATION_FALLBACK_TTL_MS
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
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
              content: 'You are a professional translation engine for a property booking website. Translate JSON values while preserving keys, array shapes, numbers, URLs, codes, and the MZ Property brand. Return valid JSON only.',
            },
            {
              role: 'user',
              content: JSON.stringify({ task: `Translate this ${entityType} content into locale ${targetLocale}.`, locale: targetLocale, payload }),
            },
          ],
        }),
      })
      if (response.ok) {
        const json = await response.json().catch(() => null) as any
        const content = String(json?.choices?.[0]?.message?.content || '').trim()
        if (content) {
          const translated = JSON.parse(content)
          if (translated && typeof translated === 'object') {
            result = translated
            ttlMs = RUNTIME_TRANSLATION_CACHE_TTL_MS
          }
        }
      }
    } catch {}
    writeRuntimeTranslation(runtimeKey, result, ttlMs)
    return result
  })().finally(() => runtimeTranslationInFlight.delete(runtimeKey))
  runtimeTranslationInFlight.set(runtimeKey, generation)
  return generation
}

async function getSiteConfigRecord() {
  if (!hasPg || !pgPool) return { ...fallbackStore.config }
  assertGuestSiteSchemaReady()
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
  assertGuestSiteSchemaReady()
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
    assertGuestSiteSchemaReady()
    const visibilityWhere = includeUnpublished ? '' : 'AND COALESCE(d.is_published, false)=true'
    const amenitySelectionsColumn = isGuestSiteAmenitySelectionsSchemaReady()
      ? 'd.amenity_selections'
      : "'[]'::jsonb AS amenity_selections"
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
         ${amenitySelectionsColumn},
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
       ORDER BY COALESCE(d.sort_order, 99999) ASC, COALESCE(NULLIF(d.public_region_label, ''), NULLIF(p.region, ''), '未分区') ASC, p.code ASC, p.address ASC`,
    )
    const rows = Array.isArray(rs?.rows) ? rs.rows : []
    if (!isGuestSiteStayPoliciesSchemaReady()) {
      return rows.map((row: any) => ({
        ...row,
        _effective_stay_policy: resolveEffectivePolicy({
          legacy: {
            house_rules: row?.house_rules,
            checkin_time: row?.checkin_time,
            checkout_time: row?.checkout_time,
          },
        }),
        _stay_policy_modes: {},
      }))
    }
    return resolveEffectivePoliciesForRows(pgPool as any, rows)
  }
  const { db } = require('../store')
  const props = Array.isArray(db?.properties) ? db.properties : []
  return props
    .filter((p: any) => !p?.archived)
    .map((p: any) => ({ ...p, ...(fallbackStore.displays[String(p.id)] || { property_id: String(p.id), is_published: false }) }))
    .filter((row: any) => includeUnpublished || !!row.is_published)
    .sort((a: any, b: any) => {
      const sortGap = Number(a.sort_order ?? 99999) - Number(b.sort_order ?? 99999)
      if (sortGap) return sortGap
      const regionA = String(a.public_region_label || a.region || '未分区')
      const regionB = String(b.public_region_label || b.region || '未分区')
      if (regionA !== regionB) return regionA.localeCompare(regionB)
      return String(a.code || a.address || '').localeCompare(String(b.code || b.address || ''))
    })
    .map((row: any) => ({
      ...row,
      _effective_stay_policy: resolveEffectivePolicy({
        legacy: {
          house_rules: row?.house_rules,
          checkin_time: row?.checkin_time,
          checkout_time: row?.checkout_time,
        },
      }),
      _stay_policy_modes: {},
    }))
}

async function getPropertyWithDisplay(propertyId: string, includeUnpublished: boolean) {
  const rows = await listPropertiesWithDisplay(includeUnpublished)
  return rows.find((row: any) => String(row.id) === propertyId || String(row.code || '') === propertyId) || null
}

async function getPublicPropertyWithDisplay(propertyId: string) {
  const rows = await listPropertiesWithDisplay(false)
  return rows.find((row: any) => String(row.id) === propertyId) || null
}

function shapePropertySummary(row: any) {
  const inferred = inferRoomCountsFromType(String(row?.type || ''))
  const capacity = Number(row?.public_capacity_override || row?.capacity || 0) || 0
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
  const amenitySelections = normalizeAmenitySelections(row?.amenity_selections, amenities)
  const houseRules = stringList(row?.house_rules)
  const bookingHighlights = stringList(row?.booking_highlights)
  const summary = {
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
    amenities,
    amenity_selections: amenitySelections,
    company_default_amenity_conflicts: companyDefaultAmenityConflicts(amenitySelections),
    legacy_amenity_candidates: legacyAmenityCandidateSelections(amenities),
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
    checkin_time: guestSiteTimeForStorage(row?.checkin_time),
    checkout_time: guestSiteTimeForStorage(row?.checkout_time),
    location_note: String(row?.location_note || '').trim(),
    price_label: String(row?.price_label || ''),
    booking_highlights: bookingHighlights,
  }
  return {
    ...summary,
    publish_readiness: publishReadiness({
      hero_title: summary.hero_title,
      short_description: summary.short_description,
      long_description: summary.long_description,
      hero_image_url: summary.hero_image_url,
      gallery_urls: summary.gallery_urls,
      public_region_label: summary.public_region_label,
      capacity: summary.capacity,
      checkin_time: summary.checkin_time,
      checkout_time: summary.checkout_time,
      feature_tags: summary.feature_tags,
      house_rules: summary.house_rules,
      booking_highlights: summary.booking_highlights,
      amenity_selections: summary.amenity_selections,
    }),
  }
}

function shapePublicPropertySummary(row: any) {
  const galleryUrls = stringList(row?.gallery_urls)
  const heroImageUrl = String(row?.hero_image_url || '').trim() || galleryUrls[0] || ''
  const capacity = Number(row?.public_capacity_override ?? row?.capacity ?? 0) || 0
  const inferred = inferRoomCountsFromType(String(row?.type || ''))
  const amenityItems = publicAmenityItems(row?.amenity_selections, row?.amenities)
  const effectivePolicy: GuestSiteEffectivePolicy = row?._effective_stay_policy || resolveEffectivePolicy({
    legacy: {
      house_rules: row?.house_rules,
      checkin_time: row?.checkin_time,
      checkout_time: row?.checkout_time,
    },
  })
  return {
    id: String(row?.id || ''),
    type: String(row?.type || ''),
    capacity,
    public_capacity_override: row?.public_capacity_override == null ? null : Number(row.public_capacity_override),
    public_region_label: String(row?.public_region_label || '').trim(),
    hero_title: String(row?.hero_title || '').trim(),
    short_description: String(row?.short_description || '').trim(),
    long_description: String(row?.long_description || '').trim(),
    hero_image_url: heroImageUrl,
    gallery_urls: heroImageUrl ? Array.from(new Set([heroImageUrl, ...galleryUrls])) : galleryUrls,
    feature_tags: stringList(row?.feature_tags),
    amenities: amenityItems.map((item) => item.label),
    amenity_items: amenityItems,
    house_rules: effectivePolicy.house_rules,
    cancellation_policy: effectivePolicy.cancellation_policy,
    stay_services: effectivePolicy.stay_services,
    sort_order: Number(row?.sort_order || 0),
    is_published: !!row?.is_published,
    bedroom_count: row?.bedroom_count == null ? inferred.bedroom_count : Number(row.bedroom_count),
    bathroom_count: row?.bathroom_count == null ? inferred.bathroom_count : Number(row.bathroom_count),
    bed_count: row?.bed_count == null ? null : Number(row.bed_count),
    checkin_time: effectivePolicy.checkin_time,
    checkout_time: effectivePolicy.checkout_time,
    price_label: String(row?.price_label || '').trim(),
    booking_highlights: stringList(row?.booking_highlights),
  }
}

async function translateSiteConfig(config: GuestSiteConfig, locale: string) {
  const targetLocale = normalizeLocale(locale)
  if (targetLocale === DEFAULT_CONTENT_LOCALE || targetLocale === 'en') return config
  const translated = await readTranslatedPayload('config', 'home', targetLocale, {
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

async function translatePropertySummary(summary: ReturnType<typeof shapePublicPropertySummary>, locale: string) {
  const targetLocale = normalizeLocale(locale)
  if (targetLocale === DEFAULT_CONTENT_LOCALE || targetLocale === 'en') return summary
  const translated = await readTranslatedPayload('property', summary.id, targetLocale, {
    hero_title: summary.hero_title,
    short_description: summary.short_description,
    long_description: summary.long_description,
    feature_tags: summary.feature_tags,
    amenities: summary.amenities,
    house_rules: summary.house_rules,
    public_region_label: summary.public_region_label,
    type: summary.type,
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

function shapeAmenityTemplate(row: any): GuestSiteAmenityTemplate {
  const now = new Date().toISOString()
  const createdAt = new Date(row?.created_at || now)
  const updatedAt = new Date(row?.updated_at || row?.created_at || now)
  return {
    id: String(row?.id || ''),
    scope: row?.scope === 'building' ? 'building' : 'company',
    scope_key: String(row?.scope_key || '').trim(),
    name: String(row?.name || '').trim(),
    amenity_candidates: normalizeAmenityTemplateCandidates(row?.amenity_candidates),
    is_active: row?.is_active !== false,
    created_at: Number.isNaN(createdAt.getTime()) ? now : createdAt.toISOString(),
    updated_at: Number.isNaN(updatedAt.getTime()) ? now : updatedAt.toISOString(),
    created_by: row?.created_by == null ? null : String(row.created_by),
    updated_by: row?.updated_by == null ? null : String(row.updated_by),
  }
}

async function buildingScopeExists(scopeKey: string) {
  if (!scopeKey) return false
  if (hasPg && pgPool) {
    const result = await pgPool.query(
      `SELECT 1
         FROM properties
        WHERE COALESCE(archived, false)=false
          AND BTRIM(COALESCE(building_name, ''))=$1
        LIMIT 1`,
      [scopeKey],
    )
    return !!result?.rows?.length
  }
  const { db } = require('../store')
  return (Array.isArray(db?.properties) ? db.properties : []).some((property: any) => (
    !property?.archived && String(property?.building_name || '').trim() === scopeKey
  ))
}

async function listAmenityTemplates(buildingName: string, includeInactive: boolean) {
  const scopeKey = String(buildingName || '').trim()
  if (hasPg && pgPool) {
    assertGuestSiteAmenityTemplatesSchemaReady()
    const result = await pgPool.query(
      `SELECT id, scope, scope_key, name, amenity_candidates, is_active, created_at, updated_at, created_by, updated_by
         FROM guest_site_amenity_templates
        WHERE (scope='company' OR (scope='building' AND scope_key=$1))
          AND ($2::boolean OR is_active=true)
        ORDER BY scope ASC, LOWER(name) ASC, updated_at DESC`,
      [scopeKey, includeInactive],
    )
    return (result?.rows || []).map(shapeAmenityTemplate)
  }
  return fallbackStore.amenityTemplates
    .filter((template) => template.scope === 'company' || (template.scope === 'building' && template.scope_key === scopeKey))
    .filter((template) => includeInactive || template.is_active)
    .sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name) || b.updated_at.localeCompare(a.updated_at))
    .map((template) => ({ ...template, amenity_candidates: template.amenity_candidates.map((candidate) => ({ ...candidate })) }))
}

async function createAmenityTemplate(
  input: z.infer<typeof amenityTemplateCreateSchema>,
  userId: string | null,
) {
  const scopeKey = input.scope === 'company' ? '' : input.scope_key.trim()
  if (input.scope === 'building' && !await buildingScopeExists(scopeKey)) return null
  const now = new Date().toISOString()
  const template = shapeAmenityTemplate({
    id: uuidv4(),
    scope: input.scope,
    scope_key: scopeKey,
    name: input.name,
    amenity_candidates: input.amenity_candidates,
    is_active: true,
    created_at: now,
    updated_at: now,
    created_by: userId,
    updated_by: userId,
  })
  if (hasPg && pgPool) {
    assertGuestSiteAmenityTemplatesSchemaReady()
    const result = await pgPool.query(
      `INSERT INTO guest_site_amenity_templates
         (id, scope, scope_key, name, amenity_candidates, is_active, created_at, updated_at, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,true,now(),now(),$6,$6)
       RETURNING id, scope, scope_key, name, amenity_candidates, is_active, created_at, updated_at, created_by, updated_by`,
      [template.id, template.scope, template.scope_key, template.name, JSON.stringify(template.amenity_candidates), userId],
    )
    return shapeAmenityTemplate(result?.rows?.[0])
  }
  const duplicate = fallbackStore.amenityTemplates.some((current) => (
    current.scope === template.scope
    && current.scope_key.toLowerCase() === template.scope_key.toLowerCase()
    && current.name.toLowerCase() === template.name.toLowerCase()
  ))
  if (duplicate) {
    const error: any = new Error('amenity_template_name_exists')
    error.code = '23505'
    throw error
  }
  fallbackStore.amenityTemplates.push(template)
  return template
}

async function updateAmenityTemplate(
  templateId: string,
  input: z.infer<typeof amenityTemplatePatchSchema>,
  userId: string | null,
) {
  if (hasPg && pgPool) {
    assertGuestSiteAmenityTemplatesSchemaReady()
    const result = await pgPool.query(
      `UPDATE guest_site_amenity_templates
          SET name=COALESCE($2,name),
              amenity_candidates=COALESCE($3::jsonb,amenity_candidates),
              is_active=COALESCE($4,is_active),
              updated_at=now(),
              updated_by=$5
        WHERE id=$1
        RETURNING id, scope, scope_key, name, amenity_candidates, is_active, created_at, updated_at, created_by, updated_by`,
      [
        templateId,
        input.name ?? null,
        input.amenity_candidates === undefined ? null : JSON.stringify(input.amenity_candidates),
        input.is_active ?? null,
        userId,
      ],
    )
    return result?.rows?.[0] ? shapeAmenityTemplate(result.rows[0]) : null
  }
  const index = fallbackStore.amenityTemplates.findIndex((template) => template.id === templateId)
  if (index < 0) return null
  const current = fallbackStore.amenityTemplates[index]
  const next = shapeAmenityTemplate({
    ...current,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.amenity_candidates === undefined ? {} : { amenity_candidates: input.amenity_candidates }),
    ...(input.is_active === undefined ? {} : { is_active: input.is_active }),
    updated_at: new Date().toISOString(),
    updated_by: userId,
  })
  const duplicate = fallbackStore.amenityTemplates.some((template, templateIndex) => (
    templateIndex !== index
    && template.scope === next.scope
    && template.scope_key.toLowerCase() === next.scope_key.toLowerCase()
    && template.name.toLowerCase() === next.name.toLowerCase()
  ))
  if (duplicate) {
    const error: any = new Error('amenity_template_name_exists')
    error.code = '23505'
    throw error
  }
  fallbackStore.amenityTemplates[index] = next
  return next
}

export const publicRouter = Router()
export const adminRouter = Router()

function guestSiteReadError(res: any, error: any, fallbackMessage: string) {
  if (error instanceof GuestSiteSchemaNotReady || error?.code === 'guest_site_schema_not_ready') {
    return res.status(503).json({ message: 'guest_site_schema_not_ready' })
  }
  if (error instanceof GuestSiteContactMessagesSchemaNotReady || error?.code === 'guest_site_contact_messages_schema_not_ready') {
    return res.status(503).json({ message: 'guest_site_contact_messages_schema_not_ready' })
  }
  if (error instanceof GuestSiteAmenitySchemaNotReady || error?.code === 'guest_site_amenity_schema_not_ready') {
    return res.status(503).json({ message: 'guest_site_amenity_schema_not_ready' })
  }
  if (error instanceof GuestSiteAmenityTemplatesSchemaNotReady || error?.code === 'guest_site_amenity_templates_schema_not_ready') {
    return res.status(503).json({ message: 'guest_site_amenity_templates_schema_not_ready' })
  }
  if (error instanceof GuestSiteStayPoliciesSchemaNotReady || error?.code === 'guest_site_stay_policies_schema_not_ready') {
    return res.status(503).json({ message: 'guest_site_stay_policies_schema_not_ready' })
  }
  if (error instanceof GuestSitePolicyConflict || error instanceof GuestSitePolicyValidationError || error instanceof GuestSitePolicyNotFound) {
    const details = (error as any).details
    return res.status(error.status).json({ message: error.code, ...(details ? { details } : {}) })
  }
  return res.status(500).json({ message: String(error?.message || fallbackMessage) })
}

function parseStayPolicySection(value: unknown): GuestSitePolicySection | null {
  const parsed = stayPolicySectionSchema.safeParse(String(value || '').trim())
  return parsed.success ? parsed.data : null
}

function replaceEffectivePolicySection(
  current: GuestSiteEffectivePolicy,
  section: GuestSitePolicySection,
  content: unknown,
  source: GuestSiteEffectivePolicy['section_sources'][GuestSitePolicySection],
) {
  const normalized: any = normalizePolicyContent(section, content)
  const next: GuestSiteEffectivePolicy = {
    ...current,
    house_rules: [...current.house_rules],
    stay_services: current.stay_services.map((service) => ({ ...service })),
    section_sources: { ...current.section_sources, [section]: source },
  }
  if (section === 'house_rules') next.house_rules = normalized.items
  else if (section === 'cancellation_policy') next.cancellation_policy = normalized.body
  else if (section === 'stay_times') {
    next.checkin_time = normalized.checkin_time
    next.checkout_time = normalized.checkout_time
  } else next.stay_services = normalized.services
  return next
}

function policyPreviewPayload(
  row: any,
  section: GuestSitePolicySection,
  content: unknown,
  source: 'follow_company' | 'override',
) {
  const current: GuestSiteEffectivePolicy = row?._effective_stay_policy || resolveEffectivePolicy({
    legacy: { house_rules: row?.house_rules, checkin_time: row?.checkin_time, checkout_time: row?.checkout_time },
  })
  const candidate = replaceEffectivePolicySection(current, section, content, source)
  const mode = row?._stay_policy_modes?.[section]?.mode || 'legacy'
  return {
    property_id: String(row?.id || ''),
    section,
    current_mode: mode,
    applies_without_mode_change: mode === source,
    current_property: shapePublicPropertySummary({ ...row, _effective_stay_policy: current }),
    candidate_property: shapePublicPropertySummary({ ...row, _effective_stay_policy: candidate }),
  }
}

publicRouter.get('/guest-site/config', async (_req, res) => {
  try {
    const locale = normalizeLocale((_req.query as any)?.locale)
    const data = await translateSiteConfig(await getSiteConfigRecord(), locale)
    return res.json(data)
  } catch (e: any) {
    return guestSiteReadError(res, e, 'guest_site_config_failed')
  }
})

publicRouter.get('/guest-site/stats', async (_req, res) => {
  try {
    if (hasPg && pgPool) {
      const result = await pgPool.query(
        `SELECT COUNT(*)::int AS properties_managed_to_date, now() AS as_of
           FROM properties`,
      )
      const row = result?.rows?.[0] || {}
      return res.json({
        properties_managed_to_date: Math.max(0, Number(row.properties_managed_to_date || 0)),
        as_of: row.as_of || new Date().toISOString(),
      })
    }
    const { db } = require('../store')
    return res.json({
      properties_managed_to_date: Array.isArray(db?.properties) ? db.properties.length : 0,
      as_of: new Date().toISOString(),
    })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'guest_site_stats_failed') })
  }
})

publicRouter.get('/guest-site/properties', async (req, res) => {
  try {
    const featuredOnly = String((req.query as any)?.featured || '').trim() === 'true'
    const locale = normalizeLocale((req.query as any)?.locale)
    const rows = await listPropertiesWithDisplay(false)
    const list = await Promise.all(rows.map((row: any) => translatePropertySummary(shapePublicPropertySummary(row), locale)))
    const out = featuredOnly ? list.slice(0, 6) : list
    return res.json(out)
  } catch (e: any) {
    return guestSiteReadError(res, e, 'guest_site_properties_failed')
  }
})

publicRouter.get('/guest-site/properties/:id', async (req, res) => {
  try {
    const locale = normalizeLocale((req.query as any)?.locale)
    const row = await getPublicPropertyWithDisplay(String(req.params.id || ''))
    if (!row) return res.status(404).json({ message: 'property_not_found' })
    return res.json(await translatePropertySummary(shapePublicPropertySummary(row), locale))
  } catch (e: any) {
    return guestSiteReadError(res, e, 'guest_site_property_failed')
  }
})

publicRouter.get('/guest-site/properties/:id/availability', async (req, res) => {
  try {
    const propertyId = String(req.params.id || '').trim()
    const row = await getPublicPropertyWithDisplay(propertyId)
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
    return guestSiteReadError(res, e, 'guest_site_availability_failed')
  }
})

publicRouter.post('/guest-site/inquiries', async (req, res) => {
  const parsed = inquiryCreateSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const payload = parsed.data
  if (payload.checkout <= payload.checkin) return res.status(400).json({ message: 'checkout_must_be_after_checkin' })
  try {
    const row = await getPublicPropertyWithDisplay(payload.property_id)
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
      assertGuestSiteSchemaReady()
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
    return guestSiteReadError(res, e, 'guest_site_inquiry_failed')
  }
})

publicRouter.post('/guest-site/contact-messages', async (req, res) => {
  const parsed = contactMessageCreateSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ message: 'invalid_contact_message', details: parsed.error.format() })
  if (!hasPg || !pgPool) return res.status(503).json({ message: 'contact_storage_unavailable' })
  try {
    assertGuestSiteContactMessagesSchemaReady()
  } catch (error) {
    return guestSiteReadError(res, error, 'guest_site_contact_message_failed')
  }

  const payload = parsed.data
  let guestName = ''
  let message = ''
  if ('inquiry_type' in payload) {
    guestName = payload.name.replace(/\s+/g, ' ').trim()
    message = propertyManagementContactMessage(payload)
  } else {
    guestName = `${payload.first_name} ${payload.last_name}`.replace(/\s+/g, ' ').trim()
    message = payload.message
  }
  const guestEmail = payload.email.toLowerCase()
  const dedupeHash = contactMessageDedupeHash({ guestName, guestEmail, message })
  const client = await pgPool.connect().catch(() => null)
  if (!client) return res.status(503).json({ message: 'contact_storage_unavailable' })

  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['guest-site-contact-rate-limit:global'])
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`guest-site-contact-rate-limit:email:${guestEmail}`])
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [dedupeHash])
    const duplicate = await client.query(
      `SELECT id
         FROM guest_site_contact_messages
        WHERE submission_id = $1::uuid
           OR (dedupe_hash = $2 AND created_at >= now() - interval '10 minutes')
        ORDER BY created_at DESC
        LIMIT 1`,
      [payload.submission_id, dedupeHash],
    )
    const existingId = String(duplicate?.rows?.[0]?.id || '').trim()
    if (existingId) {
      await client.query('COMMIT')
      return res.json({ ok: true, id: existingId, duplicate: true })
    }

    const recent = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE guest_email = $1)::int AS email_count,
         COUNT(*)::int AS total_count
       FROM guest_site_contact_messages
       WHERE created_at >= now() - interval '10 minutes'`,
      [guestEmail],
    )
    const emailCount = Number(recent?.rows?.[0]?.email_count || 0)
    const totalCount = Number(recent?.rows?.[0]?.total_count || 0)
    if (emailCount >= 3 || totalCount >= 100) {
      await client.query('ROLLBACK')
      res.set?.('Retry-After', '600')
      return res.status(429).json({ message: 'contact_rate_limited' })
    }

    const id = uuidv4()
    await client.query(
      `INSERT INTO guest_site_contact_messages
        (id, submission_id, guest_name, guest_email, message, dedupe_hash, status, created_at, updated_at)
       VALUES ($1, $2::uuid, $3, $4, $5, $6, 'new', now(), now())`,
      [id, payload.submission_id, guestName, guestEmail, message, dedupeHash],
    )
    await client.query('COMMIT')
    return res.status(201).json({ ok: true, id, duplicate: false })
  } catch (e: any) {
    try { await client.query('ROLLBACK') } catch {}
    console.error('[guest-site/contact-messages] persistence failed', e)
    return res.status(500).json({ message: 'guest_site_contact_message_failed' })
  } finally {
    client.release()
  }
})

adminRouter.get('/guest-site/config', requirePerm('guest_site_settings.view'), async (_req, res) => {
  try {
    return res.json(await getSiteConfigRecord())
  } catch (e: any) {
    return guestSiteReadError(res, e, 'guest_site_config_failed')
  }
})

adminRouter.put('/guest-site/config', requirePerm('guest_site_settings.write'), async (req, res) => {
  const parsed = siteConfigSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    const userId = String((req as any)?.user?.sub || '').trim() || null
    return res.json(await saveSiteConfigRecord(parsed.data, userId))
  } catch (e: any) {
    return guestSiteReadError(res, e, 'guest_site_config_save_failed')
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

adminRouter.get('/guest-site/stay-policies', requirePerm('guest_site_settings.view'), async (_req, res) => {
  try {
    assertGuestSiteStayPoliciesSchemaReady()
    if (!hasPg || !pgPool) return res.status(503).json({ message: 'guest_site_stay_policy_storage_unavailable' })
    return res.json({ schema_ready: true, ...(await getCompanyPolicyOverview(pgPool as any)) })
  } catch (e: any) {
    return guestSiteReadError(res, e, 'guest_site_stay_policy_overview_failed')
  }
})

adminRouter.put('/guest-site/stay-policies/company/:section/draft', requirePerm('guest_site_settings.write'), async (req, res) => {
  const section = parseStayPolicySection(req.params.section)
  const parsed = stayPolicyDraftSchema.safeParse(req.body || {})
  if (!section) return res.status(400).json({ message: 'invalid_policy_section' })
  if (!parsed.success) return res.status(400).json({ message: 'invalid_policy_draft', details: parsed.error.format() })
  try {
    assertGuestSiteStayPoliciesSchemaReady()
    if (!hasPg || !pgPool) return res.status(503).json({ message: 'guest_site_stay_policy_storage_unavailable' })
    const actorId = String((req as any)?.user?.sub || '').trim() || null
    return res.json(await savePolicyDraft(pgPool as any, {
      scopeType: 'company',
      propertyId: null,
      section,
      expectedRevision: parsed.data.expected_revision,
      content: parsed.data.content,
      actorId,
    }))
  } catch (e: any) {
    return guestSiteReadError(res, e, 'guest_site_stay_policy_draft_save_failed')
  }
})

adminRouter.post('/guest-site/stay-policies/company/:section/impact', requirePerm('guest_site_settings.view'), async (req, res) => {
  const section = parseStayPolicySection(req.params.section)
  const parsed = stayPolicyRevisionSchema.safeParse(req.body || {})
  if (!section) return res.status(400).json({ message: 'invalid_policy_section' })
  if (!parsed.success) return res.status(400).json({ message: 'invalid_policy_revision', details: parsed.error.format() })
  try {
    assertGuestSiteStayPoliciesSchemaReady()
    if (!hasPg || !pgPool) return res.status(503).json({ message: 'guest_site_stay_policy_storage_unavailable' })
    return res.json(await getCompanyPolicyImpact(pgPool as any, section, parsed.data.expected_revision))
  } catch (e: any) {
    return guestSiteReadError(res, e, 'guest_site_stay_policy_impact_failed')
  }
})

adminRouter.post('/guest-site/stay-policies/company/:section/preview', requirePerm('guest_site_settings.view'), async (req, res) => {
  const section = parseStayPolicySection(req.params.section)
  const parsed = stayPolicyPreviewSchema.safeParse(req.body || {})
  if (!section) return res.status(400).json({ message: 'invalid_policy_section' })
  if (!parsed.success) return res.status(400).json({ message: 'invalid_policy_preview', details: parsed.error.format() })
  try {
    assertGuestSiteStayPoliciesSchemaReady()
    if (!hasPg || !pgPool) return res.status(503).json({ message: 'guest_site_stay_policy_storage_unavailable' })
    const draft = await readPolicyVersion(pgPool as any, {
      scopeType: 'company', propertyId: null, section, status: 'draft',
    })
    if (!draft) throw new GuestSitePolicyNotFound('policy_draft_not_found')
    if (draft.revision !== parsed.data.expected_revision) {
      throw new GuestSitePolicyConflict('policy_revision_conflict', {
        expected_revision: parsed.data.expected_revision,
        actual_revision: draft.revision,
      })
    }
    const property = await getPropertyWithDisplay(parsed.data.property_id, true)
    if (!property) throw new GuestSitePolicyNotFound('property_not_found')
    return res.json(policyPreviewPayload(property, section, draft.content, 'follow_company'))
  } catch (e: any) {
    return guestSiteReadError(res, e, 'guest_site_stay_policy_preview_failed')
  }
})

adminRouter.post(
  '/guest-site/stay-policies/company/:section/publish',
  requirePerm('guest_site_settings.write'),
  requirePerm('guest_site_policies.publish'),
  async (req, res) => {
    const section = parseStayPolicySection(req.params.section)
    const parsed = stayPolicyPublishSchema.safeParse(req.body || {})
    if (!section) return res.status(400).json({ message: 'invalid_policy_section' })
    if (!parsed.success) return res.status(400).json({ message: 'invalid_policy_publish', details: parsed.error.format() })
    try {
      assertGuestSiteStayPoliciesSchemaReady()
      if (!hasPg || !pgPool) return res.status(503).json({ message: 'guest_site_stay_policy_storage_unavailable' })
      const actorId = String((req as any)?.user?.sub || '').trim() || null
      return res.json(await publishCompanyPolicy(pgPool as any, {
        section,
        expectedRevision: parsed.data.expected_revision,
        impactHash: parsed.data.impact_hash.toLowerCase(),
        actorId,
      }))
    } catch (e: any) {
      return guestSiteReadError(res, e, 'guest_site_stay_policy_publish_failed')
    }
  },
)

adminRouter.get('/guest-site/stay-policies/properties/:propertyId', requirePerm('guest_site_properties.view'), async (req, res) => {
  const propertyId = String(req.params.propertyId || '').trim()
  if (!propertyId) return res.status(400).json({ message: 'property_id_required' })
  try {
    assertGuestSiteStayPoliciesSchemaReady()
    if (!hasPg || !pgPool) return res.status(503).json({ message: 'guest_site_stay_policy_storage_unavailable' })
    const property = await getPropertyWithDisplay(propertyId, true)
    if (!property) throw new GuestSitePolicyNotFound('property_not_found')
    return res.json({
      ...(await getPropertyPolicyOverview(pgPool as any, String(property.id || propertyId))),
      effective_policy: property._effective_stay_policy,
      public_property: shapePublicPropertySummary(property),
    })
  } catch (e: any) {
    return guestSiteReadError(res, e, 'guest_site_property_policy_overview_failed')
  }
})

adminRouter.put('/guest-site/stay-policies/properties/:propertyId/:section/draft', requirePerm('guest_site_properties.write'), async (req, res) => {
  const propertyId = String(req.params.propertyId || '').trim()
  const section = parseStayPolicySection(req.params.section)
  const parsed = stayPolicyDraftSchema.safeParse(req.body || {})
  if (!propertyId) return res.status(400).json({ message: 'property_id_required' })
  if (!section) return res.status(400).json({ message: 'invalid_policy_section' })
  if (!parsed.success) return res.status(400).json({ message: 'invalid_policy_draft', details: parsed.error.format() })
  try {
    assertGuestSiteStayPoliciesSchemaReady()
    if (!hasPg || !pgPool) return res.status(503).json({ message: 'guest_site_stay_policy_storage_unavailable' })
    const actorId = String((req as any)?.user?.sub || '').trim() || null
    return res.json(await savePolicyDraft(pgPool as any, {
      scopeType: 'property',
      propertyId,
      section,
      expectedRevision: parsed.data.expected_revision,
      content: parsed.data.content,
      actorId,
    }))
  } catch (e: any) {
    return guestSiteReadError(res, e, 'guest_site_property_policy_draft_save_failed')
  }
})

adminRouter.post('/guest-site/stay-policies/properties/:propertyId/:section/preview', requirePerm('guest_site_properties.view'), async (req, res) => {
  const propertyId = String(req.params.propertyId || '').trim()
  const section = parseStayPolicySection(req.params.section)
  const parsed = stayPolicyRevisionSchema.safeParse(req.body || {})
  if (!propertyId) return res.status(400).json({ message: 'property_id_required' })
  if (!section) return res.status(400).json({ message: 'invalid_policy_section' })
  if (!parsed.success) return res.status(400).json({ message: 'invalid_policy_preview', details: parsed.error.format() })
  try {
    assertGuestSiteStayPoliciesSchemaReady()
    if (!hasPg || !pgPool) return res.status(503).json({ message: 'guest_site_stay_policy_storage_unavailable' })
    const draft = await readPolicyVersion(pgPool as any, {
      scopeType: 'property', propertyId, section, status: 'draft',
    })
    if (!draft) throw new GuestSitePolicyNotFound('policy_draft_not_found')
    if (draft.revision !== parsed.data.expected_revision) {
      throw new GuestSitePolicyConflict('policy_revision_conflict', {
        expected_revision: parsed.data.expected_revision,
        actual_revision: draft.revision,
      })
    }
    const property = await getPropertyWithDisplay(propertyId, true)
    if (!property) throw new GuestSitePolicyNotFound('property_not_found')
    return res.json(policyPreviewPayload(property, section, draft.content, 'override'))
  } catch (e: any) {
    return guestSiteReadError(res, e, 'guest_site_property_policy_preview_failed')
  }
})

adminRouter.put(
  '/guest-site/stay-policies/properties/:propertyId/:section/mode',
  requirePerm('guest_site_properties.write'),
  requirePerm('guest_site_policies.publish'),
  async (req, res) => {
    const propertyId = String(req.params.propertyId || '').trim()
    const section = parseStayPolicySection(req.params.section)
    const parsed = stayPolicyModeSchema.safeParse(req.body || {})
    if (!propertyId) return res.status(400).json({ message: 'property_id_required' })
    if (!section) return res.status(400).json({ message: 'invalid_policy_section' })
    if (!parsed.success) return res.status(400).json({ message: 'invalid_policy_mode', details: parsed.error.format() })
    try {
      assertGuestSiteStayPoliciesSchemaReady()
      if (!hasPg || !pgPool) return res.status(503).json({ message: 'guest_site_stay_policy_storage_unavailable' })
      const actorId = String((req as any)?.user?.sub || '').trim() || null
      return res.json(await setPropertyPolicyMode(pgPool as any, {
        propertyId,
        section,
        mode: parsed.data.mode,
        expectedRevision: parsed.data.expected_revision,
        actorId,
      }))
    } catch (e: any) {
      return guestSiteReadError(res, e, 'guest_site_property_policy_mode_save_failed')
    }
  },
)

adminRouter.post(
  '/guest-site/stay-policies/properties/:propertyId/:section/publish',
  requirePerm('guest_site_properties.write'),
  requirePerm('guest_site_policies.publish'),
  async (req, res) => {
    const propertyId = String(req.params.propertyId || '').trim()
    const section = parseStayPolicySection(req.params.section)
    const parsed = stayPolicyPropertyPublishSchema.safeParse(req.body || {})
    if (!propertyId) return res.status(400).json({ message: 'property_id_required' })
    if (!section) return res.status(400).json({ message: 'invalid_policy_section' })
    if (!parsed.success) return res.status(400).json({ message: 'invalid_policy_publish', details: parsed.error.format() })
    try {
      assertGuestSiteStayPoliciesSchemaReady()
      if (!hasPg || !pgPool) return res.status(503).json({ message: 'guest_site_stay_policy_storage_unavailable' })
      const actorId = String((req as any)?.user?.sub || '').trim() || null
      return res.json(await publishPropertyOverride(pgPool as any, {
        propertyId,
        section,
        expectedRevision: parsed.data.expected_revision,
        expectedModeRevision: parsed.data.expected_mode_revision,
        actorId,
      }))
    } catch (e: any) {
      return guestSiteReadError(res, e, 'guest_site_property_policy_publish_failed')
    }
  },
)

adminRouter.post(
  '/guest-site/stay-policies/:section/bulk-follow',
  requirePerm('guest_site_properties.write'),
  requirePerm('guest_site_policies.publish'),
  async (req, res) => {
    const section = parseStayPolicySection(req.params.section)
    const parsed = stayPolicyBulkFollowSchema.safeParse(req.body || {})
    if (!section) return res.status(400).json({ message: 'invalid_policy_section' })
    if (!parsed.success) return res.status(400).json({ message: 'invalid_policy_bulk_follow', details: parsed.error.format() })
    const uniqueIds = new Set(parsed.success ? parsed.data.items.map((item) => item.property_id) : [])
    if (uniqueIds.size !== parsed.data.items.length) return res.status(400).json({ message: 'duplicate_property_id' })
    try {
      assertGuestSiteStayPoliciesSchemaReady()
      if (!hasPg || !pgPool) return res.status(503).json({ message: 'guest_site_stay_policy_storage_unavailable' })
      const actorId = String((req as any)?.user?.sub || '').trim() || null
      return res.json(await bulkSetPropertyPoliciesToFollow(pgPool as any, {
        section,
        items: parsed.data.items.map((item) => ({ propertyId: item.property_id, expectedRevision: item.expected_revision })),
        actorId,
      }))
    } catch (e: any) {
      return guestSiteReadError(res, e, 'guest_site_property_policy_bulk_follow_failed')
    }
  },
)

adminRouter.get('/guest-site/properties', requirePerm('guest_site_properties.view'), async (_req, res) => {
  try {
    const rows = await listPropertiesWithDisplay(true)
    return res.json(rows.map(shapePropertySummary))
  } catch (e: any) {
    return guestSiteReadError(res, e, 'guest_site_property_list_failed')
  }
})

adminRouter.get('/guest-site/amenity-catalog', requirePerm('guest_site_properties.view'), (_req, res) => {
  return res.json(amenityCatalogPayload())
})

adminRouter.get('/guest-site/amenity-templates', requirePerm('guest_site_properties.view'), async (req, res) => {
  const schemaReady = isGuestSiteAmenityTemplatesSchemaReady()
  if (!schemaReady) return res.json({ schema_ready: false, templates: [] })
  try {
    const buildingName = String((req.query as any)?.building_name || '').trim()
    const includeInactive = String((req.query as any)?.include_inactive || '').trim() === 'true'
    return res.json({ schema_ready: true, templates: await listAmenityTemplates(buildingName, includeInactive) })
  } catch (e: any) {
    return guestSiteReadError(res, e, 'guest_site_amenity_template_list_failed')
  }
})

adminRouter.post('/guest-site/amenity-templates', requirePerm('guest_site_properties.write'), async (req, res) => {
  const parsed = amenityTemplateCreateSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    assertGuestSiteAmenityTemplatesSchemaReady()
    const userId = String((req as any)?.user?.sub || '').trim() || null
    const created = await createAmenityTemplate(parsed.data, userId)
    if (!created) return res.status(400).json({ message: 'building_scope_not_found' })
    return res.status(201).json(created)
  } catch (e: any) {
    if (e?.code === '23505') return res.status(409).json({ message: 'amenity_template_name_exists' })
    return guestSiteReadError(res, e, 'guest_site_amenity_template_create_failed')
  }
})

adminRouter.patch('/guest-site/amenity-templates/:templateId', requirePerm('guest_site_properties.write'), async (req, res) => {
  const templateId = String(req.params.templateId || '').trim()
  const parsed = amenityTemplatePatchSchema.safeParse(req.body || {})
  if (!templateId) return res.status(400).json({ message: 'template_id_required' })
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    assertGuestSiteAmenityTemplatesSchemaReady()
    const userId = String((req as any)?.user?.sub || '').trim() || null
    const updated = await updateAmenityTemplate(templateId, parsed.data, userId)
    if (!updated) return res.status(404).json({ message: 'amenity_template_not_found' })
    return res.json(updated)
  } catch (e: any) {
    if (e?.code === '23505') return res.status(409).json({ message: 'amenity_template_name_exists' })
    return guestSiteReadError(res, e, 'guest_site_amenity_template_update_failed')
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
    const candidateSummary = shapePropertySummary({ ...property, ...next })
    if (next.is_published && !candidateSummary.publish_readiness.ready) {
      return res.status(400).json({
        message: 'property_not_ready_to_publish',
        publish_readiness: candidateSummary.publish_readiness,
      })
    }
    const userId = String((req as any)?.user?.sub || '').trim() || null
    if (hasPg && pgPool) {
      assertGuestSiteSchemaReady()
      assertGuestSiteAmenitySelectionsSchemaReady()
      const rs = await pgPool.query(
        `INSERT INTO guest_site_property_displays
          (property_id, is_published, hero_title, short_description, long_description, hero_image_url, gallery_urls, feature_tags, amenities, amenity_selections, house_rules, sort_order, public_region_label, public_capacity_override, bedroom_count, bathroom_count, bed_count, checkin_time, checkout_time, location_note, price_label, booking_highlights, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,now(),$23)
         ON CONFLICT (property_id) DO UPDATE SET
           is_published = EXCLUDED.is_published,
           hero_title = EXCLUDED.hero_title,
           short_description = EXCLUDED.short_description,
           long_description = EXCLUDED.long_description,
           hero_image_url = EXCLUDED.hero_image_url,
           gallery_urls = EXCLUDED.gallery_urls,
           feature_tags = EXCLUDED.feature_tags,
           amenities = EXCLUDED.amenities,
           amenity_selections = EXCLUDED.amenity_selections,
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
          JSON.stringify(next.amenity_selections),
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
    return guestSiteReadError(res, e, 'guest_site_property_save_failed')
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
      assertGuestSiteSchemaReady()
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
    return guestSiteReadError(res, e, 'guest_site_inquiry_list_failed')
  }
})

adminRouter.patch('/guest-site/inquiries/:id', requirePerm('guest_site_inquiries.write'), async (req, res) => {
  const inquiryId = String(req.params.id || '').trim()
  const parsed = inquiryPatchSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg && pgPool) {
      assertGuestSiteSchemaReady()
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
    return guestSiteReadError(res, e, 'guest_site_inquiry_save_failed')
  }
})

adminRouter.get('/guest-site/contact-messages', requirePerm('guest_site_inquiries.view'), async (req, res) => {
  if (!hasPg || !pgPool) return res.status(503).json({ message: 'contact_storage_unavailable' })
  const statusRaw = String((req.query as any)?.status || '').trim()
  const parsedStatus = statusRaw ? contactMessageStatusSchema.safeParse(statusRaw) : null
  if (parsedStatus && !parsedStatus.success) return res.status(400).json({ message: 'invalid_contact_message_status' })
  try {
    const rs = statusRaw
      ? await pgPool.query(
          `SELECT id, submission_id, guest_name, guest_email, message, status, admin_note,
                  handled_by, handled_at, created_at, updated_at
             FROM guest_site_contact_messages
            WHERE status = $1
            ORDER BY created_at DESC`,
          [statusRaw],
        )
      : await pgPool.query(
          `SELECT id, submission_id, guest_name, guest_email, message, status, admin_note,
                  handled_by, handled_at, created_at, updated_at
             FROM guest_site_contact_messages
            ORDER BY created_at DESC`,
        )
    return res.json((Array.isArray(rs?.rows) ? rs.rows : []) as GuestSiteContactMessage[])
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'guest_site_contact_message_list_failed') })
  }
})

adminRouter.patch('/guest-site/contact-messages/:id', requirePerm('guest_site_inquiries.write'), async (req, res) => {
  if (!hasPg || !pgPool) return res.status(503).json({ message: 'contact_storage_unavailable' })
  const messageId = String(req.params.id || '').trim()
  const parsed = contactMessagePatchSchema.safeParse(req.body || {})
  if (!messageId) return res.status(400).json({ message: 'contact_message_id_required' })
  if (!parsed.success) return res.status(400).json({ message: 'invalid_contact_message_update', details: parsed.error.format() })

  const hasAdminNote = parsed.data.admin_note !== undefined
  const userId = String((req as any)?.user?.sub || '').trim() || null
  try {
    const rs = await pgPool.query(
      `UPDATE guest_site_contact_messages
          SET status = COALESCE($2, status),
              admin_note = CASE WHEN $3::boolean THEN $4::text ELSE admin_note END,
              handled_by = CASE
                WHEN $2::text IS NULL THEN handled_by
                WHEN $2 = 'new' THEN NULL
                ELSE $5
              END,
              handled_at = CASE
                WHEN $2::text IS NULL THEN handled_at
                WHEN $2 = 'new' THEN NULL
                ELSE now()
              END,
              updated_at = now()
        WHERE id = $1
        RETURNING id, submission_id, guest_name, guest_email, message, status, admin_note,
                  handled_by, handled_at, created_at, updated_at`,
      [messageId, parsed.data.status || null, hasAdminNote, parsed.data.admin_note ?? null, userId],
    )
    const row = rs?.rows?.[0]
    if (!row) return res.status(404).json({ message: 'contact_message_not_found' })
    return res.json(row as GuestSiteContactMessage)
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'guest_site_contact_message_save_failed') })
  }
})
