import { describe, expect, test } from 'vitest'
import { manualCreatePasswordPayload } from './cleaningManualCreate'

describe('manualCreatePasswordPayload', () => {
  test.each([
    ['checkout', ' 4455 ', ' 7788 ', { old_code: '4455' }],
    ['checkout', '   ', '7788', { old_code: null }],
    ['checkin', '4455', ' 7788 ', { new_code: '7788' }],
    ['checkin', '4455', '   ', { new_code: null }],
    ['turnover', ' 4455 ', ' 7788 ', { old_code: '4455', new_code: '7788' }],
    ['turnover', ' ', '', { old_code: null, new_code: null }],
    ['stayover', '4455', '7788', {}],
    ['stayover', '', '', {}],
  ] as const)('%s maps blank/nonblank applicable fields and omits inapplicable fields', (mode, oldCode, newCode, expected) => {
    expect(manualCreatePasswordPayload(mode, oldCode, newCode)).toEqual(expected)
  })
})
