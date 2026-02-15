import { describe, expect, it } from 'vitest'
import { deriveBuildingKeyFromProperty, isValidPropertyCode, normalizeBaseVersion } from './propertyGuideCopy'

describe('normalizeBaseVersion', () => {
  it('strips -copy- suffix', () => {
    expect(normalizeBaseVersion('v2026.02.09-copy-2026-02-15')).toBe('v2026.02.09')
  })
  it('keeps base when no suffix', () => {
    expect(normalizeBaseVersion('v1.0.0')).toBe('v1.0.0')
  })
  it('returns empty for empty input', () => {
    expect(normalizeBaseVersion('')).toBe('')
    expect(normalizeBaseVersion(null)).toBe('')
  })
})

describe('deriveBuildingKeyFromProperty', () => {
  it('prefers building_name', () => {
    expect(deriveBuildingKeyFromProperty({ building_name: 'My Tower', code: 'MSQ4404E' })).toBe('My Tower')
  })
  it('falls back to code prefix letters+digits', () => {
    expect(deriveBuildingKeyFromProperty({ code: 'MSQ4404E' })).toBe('MSQ4404')
    expect(deriveBuildingKeyFromProperty({ code: 'RM-1001' })).toBe('RM-1001')
  })
  it('falls back to address prefix, then id', () => {
    expect(deriveBuildingKeyFromProperty({ address: '123 Collins St, Melbourne' })).toBe('123 Collins St')
    expect(deriveBuildingKeyFromProperty({ id: 'pid' })).toBe('pid')
  })
})

describe('isValidPropertyCode', () => {
  it('accepts common codes', () => {
    expect(isValidPropertyCode('MSQ4404E')).toBe(true)
    expect(isValidPropertyCode('RM-1001')).toBe(true)
    expect(isValidPropertyCode('a1b2')).toBe(true)
  })
  it('rejects invalid', () => {
    expect(isValidPropertyCode('')).toBe(false)
    expect(isValidPropertyCode('@@@')).toBe(false)
    expect(isValidPropertyCode('a')).toBe(false)
    expect(isValidPropertyCode('a'.repeat(40))).toBe(false)
    expect(isValidPropertyCode('MSQ 4404')).toBe(false)
  })
})

