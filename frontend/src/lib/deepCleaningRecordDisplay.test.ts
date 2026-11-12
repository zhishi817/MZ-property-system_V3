import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { deepCleaningAreas, deepCleaningDetails, deepCleaningDisplayCost, deepCleaningMediaReferences, deepCleaningMediaRequest, deepCleaningNonImageLink, deepCleaningDate, deepCleaningDateBound, deepCleaningSummary, loadDeepCleaningMedia } from './deepCleaningRecordDisplay'

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
    expect(page).toContain('<DeepCleaningMedia references={viewing.photo_urls}')
    expect(page).toContain('<DeepCleaningMedia references={viewing.repair_photo_urls}')
    expect(page).toContain('deepCleaningMediaReferences(viewing.attachment_urls).filter(ref => !shown.has(ref))')
    expect(page).toContain('deepCleaningDetails(viewing.details)')
    expect(page).toContain('setMediaPreview(file.url || null)')
    expect(page).toContain('references={editBeforeFiles.map(file => file.url).filter(Boolean)}')
    expect(page).toContain('references={editAfterFiles.map(file => file.url).filter(Boolean)}')
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
