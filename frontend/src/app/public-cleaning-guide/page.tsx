"use client"
import React, { useEffect, useState } from 'react'
import { Card, Input, Button, Space, App, Typography } from 'antd'
import { API_BASE } from '../../lib/api'

export default function Page() {
  const { message } = App.useApp()
  const [token, setToken] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [propertyCode, setPropertyCode] = useState('')
  const [guides, setGuides] = useState<any[]>([])
  useEffect(() => { try { const t = sessionStorage.getItem('public_cleaning_token'); if (t) setToken(t) } catch {} }, [])

  async function login() {
    try {
      const res = await fetch(`${API_BASE}/public/cleaning-guide/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      const t = j?.token || ''
      if (!t) throw new Error('missing token')
      sessionStorage.setItem('public_cleaning_token', t)
      setToken(t)
      message.success('验证成功')
      load()
    } catch (e: any) { message.error(`验证失败：${e?.message || ''}`) }
  }

  async function load() {
    try {
      const hdrs: Record<string, string> = {}
      if (token) hdrs.Authorization = `Bearer ${token}`
      const url = `${API_BASE}/public/cleaning-guide${propertyCode ? `?property_code=${encodeURIComponent(propertyCode)}` : ''}`
      const res = await fetch(url, { headers: hdrs })
      if (res.status === 401) { message.error('认证失效，请重新输入密码'); sessionStorage.removeItem('public_cleaning_token'); setToken(null); setGuides([]); return }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const arr = await res.json()
      setGuides(Array.isArray(arr) ? arr : [])
    } catch (e: any) { message.error(`加载失败：${e?.message || ''}`) }
  }

  useEffect(() => { if (token) load() }, [token])

  function logout() { try { sessionStorage.removeItem('public_cleaning_token') } catch {}; setToken(null); setGuides([]) }

  return (
    <div style={{ maxWidth: 900, margin: '24px auto', padding: '0 16px' }}>
      <Typography.Title level={2}>Public Cleaning Guide</Typography.Title>
      {!token ? (
        <Card title="输入访问密码">
          <Space>
            <Input.Password placeholder="访问密码" value={password} onChange={(e)=>setPassword(e.target.value)} style={{ width: 320 }} />
            <Button type="primary" onClick={login}>验证</Button>
          </Space>
        </Card>
      ) : (
        <div>
          <Space style={{ marginBottom: 16 }}>
            <Input placeholder="房源代码（可选）" value={propertyCode} onChange={(e)=>setPropertyCode(e.target.value)} style={{ width: 240 }} />
            <Button onClick={load}>加载指南</Button>
            <Button onClick={logout}>退出</Button>
          </Space>
          {guides.map(g => (
            <Card key={g.id} title={g.title} style={{ marginBottom: 12 }}>
              <div dangerouslySetInnerHTML={{ __html: String(g.content || '') }} />
            </Card>
          ))}
          {!guides.length && <div style={{ color:'#888' }}>暂无内容</div>}
        </div>
      )}
    </div>
  )
}