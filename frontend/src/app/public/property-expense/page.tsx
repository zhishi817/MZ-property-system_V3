"use client"
import { App, Button, Card, DatePicker, Form, Input, InputNumber, Select, Space, Typography, Upload } from 'antd'
import type { UploadFile } from 'antd/es/upload/interface'
import { LockOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { API_BASE } from '../../../lib/api'

function storageKeyPassword() { return 'public_property_expense_password' }
function storageKeyToken() { return 'public_property_expense_token' }

export default function PublicPropertyExpensePage() {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [pwd, setPwd] = useState('')
  const [token, setToken] = useState<string>('')
  const [loggingIn, setLoggingIn] = useState(false)
  const [invoiceFiles, setInvoiceFiles] = useState<UploadFile[]>([])
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string }[]>([])

  useEffect(() => {
    try {
      const p = localStorage.getItem(storageKeyPassword()) || ''
      if (p) setPwd(p)
      const tk = localStorage.getItem(storageKeyToken()) || ''
      if (tk) setToken(tk)
    } catch {}
  }, [])

  const categoryOptions = useMemo(() => ([
    { value: 'electricity', label: '电费' },
    { value: 'water', label: '水费' },
    { value: 'gas_hot_water', label: '煤气/热水费' },
    { value: 'internet', label: '网费' },
    { value: 'consumables', label: '消耗品费' },
    { value: 'carpark', label: '车位费' },
    { value: 'owners_corp', label: '物业费' },
    { value: 'council_rate', label: '市政费' },
    { value: 'other', label: '其他' },
  ]), [])

  async function ensureToken(): Promise<string | null> {
    const pass = String(pwd || '').trim()
    if (!pass) { message.error('请输入访问密码'); return null }
    if (token) return token
    setLoggingIn(true)
    try {
      const res = await fetch(`${API_BASE}/public/property-expense/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pass })
      })
      const j = await res.json().catch(() => null)
      if (res.ok && j?.token) {
        const tk = String(j.token)
        setToken(tk)
        try { localStorage.setItem(storageKeyToken(), tk) } catch {}
        return tk
      }
      try { localStorage.removeItem(storageKeyToken()) } catch {}
      setToken('')
      message.error(j?.message || '认证失败')
      return null
    } catch {
      try { localStorage.removeItem(storageKeyToken()) } catch {}
      setToken('')
      message.error('认证失败')
      return null
    } finally {
      setLoggingIn(false)
    }
  }

  async function loadProperties(tk: string) {
    try {
      const res = await fetch(`${API_BASE}/public/property-expense/properties`, { headers: { Authorization: `Bearer ${tk}` } })
      const j = await res.json().catch(() => null)
      if (!res.ok) throw new Error(String(j?.message || `HTTP ${res.status}`))
      setProperties(Array.isArray(j) ? j : [])
    } catch {
      setProperties([])
    }
  }

  useEffect(() => {
    if (!token) return
    loadProperties(token)
  }, [token])

  function xhrUpload(file: any, tk: string, expenseId: string, onProgress?: (pct: number) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const fd = new FormData()
        fd.append('file', file)
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `${API_BASE}/public/property-expense/${expenseId}/upload`)
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
            if (xhr.status >= 200 && xhr.status < 300 && (j?.url || j?.id)) resolve(String(j?.url || 'ok'))
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
    const v = await form.validateFields()
    const tk = await ensureToken()
    if (!tk) return
    const payload = {
      property_id: String(v.property_id || '').trim(),
      occurred_at: v.occurred_at ? dayjs(v.occurred_at).format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
      amount: Number(v.amount || 0),
      currency: 'AUD',
      category: v.category,
      category_detail: v.category === 'other' ? String(v.category_detail || '').trim() : undefined,
      note: String(v.note || '').trim(),
    }
    try {
      const res = await fetch(`${API_BASE}/public/property-expense/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
        body: JSON.stringify(payload)
      })
      const j = await res.json().catch(() => null)
      if (!res.ok) { message.error(j?.message || '提交失败'); return }
      const id = String(j?.id || j?.row?.id || '')
      const file = invoiceFiles?.[0]?.originFileObj as any
      if (id && file) {
        try {
          await xhrUpload(file, tk, id)
        } catch (e: any) {
          message.error(`发票上传失败：${e?.message || ''}`)
        }
      }
      message.success('支出已提交')
      form.resetFields()
      setInvoiceFiles([])
    } catch {
      message.error('提交失败')
    }
  }

  const propertyOptions = useMemo(() => {
    const arr = Array.isArray(properties) ? properties : []
    const sorted = [...arr].sort((a, b) => String(a.code || a.address || a.id).localeCompare(String(b.code || b.address || b.id)))
    return sorted.map((p) => ({ value: p.id, label: p.code || p.address || p.id }))
  }, [properties])

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
      <Card title="房源支出登记（外部）" style={{ borderRadius: 12 }} extra={<Typography.Text type="secondary">提交后会写入房源支出</Typography.Text>}>
        <Form
          form={form}
          layout="vertical"
          initialValues={{ occurred_at: dayjs() }}
        >
          <div style={{ borderBottom: '1px solid #e6f4ff', paddingBottom: 8, marginBottom: 16, display:'flex', alignItems:'center', gap:8 }}>
            <LockOutlined style={{ color:'#1677ff' }} />
            <Typography.Text style={{ color:'#1d39c4', fontWeight: 600 }}>访问密码</Typography.Text>
          </div>
          <Form.Item name="password" label="访问密码" rules={[{ required: true, message: '必填' }, { validator: async (_: any, val: any) => {
            const s = String(val || '').trim()
            if (!s) return Promise.reject(new Error('必填'))
            setPwd(s)
            try { localStorage.setItem(storageKeyPassword(), s) } catch {}
            return Promise.resolve()
          } }]}><Input.Password placeholder="请输入访问密码" /></Form.Item>

          <div style={{ borderBottom: '1px solid #e6f4ff', paddingBottom: 8, marginBottom: 16, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width: 4, height: 18, background:'#1677ff', borderRadius: 2 }} />
            <Typography.Text style={{ color:'#1d39c4', fontWeight: 600 }}>支出信息</Typography.Text>
          </div>

          <Form.Item name="property_id" label="房号" rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder={token ? '请选择房号' : '请先输入密码并提交一次以获取房号列表'}
              options={propertyOptions}
              filterOption={(input, option) => String((option as any)?.label || '').toLowerCase().includes(String(input || '').toLowerCase())}
              onDropdownVisibleChange={async (open) => {
                if (!open) return
                const tk = await ensureToken()
                if (tk) loadProperties(tk)
              }}
            />
          </Form.Item>

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
              beforeUpload={() => false}
              onChange={(info) => setInvoiceFiles(info.fileList)}
            >
              <Button>选择发票文件</Button>
            </Upload>
          </Form.Item>

          <Space>
            <Button type="primary" onClick={submit} loading={loggingIn}>提交</Button>
          </Space>
        </Form>
      </Card>
    </div>
  )
}
