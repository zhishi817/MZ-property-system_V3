import { v4 as uuidv4 } from 'uuid'
import {
  GUEST_SITE_POLICY_SECTIONS,
  emptyPolicyContent,
  normalizePolicyContent,
  policySectionReadiness,
  resolveEffectivePolicy,
  stablePolicyHash,
  type GuestSiteEffectivePolicy,
  type GuestSitePolicyContent,
  type GuestSitePolicyMode,
  type GuestSitePolicySection,
} from './guestSiteStayPolicy'

export type PolicyQueryable = {
  query: (text: string, params?: any[]) => Promise<{ rows?: any[]; rowCount?: number }>
}

export type PolicyPool = PolicyQueryable & {
  connect: () => Promise<PolicyQueryable & { release?: () => void }>
}

export type PolicyVersionRow = {
  id: string
  scope_type: 'company' | 'property'
  property_id: string | null
  section: GuestSitePolicySection
  status: 'draft' | 'published' | 'archived'
  revision: number
  content: GuestSitePolicyContent
  supersedes_id: string | null
  created_at: string
  created_by: string | null
  updated_at: string
  updated_by: string | null
  published_at: string | null
  published_by: string | null
}

export type PropertyPolicyModeRow = {
  property_id: string
  section: GuestSitePolicySection
  mode: GuestSitePolicyMode
  revision: number
  decided_at: string
  decided_by: string | null
  updated_at: string
  updated_by: string | null
}

export class GuestSitePolicyConflict extends Error {
  readonly status = 409
  readonly code: string
  readonly details?: Record<string, unknown>

  constructor(code: string, details?: Record<string, unknown>) {
    super(code)
    this.name = 'GuestSitePolicyConflict'
    this.code = code
    this.details = details
  }
}

export class GuestSitePolicyValidationError extends Error {
  readonly status = 400
  readonly code: string
  readonly details?: Record<string, unknown>

  constructor(code: string, details?: Record<string, unknown>) {
    super(code)
    this.name = 'GuestSitePolicyValidationError'
    this.code = code
    this.details = details
  }
}

export class GuestSitePolicyNotFound extends Error {
  readonly status = 404
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'GuestSitePolicyNotFound'
    this.code = code
  }
}

function shapeVersion(row: any): PolicyVersionRow {
  return {
    id: String(row?.id || ''),
    scope_type: row?.scope_type === 'property' ? 'property' : 'company',
    property_id: row?.property_id == null ? null : String(row.property_id),
    section: row?.section as GuestSitePolicySection,
    status: row?.status as PolicyVersionRow['status'],
    revision: Math.max(1, Number(row?.revision || 1)),
    content: normalizePolicyContent(row?.section as GuestSitePolicySection, row?.content),
    supersedes_id: row?.supersedes_id == null ? null : String(row.supersedes_id),
    created_at: String(row?.created_at || ''),
    created_by: row?.created_by == null ? null : String(row.created_by),
    updated_at: String(row?.updated_at || ''),
    updated_by: row?.updated_by == null ? null : String(row.updated_by),
    published_at: row?.published_at == null ? null : String(row.published_at),
    published_by: row?.published_by == null ? null : String(row.published_by),
  }
}

function shapeMode(row: any): PropertyPolicyModeRow {
  return {
    property_id: String(row?.property_id || ''),
    section: row?.section as GuestSitePolicySection,
    mode: row?.mode as GuestSitePolicyMode,
    revision: Math.max(1, Number(row?.revision || 1)),
    decided_at: String(row?.decided_at || ''),
    decided_by: row?.decided_by == null ? null : String(row.decided_by),
    updated_at: String(row?.updated_at || ''),
    updated_by: row?.updated_by == null ? null : String(row.updated_by),
  }
}

async function withPolicyTransaction<T>(pool: PolicyPool, fn: (client: PolicyQueryable) => Promise<T>, serializable = false) {
  const client = await pool.connect()
  try {
    await client.query(serializable ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN')
    const value = await fn(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    throw error
  } finally {
    client.release?.()
  }
}

function subjectKey(scopeType: 'company' | 'property', propertyId: string | null, section: GuestSitePolicySection) {
  return `guest-site-stay-policy:${scopeType}:${propertyId || 'company'}:${section}`
}

async function lockSubject(client: PolicyQueryable, scopeType: 'company' | 'property', propertyId: string | null, section: GuestSitePolicySection) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [subjectKey(scopeType, propertyId, section)])
}

