import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Dependency-free hook harness: exercise this component's effect, render and
// event handlers. Real DOM/Image.PreviewGroup interaction is checked in browser.
const hooks = vi.hoisted(() => ({ states: [] as any[], cursor: 0, previous: [] as any[], effect: null as null | (() => void | (() => void)), cleanup: null as null | (() => void) }))
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual,
    useState: (initial: any) => {
      const index = hooks.cursor++
      if (!(index in hooks.states)) hooks.states[index] = initial
      return [hooks.states[index], (value: any) => { hooks.states[index] = typeof value === 'function' ? value(hooks.states[index]) : value }]
    },
    useEffect: (effect: () => void | (() => void), dependencies: any[]) => {
      if (dependencies.some((value, index) => value !== hooks.previous[index]) || !hooks.previous.length) {
        hooks.cleanup?.(); hooks.cleanup = null
        hooks.previous = dependencies
        hooks.effect = effect
      }
    },
  }
})
vi.mock('antd', () => ({ Button: 'button', Image: 'img', Space: 'space', Spin: 'spin' }))
vi.mock('../lib/deepCleaningRecordDisplay', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/deepCleaningRecordDisplay')>(), loadDeepCleaningMedia: vi.fn(),
}))
import { DeepCleaningMediaItem } from './DeepCleaningMedia'
import { loadDeepCleaningMedia } from '../lib/deepCleaningRecordDisplay'

function render(reference = 'cleaning/media/task/feedback') {
  hooks.cursor = 0
  const output = DeepCleaningMediaItem({ reference })
  if (hooks.effect) { const effect = hooks.effect; hooks.effect = null; hooks.cleanup = effect() || null }
  return output as React.ReactElement<any>
}
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }

beforeEach(() => {
  vi.clearAllMocks()
  hooks.states = []; hooks.cursor = 0; hooks.previous = []; hooks.effect = null; hooks.cleanup = null
  vi.stubGlobal('React', React)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})
afterEach(() => { hooks.cleanup?.(); hooks.cleanup = null; vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('DeepCleaningMediaItem lifecycle and error controls', () => {
  it('shows loading, loads a blob, and revokes it when dismissed', async () => {
    vi.mocked(loadDeepCleaningMedia).mockResolvedValue({ src: 'blob:sample', revoke: true })
    expect(render().props.children.type).toBe('spin')
    await settle()
    const image = render()
    expect(image.type).toBe('img'); expect(image.props.src).toBe('blob:sample')
    hooks.cleanup?.(); hooks.cleanup = null
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:sample')
    expect(vi.mocked(loadDeepCleaningMedia).mock.calls[0][1]?.aborted).toBe(true)
  })
  it('aborts on unmount and revokes a late blob without setting source', async () => {
    let resolve!: (value: { src: string; revoke: boolean }) => void
    vi.mocked(loadDeepCleaningMedia).mockImplementation(() => new Promise(done => { resolve = done }))
    render(); hooks.cleanup?.(); hooks.cleanup = null
    resolve({ src: 'blob:late', revoke: true }); await settle()
    expect(hooks.states[0]).toBe('')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:late')
  })
  it.each([401, 403, 404])('shows failure and retries an HTTP %s without public fallback', async status => {
    vi.mocked(loadDeepCleaningMedia).mockRejectedValueOnce(new Error(String(status))).mockResolvedValueOnce({ src: 'blob:retry', revoke: true })
    render(); await settle()
    const failed = render()
    expect(failed.props.children[0].props.children).toContain('加载失败')
    failed.props.children[1].props.onClick()
    render(); await settle()
    expect(render().props.src).toBe('blob:retry')
    expect(loadDeepCleaningMedia).toHaveBeenCalledTimes(2)
  })
  it('turns image decode failure into retry rather than a broken-image placeholder', async () => {
    vi.mocked(loadDeepCleaningMedia).mockResolvedValue({ src: 'blob:decode', revoke: true })
    render(); await settle()
    render().props.onError()
    expect(render().props.children[1].props.children).toBe('重试')
  })
  it('does not let a late old-reference response replace the newer photo', async () => {
    let oldResolve!: (value: { src: string; revoke: boolean }) => void
    vi.mocked(loadDeepCleaningMedia).mockImplementationOnce(() => new Promise(done => { oldResolve = done })).mockResolvedValueOnce({ src: 'blob:new', revoke: true })
    render('cleaning/old'); render('cleaning/new'); await settle()
    oldResolve({ src: 'blob:old', revoke: true }); await settle()
    expect(render('cleaning/new').props.src).toBe('blob:new')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old')
  })
  it('only offers original-material fallback for a safe public reference, never a private photo', async () => {
    vi.mocked(loadDeepCleaningMedia).mockRejectedValue(new Error('404'))
    render('cleaning/private'); await settle()
    expect(render('cleaning/private').props.children[2]).toBeNull()
    render('https://public.example.test/extensionless'); await settle()
    const fallback = render('https://public.example.test/extensionless').props.children[2]
    expect(fallback.props.href).toBe('https://public.example.test/extensionless')
  })
  it('keeps historical HTTP videos as safe links and never calls image transcoding', () => {
    render('https://media.example.test/deep-cleaning/old.mp4')
    const link = render('https://media.example.test/deep-cleaning/old.mp4')
    expect(link.type).toBe('a'); expect(link.props.rel).toBe('noreferrer')
    expect(loadDeepCleaningMedia).not.toHaveBeenCalled()
  })
})
