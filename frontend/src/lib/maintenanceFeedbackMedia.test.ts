import { describe, expect, it } from 'vitest'
import { maintenanceAfterPhotoReferences, maintenanceFeedbackMediaProxyUrl } from './maintenanceFeedbackMedia'

describe('maintenanceFeedbackMediaProxyUrl', () => {
  it('uses the authenticated proxy for a recorded cleaning object key', () => {
    expect(maintenanceFeedbackMediaProxyUrl('cleaning/feedback-before.jpg')).toContain('cleaning-app/media/image?key=cleaning%2Ffeedback-before.jpg')
  })

  it('extracts a private feedback key from a legacy R2 URL', () => {
    expect(maintenanceFeedbackMediaProxyUrl('https://media.example.test/private/mzapp/feedback-after.jpg')).toContain('key=mzapp%2Ffeedback-after.jpg')
  })

  it('uses the authenticated proxy for recorded maintenance keys and legacy URLs', () => {
    expect(maintenanceFeedbackMediaProxyUrl('maintenance/feedback-after.jpg')).toContain('key=maintenance%2Ffeedback-after.jpg')
    expect(maintenanceFeedbackMediaProxyUrl('https://media.example.test/private/maintenance/feedback-after.jpg')).toContain('key=maintenance%2Ffeedback-after.jpg')
  })

  it('uses the authenticated proxy for historical deep-cleaning keys and URLs', () => {
    expect(maintenanceFeedbackMediaProxyUrl('deep-cleaning/feedback-before.jpg')).toContain('key=deep-cleaning%2Ffeedback-before.jpg')
    expect(maintenanceFeedbackMediaProxyUrl('https://media.example.test/private/deep-cleaning-upload/feedback-after.jpg')).toContain('key=deep-cleaning-upload%2Ffeedback-after.jpg')
  })

  it('uses the authenticated proxy for daily-replacement inventory keys and legacy URLs', () => {
    expect(maintenanceFeedbackMediaProxyUrl('inventory/daily-after.jpg')).toContain('key=inventory%2Fdaily-after.jpg')
    expect(maintenanceFeedbackMediaProxyUrl('https://media.example.test/private/inventory/daily-before.jpg')).toContain('key=inventory%2Fdaily-before.jpg')
  })

  it('does not proxy public or malformed references', () => {
    expect(maintenanceFeedbackMediaProxyUrl('/uploads/maintenance.jpg')).toBe('')
    expect(maintenanceFeedbackMediaProxyUrl('')).toBe('')
  })

  it('includes executor completion photos before legacy repair photos in the web detail view', () => {
    expect(maintenanceAfterPhotoReferences({
      completion_photo_urls: '["mzapp/maintenance-completion.jpg"]',
      repair_photo_urls: ['mzapp/maintenance-completion.jpg', 'cleaning/legacy-repair.jpg'],
    })).toEqual(['mzapp/maintenance-completion.jpg', 'cleaning/legacy-repair.jpg'])
  })
})
