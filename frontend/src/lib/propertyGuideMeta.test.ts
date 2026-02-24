import { describe, expect, it } from 'vitest'
import { computeAutoSyncAddress } from './propertyGuideMeta'

describe('computeAutoSyncAddress', () => {
  it('fills address when empty', () => {
    const r = computeAutoSyncAddress({ meta: { address: '' }, propertyAddress: 'A St', lastSyncedAddress: '' })
    expect(r.patch).toEqual({ address: 'A St' })
    expect(r.nextSyncedAddress).toBe('A St')
  })

  it('updates address when previously auto-synced', () => {
    const r = computeAutoSyncAddress({ meta: { address: 'Old' }, propertyAddress: 'New', lastSyncedAddress: 'Old' })
    expect(r.patch).toEqual({ address: 'New' })
    expect(r.nextSyncedAddress).toBe('New')
  })

  it('does not override manual address', () => {
    const r = computeAutoSyncAddress({ meta: { address: 'Manual' }, propertyAddress: 'Prop', lastSyncedAddress: 'Old' })
    expect(r.patch).toEqual({})
  })

  it('no patch when property address missing', () => {
    const r = computeAutoSyncAddress({ meta: { address: '' }, propertyAddress: '', lastSyncedAddress: '' })
    expect(r.patch).toEqual({})
  })
})

