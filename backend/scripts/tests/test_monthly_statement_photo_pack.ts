import assert from 'assert'
import fs from 'fs'
import sharp from 'sharp'
import { PDFDocument } from 'pdf-lib'
import {
  assertStatementPhotoPackHasEmbeddableImages,
  countPlannedStatementPhotoReferences,
  isSafeStatementPhotoObjectKey,
  loadStatementPhotoAsset,
  normalizeStatementPhotoFetchTarget,
  prepareStatementPhotoPackRecords,
  renderPhotoPackPdfFromRecords,
  splitStatementPhotoPackVolumes,
  type StatementPhotoPackAssetDependencies,
  type StatementPhotoPackSourceRow,
} from '../../src/lib/monthlyStatementPhotoPack'
import { listPhotoUrls, statementPhotoReferenceGroups } from '../../src/lib/monthlyStatementPhotoRecords'
import type { PhotoPackTemplateRecord } from '../../src/lib/monthlyStatementPhotoPackTemplate'
import { resetChromiumBrowser } from '../../src/lib/playwright'

function makeRecord(id: string, beforeCount: number, afterCount: number): PhotoPackTemplateRecord {
  return {
    kind: 'deep_cleaning',
    jobNumber: id,
    completionText: '2026-05-01',
    areaText: '厨房',
    beforeImages: Array.from({ length: beforeCount }, (_, i) => ({ dataUrl: `before-${id}-${i + 1}`, mimeType: 'image/jpeg' })),
    afterImages: Array.from({ length: afterCount }, (_, i) => ({ dataUrl: `after-${id}-${i + 1}`, mimeType: 'image/jpeg' })),
    beforeRawCount: beforeCount,
    afterRawCount: afterCount,
  }
}

async function imageBytes(red: number, green: number, blue: number) {
  return sharp({
    create: { width: 80, height: 60, channels: 3, background: { r: red, g: green, b: blue } },
  }).jpeg({ quality: 90 }).toBuffer()
}

function dependenciesFor(objects: Map<string, Buffer>, externalBody: Buffer): StatementPhotoPackAssetDependencies {
  return {
    keyFromR2Url: (value) => {
      try {
        const url = new URL(value)
        return url.hostname === 'private-r2.example.test' ? url.pathname.replace(/^\/+/, '') : null
      } catch {
        return null
      }
    },
    readR2Object: async (key) => {
      if (key.includes('storage-unavailable')) return { status: 'unavailable' }
      const body = objects.get(key)
      return body ? { status: 'ok', object: { body, contentType: 'image/jpeg' } } : { status: 'not_found' }
    },
    fetchExternal: async (url) => {
      if (url.includes('not-image')) return { body: externalBody, contentType: 'text/plain' }
      return { body: externalBody, contentType: 'image/jpeg' }
    },
  }
}

