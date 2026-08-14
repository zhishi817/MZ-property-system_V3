import assert from 'node:assert/strict'
import fs from 'node:fs'
import express from 'express'
import sharp from 'sharp'

const dbAdapter = require('../../src/dbAdapter')
const r2 = require('../../src/r2')
const noticeKey = 'mzapp/guest-luggage.jpg'
const noticeRow = {
  id: 'guest-luggage-1',
  property_id: 'property-1',
  task_date: '2026-08-14',
  photo_urls: [noticeKey],
}
const authorizedUserIds = new Set(['cleaner-1', 'inspector-1'])
let objectReadCount = 0
let simulateFeedbackFallback = false
let feedbackQueryCount = 0

dbAdapter.hasPg = true
dbAdapter.pgPool = {
  async query(sql: string, params: any[] = []) {
    if (/FROM guest_luggage_notices/.test(sql)) {
      const references = Array.isArray(params[0]) ? params[0].map(String) : []
      const rows = references.includes(noticeKey) ? [noticeRow] : []
      return { rows, rowCount: rows.length }
    }
    if (/SELECT 1\s+FROM cleaning_tasks t/.test(sql)) {
      const allowed = authorizedUserIds.has(String(params[2] || ''))
      return { rows: allowed ? [{ ok: 1 }] : [], rowCount: allowed ? 1 : 0 }
    }
    if (/FROM property_maintenance m/.test(sql)) {
      feedbackQueryCount += 1
      return {
        rows: simulateFeedbackFallback
          ? [{
              feedback_source_type: 'property_maintenance',
              feedback_source_id: 'feedback-1',
              property_id: 'property-1',
              photo_urls: [noticeKey],
              repair_photo_urls: [],
              completion_photo_urls: [],
              attachment_urls: [],
              project_items: [],
              assignee_id: null,
            }]
          : [],
        rowCount: simulateFeedbackFallback ? 1 : 0,
      }
    }
    return { rows: [], rowCount: 0 }
  },
}
r2.hasR2 = true
r2.r2GetObjectByKey = async (key: string) => {
  assert.equal(key, noticeKey, 'only the exactly authorized notice key may reach R2')
  objectReadCount += 1
  return {
    body: await sharp({ create: { width: 2, height: 2, channels: 3, background: '#44aa88' } }).png().toBuffer(),
    contentType: 'image/png',
    etag: 'guest-luggage-test',
  }
}

const { router, guestLuggageMediaRowReferencesKey, selectUniqueGuestLuggageMediaRow } = require('../../src/modules/cleaning_app')

const mediaRoute = fs.readFileSync(require.resolve('../../src/modules/cleaning_app'), 'utf8')
const mzappRoute = fs.readFileSync(require.resolve('../../src/modules/mzapp'), 'utf8')

