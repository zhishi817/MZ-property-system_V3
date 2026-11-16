import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import express from 'express'
import multer from 'multer'
import sharp from 'sharp'
import ts from 'typescript'
import * as watermark from '../../src/lib/cleaningMediaWatermark'
import * as mediaImage from '../../src/lib/cleaningMediaImage'
import * as immutable from '../../src/lib/immutableMediaUpload'

// Real localhost HTTP/multipart/image/local-store exercise of the exact production upload handler.
// Auth is a fixed fake identity seam; no full app import, database, R2, credentials or external requests.
async function main() {
  const repo = path.resolve(__dirname, '../..')
  const source = fs.readFileSync(path.join(repo, 'src/modules/cleaning_app.ts'), 'utf8')
  const start = source.indexOf("router.post(\n  '/upload',")
  assert.ok(start > 0)
  const helpers = source.slice(source.indexOf('function stableUploadKeySegment'), source.indexOf('let cleaningConsumablesSchemaReady'))
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mz116-http-'))
  const previousCwd = process.cwd()
  fs.mkdirSync(path.join(sandbox, 'uploads'))
  process.chdir(sandbox)
  const app = express()
  app.use((req: any, _res, next) => { req.user = { sub: 'fixture-inspector', username: 'FixtureInspector' }; next() })
  const router = express.Router()
  const svgEvidence: string[] = []
  const imageFactory = (...args: any[]) => {
    const instance = (sharp as any)(...args)
    const composite = instance.composite.bind(instance)
    instance.composite = (items: any[]) => {
      for (const item of items) if (Buffer.isBuffer(item.input)) svgEvidence.push(item.input.toString('utf8'))
      return composite(items)
    }
    return instance
  }
  const context = {
    router, upload: multer({ dest: path.join(sandbox, 'uploads') }),
    requireAnyPerm: () => (_req: any, _res: any, next: () => void) => next(),
    sharp: imageFactory, fs, path, process: { cwd: () => sandbox }, Buffer, console,
    hasR2: false, ...watermark, ...mediaImage, ...immutable,
  }
  const code = ts.transpileModule(helpers + source.slice(start), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(code, context, { filename: 'exact-cleaning-upload-handler.js' })
  app.use('/cleaning-app', router)
  app.use('/uploads', express.static(path.join(sandbox, 'uploads')))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const port = (server.address() as any).port
  const base = `http://127.0.0.1:${port}`
  const original = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#eeeeee' } }).jpeg().toBuffer()
  const post = async (id: string, extra: Record<string, string> = {}, bytes = original, mime = 'image/jpeg') => {
    const form = new FormData()
    for (const [key, value] of Object.entries({ task_id: 'fixture-task', media_id: id, watermark: '1', purpose: 'inspection_photo', property_code: 'TEST6307', captured_at: '2026-11-12T04:32:36Z', ...extra })) form.append(key, value)
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), mime === 'image/jpeg' ? 'fixture.jpg' : 'fixture.mp4')
    const res = await fetch(`${base}/cleaning-app/upload`, { method: 'POST', body: form })
    return { status: res.status, body: await res.json() as any }
  }
  let checks = 0
  try {
    for (const purpose of ['inspection_photo', 'inspection_issue', 'restock_proof', 'unclean']) {
      const result = await post(purpose, { purpose, captured_by_user_id: 'fixture-inspector', watermark_text: 'WRONG CLEANER 2000-01-01' })
      assert.equal(result.status, 201)
      assert.match(svgEvidence.at(-1)!, /操作账号: FixtureInspector/)
      assert.match(svgEvidence.at(-1)!, /2026-11-12 15:32 Melbourne/)
      assert.doesNotMatch(svgEvidence.at(-1)!, /WRONG CLEANER/)
      const downloaded = Buffer.from(await (await fetch(base + result.body.url)).arrayBuffer())
      assert.equal((await sharp(downloaded).metadata()).format, 'jpeg')
      assert.notDeepEqual(downloaded, original)
      checks++
    }
    const repeated = await post('inspection_photo', { captured_by_user_id: 'fixture-inspector', watermark_text: 'WRONG CLEANER 2000-01-01' })
    assert.equal(repeated.status, 200); assert.equal(repeated.body.reused, true); checks++
    for (const owner of ['different-account', '']) {
      const result = await post(`reject-${owner}`, { captured_by_user_id: owner })
      assert.equal(result.status, 409); assert.equal(result.body.code, 'MEDIA_CAPTURE_OWNER_MISMATCH'); checks++
    }
    const legacy = await post('legacy', { watermark_text: 'WrongName' })
    assert.equal(legacy.status, 201); assert.match(svgEvidence.at(-1)!, /提交账号: FixtureInspector/); checks++
    const unknown = await post('unknown', { captured_by_user_id: 'fixture-inspector', captured_at: '' })
    assert.equal(unknown.status, 201); assert.match(svgEvidence.at(-1)!, /未记录/); checks++
    const winter = await post('winter', { purpose: 'backup_key_return', captured_at: '2026-06-12T04:32:36Z' })
    assert.equal(winter.status, 201); assert.match(svgEvidence.at(-1)!, /日终交接-备用钥匙/); assert.match(svgEvidence.at(-1)!, /14:32 Melbourne/); checks++
    const beforeVideo = svgEvidence.length
    const videoBytes = Buffer.from('fixture-video-byte-preservation-only')
    const video = await post('video', { purpose: 'lockbox_video', captured_by_user_id: 'fixture-inspector' }, videoBytes, 'video/mp4')
    assert.equal(video.status, 201); assert.equal(svgEvidence.length, beforeVideo)
    assert.deepEqual(Buffer.from(await (await fetch(base + video.body.url)).arrayBuffer()), videoBytes); checks++
    const deniedVideo = await post('video-denied', { purpose: 'lockbox_video', captured_by_user_id: 'different-account' }, videoBytes, 'video/mp4')
    assert.equal(deniedVideo.status, 409); checks++
    console.log(`MZ116 LOCAL HTTP PASS: ${checks} cases; real multipart/sharp/local immutable store/readback; fake auth; no DB/R2; synthetic video bytes only`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    process.chdir(previousCwd)
    fs.rmSync(sandbox, { recursive: true, force: true }) // only this test's generated fixture directory
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
