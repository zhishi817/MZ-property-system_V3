import { hasPg, pgPool } from '../dbAdapter'

export const GUEST_SITE_PUBLIC_CONTENT_SCHEMA_MIGRATION = '20261001_guest_site_public_content_schema'
export const GUEST_SITE_CONTACT_MESSAGES_SCHEMA_MIGRATION = '20261001_guest_site_contact_messages'
export const GUEST_SITE_AMENITY_SELECTIONS_SCHEMA_MIGRATION = '20261002_guest_site_amenity_selections'
export const GUEST_SITE_AMENITY_TEMPLATES_SCHEMA_MIGRATION = '20261002_guest_site_amenity_templates'
export const GUEST_SITE_STAY_POLICIES_SCHEMA_MIGRATION = '20261003_guest_site_stay_policies'

type GuestSiteSchemaStatus = 'pending' | 'ready' | 'not_ready'

let guestSiteSchemaStatus: GuestSiteSchemaStatus = hasPg ? 'pending' : 'ready'
let guestSiteContactMessagesReady = !hasPg
let guestSiteAmenitySelectionsReady = !hasPg
let guestSiteAmenityTemplatesReady = !hasPg
let guestSiteStayPoliciesReady = !hasPg

export class GuestSiteSchemaNotReady extends Error {
  readonly code = 'guest_site_schema_not_ready'
  readonly status = 503

  constructor() {
    super('guest_site_schema_not_ready')
    this.name = 'GuestSiteSchemaNotReady'
  }
}

export class GuestSiteContactMessagesSchemaNotReady extends Error {
  readonly code = 'guest_site_contact_messages_schema_not_ready'
  readonly status = 503

  constructor() {
    super('guest_site_contact_messages_schema_not_ready')
    this.name = 'GuestSiteContactMessagesSchemaNotReady'
  }
}

export class GuestSiteAmenitySchemaNotReady extends Error {
  readonly code = 'guest_site_amenity_schema_not_ready'
  readonly status = 503

  constructor() {
    super('guest_site_amenity_schema_not_ready')
    this.name = 'GuestSiteAmenitySchemaNotReady'
  }
}

export class GuestSiteAmenityTemplatesSchemaNotReady extends Error {
  readonly code = 'guest_site_amenity_templates_schema_not_ready'
  readonly status = 503

  constructor() {
    super('guest_site_amenity_templates_schema_not_ready')
    this.name = 'GuestSiteAmenityTemplatesSchemaNotReady'
  }
}

export class GuestSiteStayPoliciesSchemaNotReady extends Error {
  readonly code = 'guest_site_stay_policies_schema_not_ready'
  readonly status = 503

  constructor() {
    super('guest_site_stay_policies_schema_not_ready')
    this.name = 'GuestSiteStayPoliciesSchemaNotReady'
  }
}

/**
 * Guest-site DDL belongs to the controlled migration. Startup reads one fixed
 * marker; HTTP request paths only consult the retained in-memory result.
 */
export async function warmupGuestSiteSchema() {
  if (!hasPg) {
    guestSiteSchemaStatus = 'ready'
    return
  }
  if (!pgPool) {
    guestSiteSchemaStatus = 'not_ready'
    throw new GuestSiteSchemaNotReady()
  }
  try {
    const result = await pgPool.query(
      'SELECT version FROM schema_migrations WHERE version = ANY($1::text[])',
      [[GUEST_SITE_PUBLIC_CONTENT_SCHEMA_MIGRATION, GUEST_SITE_CONTACT_MESSAGES_SCHEMA_MIGRATION, GUEST_SITE_AMENITY_SELECTIONS_SCHEMA_MIGRATION, GUEST_SITE_AMENITY_TEMPLATES_SCHEMA_MIGRATION, GUEST_SITE_STAY_POLICIES_SCHEMA_MIGRATION]],
    )
    const markers = new Set((result?.rows || []).map((row: any) => String(row?.version || '')))
    if (!markers.has(GUEST_SITE_PUBLIC_CONTENT_SCHEMA_MIGRATION)) throw new GuestSiteSchemaNotReady()
    guestSiteContactMessagesReady = markers.has(GUEST_SITE_CONTACT_MESSAGES_SCHEMA_MIGRATION)
    guestSiteAmenitySelectionsReady = markers.has(GUEST_SITE_AMENITY_SELECTIONS_SCHEMA_MIGRATION)
    guestSiteAmenityTemplatesReady = markers.has(GUEST_SITE_AMENITY_TEMPLATES_SCHEMA_MIGRATION)
    guestSiteStayPoliciesReady = markers.has(GUEST_SITE_STAY_POLICIES_SCHEMA_MIGRATION)
    guestSiteSchemaStatus = 'ready'
  } catch (error) {
    guestSiteSchemaStatus = 'not_ready'
    guestSiteContactMessagesReady = false
    guestSiteAmenitySelectionsReady = false
    guestSiteAmenityTemplatesReady = false
    guestSiteStayPoliciesReady = false
    if (error instanceof GuestSiteSchemaNotReady) throw error
    throw new GuestSiteSchemaNotReady()
  }
}

export function isGuestSiteSchemaReady() {
  return !hasPg || guestSiteSchemaStatus === 'ready'
}

export function assertGuestSiteSchemaReady() {
  if (isGuestSiteSchemaReady()) return
  throw new GuestSiteSchemaNotReady()
}

export function isGuestSiteContactMessagesSchemaReady() {
  return !hasPg || guestSiteContactMessagesReady
}

export function assertGuestSiteContactMessagesSchemaReady() {
  if (isGuestSiteContactMessagesSchemaReady()) return
  throw new GuestSiteContactMessagesSchemaNotReady()
}

export function isGuestSiteAmenitySelectionsSchemaReady() {
  return !hasPg || guestSiteAmenitySelectionsReady
}

export function assertGuestSiteAmenitySelectionsSchemaReady() {
  if (isGuestSiteAmenitySelectionsSchemaReady()) return
  throw new GuestSiteAmenitySchemaNotReady()
}

export function isGuestSiteAmenityTemplatesSchemaReady() {
  return !hasPg || guestSiteAmenityTemplatesReady
}

export function assertGuestSiteAmenityTemplatesSchemaReady() {
  if (isGuestSiteAmenityTemplatesSchemaReady()) return
  throw new GuestSiteAmenityTemplatesSchemaNotReady()
}

export function isGuestSiteStayPoliciesSchemaReady() {
  return !hasPg || guestSiteStayPoliciesReady
}

export function assertGuestSiteStayPoliciesSchemaReady() {
  if (isGuestSiteStayPoliciesSchemaReady()) return
  throw new GuestSiteStayPoliciesSchemaNotReady()
}
