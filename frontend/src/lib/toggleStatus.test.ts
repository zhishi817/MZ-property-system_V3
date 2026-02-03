import { describe, expect, it } from 'vitest'
import { nextToggleValue } from './toggleStatus'

describe('nextToggleValue', () => {
  it('toggles from original to opposite, then restores original', () => {
    expect(nextToggleValue(false, false)).toBe(true)
    expect(nextToggleValue(false, true)).toBe(false)
    expect(nextToggleValue(true, true)).toBe(false)
    expect(nextToggleValue(true, false)).toBe(true)
  })
})

