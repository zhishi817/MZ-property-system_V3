import { describe, expect, it } from 'vitest'
import { filterOrdersForCalendar, isCancelledOrderStatus, orderSourcePlatform } from './orderCalendar'

const rows = [
  { id: 'confirmed-a', property_id: 'property-a', source: 'airbnb_email', status: 'confirmed', checkin: '2026-10-23', checkout: '2026-10-25', price: 0 },
  { id: 'cancelled-a', property_id: 'property-a', source: 'airbnb_email', status: 'cancelled', checkin: '2026-10-23', checkout: '2026-10-25', price: 800 },
  { id: 'canceled-a', property_id: 'property-a', source: 'Booking.com', status: ' CANCELED ', checkin: '2026-10-24', checkout: '2026-10-27' },
  { id: 'pending-cancel-a', property_id: 'property-a', source: 'manual', status: 'cancellation_pending', checkin: '2026-10-30', checkout: '2026-11-02', refund: 100 },
  { id: 'confirmed-overlap-a', property_id: 'property-a', source: 'airbnb', status: 'confirmed', checkin: '2026-10-24', checkout: '2026-10-27' },
  { id: 'confirmed-b', property_id: 'property-b', source: 'airbnb', status: 'confirmed', checkin: '2026-10-23', checkout: '2026-10-25' },
  { id: 'missing-dates', property_id: 'property-a', source: 'airbnb', status: 'confirmed', checkin: '', checkout: '' },
]

describe('order calendar visibility', () => {
  it('recognises only authoritative cancelled lifecycle values', () => {
    expect(isCancelledOrderStatus('cancelled')).toBe(true)
    expect(isCancelledOrderStatus(' CANCELED ')).toBe(true)
    expect(isCancelledOrderStatus('cancellation_pending')).toBe(false)
    expect(isCancelledOrderStatus('confirmed')).toBe(false)
  })

  it('removes cancelled orders without hiding zero-amount, refund, cross-month, or overlapping valid orders', () => {
    const visible = filterOrdersForCalendar(rows, { propertyId: 'property-a', platformFilter: 'all' })
    expect(visible.map((row) => row.id)).toEqual([
      'confirmed-a',
      'pending-cancel-a',
      'confirmed-overlap-a',
    ])
  })

  it('applies property and platform filters after cancellation filtering', () => {
    expect(filterOrdersForCalendar(rows, { propertyId: 'property-a', platformFilter: 'airbnb' }).map((row) => row.id)).toEqual([
      'confirmed-a',
      'confirmed-overlap-a',
    ])
    expect(filterOrdersForCalendar(rows, { propertyId: 'property-a', platformFilter: 'offline' }).map((row) => row.id)).toEqual([
      'pending-cancel-a',
    ])
    expect(filterOrdersForCalendar(rows, { propertyId: 'property-b', platformFilter: 'all' }).map((row) => row.id)).toEqual([
      'confirmed-b',
    ])
  })

  it('normalizes the existing platform source aliases without using colour as status', () => {
    expect(orderSourcePlatform('airbnb_email')).toBe('airbnb')
    expect(orderSourcePlatform('Booking.com')).toBe('booking')
    expect(orderSourcePlatform('Direct reservation')).toBe('offline')
    expect(orderSourcePlatform('unknown-channel')).toBe('other')
  })
})
