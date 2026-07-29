import assert from 'assert'
import fs from 'fs'
import sharp from 'sharp'
import { CLEANING_IMAGE_FORMAT_ERROR, normalizeCleaningImageUpload } from '../../src/lib/cleaningMediaImage'

async function main() {
  const route = fs.readFileSync(require.resolve('../../src/modules/cleaning_app'), 'utf8')
  assert.match(route, /FROM cleaning_task_media ctm[\s\S]*JOIN cleaning_tasks ct/, 'media proxy must bind a requested object to a recorded task media row')
  assert.match(route, /canViewMzappRecordedCleaningMedia/, 'media proxy must enforce task-specific media visibility before reading R2')
  assert.match(route, /forbidden_media/, 'unrecorded or unauthorized media keys must fail closed')
  assert.match(route, /matchingMediaRows\.length === 1/, 'media proxy must fail closed when one canonical R2 key is associated with multiple task media rows')
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
