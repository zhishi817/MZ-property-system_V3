import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { cleaningMediaCaptureOwnerMatches, cleaningPhotoWatermarkLines, melbourneCaptureTime, recordedCaptureTime } from '../../src/lib/cleaningMediaWatermark'

assert.equal(melbourneCaptureTime('2026-11-12T04:32:36.202Z'), '2026-11-12 15:32 Melbourne')
assert.equal(melbourneCaptureTime('2026-06-12T04:32:36Z'), '2026-06-12 14:32 Melbourne')
assert.equal(melbourneCaptureTime('2026-11-12T23:32:36Z'), '2026-11-13 10:32 Melbourne')
for (const value of ['', null, 'bad', '2026-11-12 15:32']) assert.equal(melbourneCaptureTime(value), '未记录')
for (const value of ['', undefined, null, 'bad', '2026-11-12 15:32']) assert.equal(recordedCaptureTime(value), null)
assert.equal(recordedCaptureTime('2026-11-12T15:32:00+11:00'), '2026-11-12T04:32:00.000Z')
assert.deepEqual(cleaningPhotoWatermarkLines({ propertyCode: 'MSQ6307E', authenticatedName: 'Angela', capturedByUserId: 'inspector', capturedAt: '2026-11-12T04:32:36Z' }), ['MSQ6307E  操作账号: Angela', '2026-11-12 15:32 Melbourne'])
assert.deepEqual(cleaningPhotoWatermarkLines({ propertyCode: 'MSQ6307E', authenticatedName: 'Admin' }), ['MSQ6307E  提交账号: Admin', '未记录'])
assert.deepEqual(cleaningPhotoWatermarkLines({}), ['未记录  提交账号: 未记录', '未记录'])
for (const purpose of ['backup_key_return', 'return_wash_linen', 'warehouse_key_return', 'remaining_consumables', 'reject_linen_return']) {
  assert.match(cleaningPhotoWatermarkLines({ purpose, authenticatedName: 'Operator' })[0], /^日终交接-/)
}
assert.equal(cleaningMediaCaptureOwnerMatches('A', 'A'), true)
assert.equal(cleaningMediaCaptureOwnerMatches('A', 'B'), false)
assert.equal(cleaningMediaCaptureOwnerMatches('A', ''), false)
assert.equal(cleaningMediaCaptureOwnerMatches('', 'B'), false)
assert.equal(cleaningMediaCaptureOwnerMatches(null, 'B'), false)
assert.equal(cleaningMediaCaptureOwnerMatches(undefined, 'B'), true) // backward compatibility, not capture certification

// Route wiring contract, deliberately no server import, database, credentials or network.
const route = fs.readFileSync(path.resolve(__dirname, '../../src/modules/cleaning_app.ts'), 'utf8')
const upload = route.slice(route.indexOf("  '/upload',"))
assert.ok(upload.indexOf('cleaningMediaCaptureOwnerMatches(body.captured_by_user_id, user.sub)') < upload.indexOf('await r2UploadImmutable('))
assert.ok(upload.indexOf('cleaningMediaCaptureOwnerMatches(body.captured_by_user_id, user.sub)') < upload.indexOf('await fs.promises.readFile(filePath)'))
assert.match(upload, /const lines = wantWatermark && isImage \? cleaningPhotoWatermarkLines/)
assert.doesNotMatch(upload, /watermarkText \? watermarkText\.split/)
assert.match(upload, /capturedByUserId: body\.captured_by_user_id/)
assert.match(upload, /authenticatedName: user\.username/)
// Unknown capture time stays NULL on business save, while created_at/action timestamps remain independent.
assert.doesNotMatch(route, /captured_at: new Date\(\)\.toISOString\(\)/)
assert.doesNotMatch(route, /captured_at \|\| now/)
assert.doesNotMatch(route, /const capturedAt = cap \? new Date\(cap\) : new Date\(\)/)
assert.match(route, /'key_photo', parsed\.data\.media_url, recordedCaptureTime\(parsed\.data\.captured_at\)/)
assert.match(route, /const capturedAt = recordedCaptureTime\(item\.captured_at\)/)
assert.equal((route.match(/const capturedAt = recordedCaptureTime\(it\.captured_at\)/g) || []).length, 4)
const mzapp = fs.readFileSync(path.resolve(__dirname, '../../src/modules/mzapp.ts'), 'utf8')
assert.match(mzapp, /const capturedAt = recordedCaptureTime\(it\.captured_at\)/)
assert.doesNotMatch(mzapp, /const capturedAt = cap \? new Date\(cap\) : new Date\(\)/)
const ddl = fs.readFileSync(path.resolve(__dirname, '../migrations/20260114_cleaning_app.sql'), 'utf8')
assert.match(ddl, /captured_at timestamptz,/)
const dayEndDdl = fs.readFileSync(path.resolve(__dirname, '../migrations/20260329_cleaning_keys_day_end.sql'), 'utf8')
assert.match(dayEndDdl, /captured_at timestamptz,/)
console.log('MZ116 watermark identity/time/legacy/day-end/video route contracts: PASS')
