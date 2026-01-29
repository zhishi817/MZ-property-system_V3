"use client"
import { Card, Form, Input, Select, Radio, Button, Space, Upload, App, Typography } from 'antd'
import type { UploadFile } from 'antd/es/upload/interface'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { API_BASE } from '../../../lib/api'
import { sortProperties } from '../../../lib/properties'
import { useSearchParams } from 'next/navigation'

type Property = { id: string; code?: string; address?: string }

export default function RepairReportPage() {
  const [props, setProps] = useState<Property[]>([])
  const [form] = Form.useForm()
  const { message } = App.useApp()
  const [files, setFiles] = useState<UploadFile[]>([])
  const [urls, setUrls] = useState<string[]>([])
  const [labelFiles, setLabelFiles] = useState<UploadFile[]>([])
  const [labelUrls, setLabelUrls] = useState<string[]>([])
  const [token, setToken] = useState<string | null>(null)
  const [pwd, setPwd] = useState('')
  const [loggingIn, setLoggingIn] = useState(false)
  const search = useSearchParams()

  useEffect(() => {
    fetch(`${API_BASE}/public/properties`).then(r => r.json()).then(setProps).catch(() => setProps([]))
    try { const t = localStorage.getItem('public_cleaning_token'); if (t) setToken(t) } catch {}
  }, [])
  useEffect(() => {
    const code = search?.get('property_code') || ''
    if (code && Array.isArray(props) && props.length) {
      const m = props.find(p => String(p.code || '').toUpperCase() === String(code).toUpperCase())
      if (m) { form.setFieldsValue({ property_id: m.id }) }
    }
  }, [search, props, form])

  const options = useMemo(() => sortProperties(props).map(p => ({ value: p.id, label: p.code || p.address || p.id })), [props])
  const categories = [
    { value: '入户走廊', label: '入户走廊' },
    { value: '客厅', label: '客厅' },
    { value: '厨房', label: '厨房' },
    { value: '卧室', label: '卧室' },
    { value: '阳台', label: '阳台' },
    { value: '浴室', label: '浴室' },
    { value: '其他', label: '其他' },
  ]
  const [cat, setCat] = useState<string>('客厅')
  const typeOptions = [
    { value: 'appliance', label: '电器' },
    { value: 'furniture', label: '家具' },
    { value: 'other', label: '其他' },
  ]
  const [itemType, setItemType] = useState<string>('other')

  async function ensureToken(): Promise<string | null> {
    try {
      const pass = String(pwd || '').trim()
      if (pass.length < 4 || pass.length > 6) { message.error('请输入4-6位访问密码'); return null }
      setLoggingIn(true)
      const res = await fetch(`${API_BASE}/public/cleaning-guide/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pass })
      })
      const j = await res.json().catch(()=>null)
      setLoggingIn(false)
      if (res.ok && j?.token) {
        try { localStorage.setItem('public_cleaning_token', j.token) } catch {}
        setToken(j.token)
        return j.token
      }
      try { localStorage.removeItem('public_cleaning_token') } catch {}
      setToken(null)
      message.error(j?.message || '认证失败')
      return null
    } catch {
      setLoggingIn(false)
      try { localStorage.removeItem('public_cleaning_token') } catch {}
      setToken(null)
      message.error('认证失败')
      return null
    }
  }

  async function submit() {
    const v = await form.validateFields()
    const tk = await ensureToken()
    if (!tk) return
    if (String(v.item_type || '') === 'appliance' && (!labelUrls || labelUrls.length === 0)) {
      message.error('电器问题需上传品牌/型号照片')
      return
    }
    const payload = {
      property_id: v.property_id,
      category: v.category,
      detail: v.detail,
      attachment_urls: urls,
      item_type: v.item_type || 'other',
      label_photo_urls: labelUrls,
      submitter_name: v.submitter_name || '',
    }
    try {
      const res = await fetch(`${API_BASE}/public/repair/report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` }, body: JSON.stringify(payload)
      })
      const j = await res.json().catch(()=>null)
      if (res.ok) { message.success('已提交维修工单'); form.resetFields(); setFiles([]); setUrls([]); setLabelFiles([]); setLabelUrls([]); setItemType('other') }
      else { message.error(j?.message || '提交失败') }
    } catch { message.error('提交失败') }
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <Card title="房源报修表" style={{ marginTop: 24 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Paragraph type="secondary">请清洁人员填写并提交维修问题。</Typography.Paragraph>
          <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
            <Form.Item name="password" label="访问密码（4-6位数字）" rules={[{ required: true }, { validator: (_, val) => {
              const s = String(val || '')
              if (s.length < 4 || s.length > 6) return Promise.reject(new Error('长度需为4-6位'))
              if (!/^\d+$/.test(s)) return Promise.reject(new Error('仅允许数字'))
              setPwd(s)
              return Promise.resolve()
            } }]}><Input.Password placeholder="例如 1234" /></Form.Item>
            <Form.Item name="property_id" label="房号" rules={[{ required: true }]}><Select options={options} showSearch optionFilterProp="label" /></Form.Item>
            <Form.Item name="category" label="问题区域" rules={[{ required: true }]}>
              <Select options={categories.map(c=>({ value: c.value, label: c.label }))} value={cat} onChange={v=>setCat(String(v))} />
            </Form.Item>
            <Form.Item name="item_type" label="问题类型" rules={[{ required: true }]}>
              <Select options={typeOptions} value={itemType} onChange={v=>setItemType(String(v))} />
            </Form.Item>
            <Form.Item name="detail" label="问题详情" rules={[{ required: true, min: 5 }]}><Input.TextArea rows={4} placeholder="请详细描述问题" /></Form.Item>
            <Form.Item label="上传附件">
              <Upload listType="picture" multiple fileList={files} onRemove={(f)=>{ setFiles(fl=>fl.filter(x=>x.uid!==f.uid)); if (f.url) setUrls(u=>u.filter(x=>x!==f.url)) }}
                customRequest={async ({ file, onSuccess, onError }: any) => {
                  let tk = token
                  if (!tk) { tk = await ensureToken(); if (!tk) { onError && onError(new Error('unauthorized')); return } }
                  const fd = new FormData(); fd.append('file', file)
                  try {
                    const r = await fetch(`${API_BASE}/public/repair/upload`, { method: 'POST', headers: { Authorization: `Bearer ${tk}` }, body: fd })
                    const j = await r.json()
                    if (r.ok && j?.url) { setUrls(u=>[...u, j.url]); setFiles(fl=>[...fl, { uid: Math.random().toString(36).slice(2), name: file.name, status: 'done', url: j.url } as UploadFile]); onSuccess && onSuccess(j, file) } else { onError && onError(j) }
                  } catch (e) { onError && onError(e) }
                }}>
                <Button>上传图片/视频</Button>
              </Upload>
              <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>家具/地毯：正常拍清晰的现场照片或视频即可。</Typography.Paragraph>
            </Form.Item>
            {itemType === 'appliance' && (
              <Form.Item label="电器品牌/型号照片（必传）">
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Upload listType="picture" multiple fileList={labelFiles} onRemove={(f)=>{ setLabelFiles(fl=>fl.filter(x=>x.uid!==f.uid)); if (f.url) setLabelUrls(u=>u.filter(x=>x!==f.url)) }}
                    customRequest={async ({ file, onSuccess, onError }: any) => {
                      let tk = token
                      if (!tk) { tk = await ensureToken(); if (!tk) { onError && onError(new Error('unauthorized')); return } }
                      const fd = new FormData(); fd.append('file', file)
                      try {
                        const r = await fetch(`${API_BASE}/public/repair/upload`, { method: 'POST', headers: { Authorization: `Bearer ${tk}` }, body: fd })
                        const j = await r.json()
                        if (r.ok && j?.url) { setLabelUrls(u=>[...u, j.url]); setLabelFiles(fl=>[...fl, { uid: Math.random().toString(36).slice(2), name: file.name, status: 'done', url: j.url } as UploadFile]); onSuccess && onSuccess(j, file) } else { onError && onError(j) }
                      } catch (e) { onError && onError(e) }
                    }}>
                    <Button>上传铭牌样片</Button>
                  </Upload>
                  <Typography.Paragraph type="secondary">请拍摄电器铭牌（包含品牌与型号）。通常位于门内侧或背面。</Typography.Paragraph>
                  <img src="/repair/appliance-label-sample.svg" alt="电器铭牌样片示意" style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid #eee' }} />
                </Space>
              </Form.Item>
            )}
            <Form.Item name="submitter_name" label="提交人姓名" rules={[{ required: true }]}><Input placeholder="如系统未登录，请填写姓名" /></Form.Item>
            <Form.Item>
              <Button type="primary" onClick={submit}>提交工单</Button>
            </Form.Item>
          </Form>
        </Space>
      </Card>
    </div>
  )
}
