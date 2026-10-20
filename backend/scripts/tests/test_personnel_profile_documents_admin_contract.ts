import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { hasPersonnelProfileDocumentViewerRole } from '../../src/lib/personnelProfileDocumentAccess'

const root = path.resolve(__dirname, '../..')
const repositoryRoot = path.resolve(root, '..')
const readBackend = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8')
const readRepository = (relativePath: string) => fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8')

const permission = 'personnel_settlements.profile_documents.view'
const catalog = readBackend('src/permissionsCatalog.ts')
const store = readBackend('src/store.ts')
const profiles = readBackend('src/lib/personnelSettlementProfiles.ts')
const router = readBackend('src/modules/personnel_settlements.ts')
const migration = readBackend('scripts/migrations/20261016_personnel_profile_documents_view_permission.sql')
const page = readRepository('frontend/src/app/finance/settlements/page.tsx')
const preview = readRepository('frontend/src/app/finance/settlements/profileDocumentPreview.ts')

assert.match(catalog, new RegExp(`'${permission.replace('.', '\\.')}'`))
assert.match(store, new RegExp(`\\{ code: '${permission.replace('.', '\\.')}' \\}`))
assert.match(store, new RegExp(`grant\\(financeId, \\[[^\\n]*'${permission.replace('.', '\\.')}'`))

const offlineGrant = store.match(/grant\(offlineMgrId, \[[^\n]+/g)?.join('\n') || ''
const cleaningGrant = store.match(/grant\(cleanMgrId, \[[^\n]+/g)?.join('\n') || ''
assert.doesNotMatch(offlineGrant, /profile_documents\.view/)
assert.doesNotMatch(cleaningGrant, /profile_documents\.view/)

assert.match(migration, /^BEGIN;/)
assert.match(migration, /name IN \('admin', 'finance_staff'\)/)
assert.doesNotMatch(migration, /cleaning_manager|offline_manager/)
assert.match(migration, new RegExp(permission.replace('.', '\\.')))
assert.match(migration, /20261016_personnel_profile_documents_view_permission/)
assert.match(migration, /COMMIT;\s*$/)

assert.match(profiles, /includeProfileDocuments: boolean/)
assert.match(profiles, /includeVisaDetails: boolean/)
assert.match(profiles, /\.\.\.\(input\.includeProfileDocuments \? \{/)
assert.match(profiles, /profile_documents_access: true as const/)
assert.match(profiles, /visa_document_uploaded:/)
assert.match(profiles, /visa_grant_number:/)

assert.equal(hasPersonnelProfileDocumentViewerRole({ role: 'admin' }), true)
assert.equal(hasPersonnelProfileDocumentViewerRole({ role: 'role.finance_staff' }), true)
assert.equal(hasPersonnelProfileDocumentViewerRole({ role: 'custom_finance', roles: ['finance_staff'] }), true)
assert.equal(hasPersonnelProfileDocumentViewerRole({ role: 'custom_finance' }), false)
assert.equal(hasPersonnelProfileDocumentViewerRole({ role: 'cleaning_manager', roles: ['offline_manager'] }), false)

assert.match(router, /hasPersonnelProfileDocumentViewerRole\(user\)/)
assert.match(router, /await userHasAnyPerm\(user, \[PROFILE_DOCUMENT_VIEW_PERMISSION\]\)/)
assert.match(router, /requirePersonnelProfileDocumentViewer/)
assert.doesNotMatch(router, /requirePerm\('personnel_settlements\.profile_documents\.view'\)/)
const selfProfileRoutes = router.slice(router.indexOf("router.get('/my-profile'"), router.indexOf("router.get('/profiles'"))
assert.match(selfProfileRoutes, /includeProfileDocuments: true/)
assert.match(selfProfileRoutes, /includeVisaDetails: false/)
assert.match(router, /ownedProfileDocumentStorageKey\(storedReference, userId, type\)/)
assert.match(router, /r2GetObjectByKeyDetailed\(key\)/)
assert.match(router, /'personnel_profile_document'/)
assert.match(router, /JSON\.stringify\(\{ document_type: type \}\)/)
assert.match(router, /Cache-Control', 'private, no-store, max-age=0'/)
assert.match(router, /Content-Disposition', 'inline'/)
assert.doesNotMatch(router, /res\.json\([^\n]*(storageReference|storedReference|key)/)

assert.doesNotMatch(page, /hasPerm\('personnel_settlements\.profile_documents\.view'\)/)
assert.match(page, /selected\?\.profile_documents_access === true/)
assert.match(page, /\{canViewSelectedProfileDocuments \? <>/)
assert.match(page, /selected\.visa_grant_number/)
assert.match(page, /openProfileDocument\('photo_id'\)/)
assert.match(page, /openProfileDocument\('visa_document'\)/)
assert.match(preview, /getBlob\(/)
assert.match(preview, /authSensitive: true/)
assert.doesNotMatch(preview, /window\.open|download|presign/i)

console.log('personnel profile documents admin contract: PASS')
