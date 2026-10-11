import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CLEANING_MEDIA_IDEMPOTENCY_CONFLICT,
  buildCleaningMediaUploadFingerprint,
  ensureImmutableMediaStored,
  sha256Hex,
  storeLocalImmutableMedia,
  type ImmutableMediaInspection,
} from '../../src/lib/immutableMediaUpload.ts'

type Stored = { fingerprint: string; body: Buffer; contentType: string }

function expected(body: Buffer, fingerprint: string) {
  return { fingerprint, bodySha256: sha256Hex(body), size: body.length, contentType: 'image/jpeg' }
}

function inspection(value: Stored | null): ImmutableMediaInspection {
  return value
    ? { status: 'exists', fingerprint: value.fingerprint, size: value.body.length, contentType: value.contentType }
    : { status: 'missing' }
}

async function main() {
  const original = Buffer.from('same-photo-source')
  const fingerprint = buildCleaningMediaUploadFingerprint({
    body: original,
    taskId: 'task-1',
    mediaId: 'media-1',
    purpose: 'inspection_photo',
    watermark: true,
    watermarkText: 'MZ watermark',
    propertyCode: 'A101',
    capturedAt: '2026-10-09T01:02:03.000Z',
    submitter: 'user-1',
    contentType: 'image/jpeg',
    originalName: 'photo.jpg',
  })
  const storedBody = Buffer.from('normalized-and-watermarked-photo')
  let stored: Stored | null = null
  let createdCount = 0
  const upload = () => ensureImmutableMediaStored({
    expected: expected(storedBody, fingerprint),
    create: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      if (stored) throw Object.assign(new Error('precondition failed'), { statusCode: 412 })
      stored = { fingerprint, body: storedBody, contentType: 'image/jpeg' }
      createdCount += 1
    },
    inspect: async () => inspection(stored),
  })
  const concurrent = await Promise.all([upload(), upload()])
  assert.equal(createdCount, 1, 'concurrent requests must create one object')
  assert.equal(concurrent.filter((item) => item.reused).length, 1, 'one concurrent request must replay')
  let existingCreateCalls = 0
  const existingRetry = await ensureImmutableMediaStored({
    expected: expected(storedBody, fingerprint),
    create: async () => { existingCreateCalls += 1 },
    inspect: async () => inspection(stored),
  })
  assert.equal(existingRetry.reused, true)
  assert.equal(existingCreateCalls, 0, 'an acknowledged retry must not send another object body')
  const equivalentAfterEncoderChange = await ensureImmutableMediaStored({
    expected: expected(Buffer.from('different-encoder-output-size'), fingerprint),
    create: async () => { throw new Error('must not create when the source fingerprint matches') },
    inspect: async () => inspection(stored),
  })
  assert.equal(equivalentAfterEncoderChange.reused, true, 'source fingerprint must survive encoder byte changes')
  const legacyRetry = await ensureImmutableMediaStored({
    expected: expected(storedBody, fingerprint),
    create: async () => { throw new Error('matching legacy object must not be uploaded again') },
    inspect: async () => ({
      status: 'exists',
      fingerprint: null,
      bodySha256: sha256Hex(storedBody),
      size: storedBody.length,
      contentType: 'image/jpeg; charset=binary',
    }),
  })
  assert.equal(legacyRetry.reused, true, 'legacy objects without metadata must reuse exact final bytes')
  let unavailableCreateCalls = 0
  await assert.rejects(ensureImmutableMediaStored({
    expected: expected(storedBody, fingerprint),
    maxAttempts: 1,
    create: async () => { unavailableCreateCalls += 1 },
    inspect: async () => ({ status: 'unavailable' }),
  }))
  assert.equal(unavailableCreateCalls, 0, 'an unavailable preflight must fail closed before sending the body')

  stored = null
  const afterLostResponse = await ensureImmutableMediaStored({
    expected: expected(storedBody, fingerprint),
    create: async () => {
      stored = { fingerprint, body: storedBody, contentType: 'image/jpeg' }
      throw Object.assign(new Error('response lost'), { code: 'TIMEOUT' })
    },
    inspect: async () => inspection(stored),
  })
  assert.equal(afterLostResponse.reused, true, 'timeout after storage must resolve by inspection')

  const differentBody = Buffer.from('different-photo')
  await assert.rejects(
    ensureImmutableMediaStored({
      expected: expected(differentBody, sha256Hex('different-fingerprint')),
      create: async () => { throw Object.assign(new Error('precondition failed'), { statusCode: 412 }) },
      inspect: async () => inspection(stored),
    }),
    (error: any) => error?.code === CLEANING_MEDIA_IDEMPOTENCY_CONFLICT,
    'reusing a media_id for different content must conflict',
  )

  await assert.rejects(
    ensureImmutableMediaStored({
      expected: expected(differentBody, fingerprint),
      create: async () => { throw new Error('legacy object must be decided by inspection') },
      inspect: async () => ({
        status: 'exists',
        fingerprint: null,
        bodySha256: sha256Hex(storedBody),
        size: storedBody.length,
        contentType: 'image/jpeg',
      }),
    }),
    (error: any) => error?.code === CLEANING_MEDIA_IDEMPOTENCY_CONFLICT,
    'legacy objects without source metadata must still require final byte equality',
  )

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mz-immutable-media-'))
  try {
    const destination = path.join(tmpDir, 'stable.upload')
    const first = path.join(tmpDir, 'first.tmp')
    const retry = path.join(tmpDir, 'retry.tmp')
    const conflict = path.join(tmpDir, 'conflict.tmp')
    await fs.promises.writeFile(first, storedBody)
    await fs.promises.writeFile(retry, storedBody)
    await fs.promises.writeFile(conflict, differentBody)
    assert.deepEqual(await storeLocalImmutableMedia(first, destination), { reused: false })
    assert.deepEqual(await storeLocalImmutableMedia(retry, destination), { reused: true })
    await assert.rejects(
      storeLocalImmutableMedia(conflict, destination),
      (error: any) => error?.code === CLEANING_MEDIA_IDEMPOTENCY_CONFLICT,
    )

    const concurrentDestination = path.join(tmpDir, 'concurrent.upload')
    const concurrentFirst = path.join(tmpDir, 'concurrent-first.tmp')
    const concurrentSecond = path.join(tmpDir, 'concurrent-second.tmp')
    await fs.promises.writeFile(concurrentFirst, storedBody)
    await fs.promises.writeFile(concurrentSecond, storedBody)
    const localConcurrent = await Promise.all([
      storeLocalImmutableMedia(concurrentFirst, concurrentDestination),
      storeLocalImmutableMedia(concurrentSecond, concurrentDestination),
    ])
    assert.equal(localConcurrent.filter((item) => item.reused).length, 1, 'atomic local create must reuse one concurrent writer')
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  }

  console.log('immutable media upload contract passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
