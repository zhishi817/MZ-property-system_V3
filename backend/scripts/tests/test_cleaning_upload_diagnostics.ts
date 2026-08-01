import assert from 'assert'
import fs from 'fs'
import path from 'path'

const modulePath = path.resolve(process.cwd(), 'src/modules/cleaning_app.ts')
const source = fs.readFileSync(modulePath, 'utf8')
const uploadRoute = source.slice(source.indexOf("router.post(\n  '/upload'"))

assert.ok(source.includes("X-Cleaning-Upload-Request-Id"), 'upload route must accept the client diagnostic request id')
assert.ok(uploadRoute.includes('event=received request_id='), 'upload route must log a received event')
assert.ok(uploadRoute.includes('event=stored request_id='), 'upload route must log a stored event')
assert.ok(uploadRoute.includes('event=failed request_id='), 'upload route must log a failed event')
assert.ok(uploadRoute.includes("'CLEANING_MEDIA_UPLOAD_FAILED'"), 'upload route must return a stable failure code')
assert.ok(uploadRoute.includes('upload_request_id: uploadRequestId'), 'upload response must return the diagnostic request id')
assert.ok(!uploadRoute.includes('message: e?.message'), 'upload failure response must not expose the raw upstream error message')

console.log('test_cleaning_upload_diagnostics: ok')
