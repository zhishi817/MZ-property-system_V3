import { renderMonthlyStatementPdfHtml } from '../../src/lib/monthlyStatementPdfTemplate'
import { countPhotoUrls, listPhotoUrls, recordHasPhotoUrls, recordMonthKey } from '../../src/lib/monthlyStatementPhotoRecords'
import { normalizePhotoUrlForPdf } from '../../src/lib/normalizePhotoUrlForPdf'

function assertOk(name: string, cond: any, extra?: any) {
  if (!cond) throw new Error(`${name} failed${extra !== undefined ? ` extra=${JSON.stringify(extra)}` : ''}`)
}

process.env.R2_PUBLIC_BASE_URL = 'https://bucket.r2.dev'
process.env.R2_BUCKET = 'bucket'
process.env.R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com'

const apiBase = 'https://api.example.com'
const allow = ['maintenance/', 'deep-cleaning/', 'deep-cleaning-upload/', 'invoice-company-logos/']

const deepRow = {
  id: 'dc-1',
  submitted_at: '2026-03-31T10:00:00Z',
  photo_urls: JSON.stringify([
    'deep-cleaning-upload/a.jpg',
    'https://bucket.r2.dev/deep-cleaning-upload/b.jpg',
  ]),
  repair_photo_urls: [{ url: 'https://bucket.r2.dev/deep-cleaning/c.jpg' }],
}

assertOk('submitted_at month key is used', recordMonthKey(deepRow) === '2026-03', recordMonthKey(deepRow))
assertOk('mixed url list is parsed', countPhotoUrls(deepRow.photo_urls) === 2, listPhotoUrls(deepRow.photo_urls))
assertOk('object url list is parsed', countPhotoUrls(deepRow.repair_photo_urls) === 1, listPhotoUrls(deepRow.repair_photo_urls))
assertOk('record with photo urls is included', recordHasPhotoUrls(deepRow) === true)

const normalizedBefore = listPhotoUrls(deepRow.photo_urls).map((u) =>
  normalizePhotoUrlForPdf(u, { apiBase, allowR2KeyPrefixes: allow, photosMode: 'full' })
)
const normalizedAfter = listPhotoUrls(deepRow.repair_photo_urls).map((u) =>
  normalizePhotoUrlForPdf(u, { apiBase, allowR2KeyPrefixes: allow, photosMode: 'full' })
)

assertOk('deep-cleaning-upload key proxies', normalizedBefore[0].startsWith(`${apiBase}/public/r2-image?url=`), normalizedBefore[0])
assertOk('deep-cleaning-upload r2 url proxies', normalizedBefore[1].startsWith(`${apiBase}/public/r2-image?url=`), normalizedBefore[1])
assertOk('deep-cleaning r2 url proxies', normalizedAfter[0].startsWith(`${apiBase}/public/r2-image?url=`), normalizedAfter[0])

const tpl = renderMonthlyStatementPdfHtml({
  month: '2026-03',
  property: { id: 'p1', code: 'MSCQ123' },
  sections: 'deep_cleaning',
  includePhotosMode: 'full',
  deepCleanings: [
    {
      id: 'dc-1',
      submitted_at: deepRow.submitted_at,
      photo_urls: normalizedBefore,
      repair_photo_urls: normalizedAfter,
    } as any,
  ],
  maintenances: [],
})

assertOk('template image count matches normalized deep photos', tpl.imageCount === 3, tpl.imageCount)

process.stdout.write('ok\n')
