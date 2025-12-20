"use client"
import { useEffect, useState } from 'react'
import { API_BASE } from '../lib/api'

type Info = { version: string; buildTimestamp: string; commit?: string }

export function VersionBadge() {
  const [info, setInfo] = useState<Info | null>(null)
  useEffect(() => {
    let mounted = true
    fetch(`${API_BASE}/version`).then(r => r.ok ? r.json() : null).then(d => { if (mounted) setInfo(d) }).catch(() => {})
    return () => { mounted = false }
  }, [])
  const feCommit = process.env.NEXT_PUBLIC_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || ''
  const apiHost = (() => { try { return new URL(API_BASE).host } catch { return '' } })()
  const text = `FE ${feCommit ? feCommit.slice(0,7) : 'dev'} • BE ${info?.commit ? info.commit.slice(0,7) : 'unknown'} • v${info?.version || 'dev'} • ${apiHost}`
  return <span style={{ opacity: 0.65 }}>{text}</span>
}
