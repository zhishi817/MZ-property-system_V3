'use client'

import { useEffect } from 'react'

const enabled = process.env.NEXT_PUBLIC_MZ_DEV_PREVIEW_ACTIVITY === '1'
const activityUrl = String(process.env.NEXT_PUBLIC_MZ_DEV_PREVIEW_ACTIVITY_URL || '').trim()
const debounceMs = 5_000

export function DevPreviewActivityReporter() {
  useEffect(() => {
    if (!enabled || !activityUrl) return
    let lastSentAt = 0

    const reportActivity = () => {
      const now = Date.now()
      if (now - lastSentAt < debounceMs) return
      lastSentAt = now
      void fetch(activityUrl, {
        method: 'POST',
        cache: 'no-store',
        keepalive: true,
      }).catch(() => undefined)
    }
    const reportVisible = () => {
      if (document.visibilityState === 'visible') reportActivity()
    }

    reportActivity()
    window.addEventListener('pointerdown', reportActivity, { passive: true })
    window.addEventListener('keydown', reportActivity)
    window.addEventListener('focus', reportActivity)
    document.addEventListener('visibilitychange', reportVisible)
    return () => {
      window.removeEventListener('pointerdown', reportActivity)
      window.removeEventListener('keydown', reportActivity)
      window.removeEventListener('focus', reportActivity)
      document.removeEventListener('visibilitychange', reportVisible)
    }
  }, [])

  return null
}