assert.match(mediaRoute, /findGuestLuggageMediaRows/, 'media proxy must resolve temporary-notice media before object access')
assert.match(mediaRoute, /FROM guest_luggage_notices/, 'media proxy must bind a temporary-notice photo to its persisted notice row')
assert.match(mediaRoute, /photo_urls \?\| \$1::text\[\]/, 'temporary-notice lookup must exact-match recorded photo references')
assert.match(mediaRoute, /LIMIT 2/, 'temporary-notice lookup must reject ambiguous references')
assert.match(mediaRoute, /hasGuestLuggageContext\s*=\s*Boolean\(guestLuggageId\)/, 'temporary-notice context must be explicit')
assert.match(mediaRoute, /hasGuestLuggageContext\s*\?\s*\{ rows: await findGuestLuggageMediaRows/, 'temporary-notice lookup rows must retain the route result shape')
assert.match(mediaRoute, /selectUniqueGuestLuggageMediaRow\(matchingGuestLuggageRows, guestLuggageId\)/, 'resolved media must match the requested notification id')
assert.match(mediaRoute, /hasGuestLuggageSourceConflict/, 'cross-source temporary-notice collisions must remain fail closed')
assert.match(mediaRoute, /const canView = hasGuestLuggageContext\s*\?\s*!hasGuestLuggageSourceConflict/, 'a request carrying guest_luggage_id must not fall through to another media source')
assert.match(mediaRoute, /isExclusiveDayEndHandoverMedia\(/, 'day-end collision protection must remain intact')
assert.match(mediaRoute, /canViewMzappGuestLuggageNoticeMedia/, 'temporary-notice media must re-check the current authenticated user')

const storedRow = {
  id: 'guest-luggage-1',
  photo_urls: ['mzapp/guest-luggage.jpg'],
}
assert.equal(guestLuggageMediaRowReferencesKey(storedRow, 'mzapp/guest-luggage.jpg'), true, 'the exact recorded photo may be selected')
assert.equal(guestLuggageMediaRowReferencesKey(storedRow, 'mzapp/another-photo.jpg'), false, 'a photo outside the notice may not be selected')
assert.equal(selectUniqueGuestLuggageMediaRow([storedRow], 'guest-luggage-1'), storedRow, 'the exact notification id may select its one exact photo row')
assert.equal(selectUniqueGuestLuggageMediaRow([storedRow], 'guest-luggage-other'), null, 'a wrong notification id must be denied')
assert.equal(selectUniqueGuestLuggageMediaRow([storedRow], ''), null, 'a missing notification id must be denied')
assert.equal(selectUniqueGuestLuggageMediaRow([storedRow, { ...storedRow, id: 'guest-luggage-2' }], 'guest-luggage-1'), null, 'ambiguous photo rows must be denied')

assert.match(mzappRoute, /export async function canViewMzappGuestLuggageNoticeMedia/, 'guest-luggage authorization must remain reusable by the authenticated media route')
assert.match(mzappRoute, /canViewAll\(user\) \|\| canEditGuestLuggage\(user\)/, 'management readers retain their existing temporary-notice authority')
assert.match(mzappRoute, /\$3::text = ANY\(ARRAY\[t\.cleaner_id::text, t\.inspector_id::text, t\.assignee_id::text\]\)/, 'only same-day assigned cleaners, inspectors, or assignees may read a temporary-notice photo')
assert.match(mzappRoute, /activeCleaningTaskWhereSql\('t'\)/, 'superseded or cancelled task assignments cannot authorize temporary-notice media')

async function withMediaServer(run: (baseUrl: string) => Promise<void>) {
  const app = express()
  app.use((req: any, _res, next) => {
    const userId = String(req.headers['x-test-user'] || '')
    req.user = { sub: userId, role: 'cleaner', roles: ['cleaner'] }
    next()
  })
  app.use('/cleaning-app', router)
  const server = await new Promise<any>((resolve) => {
    const listener = app.listen(0, () => resolve(listener))
  })
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function requestGuestLuggageMedia(baseUrl: string, userId: string, guestLuggageId: string, key = noticeKey) {
  return fetch(`${baseUrl}/cleaning-app/media/image?key=${encodeURIComponent(key)}&guest_luggage_id=${encodeURIComponent(guestLuggageId)}`, {
    headers: { 'x-test-user': userId },
  })
}

async function verifyRouteContract() {
  await withMediaServer(async (baseUrl) => {
    const authorized = await requestGuestLuggageMedia(baseUrl, 'cleaner-1', 'guest-luggage-1')
    assert.equal(authorized.status, 200, 'the assigned cleaner may read the exactly associated temporary-notice photo')
    assert.equal(authorized.headers.get('content-type'), 'image/jpeg')
    assert.ok((await authorized.arrayBuffer()).byteLength > 0, 'the authorized proxy response contains image bytes')
    assert.equal(objectReadCount, 1, 'only the authorized request may read R2')

    const inspector = await requestGuestLuggageMedia(baseUrl, 'inspector-1', 'guest-luggage-1')
    assert.equal(inspector.status, 200, 'the assigned inspector may read the exactly associated temporary-notice photo')
    assert.equal(objectReadCount, 2, 'the assigned inspector may read the same authorized object')

    const feedbackQueryCountBeforeWrongId = feedbackQueryCount
    simulateFeedbackFallback = true
    const wrongId = await requestGuestLuggageMedia(baseUrl, 'cleaner-1', 'guest-luggage-other')
    simulateFeedbackFallback = false
    assert.equal(wrongId.status, 403, 'the correct photo with a wrong guest_luggage_id must be denied')
    assert.equal(objectReadCount, 2, 'a wrong notification id must not reach R2')
    assert.equal(feedbackQueryCount, feedbackQueryCountBeforeWrongId, 'a supplied notice id must not query a generic feedback fallback')

    const unrecordedPhoto = await requestGuestLuggageMedia(baseUrl, 'cleaner-1', 'guest-luggage-1', 'mzapp/not-on-notice.jpg')
    assert.equal(unrecordedPhoto.status, 403, 'a photo outside the notification must be denied')
    assert.equal(objectReadCount, 2, 'a photo outside the notification must not reach R2')

    const unauthorized = await requestGuestLuggageMedia(baseUrl, 'outsider-1', 'guest-luggage-1')
    assert.equal(unauthorized.status, 403, 'an unassigned user must be denied')
    assert.equal(objectReadCount, 2, 'an unassigned user must not reach R2')
  })
}

verifyRouteContract()
  .then(() => console.log('guest luggage media contract passed'))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
