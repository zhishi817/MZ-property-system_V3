import { normalizePhotoUrlForPdf } from '../../src/lib/normalizePhotoUrlForPdf'

function assertOk(name: string, cond: any, extra?: any) {
  if (!cond) throw new Error(`${name} failed${extra !== undefined ? ` extra=${JSON.stringify(extra)}` : ''}`)
}

process.env.R2_PUBLIC_BASE_URL = 'https://bucket.r2.dev'
process.env.R2_BUCKET = 'bucket'
process.env.R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com'

const apiBase = 'https://api.example.com'
const allow = ['maintenance/', 'deep-cleaning/', 'deep-cleaning-upload/', 'invoice-company-logos/']

const u1 = normalizePhotoUrlForPdf('deep-cleaning-upload/a.jpg', { apiBase, allowR2KeyPrefixes: allow, photosMode: 'full' })
assertOk('key deep-cleaning-upload should normalize', typeof u1 === 'string' && u1.length > 0, u1)
assertOk('key deep-cleaning-upload should proxy', u1.startsWith(`${apiBase}/public/r2-image?url=`), u1)

const u2 = normalizePhotoUrlForPdf('other/a.jpg', { apiBase, allowR2KeyPrefixes: allow, photosMode: 'full' })
assertOk('key other should be rejected', u2 === '', u2)

const src = 'https://bucket.r2.dev/deep-cleaning-upload/a.jpg'
const u3 = normalizePhotoUrlForPdf(src, { apiBase, allowR2KeyPrefixes: allow, photosMode: 'full' })
assertOk('r2 url should proxy', u3.startsWith(`${apiBase}/public/r2-image?url=`), u3)

process.stdout.write('ok\n')

