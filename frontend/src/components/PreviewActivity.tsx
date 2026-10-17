"use client"

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'

const endpoint = process.env.NEXT_PUBLIC_MZ_PREVIEW_ACTIVITY_ENDPOINT || ''
const sessionId = process.env.NEXT_PUBLIC_MZ_PREVIEW_SESSION_ID || ''
const token = process.env.NEXT_PUBLIC_MZ_PREVIEW_ACTIVITY_TOKEN || ''
const enabled = Boolean(endpoint && sessionId && token)
const reportThrottleMs = 10_000
const warningLeadMs = 30_000

export default function PreviewActivity() {
  const pathname = usePathname()
  const [warning, setWarning] = useState(false)
  const nextReportAt = useRef(0)
  const warningTimer = useRef<number | null>(null)

  const clearWarningTimer = useCallback(() => {
    if (warningTimer.current !== null) window.clearTimeout(warningTimer.current)
    warningTimer.current = null
  }, [])

  const scheduleWarning = useCallback((expiresAt: string) => {
    clearWarningTimer()
    const deadline = Date.parse(expiresAt)
    if (!Number.isFinite(deadline)) return
    const delay = Math.max(0, deadline - Date.now() - warningLeadMs)
    warningTimer.current = window.setTimeout(async () => {
      try {
        const response = await fetch(`${endpoint}/status`, {
          cache: 'no-store',
          headers: {
            'X-MZ-Preview-Session': sessionId,
            'X-MZ-Preview-Token': token,
          },
        })
        const payload = await response.json()
        const currentDeadline = Date.parse(payload?.expires_at || '')
        if (response.ok && currentDeadline - Date.now() > warningLeadMs) {
          scheduleWarning(payload.expires_at)
          return
        }
        if (response.ok) setWarning(true)
      } catch {}
    }, delay)
  }, [clearWarningTimer])

  const reportActivity = useCallback((force = false) => {
    if (!enabled || document.hidden) return
    const now = Date.now()
    if (!force && now < nextReportAt.current) return
    if (force && now < nextReportAt.current && nextReportAt.current - now < 250) return
    nextReportAt.current = now + reportThrottleMs
    setWarning(false)
    void fetch(`${endpoint}/activity`, {
      method: 'POST',
      cache: 'no-store',
      keepalive: true,
      headers: {
        'X-MZ-Preview-Session': sessionId,
        'X-MZ-Preview-Token': token,
      },
    }).then(async (response) => {
      if (!response.ok) return
      const payload = await response.json()
      if (payload?.expires_at) scheduleWarning(payload.expires_at)
    }).catch(() => {})
  }, [scheduleWarning])

  useEffect(() => {
    if (!enabled) return
    const activity = () => reportActivity(false)
    const visibility = () => { if (!document.hidden) reportActivity(true) }
    window.addEventListener('pointerdown', activity, { passive: true })
    window.addEventListener('keydown', activity)
    window.addEventListener('input', activity)
    window.addEventListener('scroll', activity, { passive: true })
    window.addEventListener('focus', activity)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('pointerdown', activity)
      window.removeEventListener('keydown', activity)
      window.removeEventListener('input', activity)
      window.removeEventListener('scroll', activity)
      window.removeEventListener('focus', activity)
      document.removeEventListener('visibilitychange', visibility)
      clearWarningTimer()
    }
  }, [clearWarningTimer, reportActivity])

  useEffect(() => { reportActivity(true) }, [pathname, reportActivity])

  if (!enabled || !warning) return null
  return (
    <aside role="status" aria-live="polite" style={{ position: 'fixed', zIndex: 2147483000, right: 16, bottom: 16, maxWidth: 340, padding: '12px 14px', background: '#fffdf8', color: '#430611', border: '1px solid #6d071f', boxShadow: '0 12px 32px rgba(67,6,17,.2)', font: '500 14px/1.4 system-ui,sans-serif' }}>
      Local preview will stop in about 30 seconds due to inactivity.{' '}
      <button type="button" onClick={() => reportActivity(true)} style={{ border: 0, padding: 0, background: 'transparent', color: '#c92f0a', font: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>Keep it active</button>
    </aside>
  )
}
