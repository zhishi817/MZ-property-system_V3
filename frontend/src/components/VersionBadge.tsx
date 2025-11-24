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
  const text = `v${info?.version || 'dev'} • ${info?.buildTimestamp || ''}${info?.commit ? ` • ${info.commit.slice(0,7)}` : ''}`
  return <span style={{ opacity: 0.7 }}>{text}</span>
}

