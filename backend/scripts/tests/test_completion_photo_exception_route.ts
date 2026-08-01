import assert from 'assert'
import fs from 'fs'
import path from 'path'

const source = fs.readFileSync(path.resolve(__dirname, '../../src/modules/mzapp.ts'), 'utf8')
const inspectionRoute = source.match(/router\.get\('\/cleaning-tasks\/:id\/inspection-photos'[\s\S]*?\n\}\)\n\nrouter\.get\('\/cleaning-tasks\/:id\/consumables'/)?.[0] || ''
const completionRoute = source.match(/router\.get\('\/cleaning-tasks\/:id\/completion-photos'[\s\S]*?\n\}\)\n\nconst restockProofSchema/)?.[0] || ''

assert.ok(inspectionRoute, 'inspection photos route must remain discoverable')
assert.ok(completionRoute, 'completion photos route must remain discoverable')
assert.ok(!inspectionRoute.includes('completion_photo_exception'), 'inspection photo response must not claim completion-photo exceptions')
assert.match(completionRoute, /type LIKE 'completion_%'/, 'completion route must load saved completion media')
assert.match(completionRoute, /completionPhotoMissingAreas\(completionAreas\)/, 'completion route must calculate the currently missing areas')
assert.match(completionRoute, /metadata \? 'completion_photo_exception'/, 'completion route must read the latest completion-photo exception audit')
assert.match(completionRoute, /normalizeSelfCompletePhotoException\(/, 'completion route must validate exception items against currently missing areas')
assert.match(completionRoute, /photo_exception: completionPhotoException/, 'completion route must return validated exception evidence to the mobile reader')

process.stdout.write('test_completion_photo_exception_route: ok\n')
