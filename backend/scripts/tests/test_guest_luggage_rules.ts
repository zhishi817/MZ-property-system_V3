import assert from 'node:assert/strict'
import {
  canEditGuestLuggageForRoles,
  planGuestLuggageMutation,
  resolveGuestLuggageRecipientIds,
} from '../../src/services/guestLuggage'

const normalizePhotos = (value: unknown) => (
  Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : []
)

assert.equal(canEditGuestLuggageForRoles(['customer_service']), true)
assert.equal(canEditGuestLuggageForRoles(['admin']), true)
assert.equal(canEditGuestLuggageForRoles(['offline_manager']), true)
assert.equal(canEditGuestLuggageForRoles(['cleaner']), false)
assert.equal(canEditGuestLuggageForRoles(['cleaning_inspector']), false)

assert.deepEqual(
  planGuestLuggageMutation(
    { note: '沙发旁', photo_urls: ['a.jpg'], version: 2 },
    { note: '沙发旁', photoUrls: ['a.jpg'] },
    normalizePhotos,
  ),
  { changed: false, version: 2, resetAcknowledgements: false },
)
assert.deepEqual(
  planGuestLuggageMutation(
    { note: '沙发旁', photo_urls: ['a.jpg'], version: 2 },
    { note: '门边', photoUrls: ['a.jpg', 'b.jpg'] },
    normalizePhotos,
  ),
  { changed: true, version: 3, resetAcknowledgements: true },
)

assert.deepEqual(
  resolveGuestLuggageRecipientIds(
    [
      { cleaner_id: 'cleaner-1', inspector_id: 'inspector-1', assignee_id: 'cleaner-1' },
      { cleaner_id: 'dual-role', inspector_id: 'dual-role' },
    ],
    ['admin-1', 'offline-1', 'admin-1'],
  ),
  ['cleaner-1', 'inspector-1', 'dual-role', 'admin-1', 'offline-1'],
)

console.log('guest luggage rules: ok')
