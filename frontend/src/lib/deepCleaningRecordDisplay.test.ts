import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { deepCleaningSubmitterEditPatch, deepCleaningSubmitterDisplay, deepCleaningAreas, deepCleaningDetails, deepCleaningDisplayCost, deepCleaningMediaReferences, deepCleaningMediaRequest, deepCleaningNonImageLink, deepCleaningDate, deepCleaningDateBound, deepCleaningSummary, loadDeepCleaningMedia } from './deepCleaningRecordDisplay'

afterEach(() => { vi.unstubAllGlobals() })

describe('deep cleaning feedback display', () => {
  it('shows mobile areas separately from actual issue and preserves legacy description', () => {
    const mobile = { category: null, project_desc: '厨房、客厅', details: '烤箱油污，需要清洗' }
    expect(deepCleaningAreas(mobile)).toBe('厨房、客厅')
    expect(deepCleaningSummary(mobile)).toBe('烤箱油污，需要清洗')
    expect(deepCleaningAreas({ project_desc: '厨房油污，需要清洗' })).toBe('')
    expect(deepCleaningAreas({ category: '浴室', project_desc: '厨房' })).toBe('浴室')
    expect(deepCleaningSummary({ category: '厨房', project_desc: '旧网页项目描述' })).toBe('旧网页项目描述')
    expect(deepCleaningSummary({ project_desc: '厨房' })).toBe('')
  })
  it('renders plain, JSON string, array and object details without losing issue text', () => {
    expect(deepCleaningDetails('中文原始反馈')).toBe('中文原始反馈')
    expect(deepCleaningDetails('"中文反馈"')).toBe('中文反馈')
    expect(deepCleaningDetails('[{"content":"厨房油污"},{"item":"沙发污渍"}]')).toBe('厨房油污\n沙发污渍')
    expect(deepCleaningDetails({ content: '浴室除垢' })).toBe('浴室除垢')
    expect(deepCleaningDetails(null)).toBe('')
  })
  it('keeps unknown cost distinct from an explicitly recorded zero', () => {
    expect(deepCleaningDisplayCost({ total_cost: null, labor_cost: null, consumables: null })).toBeNull()
    expect(deepCleaningDisplayCost({ consumables: [] })).toBeNull()
    expect(deepCleaningDisplayCost({ consumables: [{ name: 'unknown', cost: null }] })).toBeNull()
    expect(deepCleaningDisplayCost({ total_cost: 0, labor_cost: 9 })).toBe(0)
    expect(deepCleaningDisplayCost({ labor_cost: 0 })).toBe(0)
    expect(deepCleaningDisplayCost({ labor_cost: '12.5', consumables: '[{"cost":2.5}]' })).toBe(15)
  })
  it('uses Melbourne calendar dates and local-day bounds regardless of browser timezone', () => {
    expect(deepCleaningDate('2026-11-08T13:30:00Z')).toBe('2026-11-09')
    expect(deepCleaningDateBound('2026-11-09')).toBe('2026-11-08T13:00:00.000Z')
    expect(deepCleaningDateBound('2026-11-09', true)).toBe('2026-11-09T12:59:59.999Z')
    expect(deepCleaningDateBound('2026-06-09')).toBe('2026-06-08T14:00:00.000Z')
    expect(deepCleaningDate('2026-11-09')).toBe('2026-11-09')
  })
  it('parses historical JSON photo arrays, deduplicates and rejects non-string entries', () => {
    expect(deepCleaningMediaReferences('["cleaning/a","cleaning/a","mzapp/b.jpg"]')).toEqual(['cleaning/a', 'mzapp/b.jpg'])
    expect(deepCleaningMediaReferences([null, 4, ' deep-cleaning/c.heic '])).toEqual(['deep-cleaning/c.heic'])
  })
})

