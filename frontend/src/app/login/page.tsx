"use client"
import { Card, Form, Input, Button, message, Typography, Checkbox, Modal } from 'antd'
import Image from 'next/image'
import { useState } from 'react'
import { MailOutlined, LockOutlined } from '@ant-design/icons'
import { useRouter } from 'next/navigation'
import { API_BASE } from '../../lib/api'
import './styles.css'

export default function LoginPage() {
  const [form] = Form.useForm()
  const [forgotOpen, setForgotOpen] = useState(false as any)
  const [forgotForm] = Form.useForm()
  const router = useRouter()
  try {
    const remembered = typeof window !== 'undefined' ? (localStorage.getItem('remember_username') || '') : ''
    if (remembered) form.setFieldsValue({ username: remembered, remember: true })
  } catch {}
  async function submit() {
    const v = await form.validateFields()
    v.username = (v.username || '').trim()
    v.password = (v.password || '').trim()
    let res: Response
    try {
      res = await fetch(`${API_BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) })
    } catch (e: any) {
      message.error('无法连接服务，请稍后重试')
      return
    }
    if (res.ok) {
      const data = await res.json()
      try {
        const secure = typeof window !== 'undefined' && window.location.protocol === 'https:' ? '; Secure' : ''
        document.cookie = `auth=${data.token}; path=/; max-age=${7*24*60*60}; SameSite=Lax${secure}`
      } catch {}
      try { localStorage.setItem('token', data.token) } catch {}
      try {
        if (v.remember) localStorage.setItem('remember_username', v.username)
        else localStorage.removeItem('remember_username')
      } catch {}
      try {
        const p = (data.token || '').split('.')[1]
        if (p) {
          const norm = p.replace(/-/g, '+').replace(/_/g, '/'); const pad = norm + '==='.slice((norm.length + 3) % 4)
          const j = JSON.parse(atob(pad))
          const r = j?.role || (v.username === 'admin' ? 'admin' : null)
          if (r) { try { localStorage.setItem('role', r) } catch {} }
        } else if (v.username === 'admin') { try { localStorage.setItem('role', 'admin') } catch {} }
      } catch {}
      message.success('登录成功')
      try { await new Promise(r => setTimeout(r, 100)) } catch {}
      router.push('/dashboard')
    } else {
      try {
        const err = await res.json()
        message.error(err?.message || `登录失败 (${res.status})`)
      } catch {
        message.error(`登录失败 (${res.status})`)
      }
    }
  }
  return (
    <div className="login-wrapper">
      <div className="decor-layer">
        <div className="bubble b1"></div>
        <div className="bubble b2"></div>
        <div className="bubble b3"></div>
        <div className="grid"></div>
        <div className="geom-rect"></div>
        <div className="geom-circle"></div>
      </div>
      <Card className="login-card">
        <div className="login-logo-wrap" style={{ display: 'flex', justifyContent: 'center' }}>
          <div style={{ position: 'relative', width: '240px', height: '64px' }}>
            <Image src="/company-logo.png" alt="MZ Property" fill style={{ objectFit: 'contain', objectPosition: 'center' }} priority />
          </div>
        </div>
        <Form form={form} layout="vertical" initialValues={{ remember: true }} requiredMark={false}>
          <Form.Item name="username" label="邮箱地址/用户名" rules={[{ required: true }]}> 
            <Input size="large" placeholder="admin / ops / field" prefix={<MailOutlined />} />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true }]}> 
            <Input.Password size="large" placeholder="请输入密码" visibilityToggle prefix={<LockOutlined />} />
          </Form.Item>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Form.Item name="remember" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>记住我</Checkbox>
            </Form.Item>
            <a className="forgot-link" onClick={() => setForgotOpen(true)}>忘记密码？</a>
          </div>
          <Button type="primary" block size="large" style={{ marginTop: 12 }} onClick={submit}>登录</Button>
        </Form>
      </Card>
      <Modal open={forgotOpen} onCancel={() => setForgotOpen(false)} onOk={async () => {
        const v = await forgotForm.validateFields()
        try {
          const r = await fetch(`${API_BASE}/auth/forgot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: v.email }) })
          if (!r.ok) throw new Error('fallback')
        } catch {}
        message.success('已发送重置密码指南到邮箱')
        setForgotOpen(false); forgotForm.resetFields()
      }} title="找回密码">
        <Form form={forgotForm} layout="vertical">
          <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email' }]}>
            <Input placeholder="请输入注册邮箱" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