export async function readPolicyVersion(
  db: PolicyQueryable,
  input: {
    scopeType: 'company' | 'property'
    propertyId: string | null
    section: GuestSitePolicySection
    status: 'draft' | 'published'
    lock?: boolean
  },
) {
  const result = await db.query(
    `SELECT id, scope_type, property_id, section, status, revision, content, supersedes_id,
            created_at, created_by, updated_at, updated_by, published_at, published_by
       FROM guest_site_stay_policy_versions
      WHERE scope_type=$1
        AND property_id IS NOT DISTINCT FROM $2
        AND section=$3
        AND status=$4
      LIMIT 1${input.lock ? ' FOR UPDATE' : ''}`,
    [input.scopeType, input.propertyId, input.section, input.status],
  )
  return result?.rows?.[0] ? shapeVersion(result.rows[0]) : null
}

export async function listPolicyHistory(
  db: PolicyQueryable,
  scopeType: 'company' | 'property',
  propertyId: string | null,
  section: GuestSitePolicySection,
  limit = 20,
) {
  const result = await db.query(
    `SELECT id, scope_type, property_id, section, status, revision, content, supersedes_id,
            created_at, created_by, updated_at, updated_by, published_at, published_by
       FROM guest_site_stay_policy_versions
      WHERE scope_type=$1
        AND property_id IS NOT DISTINCT FROM $2
        AND section=$3
      ORDER BY revision DESC, updated_at DESC
      LIMIT $4`,
    [scopeType, propertyId, section, Math.max(1, Math.min(100, limit))],
  )
  return (result?.rows || []).map(shapeVersion)
}

async function nextRevision(db: PolicyQueryable, scopeType: 'company' | 'property', propertyId: string | null, section: GuestSitePolicySection) {
  const result = await db.query(
    `SELECT COALESCE(MAX(revision), 0)::int AS max_revision
       FROM guest_site_stay_policy_versions
      WHERE scope_type=$1 AND property_id IS NOT DISTINCT FROM $2 AND section=$3`,
    [scopeType, propertyId, section],
  )
  return Math.max(0, Number(result?.rows?.[0]?.max_revision || 0)) + 1
}

async function insertAudit(
  db: PolicyQueryable,
  input: {
    action: 'draft_saved' | 'section_published' | 'mode_changed' | 'bulk_mode_changed'
    scopeType: 'company' | 'property'
    propertyId: string | null
    section: GuestSitePolicySection
    versionId?: string | null
    actorId: string | null
    before?: Record<string, unknown> | null
    after?: Record<string, unknown> | null
    metadata?: Record<string, unknown>
  },
) {
  await db.query(
    `INSERT INTO guest_site_stay_policy_audits
      (id, action, scope_type, property_id, section, version_id, actor_id, before_json, after_json, metadata, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,now())`,
    [
      uuidv4(),
      input.action,
      input.scopeType,
      input.propertyId,
      input.section,
      input.versionId || null,
      input.actorId,
      input.before == null ? null : JSON.stringify(input.before),
      input.after == null ? null : JSON.stringify(input.after),
      JSON.stringify(input.metadata || {}),
    ],
  )
}