async function run() {
  assert.deepEqual(listPhotoUrls([
    'a.jpg',
    { url: 'b.jpg' },
    { urls: ['c.jpg', { src: 'd.jpg' }] },
  ]), ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'])

  assert.deepEqual(statementPhotoReferenceGroups({
    photo_urls: ['before.jpg', 'before.jpg'],
    completion_photo_urls: ['completion.jpg', 'same-after.jpg'],
    repair_photo_urls: ['same-after.jpg', 'legacy-after.jpg'],
  }), {
    before: ['before.jpg'],
    after: ['completion.jpg', 'same-after.jpg', 'legacy-after.jpg'],
  })

  assert.equal(isSafeStatementPhotoObjectKey('cleaning/media/redacted-task/photo-without-extension'), true)
  assert.equal(isSafeStatementPhotoObjectKey('maintenance/legacy-photo.jpg'), true)
  assert.equal(isSafeStatementPhotoObjectKey('cleaning/../other-property/photo'), false)
  assert.equal(isSafeStatementPhotoObjectKey('cleaning/media/photo?token=secret'), false)
  assert.deepEqual(normalizeStatementPhotoFetchTarget(
    'cleaning/media/redacted-task/photo-without-extension',
    '',
    () => null,
  ), { kind: 'r2', value: 'cleaning/media/redacted-task/photo-without-extension' })
  const privateR2Key = (value: string) => {
    try {
      const url = new URL(value)
      return url.hostname === 'private-r2.example.test' ? url.pathname.replace(/^\/+/, '') : null
    } catch {
      return null
    }
  }
  assert.deepEqual(normalizeStatementPhotoFetchTarget(
    'https://private-r2.example.test/maintenance/legacy-photo.jpg',
    '',
    privateR2Key,
  ), { kind: 'r2', value: 'maintenance/legacy-photo.jpg' })
  assert.deepEqual(normalizeStatementPhotoFetchTarget(
    '/r2-image?url=https%3A%2F%2Fprivate-r2.example.test%2Fdeep-cleaning%2Flegacy-photo.jpg',
    'https://api.example.test',
    privateR2Key,
  ), { kind: 'r2', value: 'deep-cleaning/legacy-photo.jpg' })
  assert.equal(normalizeStatementPhotoFetchTarget('/uploads/legacy.jpg', '', () => null), null)
  assert.deepEqual(
    normalizeStatementPhotoFetchTarget('/uploads/legacy.jpg', 'https://api.example.test', () => null),
    { kind: 'url', value: 'https://api.example.test/uploads/legacy.jpg' },
  )

  const keys = [
    'cleaning/media/redacted-task-a/before-1',
    'cleaning/media/redacted-task-a/after-1',
    'cleaning/media/redacted-task-b/before-1',
    'cleaning/media/redacted-task-b/after-1',
  ]
  const bodies = await Promise.all([
    imageBytes(220, 40, 40),
    imageBytes(40, 180, 40),
    imageBytes(40, 40, 220),
    imageBytes(200, 160, 40),
  ])
  const objects = new Map(keys.map((key, index) => [key, bodies[index]]))
  const dependencies = dependenciesFor(objects, bodies[0])
  const la812ShapedRows: StatementPhotoPackSourceRow[] = [
    {
      kind: 'maintenance',
      row: {
        id: 'redacted-record-a',
        work_no: 'TEST-812-A',
        completed_at: '2026-10-04T01:00:00.000Z',
        category: 'Kitchen',
        photo_urls: [keys[0]],
        completion_photo_urls: [keys[1]],
        repair_photo_urls: [keys[1]],
      },
    },
    {
      kind: 'maintenance',
      row: {
        id: 'redacted-record-b',
        work_no: 'TEST-812-B',
        completed_at: '2026-10-14T01:00:00.000Z',
        category: 'Bathroom',
        photo_urls: [keys[2]],
        completion_photo_urls: [keys[3]],
        repair_photo_urls: [],
      },
    },
  ]
  assert.equal(countPlannedStatementPhotoReferences(la812ShapedRows), 4)
  const prepared = await prepareStatementPhotoPackRecords({
    sourceRows: la812ShapedRows,
    apiBase: '',
    fetchConcurrency: 2,
    fetchTimeoutMs: 2000,
    maxEdge: 1200,
    jpegQuality: 80,
    dependencies,
  })
  assert.equal(prepared.records.length, 2)
  assert.equal(prepared.successImages, 4)
  assert.equal(prepared.failedDetails.length, 0)
  assert.deepEqual(prepared.records.map((record) => [record.beforeImages.length, record.afterImages.length]), [[1, 1], [1, 1]])
  assertStatementPhotoPackHasEmbeddableImages(prepared, 4)

  const mixedPrepared = await prepareStatementPhotoPackRecords({
    sourceRows: [{
      kind: 'maintenance',
      row: {
        id: 'mixed-record',
        completed_at: '2026-10-15',
        photo_urls: ['maintenance/legacy-before.jpg'],
        completion_photo_urls: ['https://assets.example.test/legacy-after.jpg'],
        repair_photo_urls: ['https://assets.example.test/legacy-after.jpg', 'deep-cleaning/historical-after.jpg'],
      },
    }],
    apiBase: '',
    fetchConcurrency: 2,
    fetchTimeoutMs: 2000,
    maxEdge: 1200,
    jpegQuality: 80,
    dependencies: dependenciesFor(new Map([
      ['maintenance/legacy-before.jpg', bodies[0]],
      ['deep-cleaning/historical-after.jpg', bodies[1]],
    ]), bodies[2]),
  })
  assert.equal(mixedPrepared.successImages, 3)
  assert.equal(mixedPrepared.records[0].afterRawCount, 2)
  assert.equal(mixedPrepared.records[0].afterImages.length, 2)

  const association = new Set(['cleaning/media/current-property/photo'])
  const unassociated = await loadStatementPhotoAsset({
    raw: 'cleaning/media/other-property/photo',
    associatedReferences: association,
    apiBase: '',
    timeoutMs: 2000,
    maxEdge: 1200,
    jpegQuality: 80,
    dependencies,
  })
  assert.equal(unassociated.reason, 'unassociated_source')

  const illegal = await loadStatementPhotoAsset({
    raw: 'cleaning/../other-property/photo',
    associatedReferences: new Set(['cleaning/../other-property/photo']),
    apiBase: '',
    timeoutMs: 2000,
    maxEdge: 1200,
    jpegQuality: 80,
    dependencies,
  })
  assert.equal(illegal.reason, 'invalid_source')

  const missing = await loadStatementPhotoAsset({
    raw: 'cleaning/media/redacted-task/missing',
    associatedReferences: new Set(['cleaning/media/redacted-task/missing']),
    apiBase: '',
    timeoutMs: 2000,
    maxEdge: 1200,
    jpegQuality: 80,
    dependencies,
  })
  assert.equal(missing.reason, 'r2_not_found')

  const unavailable = await loadStatementPhotoAsset({
    raw: 'cleaning/media/redacted-task/storage-unavailable',
    associatedReferences: new Set(['cleaning/media/redacted-task/storage-unavailable']),
    apiBase: '',
    timeoutMs: 2000,
    maxEdge: 1200,
    jpegQuality: 80,
    dependencies,
  })
  assert.equal(unavailable.reason, 'r2_unavailable')

  const corruptDependencies = dependenciesFor(new Map([
    ['cleaning/media/redacted-task/corrupt', Buffer.from('not-an-image')],
  ]), bodies[0])
  const corrupt = await loadStatementPhotoAsset({
    raw: 'cleaning/media/redacted-task/corrupt',
    associatedReferences: new Set(['cleaning/media/redacted-task/corrupt']),
    apiBase: '',
    timeoutMs: 2000,
    maxEdge: 1200,
    jpegQuality: 80,
    dependencies: corruptDependencies,
  })
  assert.equal(corrupt.reason, 'image_decode_failed')

  const invalidContent = await loadStatementPhotoAsset({
    raw: 'https://assets.example.test/not-image',
    associatedReferences: new Set(['https://assets.example.test/not-image']),
    apiBase: '',
    timeoutMs: 2000,
    maxEdge: 1200,
    jpegQuality: 80,
    dependencies,
  })
  assert.equal(invalidContent.reason, 'invalid_content_type')

  const timeout = await loadStatementPhotoAsset({
    raw: 'https://assets.example.test/slow.jpg',
    associatedReferences: new Set(['https://assets.example.test/slow.jpg']),
    apiBase: '',
    timeoutMs: 2000,
    maxEdge: 1200,
    jpegQuality: 80,
    dependencies: {
      ...dependencies,
      fetchExternal: async () => { throw Object.assign(new Error('request aborted'), { name: 'AbortError' }) },
    },
  })
  assert.equal(timeout.reason, 'fetch_timeout')

  const partial = await prepareStatementPhotoPackRecords({
    sourceRows: [{
      kind: 'maintenance',
      row: { id: 'partial', completed_at: '2026-10-16', photo_urls: [keys[0], 'cleaning/media/redacted-task/missing'], repair_photo_urls: [] },
    }],
    apiBase: '',
    fetchConcurrency: 2,
    fetchTimeoutMs: 2000,
    maxEdge: 1200,
    jpegQuality: 80,
    dependencies,
  })
  assert.equal(partial.successImages, 1)
  assert.equal(partial.failedDetails.length, 1)
  assert.equal(partial.records.length, 1)
  assertStatementPhotoPackHasEmbeddableImages(partial, 2)

  const allMissing = await prepareStatementPhotoPackRecords({
    sourceRows: [{
      kind: 'maintenance',
      row: { id: 'all-missing', completed_at: '2026-10-17', photo_urls: ['cleaning/media/redacted-task/missing'], repair_photo_urls: ['cleaning/media/redacted-task/storage-unavailable'] },
    }],
    apiBase: '',
    fetchConcurrency: 2,
    fetchTimeoutMs: 2000,
    maxEdge: 1200,
    jpegQuality: 80,
    dependencies,
  })
  assert.throws(
    () => assertStatementPhotoPackHasEmbeddableImages(allMissing, 2),
    (error: any) => error?.code === 'PHOTO_PACK_RENDER_EMPTY'
      && /r2_not_found=1/.test(String(error?.message || ''))
      && /r2_unavailable=1/.test(String(error?.message || ''))
      && Array.isArray(error?.failedUrls)
      && error.failedUrls.every((item: string) => /^r2_(not_found|unavailable):ref=[a-f0-9]{12}$/.test(item)),
  )

  const beforeUrls = Array.from({ length: 18 }, (_, i) => `before-${i + 1}.jpg`)
  const afterUrls = Array.from({ length: 8 }, (_, i) => `after-${i + 1}.jpg`)
  assert.equal(beforeUrls.length + afterUrls.length, 26)

  const volumes = splitStatementPhotoPackVolumes([
    makeRecord('A', 18, 8),
    makeRecord('B', 40, 30),
    makeRecord('C', 5, 2),
  ], { imagesPerVolume: 60, pagesPerVolume: 20 })
  assert.equal(volumes.length, 3)
  assert.ok(volumes.every((volume) => volume.length === 1))

  const giant = makeRecord('GIANT', 140, 20)
  const giantVolumes = splitStatementPhotoPackVolumes([giant], { imagesPerVolume: 120, pagesPerVolume: 35 })
  assert.equal(giantVolumes.length, 1)
  assert.equal(giantVolumes[0][0].jobNumber, 'GIANT')

  if (String(process.env.MZ103_RENDER_PDF || '').trim().toLowerCase() === 'yes') {
    const rendered = await renderPhotoPackPdfFromRecords({
      monthKey: '2026-10',
      property: { id: 'redacted-property', code: 'TEST812', address: 'Redacted' },
      landlordName: 'Redacted',
      showChinese: true,
      sections: 'maintenance',
      records: prepared.records,
      rawUrls: 4,
      cleanedUrls: 4,
      failedUrls: [],
      notLoaded: 0,
      effectivePhotosMode: 'compressed',
    })
    const pdf = await PDFDocument.load(rendered.pdf)
    assert.equal(rendered.imageCount, 4)
    assert.equal(pdf.getPageCount(), 2)
    const outputPath = String(process.env.MZ103_PDF_OUTPUT || '').trim()
    if (outputPath) fs.writeFileSync(outputPath, rendered.pdf)
    await resetChromiumBrowser()
    console.log(`test_monthly_statement_photo_pack passed records=${prepared.records.length} images=${rendered.imageCount} pages=${pdf.getPageCount()}`)
    return
  }

  console.log(`test_monthly_statement_photo_pack passed records=${prepared.records.length} images=${prepared.successImages} pdf=skipped`)
}

run().catch(async (error) => {
  if (String(process.env.MZ103_RENDER_PDF || '').trim().toLowerCase() === 'yes') {
    try { await resetChromiumBrowser() } catch {}
  }
  console.error(error)
  process.exit(1)
})
