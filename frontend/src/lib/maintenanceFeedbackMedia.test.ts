import { describe, expect, it } from 'vitest'
import { maintenanceFeedbackMediaProxyUrl } from './maintenanceFeedbackMedia'

describe('maintenanceFeedbackMediaProxyUrl', () => {
  it('uses the authenticated proxy for a recorded cleaning object key', () => {
    expect(maintenanceFeedbackMediaProxyUrl('cleaning/feedback-before.jpg')).toContain('cleaning-app/media/image?key=cleaning%2Ffeedback-before.jpg')
  })

  it('extracts a private feedback key from a legacy R2 URL', () => {
    expect(maintenanceFeedbackMediaProxyUrl('https://media.example.test/private/mzapp/feedback-after.jpg')).toContain('key=mzapp%2Ffeedback-after.jpg')
  })

  it('does not proxy public or malformed references', () => {
    expect(maintenanceFeedbackMediaProxyUrl('/uploads/maintenance.jpg')).toBe('')
    expect(maintenanceFeedbackMediaProxyUrl('')).toBe('')
  })
})