export async function savePolicyDraft(
  pool: PolicyPool,
  input: {
    scopeType: 'company' | 'property'
    propertyId: string | null
    section: GuestSitePolicySection
    expectedRevision: number
    content: unknown
    actorId: string | null
  },
) {
  return withPolicyTransaction(pool, async (client) => {
    if (input.scopeType === 'property' && input.propertyId) await assertPropertyExists(client, input.propertyId)
    await lockSubject(client, input.scopeType, input.propertyId, input.section)
    const current = await readPolicyVersion(client, {
      scopeType: input.scopeType,
      propertyId: input.propertyId,
      section: input.section,
      status: 'draft',
      lock: true,
    })
    const actualRevision = current?.revision || 0
    if (actualRevision !== input.expectedRevision) {
      throw new GuestSitePolicyConflict('policy_revision_conflict', {
        expected_revision: input.expectedRevision,
        actual_revision: actualRevision,
      })
    }
    const content = normalizePolicyContent(input.section, input.content)
    let saved: PolicyVersionRow
    if (current) {
      const result = await client.query(
        `UPDATE guest_site_stay_policy_versions
            SET content=$2::jsonb, revision=revision+1, updated_at=now(), updated_by=$3
          WHERE id=$1 AND status='draft'
          RETURNING id, scope_type, property_id, section, status, revision, content, supersedes_id,
                    created_at, created_by, updated_at, updated_by, published_at, published_by`,
        [current.id, JSON.stringify(content), input.actorId],
      )
      saved = shapeVersion(result?.rows?.[0])
    } else {
      const published = await readPolicyVersion(client, {
        scopeType: input.scopeType,
        propertyId: input.propertyId,
        section: input.section,
        status: 'published',
        lock: true,
      })
      const revision = await nextRevision(client, input.scopeType, input.propertyId, input.section)
      const result = await client.query(
        `INSERT INTO guest_site_stay_policy_versions
          (id, scope_type, property_id, section, status, revision, content, supersedes_id,
           created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,'draft',$5,$6::jsonb,$7,now(),$8,now(),$8)
         RETURNING id, scope_type, property_id, section, status, revision, content, supersedes_id,
                   created_at, created_by, updated_at, updated_by, published_at, published_by`,
        [uuidv4(), input.scopeType, input.propertyId, input.section, revision, JSON.stringify(content), published?.id || null, input.actorId],
      )
      saved = shapeVersion(result?.rows?.[0])
    }
    await insertAudit(client, {
      action: 'draft_saved',
      scopeType: input.scopeType,
      propertyId: input.propertyId,
      section: input.section,
      versionId: saved.id,
      actorId: input.actorId,
      before: current ? { revision: current.revision, content: current.content } : null,
      after: { revision: saved.revision, content: saved.content },
    })
    return {
      draft: saved,
      readiness: policySectionReadiness(input.section, saved.content, input.scopeType),
    }
  })
}

function sectionValue(policy: GuestSiteEffectivePolicy, section: GuestSitePolicySection) {
  if (section === 'house_rules') return { items: policy.house_rules }
  if (section === 'cancellation_policy') return { body: policy.cancellation_policy }
  if (section === 'stay_times') return { checkin_time: policy.checkin_time, checkout_time: policy.checkout_time }
  return { services: policy.stay_services }
}

type ImpactSourceRow = {
  property_id: string
  property_code: string
  property_title: string
  is_published: boolean
  mode: GuestSitePolicyMode
  mode_revision: number
  legacy_house_rules: unknown
  legacy_checkin_time: unknown
  legacy_checkout_time: unknown
  override_content: unknown
  override_revision: number
}

export function buildCompanyPolicyImpact(input: {
  section: GuestSitePolicySection
  draft: PolicyVersionRow
  published: PolicyVersionRow | null
  properties: ImpactSourceRow[]
}) {
  const ordered = [...input.properties].sort((a, b) => a.property_id.localeCompare(b.property_id))
  const properties = ordered.map((row) => {
    const modes = { [input.section]: row.mode }
    const legacy = {
      house_rules: row.legacy_house_rules,
      checkin_time: row.legacy_checkin_time,
      checkout_time: row.legacy_checkout_time,
    }
    const overrides = row.override_content == null ? {} : { [input.section]: row.override_content }
    const beforePolicy = resolveEffectivePolicy({
      legacy,
      modes,
      company: input.published ? { [input.section]: input.published.content } : {},
      overrides,
    })
    const afterPolicy = resolveEffectivePolicy({
      legacy,
      modes,
      company: { [input.section]: input.draft.content },
      overrides,
    })
    const before = sectionValue(beforePolicy, input.section)
    const after = sectionValue(afterPolicy, input.section)
    return {
      property_id: row.property_id,
      property_code: row.property_code,
      property_title: row.property_title,
      is_published: row.is_published,
      mode: row.mode,
      mode_revision: row.mode_revision,
      override_revision: row.override_revision,
      changed: row.mode === 'follow_company' && stablePolicyHash(before) !== stablePolicyHash(after),
      before,
      after,
    }
  })
  const impactHash = stablePolicyHash({
    section: input.section,
    draft: { id: input.draft.id, revision: input.draft.revision, content_hash: stablePolicyHash(input.draft.content) },
    published: input.published
      ? { id: input.published.id, revision: input.published.revision, content_hash: stablePolicyHash(input.published.content) }
      : null,
    properties: properties.map((row) => ({
      property_id: row.property_id,
      property_code: row.property_code,
      property_title: row.property_title,
      is_published: row.is_published,
      mode: row.mode,
      mode_revision: row.mode_revision,
      override_revision: row.override_revision,
      changed: row.changed,
      before_hash: stablePolicyHash(row.before),
      after_hash: stablePolicyHash(row.after),
    })),
  })
  return {
    section: input.section,
    draft_revision: input.draft.revision,
    impact_hash: impactHash,
    changed_count: properties.filter((row) => row.changed).length,
    properties,
  }
}

