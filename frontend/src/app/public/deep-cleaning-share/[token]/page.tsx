"use client"
import { App, Button, Card, DatePicker, Form, Input, InputNumber, Select, Space, Typography, Upload } from 'antd'
import { LockOutlined } from '@ant-design/icons'
import type { UploadFile } from 'antd/es/upload/interface'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { API_BASE } from '../../../../lib/api'

type DeepCleaningRecord = Record<string, any>

const statusOptions = [
  { value: 'pending', label: '待清洁' },
  { value: 'assigned', label: '已分配' },
  { value: 'in_progress', label: '清洁中' },
  { value: 'completed', label: '待审核' },
  { value: 'canceled', label: '已取消' },
]

const urgencyOptions = [
  { value: 'high', label: '高' },
  { value: 'normal', label: '中' },
  { value: 'low', label: '低' },
]

function safeJsonParse(v: any) {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') return v
  const s = String(v || '').trim()
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

export default function PublicDeepCleaningSharePage({ params }: { params: { token: string } }) {
  const shareId = String(params?.token || '')
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [pwdForm] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [record, setRecord] = useState<DeepCleaningRecord | null>(null)
  const [shareJwt, setShareJwt] = useState<string>('')
  const [beforeFiles, setBeforeFiles] = useState<UploadFile[]>([])
  const [afterFiles, setAfterFiles] = useState<UploadFile[]>([])
  const [attachFiles, setAttachFiles] = useState<UploadFile[]>([])
  const [beforeUrls, setBeforeUrls] = useState<string[]>([])
  const [afterUrls, setAfterUrls] = useState<string[]>([])
  const [attachUrls, setAttachUrls] = useState<string[]>([])

  const storageKey = useMemo(() => `deep_cleaning_share_jwt:${shareId}`, [shareId])
  const statusWatch = Form.useWatch('status', form)

  async function loadRecord() {
    if (!shareId) return
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/public/deep-cleaning-share/${encodeURIComponent(shareId)}`, { cache: 'no-store' })
      const j = await res.json().catch(() => null)
      if (!res.ok) { message.error(j?.message || '加载失败'); setRecord(null); return }
      setRecord(j)
      const b: string[] = Array.isArray(j?.photo_urls) ? j.photo_urls : []
      const a: string[] = Array.isArray(j?.repair_photo_urls) ? j.repair_photo_urls : []
      const at: string[] = Array.isArray(j?.attachment_urls) ? j.attachment_urls : []
      setBeforeUrls(b); setAfterUrls(a); setAttachUrls(at)
      setBeforeFiles(b.map((u: string, i: number) => ({ uid: `b-${i}`, name: `before-${i + 1}`, status: 'done', url: u } as UploadFile)))
      setAfterFiles(a.map((u: string, i: number) => ({ uid: `a-${i}`, name: `after-${i + 1}`, status: 'done', url: u } as UploadFile)))
      setAttachFiles(at.map((u: string, i: number) => ({ uid: `at-${i}`, name: `att-${i + 1}`, status: 'done', url: u } as UploadFile)))
      form.setFieldsValue({
        status: String(j?.status || 'pending'),
        urgency: String(j?.urgency || 'normal'),
        details: typeof j?.details === 'string' ? j.details : (j?.details ? JSON.stringify(j.details) : ''),
        repair_notes: String(j?.repair_notes || ''),
        eta: j?.eta ? dayjs(String(j.eta)) : null,
        completed_at: j?.completed_at ? dayjs(String(j.completed_at)) : null,
        checklist: safeJsonParse(j?.checklist) || [],
        consumables: safeJsonParse(j?.consumables) || [],
        labor_minutes: j?.labor_minutes !== undefined && j?.labor_minutes !== null ? Number(j?.labor_minutes || 0) : undefined,
        labor_cost: j?.labor_cost !== undefined && j?.labor_cost !== null ? Number(j?.labor_cost || 0) : undefined,
      })
    } catch {
      message.error('加载失败')
      setRecord(null)
    } finally {
      setLoading(false)
    }
  }

  async function login() {
    const v = await pwdForm.validateFields()
    const password = String(v.password || '')
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/public/deep-cleaning-share/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: shareId, password })
      })
      const j = await res.json().catch(() => null)
      if (!res.ok) { message.error(j?.message || '密码错误'); return }
      const tk = String(j?.token || '')
      setShareJwt(tk)
      try { sessionStorage.setItem(storageKey, tk) } catch {}
      if (j?.deep_cleaning) setRecord(j.deep_cleaning)
      message.success('验证成功')
    } catch {
      message.error('验证失败')
    } finally {
      setLoading(false)
    }
  }

  async function uploadOne(file: File) {
    if (!shareJwt) throw new Error('请先输入密码')
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`${API_BASE}/public/deep-cleaning-share/upload`, { method: 'POST', headers: { Authorization: `Bearer ${shareJwt}` }, body: fd })
    const j = await res.json().catch(()=>null)
    if (!res.ok) throw new Error(j?.message || `HTTP ${res.status}`)
    const url = String(j?.url || '')
    if (!url) throw new Error('upload failed')
    return url
  }

  async function save() {
    if (!shareJwt) { message.error('请先输入密码'); return }
    const v = await form.validateFields()
    const payload: any = {
      status: v.status,
      urgency: v.urgency,
      details: v.details ? String(v.details) : '[]',
      repair_notes: String(v.repair_notes || '') || undefined,
      photo_urls: beforeUrls,
      repair_photo_urls: afterUrls,
      attachment_urls: attachUrls,
      checklist: Array.isArray(v.checklist) ? v.checklist : [],
      consumables: Array.isArray(v.consumables) ? v.consumables : [],
      labor_minutes: v.labor_minutes !== undefined ? Number(v.labor_minutes || 0) : undefined,
      labor_cost: v.labor_cost !== undefined ? Number(v.labor_cost || 0) : undefined,
      eta: v.eta ? dayjs(v.eta).format('YYYY-MM-DD') : undefined,
    }
    if (String(v.status || '') === 'completed') {
      payload.completed_at = v.completed_at ? dayjs(v.completed_at).toDate().toISOString() : new Date().toISOString()
    } else {
      payload.completed_at = undefined
    }
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/public/deep-cleaning-share/${encodeURIComponent(shareId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shareJwt}` },
        body: JSON.stringify(payload)
      })
      const j = await res.json().catch(() => null)
      if (!res.ok) { message.error(j?.message || '保存失败'); return }
      message.success('已保存')
      await loadRecord()
    } catch {
      message.error('保存失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    try {
      const tk = sessionStorage.getItem(storageKey) || ''
      if (tk) setShareJwt(tk)
    } catch {}
    loadRecord()
  }, [storageKey])

  const title = `${String((record as any)?.code || (record as any)?.property_code || (record as any)?.property_id || '') || '深度清洁记录'}`
  const workNo = String((record as any)?.work_no || (record as any)?.id || '')

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: 16 }}>
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        <Card loading={loading} style={{ borderRadius: 12 }}>
          <Space direction="vertical" style={{ width: '100%' }} size={8}>
            <Typography.Title level={4} style={{ margin: 0 }}>深度清洁外部编辑</Typography.Title>
            <Typography.Text type="secondary">房号：{title}</Typography.Text>
            <Typography.Text type="secondary">工单号：{workNo}</Typography.Text>
          </Space>
        </Card>

        <Card loading={loading} style={{ borderRadius: 12 }} title={<Space><LockOutlined />输入密码后可编辑</Space>}>
          <Form form={pwdForm} layout="inline">
            <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password placeholder="认证密码" />
            </Form.Item>
            <Button type="primary" onClick={login} loading={loading}>验证</Button>
          </Form>
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
            仅持有分享链接且通过密码验证的人员可更新该记录。
          </Typography.Paragraph>
        </Card>

        <Card loading={loading} style={{ borderRadius: 12 }} title="编辑内容">
          <Form form={form} layout="vertical">
            <Space style={{ width: '100%' }} wrap>
              <Form.Item name="status" label="状态" rules={[{ required: true }]} style={{ minWidth: 220, marginBottom: 0 }}>
                <Select options={statusOptions} />
              </Form.Item>
              <Form.Item name="urgency" label="紧急程度" rules={[{ required: true }]} style={{ minWidth: 220, marginBottom: 0 }}>
                <Select options={urgencyOptions} />
              </Form.Item>
              <Form.Item name="eta" label="预计完成时间" style={{ minWidth: 220, marginBottom: 0 }}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              {String(statusWatch || '') === 'completed' ? (
                <Form.Item name="completed_at" label="完成时间" style={{ minWidth: 220, marginBottom: 0 }}>
                  <DatePicker showTime style={{ width: '100%' }} />
                </Form.Item>
              ) : null}
            </Space>

            <Form.Item name="details" label="清洁摘要" rules={[{ required: true, min: 3 }]}>
              <Input.TextArea rows={3} placeholder="简要描述清洁重点/处理进度" />
            </Form.Item>

            <Form.Item name="repair_notes" label="执行说明（完成确认）">
              <Input.TextArea rows={3} placeholder="例如：已完成厨房重油污处理，浴室除垢消毒…" />
            </Form.Item>

            <Form.Item name="checklist" label="清洁项目清单">
              <Form.List name="checklist">
                {(fields, { add, remove }) => (
                  <Space direction="vertical" style={{ width:'100%' }}>
                    {fields.map(f => (
                      <div key={f.key} style={{ display:'grid', gridTemplateColumns: '1fr 120px 1fr 60px', gap: 8, alignItems:'center' }}>
                        <Form.Item name={[f.name, 'item']} rules={[{ required: true }]} style={{ marginBottom: 0 }}>
                          <Input placeholder="项目" />
                        </Form.Item>
                        <Form.Item name={[f.name, 'done']} style={{ marginBottom: 0 }}>
                          <Select options={[{ value: true, label: '完成' }, { value: false, label: '未完成' }]} />
                        </Form.Item>
                        <Form.Item name={[f.name, 'note']} style={{ marginBottom: 0 }}>
                          <Input placeholder="备注" />
                        </Form.Item>
                        <Button onClick={() => remove(f.name)}>删除</Button>
                      </div>
                    ))}
                    <Button onClick={() => add({ item: '', done: false })}>新增项目</Button>
                  </Space>
                )}
              </Form.List>
            </Form.Item>

            <Card size="small" title="材料上传" style={{ marginBottom: 12 }}>
              <Space direction="vertical" style={{ width:'100%' }}>
                <div>
                  <div style={{ marginBottom: 6, fontWeight: 600 }}>清洁前（图片/视频）</div>
                  <Upload
                    multiple
                    accept="image/*,video/*"
                    fileList={beforeFiles}
                    customRequest={async ({ file, onSuccess, onError }: any) => {
                      try { const url = await uploadOne(file as File); onSuccess?.({ url }, file) } catch (e: any) { onError?.(e) }
                    }}
                    onChange={(info) => {
                      const next = (info.fileList || []).map(f => {
                        const r: any = (f as any).response
                        if (r?.url) return { ...f, url: r.url, status: 'done' as any }
                        return f
                      })
                      setBeforeFiles(next)
                      setBeforeUrls(next.map(f => String((f as any).url || '')).filter(Boolean))
                    }}
                    listType="picture"
                  >
                    <Button>上传</Button>
                  </Upload>
                </div>
                <div>
                  <div style={{ marginBottom: 6, fontWeight: 600 }}>清洁后（图片/视频）</div>
                  <Upload
                    multiple
                    accept="image/*,video/*"
                    fileList={afterFiles}
                    customRequest={async ({ file, onSuccess, onError }: any) => {
                      try { const url = await uploadOne(file as File); onSuccess?.({ url }, file) } catch (e: any) { onError?.(e) }
                    }}
                    onChange={(info) => {
                      const next = (info.fileList || []).map(f => {
                        const r: any = (f as any).response
                        if (r?.url) return { ...f, url: r.url, status: 'done' as any }
                        return f
                      })
                      setAfterFiles(next)
                      setAfterUrls(next.map(f => String((f as any).url || '')).filter(Boolean))
                    }}
                    listType="picture"
                  >
                    <Button>上传</Button>
                  </Upload>
                </div>
                <div>
                  <div style={{ marginBottom: 6, fontWeight: 600 }}>附件</div>
                  <Upload
                    multiple
                    accept="image/*,video/*"
                    fileList={attachFiles}
                    customRequest={async ({ file, onSuccess, onError }: any) => {
                      try { const url = await uploadOne(file as File); onSuccess?.({ url }, file) } catch (e: any) { onError?.(e) }
                    }}
                    onChange={(info) => {
                      const next = (info.fileList || []).map(f => {
                        const r: any = (f as any).response
                        if (r?.url) return { ...f, url: r.url, status: 'done' as any }
                        return f
                      })
                      setAttachFiles(next)
                      setAttachUrls(next.map(f => String((f as any).url || '')).filter(Boolean))
                    }}
                  >
                    <Button>上传</Button>
                  </Upload>
                </div>
              </Space>
            </Card>

            <Card size="small" title="耗材与工时" style={{ marginBottom: 12 }}>
              <Space wrap style={{ width:'100%' }}>
                <Form.Item name="labor_minutes" label="工时（分钟）" style={{ minWidth: 220, marginBottom: 0 }}>
                  <InputNumber min={0} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item name="labor_cost" label="人工成本（可选）" style={{ minWidth: 220, marginBottom: 0 }}>
                  <InputNumber min={0} style={{ width: '100%' }} />
                </Form.Item>
              </Space>
              <Form.Item name="consumables" label="耗材记录" style={{ marginTop: 12 }}>
                <Form.List name="consumables">
                  {(fields, { add, remove }) => (
                    <Space direction="vertical" style={{ width:'100%' }}>
                      {fields.map(f => (
                        <div key={f.key} style={{ display:'grid', gridTemplateColumns: '1fr 120px 120px 120px 60px', gap: 8, alignItems:'center' }}>
                          <Form.Item name={[f.name, 'name']} rules={[{ required: true }]} style={{ marginBottom: 0 }}>
                            <Input placeholder="耗材名称" />
                          </Form.Item>
                          <Form.Item name={[f.name, 'qty']} style={{ marginBottom: 0 }}>
                            <InputNumber min={0} style={{ width:'100%' }} placeholder="数量" />
                          </Form.Item>
                          <Form.Item name={[f.name, 'unit']} style={{ marginBottom: 0 }}>
                            <Input placeholder="单位" />
                          </Form.Item>
                          <Form.Item name={[f.name, 'cost']} style={{ marginBottom: 0 }}>
                            <InputNumber min={0} style={{ width:'100%' }} placeholder="金额" />
                          </Form.Item>
                          <Button onClick={() => remove(f.name)}>删除</Button>
                        </div>
                      ))}
                      <Button onClick={() => add({ name: '', qty: 1 })}>新增耗材</Button>
                    </Space>
                  )}
                </Form.List>
              </Form.Item>
            </Card>

            <Button type="primary" onClick={save} loading={loading} disabled={!shareJwt}>保存</Button>
          </Form>
        </Card>
      </Space>
    </div>
  )
}

