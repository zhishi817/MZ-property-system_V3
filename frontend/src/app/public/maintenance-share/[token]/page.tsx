"use client"
import { App, Button, Card, DatePicker, Form, Input, InputNumber, Select, Space, Switch, Typography, Upload } from 'antd'
import { LockOutlined, UploadOutlined } from '@ant-design/icons'
import type { UploadFile } from 'antd/es/upload/interface'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { API_BASE } from '../../../../lib/api'

type MaintenanceRecord = Record<string, any>

function summaryFromDetails(details?: string) {
  const s = String(details || '')
  if (!s) return ''
  try {
    const arr = JSON.parse(s)
    if (Array.isArray(arr) && arr[0] && typeof arr[0].content === 'string') return arr[0].content
  } catch {}
  return s
}

function buildDetailsPayload(text: string) {
  const s = String(text || '').trim()
  if (!s) return JSON.stringify([])
  return JSON.stringify([{ content: s }])
}

const statusOptions = [
  { value: 'pending', label: '待处理' },
  { value: 'assigned', label: '已分配' },
  { value: 'in_progress', label: '进行中' },
  { value: 'completed', label: '已完成' },
  { value: 'canceled', label: '已取消' },
]

const urgencyOptions = [
  { value: 'high', label: '紧急' },
  { value: 'medium', label: '普通' },
  { value: 'low', label: '不紧急' },
]

const payMethodOptions = [
  { value: 'rent_deduction', label: '租金扣除' },
  { value: 'tenant_pay', label: '房客支付' },
  { value: 'company_pay', label: '公司承担' },
  { value: 'landlord_pay', label: '房东支付' },
  { value: 'other_pay', label: '其他人支付' },
]

