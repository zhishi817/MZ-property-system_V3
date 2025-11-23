"use client"
import { Card, Form, Input, Button, message, Typography, Checkbox } from 'antd'
import { MailOutlined, LockOutlined } from '@ant-design/icons'
import { useRouter } from 'next/navigation'
import { API_BASE } from '../../lib/api'
import './styles.css'

export default function LoginPage() {
  const [form] = Form.useForm()
  const router = useRouter()
  async function submit() {
    const v = await form.validateFields()
    const res = await fetch(`${API_BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) })
    if (res.ok) {
      const data = await res.json()
      try { document.cookie = `auth=${data.token}; path=/; max-age=${7*24*60*60}` } catch {}
      try { localStorage.setItem('token', data.token) } catch {}
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
      router.push('/dashboard')
    } else {
      message.error('登录失败')
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
          <img src="/company-logo.png" alt="MZ Property" className="login-logo" />
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
            <a className="forgot-link">忘记密码？</a>
          </div>
          <Button type="primary" block size="large" style={{ marginTop: 12 }} onClick={submit}>登录</Button>
        </Form>
      </Card>
    </div>
  )
}