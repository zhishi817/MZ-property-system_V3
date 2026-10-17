import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DESKTOP_AMENITY_SUMMARY_LIMIT,
  MOBILE_AMENITY_SUMMARY_LIMIT,
  amenitySummaryKeys,
  sortAmenitiesForDisplay,
} from '../src/lib/amenityPresentation.ts'

const amenity = (key, category) => ({ key, category, label: key, icon: key })

test('expanded amenities use stable category order and remove duplicate keys', () => {
  const sorted = sortAmenitiesForDisplay([
    amenity('baby-cot', 'Baby amenities'),
    amenity('wifi', 'Internet & work'),
    amenity('kettle', 'Kitchen appliances'),
    amenity('washing-machine', 'Laundry'),
    amenity('free-parking', 'Parking'),
    amenity('kettle', 'Kitchen appliances'),
    amenity('high-chair', 'Baby amenities'),
  ])
  assert.deepEqual(sorted.map((item) => item.key), ['kettle', 'washing-machine', 'wifi', 'free-parking', 'baby-cot', 'high-chair'])
})

test('collapsed summary spans core categories before baby amenities', () => {
  const items = [
    amenity('baby-cot', 'Baby amenities'),
    amenity('toaster', 'Kitchen appliances'),
    amenity('kettle', 'Kitchen appliances'),
    amenity('drying-rack', 'Laundry'),
    amenity('washing-machine', 'Laundry'),
    amenity('workspace', 'Internet & work'),
    amenity('wifi', 'Internet & work'),
    amenity('free-parking', 'Parking'),
    amenity('pool', 'Building facilities'),
    amenity('high-chair', 'Baby amenities'),
  ]
  assert.deepEqual(amenitySummaryKeys(items, 4), ['toaster', 'washing-machine', 'wifi', 'free-parking'])
  assert.equal(amenitySummaryKeys(items, 6).includes('baby-cot'), false)
  assert.equal(amenitySummaryKeys(items, 6).includes('high-chair'), false)
})

test('collapsed summary skips missing categories and remains unique', () => {
  const summary = amenitySummaryKeys([
    amenity('wifi', 'Internet & work'),
    amenity('free-parking', 'Parking'),
    amenity('pool', 'Building facilities'),
    amenity('baby-cot', 'Baby amenities'),
  ], 4)
  assert.deepEqual(summary, ['wifi', 'free-parking', 'pool', 'baby-cot'])
  assert.equal(new Set(summary).size, summary.length)
})

test('summary limits fill the dense desktop and mobile grids before baby defaults', () => {
  const nonBaby = Array.from({ length: 18 }, (_, index) => amenity(`core-${index + 1}`, index < 6 ? 'Kitchen appliances' : index < 10 ? 'Laundry' : index < 14 ? 'Internet & work' : 'Building facilities'))
  const items = [amenity('baby-cot', 'Baby amenities'), ...nonBaby, amenity('high-chair', 'Baby amenities')]
  const desktop = amenitySummaryKeys(items, DESKTOP_AMENITY_SUMMARY_LIMIT)
  const mobile = amenitySummaryKeys(items, MOBILE_AMENITY_SUMMARY_LIMIT)
  assert.equal(desktop.length, 15)
  assert.equal(mobile.length, 10)
  assert.equal(desktop.some((key) => key === 'baby-cot' || key === 'high-chair'), false)
  assert.equal(mobile.some((key) => key === 'baby-cot' || key === 'high-chair'), false)
})