describe('deep cleaning authenticated media', () => {
  it.each([
    ['cleaning/media/task/feedback-001', 'cleaning/media/task/feedback-001'],
    ['deep-cleaning/old.jpg', 'deep-cleaning/old.jpg'],
    ['https://media.example.test/private/deep-cleaning-upload/old.HEIC?signature=synthetic', 'deep-cleaning-upload/old.HEIC'],
    ['https://media.example.test/mzapp/old.jpeg', 'mzapp/old.jpeg'],
  ])('routes supported historical reference %s through the existing authorized proxy', (ref, key) => {
    const request = deepCleaningMediaRequest(ref)!
    expect(request.authenticated).toBe(true)
    expect(request.url).toContain(`key=${encodeURIComponent(key)}`)
  })
  it('preserves R2 authority for server validation and rejects executable/unknown bare references', () => {
    const ref = 'r2://synthetic-namespace/mzapp/old.jpg'
    const request = deepCleaningMediaRequest(ref)!
    expect(request.authenticated).toBe(true)
    expect(request.url).toContain(`url=${encodeURIComponent(ref)}`)
    expect(request.url).not.toContain('key=')
    expect(deepCleaningMediaRequest('javascript:alert(1)')).toBeNull()
    expect(deepCleaningMediaRequest('unknown/bare.jpg')).toBeNull()
  })
  it('preserves existing HTTP video/file links without image transcoding or private-key fallback', () => {
    expect(deepCleaningNonImageLink('https://media.example.test/deep-cleaning/old.mp4')).toBe('https://media.example.test/deep-cleaning/old.mp4')
    expect(deepCleaningNonImageLink('https://media.example.test/old.pdf?signature=synthetic')).toContain('old.pdf')
    expect(deepCleaningNonImageLink('cleaning/private.mp4')).toBe('')
    expect(deepCleaningNonImageLink('javascript:video.mp4')).toBe('')
    expect(deepCleaningNonImageLink('https://media.example.test/old.heic')).toBe('')
    expect(deepCleaningNonImageLink('https://media.example.test/old.pptx')).toContain('old.pptx')
    expect(deepCleaningNonImageLink('https://media.example.test/old.avi')).toContain('old.avi')
  })
  it('never sends authorization to an external public image', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await loadDeepCleaningMedia('https://public.example.test/old.jpg')).toEqual({ src: 'https://public.example.test/old.jpg', revoke: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('uses authenticated abortable requests and only constructs object URLs from image responses', async () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', { getItem: () => 'synthetic-preview-token' })
    const create = vi.fn(() => 'blob:synthetic')
    const originalURL = URL
    class MockURL extends originalURL { static createObjectURL = create }
    vi.stubGlobal('URL', MockURL)
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['synthetic'], { type: 'image/jpeg' }) })
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    expect(await loadDeepCleaningMedia('cleaning/media/task/no-extension', controller.signal)).toEqual({ src: 'blob:synthetic', revoke: true })
    expect(fetchMock.mock.calls[0][1]).toEqual({ headers: { Authorization: 'Bearer synthetic-preview-token' }, signal: controller.signal })
    fetchMock.mockResolvedValue({ ok: false, status: 403 })
    await expect(loadDeepCleaningMedia('cleaning/private')).rejects.toThrow('403')
    fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(['invalid'], { type: 'text/html' }) })
    await expect(loadDeepCleaningMedia('cleaning/private')).rejects.toThrow('invalid_image_response')
    expect(create).toHaveBeenCalledTimes(1)
  })
})

describe('deep cleaning page wiring contract', () => {
  const page = readFileSync(new URL('../app/deep-cleaning/records/page.tsx', import.meta.url), 'utf8')
  it('renders before/after/attachment media and issue text independently of project description', () => {
    expect(page).toContain('<DeepCleaningMedia context={viewing} references={viewing.photo_urls}')
    expect(page).toContain('<DeepCleaningMedia context={viewing} references={viewing.repair_photo_urls}')
    expect(page).toContain('deepCleaningVisibleAttachments(viewing.attachment_urls, viewing.photo_urls, viewing.repair_photo_urls)')
    expect(page).toContain('deepCleaningDetails(viewing.details)')
    expect(page).toContain("localUploadPreviewUrls.current.get(file.url || '')")
    expect(page).toContain('references={editBeforeFiles.filter(file => !file.originFileObj).map(file => file.url).filter(Boolean)}')
    expect(page).toContain('references={editAfterFiles.filter(file => !file.originFileObj).map(file => file.url).filter(Boolean)}')
    expect(page).not.toContain('worker_name || viewing?.submitter_name')
    expect(page).toContain("if (m === null || m === undefined || m === '') return '-'")
  })
  it('uses matching date/area params, cancels old requests, rejects errors and keeps permission gates', () => {
    expect(page).toContain('params.area = filterCat')
    expect(page).toContain('params.record_date_from')
    expect(page).toContain('params.record_date_to')
    expect(page).not.toContain('params.completed_at_from')
    expect(page).toContain('if (!res.ok) throw')
    expect(page).toContain('if (controller.signal.aborted) return')
    expect(page).toContain("hasPerm('property_deep_cleaning.write')")
    expect(page).toContain("hasPerm('property_deep_cleaning.delete')")
    expect(page).toContain('if (!controller.signal.aborted) setLoading(false)')
  })
})