async function readImpactRows(db: PolicyQueryable, section: GuestSitePolicySection): Promise<ImpactSourceRow[]> {
  const result = await db.query(
    `SELECT d.property_id,
            COALESCE(NULLIF(p.code, ''), d.property_id) AS property_code,
            COALESCE(NULLIF(d.hero_title, ''), NULLIF(p.code, ''), d.property_id) AS property_title,
            COALESCE(d.is_published, false) AS is_published,
            COALESCE(m.mode, 'legacy') AS mode,
            COALESCE(m.revision, 0)::int AS mode_revision,
            d.house_rules AS legacy_house_rules,
            d.checkin_time AS legacy_checkin_time,
            d.checkout_time AS legacy_checkout_time,
            o.content AS override_content,
            COALESCE(o.revision, 0)::int AS override_revision
       FROM guest_site_property_displays d
       JOIN properties p ON p.id=d.property_id
       LEFT JOIN guest_site_property_policy_sections m
         ON m.property_id=d.property_id AND m.section=$1
       LEFT JOIN guest_site_stay_policy_versions o
         ON o.scope_type='property' AND o.property_id=d.property_id AND o.section=$1 AND o.status='published'
      WHERE COALESCE(p.archived, false)=false
      ORDER BY COALESCE(NULLIF(p.code, ''), d.property_id) ASC`,
    [section],
  )
  return (result?.rows || []).map((row: any) => ({
    property_id: String(row?.property_id || ''),
    property_code: String(row?.property_code || ''),
    property_title: String(row?.property_title || ''),
    is_published: !!row?.is_published,
    mode: (row?.mode || 'legacy') as GuestSitePolicyMode,
    mode_revision: Math.max(0, Number(row?.mode_revision || 0)),
    legacy_house_rules: row?.legacy_house_rules,
    legacy_checkin_time: row?.legacy_checkin_time,
    legacy_checkout_time: row?.legacy_checkout_time,
    override_content: row?.override_content,
    override_revision: Math.max(0, Number(row?.override_revision || 0)),
  }))
}

export async function getCompanyPolicyImpact(db: PolicyQueryable, section: GuestSitePolicySection, expectedRevision: number) {
  const draft = await readPolicyVersion(db, { scopeType: 'company', propertyId: null, section, status: 'draft' })
  if (!draft) throw new GuestSitePolicyNotFound('policy_draft_not_found')
  if (draft.revision !== expectedRevision) {
    throw new GuestSitePolicyConflict('policy_revision_conflict', {
      expected_revision: expectedRevision,
      actual_revision: draft.revision,
    })
  }
  const published = await readPolicyVersion(db, { scopeType: 'company', propertyId: null, section, status: 'published' })
  const properties = await readImpactRows(db, section)
  return buildCompanyPolicyImpact({ section, draft, published, properties })
}

