"use client"
import { useEffect, useState } from 'react'
import { Card, Input, Button, Space, App, Typography } from 'antd'
import { API_BASE, authHeaders } from '../../../lib/api'

export default function Page() {
  const { message } = App.useApp()
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [pwd, setPwd] = useState('')

  async function load() {
    try {
      const res = await fetch(`${API_BASE}/public/company-expense/password-info`, { headers: authHeaders() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      setUpdatedAt(j?.password_updated_at || null)
    } catch (e: any) { message.error(`加载失败：${e?.message || ''}`) }
  }
  useEffect(() => { load() }, [])

  async function reset() {
    try {
      const res = await fetch(`${API_BASE}/public/company-expense/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ new_password: pwd }) })
      if (!res.ok) {
        const j = await res.json().catch(()=>null)
        throw new Error(j?.message || `HTTP ${res.status}`)
      }
      message.success('密码已重置，旧 Token 已失效')
      setPwd('')
      load()
    } catch (e: any) { message.error(`重置失败：${e?.message || ''}`) }
  }

  return (
    <div>
      <Typography.Title level={3}>公司支出外链访问密码</Typography.Title>
      <Card title="当前状态" style={{ marginBottom: 16 }}>
        <div>最后更新时间：{updatedAt ? new Date(updatedAt).toLocaleString() : '未知'}</div>
      </Card>
      <Card title="重置访问密码">
        <Space>
          <Input.Password placeholder="新密码" value={pwd} onChange={(e)=>setPwd(e.target.value)} style={{ width: 320 }} />
          <Button type="primary" onClick={reset} disabled={!pwd.trim()}>重置</Button>
        </Space>
      </Card>
    </div>
  )
}

