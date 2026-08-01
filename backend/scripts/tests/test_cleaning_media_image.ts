import assert from 'assert'
import express from 'express'
import fs from 'fs'
import sharp from 'sharp'
import { requireAnyPerm } from '../../src/auth'
import { CLEANING_IMAGE_FORMAT_ERROR, normalizeCleaningImageUpload } from '../../src/lib/cleaningMediaImage'
import {
  canViewRecordedDayEndMedia,
  CLEANING_MEDIA_IMAGE_READ_PERMISSIONS,
  selectExclusiveRecordedCleaningMedia,
  selectUniqueRecordedCleaningMediaRow,
  selectUniqueRecordedDayEndMediaRow,
} from '../../src/modules/cleaning_app'

async function mediaImageGateStatus(user: any) {
  const app = express()
  app.use((req: any, _res, next) => {
    req.user = JSON.parse(String(req.headers['x-test-user'] || '{}'))
    next()
  })
  app.get('/media/image', requireAnyPerm(CLEANING_MEDIA_IMAGE_READ_PERMISSIONS), (_req, res) => res.status(204).end())
  const server = await new Promise<any>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const response = await fetch(`http://127.0.0.1:${port}/media/image`, {
      headers: { 'x-test-user': JSON.stringify(user) },
    })
    return response.status
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function main() {
  const route = fs.readFileSync(require.resolve('../../src/modules/cleaning_app'), 'utf8')
  assert.match(route, /FROM cleaning_task_media ctm[\s\S]*JOIN cleaning_tasks ct/, 'media proxy must bind a requested object to a recorded task media row')
  assert.match(route, /FROM cleaning_consumable_usages u[\s\S]*JOIN cleaning_tasks ct/, 'media proxy must also resolve recorded consumable photo references')
  assert.match(route, /FROM cleaning_day_end_media/, 'media proxy must resolve recorded day-end handover photos')
  assert.match(route, /canViewMzappRecordedCleaningMedia/, 'media proxy must enforce task-specific media visibility before reading R2')
  assert.match(route, /canViewRecordedDayEndMedia/, 'media proxy must enforce day-end owner or manager visibility before reading R2')
  assert.match(route, /requireAnyPerm\(CLEANING_MEDIA_IMAGE_READ_PERMISSIONS\)/, 'media proxy must use the shared media-read permission gate')
  assert.match(route, /forbidden_media/, 'unrecorded or unauthorized media keys must fail closed')
  assert.match(route, /selectUniqueRecordedCleaningMediaRow/, 'media proxy must use the single-task and single-type authorization selector')
  assert.match(route, /living_room_photo_urls: livingRoomPhotoUrls/, 'consumables response must expose the compatible plural living-photo field')
  assert.match(route, /living_room_photo_url: livingRoomPhotoUrls\[0\] \|\| null/, 'legacy living-photo field must remain the first plural item')
  const ordinary = { id: 'task-a', type: 'consumable_item_photo', url: 'cleaning/a.jpg' }
  assert.equal(selectUniqueRecordedCleaningMediaRow([ordinary]), ordinary)
  assert.equal(selectUniqueRecordedCleaningMediaRow([ordinary, { ...ordinary, type: 'inspection_photo' }]), null, 'one key recorded under two types must fail closed')
  assert.equal(selectUniqueRecordedCleaningMediaRow([ordinary, { ...ordinary, id: 'task-b' }]), null, 'one key recorded under two tasks must fail closed')
  const dayEnd = { user_id: 'cleaner-a', kind: 'warehouse_key_return', url: 'cleaning/day-end.jpg' }
  assert.equal(selectUniqueRecordedDayEndMediaRow([dayEnd]), dayEnd)
  assert.equal(selectUniqueRecordedDayEndMediaRow([dayEnd, { ...dayEnd, user_id: 'cleaner-b' }]), null, 'one key recorded for two day-end users must fail closed')
  assert.equal(selectUniqueRecordedDayEndMediaRow([dayEnd, { ...dayEnd, kind: 'remaining_consumables' }]), null, 'one key recorded for two day-end kinds must fail closed')
  assert.equal(selectExclusiveRecordedCleaningMedia([ordinary], []).source, 'task')
  assert.equal(selectExclusiveRecordedCleaningMedia([], [dayEnd]).source, 'day_end')
  assert.equal(selectExclusiveRecordedCleaningMedia([ordinary, { ...ordinary, id: 'task-b' }], [dayEnd]), null, 'task conflict plus one day-end record must fail closed')
  assert.equal(selectExclusiveRecordedCleaningMedia([ordinary], [dayEnd, { ...dayEnd, user_id: 'cleaner-b' }]), null, 'day-end conflict plus one task record must fail closed')
  assert.equal(selectExclusiveRecordedCleaningMedia([ordinary], [dayEnd]), null, 'one key recorded by task and day-end records must fail closed')
  const inventoryManager = { sub: 'inventory-manager', role: 'inventory_manager', roles: ['inventory_manager'] }
  assert.equal(await mediaImageGateStatus(inventoryManager), 204, 'inventory_manager must reach recorded day-end media authorization through the route gate')
  assert.equal(await mediaImageGateStatus({ sub: 'finance-user', role: 'finance', roles: ['finance'] }), 403, 'unrelated role must be rejected by the route gate')
  assert.equal(canViewRecordedDayEndMedia(inventoryManager, dayEnd, 'inventory-manager'), true, 'inventory_manager may read a recorded day-end photo')
  assert.equal(canViewRecordedDayEndMedia({ sub: 'cleaner-a', role: 'cleaner', roles: ['cleaner'] }, dayEnd, 'cleaner-a'), true, 'day-end owner may read their recorded photo')
  assert.equal(canViewRecordedDayEndMedia({ sub: 'cleaner-b', role: 'cleaner', roles: ['cleaner'] }, dayEnd, 'cleaner-b'), false, 'unrelated cleaner must not read another owner\'s day-end photo')
  const png = await sharp({
    create: {
      width: 8,
      height: 6,
      channels: 3,
      background: { r: 240, g: 180, b: 80 },
    },
  }).png().toBuffer()

  const normalized = await normalizeCleaningImageUpload({
    buffer: png,
    contentType: 'image/heic',
    originalName: 'android-photo.heic',
  })
  assert.equal(normalized.normalized, true)
  assert.equal(normalized.contentType, 'image/jpeg')
  assert.equal(normalized.extension, '.jpg')
  assert.equal((await sharp(normalized.buffer).metadata()).format, 'jpeg')

  const mislabeled = await normalizeCleaningImageUpload({
    buffer: png,
    contentType: 'application/octet-stream',
    originalName: 'android-photo.jpg',
  })
  assert.equal(mislabeled.contentType, 'image/jpeg')
  assert.equal((await sharp(mislabeled.buffer).metadata()).format, 'jpeg')

  await assert.rejects(
    normalizeCleaningImageUpload({
      buffer: Buffer.from('not-an-image'),
      contentType: 'image/heic',
      originalName: 'broken.heic',
    }),
    (error: any) => error?.code === CLEANING_IMAGE_FORMAT_ERROR,
  )

  process.stdout.write('test_cleaning_media_image: ok\n')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
