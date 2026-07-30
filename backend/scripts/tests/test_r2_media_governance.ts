import assert from 'assert'

process.env.R2_ENDPOINT = process.env.R2_ENDPOINT || 'https://example.r2.cloudflarestorage.com'
process.env.R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || 'contract-test-access-key'
process.env.R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || 'contract-test-secret-key'
process.env.R2_BUCKET = process.env.R2_BUCKET || 'contract-test-bucket'
process.env.R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL || 'https://contract-test.r2.dev'

const {
  extractR2KeysFromValue,
  isApprovedCleanupPrefix,
  isReferenceColumn,
  normalizeR2Reference,
  summarizeR2Objects,
} = require('../../src/lib/r2MediaGovernance') as typeof import('../../src/lib/r2MediaGovernance')

const now = Date.parse('2026-07-26T00:00:00.000Z')
const oldObject = { key: 'cleaning/orphan.jpg', size: 120, lastModified: '2026-06-01T00:00:00.000Z', etag: null }
const recentObject = { key: 'cleaning/recent.jpg', size: 80, lastModified: '2026-07-25T00:00:00.000Z', etag: null }
const referencedObject = { key: 'cleaning/used.jpg', size: 60, lastModified: '2026-06-01T00:00:00.000Z', etag: null }

assert.equal(normalizeR2Reference('cleaning/media/task-1/media-1'), 'cleaning/media/task-1/media-1')
assert.equal(normalizeR2Reference('https://contract-test.r2.dev/cleaning/media/task-1/media-1'), 'cleaning/media/task-1/media-1')
assert.deepEqual(
  extractR2KeysFromValue({ photo_urls: ['cleaning/used.jpg', 'https://contract-test.r2.dev/cleaning/orphan.jpg'] }),
  ['cleaning/used.jpg', 'cleaning/orphan.jpg'],
)
assert.equal(isReferenceColumn('photo_urls'), true)
assert.equal(isReferenceColumn('password_hash'), false)
assert.equal(isApprovedCleanupPrefix('onboarding/r2-test/', []), false)
assert.equal(isApprovedCleanupPrefix('onboarding/r2-test/', ['onboarding/r2-test/']), true)

const summary = summarizeR2Objects([oldObject, recentObject, referencedObject], new Set(['cleaning/used.jpg']), now, 7 * 24 * 60 * 60 * 1000)
assert.deepEqual(summary, {
  object_count: 3,
  referenced_object_count: 1,
  orphan_object_count: 2,
  orphan_bytes: 200,
  eligible_orphan_count: 1,
  eligible_orphan_bytes: 120,
  eligible_orphan_keys: ['cleaning/orphan.jpg'],
})

process.stdout.write('test_r2_media_governance: ok\n')