export async function publishCompanyPolicy(
  pool: PolicyPool,
  input: {
    section: GuestSitePolicySection
    expectedRevision: number
    impactHash: string
    actorId: string | null
  },
) {
  return withPolicyTransaction(pool, async (client) => {
    await lockSubject(client, 'company', null, input.section)
    // Publishing is rare and explicit. These SHARE locks stabilize the
    // property impact scope, every mode revision, and property override
    // versions while the reviewed impact hash is checked. This transaction
    // may still update policy-version rows; PostgreSQL permits a transaction
    // to hold both locks while blocking concurrent writers.
    await client.query('LOCK TABLE properties IN SHARE MODE')
    await client.query('LOCK TABLE guest_site_property_displays IN SHARE MODE')
    await client.query('LOCK TABLE guest_site_stay_policy_versions IN SHARE MODE')
    await client.query('LOCK TABLE guest_site_property_policy_sections IN SHARE MODE')
    const draft = await readPolicyVersion(client, {
      scopeType: 'company', propertyId: null, section: input.section, status: 'draft', lock: true,
    })
    if (!draft) throw new GuestSitePolicyNotFound('policy_draft_not_found')
    if (draft.revision !== input.expectedRevision) {
      throw new GuestSitePolicyConflict('policy_revision_conflict', {
        expected_revision: input.expectedRevision,
        actual_revision: draft.revision,
      })
    }
    const readiness = policySectionReadiness(input.section, draft.content, 'company')
    if (!readiness.ready) throw new GuestSitePolicyValidationError('policy_section_not_ready', { readiness })
    const published = await readPolicyVersion(client, {
      scopeType: 'company', propertyId: null, section: input.section, status: 'published', lock: true,
    })
    const impact = buildCompanyPolicyImpact({
      section: input.section,
      draft,
      published,
      properties: await readImpactRows(client, input.section),
    })
    if (!input.impactHash || impact.impact_hash !== input.impactHash) {
      throw new GuestSitePolicyConflict('policy_impact_changed', {
        expected_impact_hash: input.impactHash,
        actual_impact_hash: impact.impact_hash,
      })
    }
    if (published) {
      await client.query(
        `UPDATE guest_site_stay_policy_versions
            SET status='archived', updated_at=now(), updated_by=$2
          WHERE id=$1 AND status='published'`,
        [published.id, input.actorId],
      )
    }
    const result = await client.query(
      `UPDATE guest_site_stay_policy_versions
          SET status='published', published_at=now(), published_by=$2, updated_at=now(), updated_by=$2
        WHERE id=$1 AND status='draft'
        RETURNING id, scope_type, property_id, section, status, revision, content, supersedes_id,
                  created_at, created_by, updated_at, updated_by, published_at, published_by`,
      [draft.id, input.actorId],
    )
    const next = shapeVersion(result?.rows?.[0])
    await insertAudit(client, {
      action: 'section_published',
      scopeType: 'company',
      propertyId: null,
      section: input.section,
      versionId: next.id,
      actorId: input.actorId,
      before: published ? { version_id: published.id, revision: published.revision, content: published.content } : null,
      after: { version_id: next.id, revision: next.revision, content: next.content },
      metadata: { impact_hash: impact.impact_hash, changed_count: impact.changed_count },
    })
    return { published: next, impact }
  }, true)
}

export async function readPropertyModes(db: PolicyQueryable, propertyIds: string[]) {
  if (!propertyIds.length) return new Map<string, Partial<Record<GuestSitePolicySection, PropertyPolicyModeRow>>>()
  const result = await db.query(
    `SELECT property_id, section, mode, revision, decided_at, decided_by, updated_at, updated_by
       FROM guest_site_property_policy_sections
      WHERE property_id=ANY($1::text[])
      ORDER BY property_id, section`,
    [propertyIds],
  )
  const map = new Map<string, Partial<Record<GuestSitePolicySection, PropertyPolicyModeRow>>>()
  for (const raw of result?.rows || []) {
    const row = shapeMode(raw)
    const current = map.get(row.property_id) || {}
    current[row.section] = row
    map.set(row.property_id, current)
  }
  return map
}

export async function readPublishedPolicyMaps(db: PolicyQueryable, propertyIds: string[]) {
  const companyResult = await db.query(
    `SELECT id, scope_type, property_id, section, status, revision, content, supersedes_id,
            created_at, created_by, updated_at, updated_by, published_at, published_by
       FROM guest_site_stay_policy_versions
      WHERE scope_type='company' AND status='published'`,
  )
  const overrideResult = propertyIds.length
    ? await db.query(
        `SELECT id, scope_type, property_id, section, status, revision, content, supersedes_id,
                created_at, created_by, updated_at, updated_by, published_at, published_by
           FROM guest_site_stay_policy_versions
          WHERE scope_type='property' AND status='published' AND property_id=ANY($1::text[])`,
        [propertyIds],
      )
    : { rows: [] }
  const company: Partial<Record<GuestSitePolicySection, unknown>> = {}
  for (const raw of companyResult?.rows || []) {
    const row = shapeVersion(raw)
    company[row.section] = row.content
  }
  const overrides = new Map<string, Partial<Record<GuestSitePolicySection, unknown>>>()
  for (const raw of overrideResult?.rows || []) {
    const row = shapeVersion(raw)
    if (!row.property_id) continue
    const current = overrides.get(row.property_id) || {}
    current[row.section] = row.content
    overrides.set(row.property_id, current)
  }
  return { company, overrides }
}

