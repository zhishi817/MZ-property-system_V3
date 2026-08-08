import { afterEach, describe, expect, it, vi } from 'vitest'
import { postJSON } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})
describe('API JSON errors', () => {
  it('preserves a 409 business code when the server does not send a message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 409,
      headers: { get: (name: string) => name === 'content-type' ? 'application/json' : null },
      json: async () => ({ code: 'maintenance_feedback_creation_required' }),
    })))

    await expect(postJSON('/mzapp/property-feedbacks', {})).rejects.toMatchObject({
      message: 'maintenance_feedback_creation_required',
      code: 'maintenance_feedback_creation_required',
      status: 409,
    })
  })
})
