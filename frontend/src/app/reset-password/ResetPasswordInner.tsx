"use client"

import { Card, Form, Input, Button, message } from 'antd'
import { useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { API_BASE } from '../../lib/api'

function buildAuthUrlCandidates(endpoint: 'reset') {
  const base = String(API_BASE || '').trim().replace(/\/+$/g, '')
  if (!base) return []
  const raw = base
  const stripAuth = raw.replace(/\/auth\/?$/g, '')
  const stripApi = stripAuth.replace(/\/api\/?$/g, '')
  const paths = endpoint === 'reset' ? ['auth/reset', 'reset'] : []
  const candidates = [
    ...paths.map(p => `${raw}/${p}`),
    ...paths.map(p => `${stripAuth}/${p}`),
    ...paths.map(p => `${stripApi}/${p}`),
  ].map(u => u.replace(/([^:]\/)\/+/g, '$1'))
  return Array.from(new Set(candidates)).filter(Boolean)
}

export default function ResetPasswordInner() {
  const [form] = Form.useForm()
  const router = useRouter()
  const sp = useSearchParams()
  const token = useMemo(() => String(sp.get('token') || '').trim(), [sp])
  const [loading, setLoading] = useState(false)
  const [msg, ctx] = message.useMessage()

  async function submit() {
    const v = await form.validateFields()
    const urls = buildAuthUrlCandidates('reset')
    if (!urls.length) { msg.error('后端地址未配置（NEXT_PUBLIC_API_BASE_URL）'); return }
    if (!token) { msg.error('缺少重置链接 token'); return }

    setLoading(true)
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => { try { controller.abort() } catch {} }, 15000)
      try {
        let last: Response | null = null
        for (const url of urls) {
          last = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password: v.password }), signal: controller.signal })
          if (last.status !== 404) break
        }
        if (!last?.ok) {
          let m = `重置失败 (${last?.status || 0})`
          try { if (last) { const j = await last.json(); if (j?.message) m = String(j.message) } } catch {}
          msg.error(m)
          return
        }
      } finally { try { clearTimeout(timer) } catch {} }
      msg.success('密码已重置，请重新登录')
      try { await new Promise(r => setTimeout(r, 300)) } catch {}
      router.push('/login')
    } catch {
      msg.error('重置失败，请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: '#f5f7fa' }}>
      {ctx}
      <Card title="重置密码" style={{ width: '100%', maxWidth: 420 }}>
        <Form form={form} layout="vertical">
          <Form.Item name="password" label="新密码" rules={[{ required: true, min: 6 }]}>
            <Input.Password placeholder="至少 6 位" />
          </Form.Item>
          <Form.Item
            name="passwordConfirm"
            label="确认新密码"
            dependencies={['password']}
            rules={[
              { required: true, min: 6 },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  const p = getFieldValue('password')
                  if (!value || value === p) return Promise.resolve()
                  return Promise.reject(new Error('两次输入的密码不一致'))
                },
              }),
            ]}
          >
            <Input.Password placeholder="再次输入新密码" />
          </Form.Item>
          <Button type="primary" block onClick={submit} loading={loading} disabled={loading}>提交</Button>
        </Form>
      </Card>
    </div>
  )
}