export async function resolveEffectivePoliciesForRows(db: PolicyQueryable, rows: any[]) {
  const propertyIds = rows.map((row) => String(row?.id || row?.property_id || '')).filter(Boolean)
  const [modesByProperty, published] = await Promise.all([
    readPropertyModes(db, propertyIds),
    readPublishedPolicyMaps(db, propertyIds),
  ])
  return rows.map((row) => {
    const propertyId = String(row?.id || row?.property_id || '')
    const modeRows = modesByProperty.get(propertyId) || {}
    const modes: Partial<Record<GuestSitePolicySection, GuestSitePolicyMode>> = {}
    for (const section of GUEST_SITE_POLICY_SECTIONS) modes[section] = modeRows[section]?.mode || 'legacy'
    return {
      ...row,
      _effective_stay_policy: resolveEffectivePolicy({
        legacy: {
          house_rules: row?.house_rules,
          checkin_time: row?.checkin_time,
          checkout_time: row?.checkout_time,
        },
        modes,
        company: published.company,
        overrides: published.overrides.get(propertyId) || {},
      }),
      _stay_policy_modes: modeRows,
    }
  })
}

async function assertPropertyExists(db: PolicyQueryable, propertyId: string) {
  const result = await db.query(
    `SELECT p.id
       FROM properties p
       JOIN guest_site_property_displays d ON d.property_id=p.id
      WHERE p.id=$1 AND COALESCE(p.archived, false)=false
      LIMIT 1`,
    [propertyId],
  )
  if (!result?.rows?.[0]) throw new GuestSitePolicyNotFound('property_not_found')
}