export default function PublicMaintenanceSharePage({ params }: { params: { token: string } }) {
  const shareId = String(params?.token || '')
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [pwdForm] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [record, setRecord] = useState<MaintenanceRecord | null>(null)
  const [shareJwt, setShareJwt] = useState<string>('')
  const [files, setFiles] = useState<UploadFile[]>([])
  const [urls, setUrls] = useState<string[]>([])

  const payMethodWatch = Form.useWatch('pay_method', form)
  const hasPartsWatch = Form.useWatch('has_parts', form)
  const statusWatch = Form.useWatch('status', form)

  const storageKey = useMemo(() => `maintenance_share_jwt:${shareId}`, [shareId])

  async function loadRecord() {
    if (!shareId) return
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/public/maintenance-share/${encodeURIComponent(shareId)}`, { cache: 'no-store' })
      const j = await res.json().catch(() => null)
      if (!res.ok) { message.error(j?.message || '加载失败'); setRecord(null); return }
      setRecord(j)
      const initUrls: string[] = Array.isArray(j?.repair_photo_urls) ? j.repair_photo_urls : []
      setUrls(initUrls)
      setFiles(initUrls.map((u: string, i: number) => ({ uid: String(i), name: `photo-${i + 1}`, status: 'done', url: u } as UploadFile)))
      form.setFieldsValue({
        status: String(j?.status || 'pending'),
        urgency: String(j?.urgency || 'medium'),
        details: summaryFromDetails(j?.details),
        repair_notes: String(j?.repair_notes || ''),
        has_parts: j?.has_parts === true,
        maintenance_amount: j?.maintenance_amount !== undefined && j?.maintenance_amount !== null ? Number(j?.maintenance_amount || 0) : undefined,
        parts_amount: j?.parts_amount !== undefined && j?.parts_amount !== null ? Number(j?.parts_amount || 0) : undefined,
        pay_method: j?.pay_method ?? undefined,
        pay_other_note: j?.pay_other_note ?? undefined,
        eta: j?.eta ? dayjs(String(j.eta)) : null,
        completed_at: j?.completed_at ? dayjs(String(j.completed_at)) : null,
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
      const res = await fetch(`${API_BASE}/public/maintenance-share/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: shareId, password })
      })
      const j = await res.json().catch(() => null)
      if (!res.ok) { message.error(j?.message || '密码错误'); return }
      const tk = String(j?.token || '')
      setShareJwt(tk)
      try { sessionStorage.setItem(storageKey, tk) } catch {}
      if (j?.maintenance) {
        setRecord(j.maintenance)
      }
      message.success('验证成功')
    } catch {
      message.error('验证失败')
    } finally {
      setLoading(false)
    }
  }

  async function save() {
    if (!shareJwt) { message.error('请先输入密码'); return }
    const v = await form.validateFields()
    const payload: any = {
      status: v.status,
      urgency: v.urgency,
      details: buildDetailsPayload(String(v.details || '')),
      repair_notes: String(v.repair_notes || '') || undefined,
      repair_photo_urls: urls,
      has_parts: v.has_parts === true,
      maintenance_amount: v.maintenance_amount !== undefined ? Number(v.maintenance_amount || 0) : undefined,
      parts_amount: v.parts_amount !== undefined ? Number(v.parts_amount || 0) : undefined,
      pay_method: v.pay_method ? String(v.pay_method) : undefined,
      pay_other_note: String(v.pay_method || '') === 'other_pay' ? (v.pay_other_note ? String(v.pay_other_note) : undefined) : undefined,
      eta: v.eta ? dayjs(v.eta).format('YYYY-MM-DD') : undefined,
    }
    if (String(v.status || '') === 'completed') {
      payload.completed_at = v.completed_at ? dayjs(v.completed_at).toDate().toISOString() : new Date().toISOString()
    } else {
      payload.completed_at = undefined
    }
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/public/maintenance-share/${encodeURIComponent(shareId)}`, {
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

  const title = `${String((record as any)?.code || (record as any)?.property_code || (record as any)?.property_id || '') || '维修记录'}`
  const workNo = String((record as any)?.work_no || (record as any)?.id || '')

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: 16 }}>
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        <Card loading={loading} style={{ borderRadius: 12 }}>
          <Space direction="vertical" style={{ width: '100%' }} size={8}>
            <Typography.Title level={4} style={{ margin: 0 }}>维修记录外部编辑</Typography.Title>
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

            <Form.Item name="details" label="问题摘要" rules={[{ required: true, min: 3 }]}>
              <Input.TextArea rows={3} placeholder="简要描述问题/处理进度" />
            </Form.Item>

            <Form.Item name="repair_notes" label="维修记录描述">
              <Input.TextArea rows={3} placeholder="可填写维修过程、处理结果、注意事项等" />
            </Form.Item>

            <Form.Item label="维修照片">
              <Upload
                listType="picture"
                multiple
                fileList={files}
                onRemove={(f) => {
                  setFiles(fl => fl.filter(x => x.uid !== f.uid))
                  if (f.url) setUrls(u => u.filter(x => x !== f.url))
                }}
                customRequest={async ({ file, onSuccess, onError }: any) => {
                  if (!shareJwt) { onError && onError(new Error('unauthorized')); return }
                  const fd = new FormData()
                  fd.append('file', file)
                  try {
                    const r = await fetch(`${API_BASE}/public/maintenance-share/upload`, { method: 'POST', headers: { Authorization: `Bearer ${shareJwt}` }, body: fd })
                    const j = await r.json().catch(() => null)
                    if (r.ok && j?.url) {
                      setUrls(u => [...u, j.url])
                      setFiles(fl => [...fl, { uid: Math.random().toString(36).slice(2), name: file.name, status: 'done', url: j.url } as UploadFile])
                      onSuccess && onSuccess(j, file)
                    } else {
                      onError && onError(j || new Error('upload failed'))
                    }
                  } catch (e) {
                    onError && onError(e)
                  }
                }}
              >
                <Button icon={<UploadOutlined />}>上传图片</Button>
              </Upload>
            </Form.Item>

            {String(statusWatch || '') === 'completed' ? (
              <Card size="small" style={{ borderRadius: 12, marginBottom: 12 }} title="费用信息">
                <Space style={{ width: '100%' }} wrap>
                  <Form.Item name="maintenance_amount" label="维修金额（AUD）" style={{ minWidth: 220, marginBottom: 0 }}>
                    <InputNumber min={0} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name="has_parts" label="是否有配件费" valuePropName="checked" style={{ minWidth: 220, marginBottom: 0 }}>
                    <Switch />
                  </Form.Item>
                  <Form.Item name="parts_amount" label="配件费金额（AUD）" style={{ minWidth: 220, marginBottom: 0, display: hasPartsWatch ? 'block' : 'none' }}>
                    <InputNumber min={0} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name="pay_method" label="扣款方式" style={{ minWidth: 220, marginBottom: 0 }}>
                    <Select allowClear options={payMethodOptions} />
                  </Form.Item>
                  {String(payMethodWatch || '') === 'other_pay' ? (
                    <Form.Item name="pay_other_note" label="其他人备注" style={{ minWidth: 320, marginBottom: 0 }}>
                      <Input placeholder="填写其他人信息/备注" />
                    </Form.Item>
                  ) : null}
                </Space>
              </Card>
            ) : null}

            <Button type="primary" onClick={save} loading={loading} disabled={!shareJwt}>
              保存更新
            </Button>
          </Form>
        </Card>
      </Space>
    </div>
  )
}
