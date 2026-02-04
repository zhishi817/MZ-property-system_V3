"use client"
import { App, Button, Card, DatePicker, Form, Input, InputNumber, Select, Space, Typography, Upload } from 'antd'
import type { UploadFile } from 'antd/es/upload/interface'
import { LockOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { API_BASE } from '../../../lib/api'

function storageKeyPassword() { return 'public_company_expense_password' }
function storageKeyToken() { return 'public_company_expense_token' }

export default function PublicCompanyExpensePage() {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [pwd, setPwd] = useState('')
  const [token, setToken] = useState<string>('')
  const [loggingIn, setLoggingIn] = useState(false)
  const [invoiceFiles, setInvoiceFiles] = useState<UploadFile[]>([])
  const [invoiceUrl, setInvoiceUrl] = useState<string>('')

  useEffect(() => {
    try {
      const p = localStorage.getItem(storageKeyPassword()) || ''
      if (p) setPwd(p)
      const tk = localStorage.getItem(storageKeyToken()) || ''
      if (tk) setToken(tk)
    } catch {}
  }, [])

  const categoryOptions = useMemo(() => ([
    { value: 'office', label: '办公' },
    { value: 'bedding_fee', label: '床品费' },
    { value: 'office_rent', label: '办公室租金' },
    { value: 'car_loan', label: '车贷' },
    { value: 'electricity', label: '电费' },
    { value: 'internet', label: '网费' },
    { value: 'water', label: '水费' },
    { value: 'fuel', label: '油费' },
    { value: 'parking_fee', label: '车位费' },
    { value: 'maintenance_materials', label: '维修材料费' },
    { value: 'tax', label: '税费' },
    { value: 'service', label: '服务采购' },
    { value: 'other', label: '其他' },
  ]), [])

  async function ensureToken(): Promise<string | null> {
    const pass = String(pwd || '').trim()
    if (!pass) { message.error('请输入访问密码'); return null }
    if (token) return token
    return await loginAndStore(pass)
  }

  async function loginAndStore(passRaw?: string): Promise<string | null> {
    const pass = String(passRaw ?? pwd ?? '').trim()
    if (!pass) { message.error('请输入访问密码'); return null }
    setLoggingIn(true)
    try {
      const res = await fetch(`${API_BASE}/public/company-expense/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pass })
      })
      const j = await res.json().catch(() => null)
      if (res.ok && j?.token) {
        const tk = String(j.token)
        setToken(tk)
        try { localStorage.setItem(storageKeyPassword(), pass) } catch {}
        try { localStorage.setItem(storageKeyToken(), tk) } catch {}
        message.success('密码认证成功')
        return tk
      }
      try { localStorage.removeItem(storageKeyToken()) } catch {}
      setToken('')
      message.error(j?.message || '认证失败')
      return null
    } catch (e: any) {
      try { localStorage.removeItem(storageKeyToken()) } catch {}
      setToken('')
      message.error(e?.message || '认证失败')
      return null
    } finally {
      setLoggingIn(false)
    }
  }

  function clearAuth() {
    setToken('')
    try { localStorage.removeItem(storageKeyToken()) } catch {}
  }

  function xhrUpload(file: any, tk: string, onProgress?: (pct: number) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const fd = new FormData()
        fd.append('file', file)
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `${API_BASE}/public/company-expense/upload`)
        xhr.setRequestHeader('Authorization', `Bearer ${tk}`)
        xhr.upload.onprogress = (evt) => {
          if (evt.lengthComputable && onProgress) {
            const pct = Number((((evt.loaded || 0) / (evt.total || 1)) * 100).toFixed(0))
            onProgress(pct)
          }
        }
        xhr.onreadystatechange = () => {
          if (xhr.readyState !== 4) return
          try {
            const j = JSON.parse(xhr.responseText || '{}')
            if (xhr.status >= 200 && xhr.status < 300 && j?.url) resolve(String(j.url))
            else reject(new Error(String(j?.message || 'upload failed')))
          } catch (e) {
            reject(e)
          }
        }
        xhr.onerror = (e) => reject(e as any)
        xhr.send(fd)
      } catch (e) {
        reject(e)
      }
    })
  }

  async function submit() {
    if (!token) { message.error('请先验证访问密码'); return }
    const v = await form.validateFields()
    const payload = {
      occurred_at: v.occurred_at ? dayjs(v.occurred_at).format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
      amount: Number(v.amount || 0),
      currency: 'AUD',
      category: v.category,
      category_detail: v.category === 'other' ? String(v.category_detail || '').trim() : undefined,
      note: String(v.note || '').trim(),
      invoice_url: invoiceUrl || undefined,
    }
    try {
      const res = await fetch(`${API_BASE}/public/company-expense/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload)
      })
      const j = await res.json().catch(() => null)
      if (res.status === 401) {
        clearAuth()
        message.error('认证已失效，请重新验证密码')
        return
      }
      if (!res.ok) { message.error(j?.message || '提交失败'); return }
      message.success('支出已提交')
      form.resetFields()
      setInvoiceFiles([])
      setInvoiceUrl('')
    } catch {
      message.error('提交失败')
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
      <Card title="公司支出登记（外部）" style={{ borderRadius: 12 }} extra={<Typography.Text type="secondary">提交后会写入公司支出</Typography.Text>}>
        <div style={{ borderBottom: '1px solid #e6f4ff', paddingBottom: 8, marginBottom: 16, display:'flex', alignItems:'center', gap:8 }}>
          <LockOutlined style={{ color:'#1677ff' }} />
          <Typography.Text style={{ color:'#1d39c4', fontWeight: 600 }}>访问密码</Typography.Text>
        </div>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space wrap>
            <Input.Password placeholder="请输入访问密码" value={pwd} onChange={(e)=>setPwd(e.target.value)} style={{ width: 260 }} />
            <Button type="primary" onClick={() => loginAndStore()} loading={loggingIn}>验证并保存</Button>
            {token ? <Typography.Text type="success">已认证</Typography.Text> : <Typography.Text type="secondary">未认证</Typography.Text>}
            {token ? <Button onClick={clearAuth}>退出</Button> : null}
          </Space>
        </Space>

        <div style={{ height: 16 }} />

        <Form
          form={form}
          layout="vertical"
          initialValues={{ occurred_at: dayjs() }}
          disabled={!token}
        >
          <div style={{ borderBottom: '1px solid #e6f4ff', paddingBottom: 8, marginBottom: 16, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width: 4, height: 18, background:'#1677ff', borderRadius: 2 }} />
            <Typography.Text style={{ color:'#1d39c4', fontWeight: 600 }}>支出信息</Typography.Text>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
            <Form.Item name="occurred_at" label="日期" rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="amount" label="金额(AUD)" rules={[{ required: true }]}>
              <InputNumber min={0} step={1} style={{ width: '100%' }} />
            </Form.Item>
          </div>

          <Form.Item name="category" label="类别" rules={[{ required: true }]}>
            <Select options={categoryOptions} />
          </Form.Item>

          <Form.Item noStyle shouldUpdate>
            {() => {
              const c = form.getFieldValue('category')
              if (c === 'other') {
                return (
                  <Form.Item name="category_detail" label="其他支出描述" rules={[{ required: true }]}>
                    <Input />
                  </Form.Item>
                )
              }
              return null
            }}
          </Form.Item>

          <Form.Item name="note" label="备注">
            <Input />
          </Form.Item>

          <Form.Item label="发票(可选)">
            <Upload
              fileList={invoiceFiles}
              maxCount={1}
              onRemove={() => { setInvoiceFiles([]); setInvoiceUrl(''); return true }}
              customRequest={async ({ file, onProgress, onSuccess, onError }: any) => {
                if (!token) { onError && onError(new Error('unauthorized')); message.error('请先验证访问密码'); return }
                const uid = Math.random().toString(36).slice(2)
                setInvoiceFiles([{ uid, name: (file as any)?.name || 'invoice', status: 'uploading', percent: 0 } as UploadFile])
                try {
                  const url = await xhrUpload(file, token, (pct) => {
                    onProgress && onProgress({ percent: pct })
                    setInvoiceFiles([{ uid, name: (file as any)?.name || 'invoice', status: 'uploading', percent: pct } as UploadFile])
                  })
                  setInvoiceUrl(url)
                  setInvoiceFiles([{ uid, name: (file as any)?.name || 'invoice', status: 'done', percent: 100, url } as UploadFile])
                  onSuccess && onSuccess({ url }, file)
                } catch (e) {
                  setInvoiceFiles([{ uid, name: (file as any)?.name || 'invoice', status: 'error' } as UploadFile])
                  onError && onError(e)
                }
              }}
            >
              <Button>上传发票</Button>
            </Upload>
          </Form.Item>

          <Space>
            <Button type="primary" onClick={submit} loading={loggingIn}>提交</Button>
            <Button onClick={() => { form.resetFields(); setInvoiceFiles([]); setInvoiceUrl('') }}>重置</Button>
          </Space>
        </Form>
      </Card>
    </div>
  )
}