describe('deep cleaning authoritative media context', () => {
  it('adds only server-provided work task context to private key and canonical R2 requests', () => {
    const context = { media_access_work_task_id: 'authoritative-id' }
    for (const reference of ['mzapp/a.jpg', 'deep-cleaning/a.jpg', 'r2://fixture/mzapp/a.jpg']) {
      const request = deepCleaningMediaRequest(reference, context)!
      expect(request.url).toContain('work_task_id=authoritative-id')
      expect(request.url).not.toContain('source_id=')
      expect(request.url).not.toContain('property_id=')
    }
    expect(deepCleaningMediaRequest('mzapp/a.jpg', {})!.url).not.toContain('work_task_id=')
    expect(deepCleaningMediaRequest('https://example.invalid/a.jpg', context)).toEqual({ url: 'https://example.invalid/a.jpg', authenticated: false })
  })
})

it('keeps unsaved ordinary uploads local without changing remote save references or upload permissions', () => {
  const page = readFileSync(new URL('../app/deep-cleaning/records/page.tsx', import.meta.url), 'utf8')
  expect(page).toContain("file.originFileObj ? localUploadPreviewUrls.current.get(file.url || '') || null : file.url || null")
  expect(page).toContain('editAttachFiles.filter(file => !file.originFileObj).map(file => file.url)')
  expect(page).toContain('makeUploadProps(setEditBeforeFiles, false, editing)')
  expect(page).toContain('makeUploadProps(setEditAfterFiles, false, editing)')
  expect(page).toContain('makeUploadProps(setEditAttachFiles, false, editing).itemRender?.(node, file, files, actions)')
  expect(page).toContain('photo_urls: deepCleaningMediaReferences(editBeforeFiles.map(')
  expect(page).toContain('attachment_urls: deepCleaningMediaReferences(editAttachFiles.map(')
})

it('uses explicit deep record context only without a projection and never guesses or falls back from a task ID', () => {
  const reference = 'r2://fixture/mzapp/a.jpg'
  const recordOnly = deepCleaningMediaRequest(reference, { id: 'actual-record', media_access_work_task_id: null })!
  expect(recordOnly.url).toContain('deep_record_id=actual-record')
  expect(recordOnly.url).not.toContain('work_task_id=')
  const projected = deepCleaningMediaRequest(reference, { id: 'actual-record', media_access_work_task_id: 'actual-task' })!
  expect(projected.url).toContain('work_task_id=actual-task')
  expect(projected.url).not.toContain('deep_record_id=')
  expect(deepCleaningMediaRequest(reference)!.url).not.toContain('deep_record_id=')
})

describe('reliable deep cleaning submitter display', () => {
  it('preserves explicit and historical names before verified creator fallback', () => {
    expect(deepCleaningSubmitterDisplay({ submitter_name: '历史提交者', submitter_display_name: '创建账号', submitter_display_source: 'created_by' })).toBe('历史提交者')
    for (const source of ['created_by_user_id', 'created_by']) expect(deepCleaningSubmitterDisplay({ submitter_name: '', submitter_display_name: '核验创建账号', submitter_display_source: source })).toBe('核验创建账号')
  })
  it('does not guess a submitter from unverified identifiers, workers, or display names', () => {
    expect(deepCleaningSubmitterDisplay({ submitter_display_name: '无来源姓名', submitter_display_source: 'unknown' })).toBe('未记录')
    expect(deepCleaningSubmitterDisplay({ created_by: 'actor-id', worker_name: '执行人' } as any)).toBe('未记录')
    expect(deepCleaningSubmitterDisplay(null)).toBe('未记录')
  })
  it('keeps derived display out of ordinary edit form initialization and save payload', () => {
    const page = readFileSync(new URL('../app/deep-cleaning/records/page.tsx', import.meta.url), 'utf8')
    expect(page).toContain("submitter_name: r.submitter_name || ''")
    expect(page).toContain("submitter_name: String(v.submitter_name || '').trim()")
    expect(page).not.toContain('viewing.submitter_name || viewing.created_by')
    expect(page).toContain('deepCleaningSubmitterDisplay(viewing)')
  })
})

describe('non-destructive submitter edit payload', () => {
  it('omits unchanged unknown, verified-fallback and existing historical names', () => {
    for (const original of [null, undefined, '']) expect(deepCleaningSubmitterEditPatch(original, '')).toEqual({})
    expect(deepCleaningSubmitterEditPatch(' 历史姓名 ', ' 历史姓名 ')).toEqual({})
    expect(deepCleaningSubmitterEditPatch('原提交人', '原提交人')).toEqual({})
  })
  it('sends a trimmed name only on explicit change or clear', () => {
    expect(deepCleaningSubmitterEditPatch(null, ' 新选择 ')).toEqual({ submitter_name: '新选择' })
    expect(deepCleaningSubmitterEditPatch('旧姓名', '新姓名')).toEqual({ submitter_name: '新姓名' })
    expect(deepCleaningSubmitterEditPatch('旧姓名', undefined)).toEqual({ submitter_name: '' })
    expect(deepCleaningSubmitterEditPatch('旧姓名', '')).toEqual({ submitter_name: '' })
  })
})
