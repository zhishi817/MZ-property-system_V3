import assert from 'assert'
import fs from 'fs'
import path from 'path'

process.env.R2_BUCKET = 'offline-task-contract-bucket'
process.env.R2_PUBLIC_BASE_URL = 'https://offline-task-contract.r2.dev'
process.env.R2_ENDPOINT = 'https://offline-task-contract.r2.cloudflarestorage.com'
process.env.R2_STORAGE_NAMESPACE = ''

const {
  canonicalizeMzappTaskPhotoReference,
  createMzappTaskPhotoRemoteReference,
  currentOfflineTaskPhotoKeyFromReference,
  currentMzappTaskPhotoKeyFromReference,
  isLegacyMzappTaskPhotoPublicUrl,
  mzappTaskPhotoReferenceVariants,
  offlineTaskPhotoReferenceVariants,
  normalizeMzappTaskPhotoKey,
} = require('../../src/lib/mzappTaskPhotoReference') as typeof import('../../src/lib/mzappTaskPhotoReference')

const key = 'mzapp/offline-task-photo.jpg'
const canonical = createMzappTaskPhotoRemoteReference(key)

assert.match(String(canonical), /^r2:\/\/bucket-[a-f0-9]{64}\/mzapp\/offline-task-photo\.jpg$/)
assert.equal(
  canonicalizeMzappTaskPhotoReference('https://offline-task-contract.r2.dev/mzapp/offline-task-photo.jpg'),
  canonical,
  'the current upload URL becomes the stable server reference',
)
assert.equal(
  canonicalizeMzappTaskPhotoReference('https://legacy-task-photo.r2.dev/mzapp/offline-task-photo.jpg'),
  null,
  'an unknown legacy host must not be reinterpreted as the current storage bucket',
)
assert.equal(
  canonicalizeMzappTaskPhotoReference('https://legacy-task-photo.r2.dev/mzapp/offline-task-photo.jpg', ['https://legacy-task-photo.r2.dev/mzapp/offline-task-photo.jpg']),
  'https://legacy-task-photo.r2.dev/mzapp/offline-task-photo.jpg',
  'an already-recorded legacy reference remains compatible',
)
assert.equal(canonicalizeMzappTaskPhotoReference('r2://bucket-any/mzapp/../private.jpg'), null)
assert.equal(currentMzappTaskPhotoKeyFromReference(canonical), key, 'current canonical references resolve only to the current mzapp key')
assert.equal(normalizeMzappTaskPhotoKey(key), key, 'a safe raw mzapp key remains an exact offline-photo candidate')
assert.equal(normalizeMzappTaskPhotoKey('mzapp/../private.jpg'), null, 'unsafe raw keys must not be used as an offline-photo candidate')
assert.deepEqual(mzappTaskPhotoReferenceVariants(key), [key, canonical], 'a raw key includes its stable current reference for exact offline association')
assert.deepEqual(
  mzappTaskPhotoReferenceVariants('https://legacy-task-photo.r2.dev/mzapp/offline-task-photo.jpg'),
  ['https://legacy-task-photo.r2.dev/mzapp/offline-task-photo.jpg', key, canonical],
  'a safe legacy source URL retains its exact reference and canonical key identities so a supplied key cannot mask its offline association',
)
assert.equal(currentMzappTaskPhotoKeyFromReference('https://legacy-task-photo.r2.dev/mzapp/offline-task-photo.jpg'), null, 'legacy hosts cannot resolve as current storage keys')
assert.equal(
  currentOfflineTaskPhotoKeyFromReference('https://offline-task-contract.r2.dev/historical/offline-task-photo.jpg'),
  'historical/offline-task-photo.jpg',
  'an already-recorded current-public-base historical offline photo resolves to its safe object key',
)
assert.deepEqual(
  offlineTaskPhotoReferenceVariants('https://offline-task-contract.r2.dev/historical/offline-task-photo.jpg'),
  ['https://offline-task-contract.r2.dev/historical/offline-task-photo.jpg'],
  'a historical current-public-base URL stays an exact persisted-reference candidate',
)
assert.equal(currentOfflineTaskPhotoKeyFromReference('https://unknown-task-photo.r2.dev/historical/offline-task-photo.jpg'), null, 'an unknown public base must not resolve as an offline task object key')
assert.equal(currentOfflineTaskPhotoKeyFromReference('https://offline-task-contract.r2.dev/historical/../private.jpg'), null, 'historical compatibility must reject traversal before URL normalization')
assert.equal(isLegacyMzappTaskPhotoPublicUrl('https://legacy-task-photo.r2.dev/mzapp/offline-task-photo.jpg'), true, 'a recorded legacy R2 image may be read through the authenticated server proxy')
assert.equal(isLegacyMzappTaskPhotoPublicUrl('http://legacy-task-photo.r2.dev/mzapp/offline-task-photo.jpg'), false, 'legacy media fallback must not permit plaintext HTTP')
assert.equal(isLegacyMzappTaskPhotoPublicUrl('https://legacy-task-photo.r2.dev/mzapp/../private.jpg'), false, 'legacy media fallback must reject unsafe paths')

const routerSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/mzapp.ts'), 'utf8')
assert.match(routerSource, /remote_reference:\s*createMzappTaskPhotoRemoteReference\(key\)/)
assert.match(routerSource, /canonicalizeMzappTaskPhotoReference\(reference, existingPhotoUrls\)/)

const mediaRouterSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/cleaning_app.ts'), 'utf8')
assert.match(mediaRouterSource, /findOfflineWorkTaskPhotoRows/, 'the media proxy must resolve offline work-task photos from their exact business row')
assert.match(mediaRouterSource, /offlineTaskPhotoReferenceVariants\(requestedKey\)[\s\S]*offlineTaskPhotoReferenceVariants\(sourceUrl\)/, 'key and source URL must independently enter the offline exact-association path before generic feedback lookup')
assert.match(mediaRouterSource, /jsonb_array_elements_text\(w\.photo_urls\) AS stored\(value\)/, 'offline media ownership must inspect each exact stored photo reference, not a URL prefix match')
assert.match(mediaRouterSource, /stored\.value = ANY\(\$1::text\[\]\)[\s\S]*LIMIT 2/, 'a legacy client without work_task_id may only use the bounded unique-reference lookup')
assert.ok(mediaRouterSource.includes("regexp_replace(stored.value, '^https://[^/]+/', '')"), 'raw keys must fail closed when an exact stored legacy URL has the same canonical mzapp object key')
assert.match(mediaRouterSource, /requestedWorkTaskIdRaw && !requestedWorkTaskId/, 'a malformed work_task_id must fail closed')
assert.doesNotMatch(mediaRouterSource, /Boolean\(!sourceTaskId && \(offlineCurrentKey \|\| offlineLegacyReference\)\)/, 'source_task_id must not bypass offline association')
assert.match(mediaRouterSource, /function inspectMzappR2Url/, 'R2 legacy variants must use URL parsing rather than a brittle string regex')
assert.match(mediaRouterSource, /url\.protocol !== 'https:'/ , 'plaintext HTTP R2 variants must fail closed before generic media lookup')
assert.match(mediaRouterSource, /authority\.includes\('@'\) \|\| \/:\\d\+\$\/.test\(authority\)/, 'explicit-port legacy R2 variants must fail closed')
assert.match(mediaRouterSource, /requestedKeyMzappR2Url\?\.hasUnsafeVariant \|\| sourceUrlMzappR2Url\?\.hasUnsafeVariant/, 'an unsafe URL must fail closed even when a supplied key would otherwise mask it')
assert.match(mediaRouterSource, /findOfflineWorkTaskPhotoRows\(pgPool, offlineReferences\)/, 'offline lookup must consider every supplied candidate reference before validating task access')
assert.match(mediaRouterSource, /offlineStoredReference = offlineReferences\.find/, 'the object read must use the exact stored offline reference that established authorization')
assert.match(mediaRouterSource, /currentOfflineTaskPhotoKeyFromReference/, 'a current-public-base historical reference must resolve only inside the authenticated offline proxy')
assert.match(mediaRouterSource, /offlineRows\.length && \(!offlineRow \|\| \(requestedWorkTaskId && String\(offlineRow\.id \|\| ''\)\.trim\(\) !== requestedWorkTaskId\)\)/, 'duplicate or wrong-task offline references must fail closed before generic media lookup')
assert.match(mediaRouterSource, /canViewMzappOfflineWorkTaskMedia/, 'offline media reads must enforce authenticated task access before loading bytes')
assert.match(mediaRouterSource, /loadLegacyOfflineTaskPhoto/, 'legacy R2 reads must stay server-side after authorization')
assert.match(mediaRouterSource, /code: 'media_not_found'/, 'missing offline objects must report a terminal not-found code')

process.stdout.write('test_mzapp_task_photo_reference: ok\n')
