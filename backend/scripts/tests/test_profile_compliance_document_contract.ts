import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const backendRoot = path.resolve(__dirname, '../..')
const read = (relativePath: string) => fs.readFileSync(path.join(backendRoot, relativePath), 'utf8')

const users = read('src/modules/users.ts')
const r5Migration = read('scripts/migrations/20260902_r5_1_request_schema.sql')
assert.match(users, /visa_document_url: z\.string\(\)\.trim\(\)\.max\(500\)\.optional\(\)\.nullable\(\)/)
assert.match(users, /visa_grant_number: z\.string\(\)\.trim\(\)\.max\(120\)\.optional\(\)\.nullable\(\)/)
assert.doesNotMatch(users, /ensureProfileColumns|ALTER TABLE users ADD COLUMN/)
assert.match(r5Migration, /ALTER TABLE users ADD COLUMN IF NOT EXISTS visa_document_url text/)
assert.match(r5Migration, /ALTER TABLE users ADD COLUMN IF NOT EXISTS visa_grant_number text/)
assert.match(users, /PROFILE_USER_COLUMNS/)
assert.match(users, /patch\.visa_document_url = parsed\.data\.visa_document_url/)
assert.match(users, /patch\.visa_grant_number = parsed\.data\.visa_grant_number/)
assert.match(users, /photo_id_uploaded: !!String\(row\.photo_id_url \|\| ''\)\.trim\(\)/)
assert.match(users, /visa_document_uploaded: !!String\(row\.visa_document_url \|\| ''\)\.trim\(\)/)
assert.match(users, /router\.get\('\/me\/profile-documents\/:documentType'/)
assert.match(users, /r2GetObjectByKey\(key\)/)
assert.match(users, /Cache-Control', 'private, no-store, max-age=0'/)
assert.match(users, /invalid_profile_document_reference/)
assert.match(users, /ownedProfileDocumentKey\(userId, type\)/)

const mzapp = read('src/modules/mzapp.ts')
assert.match(mzapp, /watermarkMode === 'photo_id_full' \|\| watermarkMode === 'profile_document_full'/)
assert.match(mzapp, /const PHOTO_ID_WATERMARK_TEXT = '仅用于MZ Property（ABN：42 657 925 365）记录,不做任何其他用途。\\nFor the records of MZ Property \(ABN: 42 657 925 365\) only, not for other purpose\.'/)
assert.match(mzapp, /Array\.from\(\{ length: 5 \}\)/)
assert.match(mzapp, /profile_document_type/)
assert.match(mzapp, /mzapp\/profile-documents\/\$\{encodeURIComponent\(userId\)\}\/\$\{profileDocumentType\}/)
assert.match(mzapp, /secure_profile_document_storage_unavailable/)

for (const schemaFile of ['scripts/schema.sql', 'scripts/schema_neon.sql', 'scripts/init_db.ts']) {
  const schema = read(schemaFile)
  assert.match(schema, /visa_document_url text/)
  assert.match(schema, /visa_grant_number text/)
}

console.log('profile compliance document contract: PASS')
