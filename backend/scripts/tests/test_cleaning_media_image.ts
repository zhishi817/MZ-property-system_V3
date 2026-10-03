import assert from 'assert'
import fs from 'fs'
import sharp from 'sharp'
import { CLEANING_IMAGE_FORMAT_ERROR, normalizeCleaningImageUpload } from '../../src/lib/cleaningMediaImage'
import {
  canUseUniqueFeedbackMediaForMismatchedTaskContext,
  canViewRecordedDayEndMedia,
  hasRecordedCleaningMediaSourceTaskMismatch,
  isExclusiveDayEndHandoverMedia,
  selectExclusiveRecordedCleaningMedia,
  selectUniqueRecordedCleaningMediaRow,
  selectUniqueRecordedDayEndMediaRow,
} from '../../src/modules/cleaning_app'
import { canViewMzappPropertyFeedback } from '../../src/modules/mzapp'

async function main() {
  const route = fs.readFileSync(require.resolve('../../src/modules/cleaning_app'), 'utf8')
  assert.match(route, /FROM cleaning_task_media ctm[\s\S]*JOIN cleaning_tasks ct/, 'media proxy must bind a requested object to a recorded task media row')
  assert.match(route, /ctm\.uploader_id::text AS uploader_id/, 'media proxy must load persisted uploader ownership for task-media authorization')
  assert.doesNotMatch(route, /\(\$2::text = '' OR ctm\.task_id::text = \$2::text\)/, 'caller task context must not hide recorded task-media associations from collision detection')
  assert.match(route, /FROM cleaning_consumable_usages u[\s\S]*JOIN cleaning_tasks ct/, 'media proxy must also resolve recorded consumable photo references')
  assert.doesNotMatch(route, /\(\$2::text = '' OR ct\.id::text = \$2::text\)/, 'caller task context must not hide recorded consumable associations from collision detection')
  assert.match(route, /const hasTaskContextMismatch = hasRecordedCleaningMediaSourceTaskMismatch\(matchingMediaRows, sourceTaskId\)/, 'source_task_id must be validated after all recorded task associations are loaded')
  const matchingMediaRowsIndex = route.indexOf('const matchingMediaRows =')
  const sourceMismatchGuardIndex = route.indexOf('if (hasTaskContextMismatch', matchingMediaRowsIndex)
  const exactFeedbackLookupIndex = route.lastIndexOf('const feedbackMediaRows =', sourceMismatchGuardIndex)
  assert.ok(exactFeedbackLookupIndex >= 0 && sourceMismatchGuardIndex > exactFeedbackLookupIndex, 'the proxy must resolve an exact feedback association before deciding whether the current screen task is a mismatch')
  assert.match(route, /canUseUniqueFeedbackMediaForMismatchedTaskContext\(matchingMediaRows, feedbackMediaRows\)/, 'a mismatched screen task may proceed only through one unambiguous feedback record')
  assert.match(route, /const feedbackViewerTaskResult = feedbackMediaRow && sourceTaskId[\s\S]*FROM cleaning_tasks[\s\S]*WHERE id::text = \$1::text/, 'a supplied feedback viewer task must resolve one real task before granting historical feedback access')
  assert.match(route, /canViewMzappRecordedCleaningMedia\(user, feedbackViewerTask, userId, 'feedback_viewer_context'\)/, 'the current task carried by the feedback screen must be visible to the authenticated user')
  assert.match(route, /FROM guest_luggage_notices/, 'media proxy must resolve a temporary-notice photo through its saved notice record')
  assert.match(route, /guest_luggage_id/, 'temporary-notice media must require an exact notice context')
  assert.match(route, /hasGuestLuggageSourceConflict/, 'a temporary-notice key that collides with another recorded source must fail closed')
  assert.match(route, /!hasTaskOrDayEndMedia \|\| \(matchingMediaRows\.length > 0 && hasTaskContextMismatch\)\s*\? await findPropertyFeedbackMediaRows\(pgPool, key\)/, 'feedback-only keys and mismatched historical task contexts must resolve exact feedback history without slowing the ordinary task/day-end path')
  assert.match(route, /hasTaskOrDayEndMedia \|\| feedbackMediaRows\.length > 0/, 'a temporary-notice key colliding with task, day-end, feedback, or external-maintenance media must fail closed')
  assert.match(route, /const canView = hasGuestLuggageContext\s*\?\s*!hasGuestLuggageSourceConflict/, 'a supplied temporary-notice id must be authorized only through its exact notice association')
  assert.match(route, /FROM cleaning_day_end_media/, 'media proxy must resolve recorded day-end handover photos')
  assert.match(route, /isExclusiveDayEndHandoverMedia\(/, 'the owner/date day-end branch must reject a key recorded by any other private-media source before reading R2')
  assert.match(route, /findPropertyFeedbackMediaRows\(pgPool, dayEndKey\)/, 'the owner/date day-end branch must include feedback and external-maintenance records in cross-source collision detection')
  assert.match(route, /FROM guest_luggage_notices[\s\S]*dayEndKeyPattern/, 'the owner/date day-end branch must include temporary-notice records in cross-source collision detection')
  assert.match(route, /canViewMzappRecordedCleaningMedia/, 'media proxy must enforce task-specific media visibility before reading R2')
  assert.match(route, /canViewRecordedDayEndMedia/, 'media proxy must enforce day-end owner or manager visibility before reading R2')
  assert.match(route, /canViewMzappPropertyFeedback\(user, feedbackMediaRow, userId\)/, 'property-feedback media must use the resolved property record and current authenticated user')
  assert.match(route, /findOfflineWorkTaskPhotoRows/, 'offline media must resolve an exact work-task photo association before reading bytes')
  assert.match(route, /COALESCE\(w\.photo_urls, '\[\]'::jsonb\) \|\| COALESCE\(w\.completion_photo_urls, '\[\]'::jsonb\)/, 'offline media must compare canonical identities from both task and persisted completion photo references')
  assert.match(route, /offlineTaskPhotoReferenceVariants\(requestedKey\)[\s\S]*offlineTaskPhotoReferenceVariants\(sourceUrl\)/, 'key and source URL must independently resolve offline ownership before generic feedback lookup')
  assert.match(route, /requestedWorkTaskIdRaw && !requestedWorkTaskId/, 'malformed offline work-task context must fail closed')
  assert.doesNotMatch(route, /Boolean\(!sourceTaskId && \(offlineCurrentKey \|\| offlineLegacyReference\)\)/, 'source_task_id must never bypass offline-media association')
  assert.match(route, /function inspectMzappR2Url/, 'R2 URL variants must be parsed instead of matched with a lossy string prefix')
  assert.match(route, /url\.hostname\.toLowerCase\(\)\.endsWith\('\.r2\.dev'\)/, 'R2 variant recognition must use the parsed hostname')
  assert.match(route, /url\.protocol !== 'https:'/ , 'plaintext HTTP R2 variants must be rejected before generic media lookup')
  assert.match(route, /authority\.includes\('@'\) \|\| \/:\\d\+\$\/.test\(authority\)/, 'explicit ports and userinfo must be rejected even when URL parsing normalizes defaults')
  assert.match(route, /requestedKeyMzappR2Url\?\.hasUnsafeVariant \|\| sourceUrlMzappR2Url\?\.hasUnsafeVariant/, 'any supplied R2 URL query, fragment, port or userinfo variant must fail closed even when a key is supplied')
  assert.match(route, /findOfflineWorkTaskPhotoRows\(pgPool, offlineReferences\)/, 'offline lookup must consider every supplied reference before validating task access')
  assert.match(route, /offlineStoredReference = offlineReferences\.find/, 'the object read must use the exact stored offline reference that established authorization')
  assert.match(route, /currentOfflineTaskPhotoKeyFromReference/, 'a matched current-public-base historical reference must load by its parsed object key only after authorization')
  assert.match(route, /normalizeStoredPhotoUrls\(offlineRow\.completion_photo_urls\)/, 'persisted completion-photo references must be eligible for exact offline task authorization')
  assert.match(route, /offlineRows\.length && \(!offlineRow \|\| \(requestedWorkTaskId && String\(offlineRow\.id \|\| ''\)\.trim\(\) !== requestedWorkTaskId\)\)/, 'zero-or-wrong task context must not fall through after an offline association is found')
  assert.match(route, /code: 'media_not_found'/, 'an authorized but missing offline object must report a terminal not-found result')
  assert.match(route, /if \(!canView\) \{\s*return res\.status\(403\)\.json\(\{ message: 'forbidden_media' \}\)/, 'source-specific authorization must fail closed before R2 is read')
  assert.match(route, /forbidden_media/, 'unrecorded or unauthorized media keys must fail closed')
  assert.match(route, /selectUniqueRecordedCleaningMediaRow/, 'media proxy must use the single-task and single-type authorization selector')
  assert.match(route, /living_room_photo_urls: livingRoomPhotoUrls/, 'consumables response must expose the compatible plural living-photo field')
  assert.match(route, /living_room_photo_url: livingRoomPhotoUrls\[0\] \|\| null/, 'legacy living-photo field must remain the first plural item')
  assert.match(route, /INSERT INTO cleaning_task_media \(id, task_id, type, url, captured_at, lat, lng, uploader_id\)/, 'direct task media inserts must persist uploader ownership')
  assert.match(route, /uploader_id: String\(user\?\.sub \|\| ''\)\.trim\(\) \|\| null/, 'object-based task media inserts must persist uploader ownership')
  assert.match(route, /type LIKE 'consumable_item_photo:%'/, 'replacement consumable submissions must clear prior uploader-owned item-photo records')
  assert.match(route, /type: `consumable_item_photo:\$\{String\(it\.item_id\)\}`,[\s\S]*?uploader_id: String\(user\?\.sub \|\| ''\)\.trim\(\) \|\| null/, 'consumable item photos must persist an exact uploader-owned task-media record')
  assert.match(route, /recordedTaskMediaKeys[\s\S]*?return !recordedTaskMediaKeys\.has\(storedKey\)/, 'media authorization must prefer uploader-owned task-media rows over legacy consumable usage fallbacks')
  const ordinary = { id: 'task-a', type: 'consumable_item_photo', url: 'cleaning/a.jpg' }
  assert.equal(hasRecordedCleaningMediaSourceTaskMismatch([ordinary], ''), false, 'missing optional task context keeps existing exact-source collision checks')
  assert.equal(hasRecordedCleaningMediaSourceTaskMismatch([ordinary], 'task-a'), false, 'matching task context may proceed to source-specific authorization')
  assert.equal(hasRecordedCleaningMediaSourceTaskMismatch([ordinary], 'task-b'), true, 'wrong task context must deny even if another source records the same key')
  assert.equal(hasRecordedCleaningMediaSourceTaskMismatch([], 'task-b'), true, 'supplied task context without any matching task association must not fall through to another source')
  assert.equal(canUseUniqueFeedbackMediaForMismatchedTaskContext([ordinary], [{ id: 'feedback-a' }]), true, 'one exact task association and one exact feedback record may use feedback authorization')
  assert.equal(canUseUniqueFeedbackMediaForMismatchedTaskContext([], [{ id: 'feedback-a' }]), true, 'feedback-only history may use the current visible task as viewer context')
  assert.equal(canUseUniqueFeedbackMediaForMismatchedTaskContext([ordinary], []), false, 'a wrong task context without feedback remains denied')
  assert.equal(canUseUniqueFeedbackMediaForMismatchedTaskContext([ordinary], [{ id: 'feedback-a' }, { id: 'feedback-b' }]), false, 'ambiguous feedback records remain denied')
  assert.equal(canUseUniqueFeedbackMediaForMismatchedTaskContext([ordinary, { ...ordinary, id: 'task-b' }], [{ id: 'feedback-a' }]), false, 'ambiguous task ownership cannot fall through to feedback authorization')
  assert.equal(selectUniqueRecordedCleaningMediaRow([ordinary]), ordinary)
  assert.equal(selectUniqueRecordedCleaningMediaRow([ordinary, { ...ordinary, type: 'inspection_photo' }]), null, 'one key recorded under two types must fail closed')
  assert.equal(selectUniqueRecordedCleaningMediaRow([ordinary, { ...ordinary, id: 'task-b' }]), null, 'one key recorded under two tasks must fail closed')
  const dayEnd = { user_id: 'cleaner-a', date: '2026-08-12', kind: 'warehouse_key_return', url: 'cleaning/day-end.jpg' }
  assert.equal(selectUniqueRecordedDayEndMediaRow([dayEnd]), dayEnd)
  assert.equal(selectUniqueRecordedDayEndMediaRow([dayEnd, { ...dayEnd, user_id: 'cleaner-b' }]), null, 'one key recorded for two day-end users must fail closed')
  assert.equal(selectUniqueRecordedDayEndMediaRow([dayEnd, { ...dayEnd, kind: 'remaining_consumables' }]), null, 'one key recorded for two day-end kinds must fail closed')
  assert.equal(selectExclusiveRecordedCleaningMedia([ordinary], []).source, 'task')
  assert.equal(selectExclusiveRecordedCleaningMedia([], [dayEnd]).source, 'day_end')
  assert.equal(selectExclusiveRecordedCleaningMedia([ordinary, { ...ordinary, id: 'task-b' }], [dayEnd]), null, 'task conflict plus one day-end record must fail closed')
  assert.equal(selectExclusiveRecordedCleaningMedia([ordinary], [dayEnd, { ...dayEnd, user_id: 'cleaner-b' }]), null, 'day-end conflict plus one task record must fail closed')
  assert.equal(selectExclusiveRecordedCleaningMedia([ordinary], [dayEnd]), null, 'one key recorded by task and day-end records must fail closed')
  assert.equal(isExclusiveDayEndHandoverMedia([dayEnd], [], [], [], 'cleaner-a', '2026-08-12'), true, 'one exact day-end record may be read by its owner/date route')
  assert.equal(isExclusiveDayEndHandoverMedia([dayEnd], [ordinary], [], [], 'cleaner-a', '2026-08-12'), false, 'day-end owner/date media must reject a task-media collision')
  assert.equal(isExclusiveDayEndHandoverMedia([dayEnd], [], [{ id: 'notice-a' }], [], 'cleaner-a', '2026-08-12'), false, 'day-end owner/date media must reject a temporary-notice collision')
  assert.equal(isExclusiveDayEndHandoverMedia([dayEnd], [], [], [{ id: 'feedback-a' }], 'cleaner-a', '2026-08-12'), false, 'day-end owner/date media must reject a feedback or external-maintenance collision')
  assert.equal(isExclusiveDayEndHandoverMedia([dayEnd, { ...dayEnd, user_id: 'cleaner-b' }], [], [], [], 'cleaner-a', '2026-08-12'), false, 'day-end owner/date media must reject another day-end owner collision')
  const inventoryManager = { sub: 'inventory-manager', role: 'inventory_manager', roles: ['inventory_manager'] }
  assert.equal(canViewRecordedDayEndMedia(inventoryManager, dayEnd, 'inventory-manager'), true, 'inventory_manager may read a recorded day-end photo')
  assert.equal(canViewRecordedDayEndMedia({ sub: 'finance-user', role: 'finance', roles: ['finance'] }, dayEnd, 'finance-user'), false, 'unrelated role must not read a recorded day-end photo')
  assert.equal(canViewRecordedDayEndMedia({ sub: 'cleaner-a', role: 'cleaner', roles: ['cleaner'] }, dayEnd, 'cleaner-a'), true, 'day-end owner may read their recorded photo')
  assert.equal(canViewRecordedDayEndMedia({ sub: 'cleaner-b', role: 'cleaner', roles: ['cleaner'] }, dayEnd, 'cleaner-b'), false, 'unrelated cleaner must not read another owner\'s day-end photo')
  assert.equal(await canViewMzappPropertyFeedback({}, { id: 'property-a' }, ''), false, 'anonymous callers must not read property-feedback media')
  assert.equal(await canViewMzappPropertyFeedback({ sub: 'internal-user' }, { id: 'property-a' }, 'internal-user'), true, 'an authenticated internal user may read media after the route resolved one real property record')
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