async function readPropertyMode(db: PolicyQueryable, propertyId: string, section: GuestSitePolicySection, lock = false) {
  const result = await db.query(
    `SELECT property_id, section, mode, revision, decided_at, decided_by, updated_at, updated_by
       FROM guest_site_property_policy_sections
      WHERE property_id=$1 AND section=$2
      LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [propertyId, section],
  )
  return result?.rows?.[0] ? shapeMode(result.rows[0]) : null
}

export async function setPropertyPolicyMode(
  pool: PolicyPool,
  input: {
    propertyId: string
    section: GuestSitePolicySection
    mode: 'legacy' | 'follow_company'
    expectedRevision: number
    actorId: string | null
  },
) {
  return withPolicyTransaction(pool, async (client) => {
    await assertPropertyExists(client, input.propertyId)
    await lockSubject(client, 'property', input.propertyId, input.section)
    const current = await readPropertyMode(client, input.propertyId, input.section, true)
    const actualRevision = current?.revision || 0
    if (actualRevision !== input.expectedRevision) {
      throw new GuestSitePolicyConflict('policy_mode_revision_conflict', {
        expected_revision: input.expectedRevision,
        actual_revision: actualRevision,
      })
    }
    if (input.mode === 'follow_company') {
      const company = await readPolicyVersion(client, {
        scopeType: 'company', propertyId: null, section: input.section, status: 'published', lock: false,
      })
      if (!company) throw new GuestSitePolicyConflict('company_policy_section_not_published')
    }
    const result = current
      ? await client.query(
          `UPDATE guest_site_property_policy_sections
              SET mode=$3, revision=revision+1, decided_at=now(), decided_by=$4, updated_at=now(), updated_by=$4
            WHERE property_id=$1 AND section=$2
            RETURNING property_id, section, mode, revision, decided_at, decided_by, updated_at, updated_by`,
          [input.propertyId, input.section, input.mode, input.actorId],
        )
      : await client.query(
          `INSERT INTO guest_site_property_policy_sections
            (property_id, section, mode, revision, decided_at, decided_by, updated_at, updated_by)
           VALUES ($1,$2,$3,1,now(),$4,now(),$4)
           RETURNING property_id, section, mode, revision, decided_at, decided_by, updated_at, updated_by`,
          [input.propertyId, input.section, input.mode, input.actorId],
        )
    const next = shapeMode(result?.rows?.[0])
    await insertAudit(client, {
      action: 'mode_changed',
      scopeType: 'property',
      propertyId: input.propertyId,
      section: input.section,
      actorId: input.actorId,
      before: current ? { mode: current.mode, revision: current.revision } : null,
      after: { mode: next.mode, revision: next.revision },
    })
    return next
  })
}

export async function bulkSetPropertyPoliciesToFollow(
  pool: PolicyPool,
  input: {
    section: GuestSitePolicySection
    items: Array<{ propertyId: string; expectedRevision: number }>
    actorId: string | null
  },
) {
  return withPolicyTransaction(pool, async (client) => {
    const company = await readPolicyVersion(client, {
      scopeType: 'company', propertyId: null, section: input.section, status: 'published', lock: false,
    })
    if (!company) throw new GuestSitePolicyConflict('company_policy_section_not_published')
    const batchId = uuidv4()
    const results: PropertyPolicyModeRow[] = []
    const items = [...input.items].sort((a, b) => a.propertyId.localeCompare(b.propertyId))
    for (const item of items) {
      await assertPropertyExists(client, item.propertyId)
      await lockSubject(client, 'property', item.propertyId, input.section)
      const current = await readPropertyMode(client, item.propertyId, input.section, true)
      const actualRevision = current?.revision || 0
      if (actualRevision !== item.expectedRevision) {
        throw new GuestSitePolicyConflict('policy_mode_revision_conflict', {
          property_id: item.propertyId,
          expected_revision: item.expectedRevision,
          actual_revision: actualRevision,
        })
      }
      const result = current
        ? await client.query(
            `UPDATE guest_site_property_policy_sections
                SET mode='follow_company', revision=revision+1, decided_at=now(), decided_by=$3, updated_at=now(), updated_by=$3
              WHERE property_id=$1 AND section=$2
              RETURNING property_id, section, mode, revision, decided_at, decided_by, updated_at, updated_by`,
            [item.propertyId, input.section, input.actorId],
          )
        : await client.query(
            `INSERT INTO guest_site_property_policy_sections
              (property_id, section, mode, revision, decided_at, decided_by, updated_at, updated_by)
             VALUES ($1,$2,'follow_company',1,now(),$3,now(),$3)
             RETURNING property_id, section, mode, revision, decided_at, decided_by, updated_at, updated_by`,
            [item.propertyId, input.section, input.actorId],
          )
      const next = shapeMode(result?.rows?.[0])
      results.push(next)
      await insertAudit(client, {
        action: 'bulk_mode_changed',
        scopeType: 'property',
        propertyId: item.propertyId,
        section: input.section,
        actorId: input.actorId,
        before: current ? { mode: current.mode, revision: current.revision } : null,
        after: { mode: next.mode, revision: next.revision },
        metadata: { batch_id: batchId },
      })
    }
    return { batch_id: batchId, items: results }
  })
}

export async function publishPropertyOverride(
  pool: PolicyPool,
  input: {
    propertyId: string
    section: GuestSitePolicySection
    expectedRevision: number
    expectedModeRevision: number
    actorId: string | null
  },
) {
  return withPolicyTransaction(pool, async (client) => {
    await assertPropertyExists(client, input.propertyId)
    await lockSubject(client, 'property', input.propertyId, input.section)
    const draft = await readPolicyVersion(client, {
      scopeType: 'property', propertyId: input.propertyId, section: input.section, status: 'draft', lock: true,
    })
    if (!draft) throw new GuestSitePolicyNotFound('policy_draft_not_found')
    if (draft.revision !== input.expectedRevision) {
      throw new GuestSitePolicyConflict('policy_revision_conflict', {
        expected_revision: input.expectedRevision,
        actual_revision: draft.revision,
      })
    }
    const mode = await readPropertyMode(client, input.propertyId, input.section, true)
    const actualModeRevision = mode?.revision || 0
    if (actualModeRevision !== input.expectedModeRevision) {
      throw new GuestSitePolicyConflict('policy_mode_revision_conflict', {
        expected_revision: input.expectedModeRevision,
        actual_revision: actualModeRevision,
      })
    }
    const readiness = policySectionReadiness(input.section, draft.content, 'property')
    if (!readiness.ready) throw new GuestSitePolicyValidationError('policy_section_not_ready', { readiness })
    const published = await readPolicyVersion(client, {
      scopeType: 'property', propertyId: input.propertyId, section: input.section, status: 'published', lock: true,
    })
    if (published) {
      await client.query(
        `UPDATE guest_site_stay_policy_versions
            SET status='archived', updated_at=now(), updated_by=$2
          WHERE id=$1 AND status='published'`,
        [published.id, input.actorId],
      )
    }
    const publishedResult = await client.query(
      `UPDATE guest_site_stay_policy_versions
          SET status='published', published_at=now(), published_by=$2, updated_at=now(), updated_by=$2
        WHERE id=$1 AND status='draft'
        RETURNING id, scope_type, property_id, section, status, revision, content, supersedes_id,
                  created_at, created_by, updated_at, updated_by, published_at, published_by`,
      [draft.id, input.actorId],
    )
    const nextPublished = shapeVersion(publishedResult?.rows?.[0])
    const modeResult = mode
      ? await client.query(
          `UPDATE guest_site_property_policy_sections
              SET mode='override', revision=revision+1, decided_at=now(), decided_by=$3, updated_at=now(), updated_by=$3
            WHERE property_id=$1 AND section=$2
            RETURNING property_id, section, mode, revision, decided_at, decided_by, updated_at, updated_by`,
          [input.propertyId, input.section, input.actorId],
        )
      : await client.query(
          `INSERT INTO guest_site_property_policy_sections
            (property_id, section, mode, revision, decided_at, decided_by, updated_at, updated_by)
           VALUES ($1,$2,'override',1,now(),$3,now(),$3)
           RETURNING property_id, section, mode, revision, decided_at, decided_by, updated_at, updated_by`,
          [input.propertyId, input.section, input.actorId],
        )
    const nextMode = shapeMode(modeResult?.rows?.[0])
    await insertAudit(client, {
      action: 'section_published',
      scopeType: 'property',
      propertyId: input.propertyId,
      section: input.section,
      versionId: nextPublished.id,
      actorId: input.actorId,
      before: published ? { version_id: published.id, revision: published.revision, content: published.content } : null,
      after: { version_id: nextPublished.id, revision: nextPublished.revision, content: nextPublished.content },
    })
    await insertAudit(client, {
      action: 'mode_changed',
      scopeType: 'property',
      propertyId: input.propertyId,
      section: input.section,
      actorId: input.actorId,
      before: mode ? { mode: mode.mode, revision: mode.revision } : null,
      after: { mode: nextMode.mode, revision: nextMode.revision },
      metadata: { source: 'override_publish', version_id: nextPublished.id },
    })
    return { published: nextPublished, mode: nextMode }
  })
}

export async function getCompanyPolicyOverview(db: PolicyQueryable) {
  const sections = await Promise.all(GUEST_SITE_POLICY_SECTIONS.map(async (section) => {
    const [draft, published, history] = await Promise.all([
      readPolicyVersion(db, { scopeType: 'company', propertyId: null, section, status: 'draft' }),
      readPolicyVersion(db, { scopeType: 'company', propertyId: null, section, status: 'published' }),
      listPolicyHistory(db, 'company', null, section),
    ])
    return {
      section,
      draft,
      published,
      default_draft: draft || published ? null : emptyPolicyContent(section),
      readiness: policySectionReadiness(section, draft?.content || emptyPolicyContent(section), 'company'),
      history,
    }
  }))
  return { sections }
}

export async function getPropertyPolicyOverview(db: PolicyQueryable, propertyId: string) {
  await assertPropertyExists(db, propertyId)
  const [modeMap, publishedMaps] = await Promise.all([
    readPropertyModes(db, [propertyId]),
    readPublishedPolicyMaps(db, [propertyId]),
  ])
  const modes = modeMap.get(propertyId) || {}
  const sections = await Promise.all(GUEST_SITE_POLICY_SECTIONS.map(async (section) => {
    const [draft, published, history] = await Promise.all([
      readPolicyVersion(db, { scopeType: 'property', propertyId, section, status: 'draft' }),
      readPolicyVersion(db, { scopeType: 'property', propertyId, section, status: 'published' }),
      listPolicyHistory(db, 'property', propertyId, section),
    ])
    return {
      section,
      mode: modes[section] || null,
      draft,
      published,
      default_draft: draft || published ? null : emptyPolicyContent(section),
      readiness: policySectionReadiness(section, draft?.content || emptyPolicyContent(section), 'property'),
      company_published: publishedMaps.company[section] || null,
      history,
    }
  }))
  return { property_id: propertyId, sections }
}
