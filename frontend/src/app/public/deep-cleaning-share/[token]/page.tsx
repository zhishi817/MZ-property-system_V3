"use client"
import { Alert, App, Button, Card, Form, Input, InputNumber, Select, Space, Table, Typography, Upload } from 'antd'
import { LockOutlined } from '@ant-design/icons'
import type { UploadFile } from 'antd/es/upload/interface'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { API_BASE } from '../../../../lib/api'
import { canSubmitPublicDeepCleaning, publicDeepCleaningPayload } from '../../../../lib/deepCleaningPublicShare'

type DeepCleaningRecord = Record<string, any>

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
  const [loadError, setLoadError] = useState('')
  const [shareJwt, setShareJwt] = useState<string>('')
  const [beforeFiles, setBeforeFiles] = useState<UploadFile[]>([])
  const [afterFiles, setAfterFiles] = useState<UploadFile[]>([])
  const [attachFiles, setAttachFiles] = useState<UploadFile[]>([])
  const [beforeUrls, setBeforeUrls] = useState<string[]>([])
  const [afterUrls, setAfterUrls] = useState<string[]>([])
  const [attachUrls, setAttachUrls] = useState<string[]>([])

  const storageKey = useMemo(() => `deep_cleaning_share_jwt:${shareId}`, [shareId])

  async function loadRecord() {
    if (!shareId) return
    setLoading(true)
    setLoadError('')
    try {
      const res = await fetch(`${API_BASE}/public/deep-cleaning-share/${encodeURIComponent(shareId)}`, { cache: 'no-store' })
      const j = await res.json().catch(() => null)
      if (!res.ok) {
        const msg = j?.message || '加载失败'
        message.error(msg)
        setLoadError(msg)
        setRecord(null)
        return
      }
      setRecord(j)
      const b: string[] = Array.isArray(j?.photo_urls) ? j.photo_urls : []
      const a: string[] = Array.isArray(j?.repair_photo_urls) ? j.repair_photo_urls : []
      const at: string[] = Array.isArray(j?.attachment_urls) ? j.attachment_urls : []
      setBeforeUrls(b); setAfterUrls(a); setAttachUrls(at)
      setBeforeFiles(b.map((u: string, i: number) => ({ uid: `b-${i}`, name: `before-${i + 1}`, status: 'done', url: u } as UploadFile)))
      setAfterFiles(a.map((u: string, i: number) => ({ uid: `a-${i}`, name: `after-${i + 1}`, status: 'done', url: u } as UploadFile)))
      setAttachFiles(at.map((u: string, i: number) => ({ uid: `at-${i}`, name: `att-${i + 1}`, status: 'done', url: u } as UploadFile)))
      form.setFieldsValue({
        urgency: String(j?.urgency || 'normal'),
        details: typeof j?.details === 'string' ? j.details : (j?.details ? JSON.stringify(j.details) : ''),
        repair_notes: String(j?.repair_notes || ''),
        checklist: safeJsonParse(j?.checklist) || [],
        labor_minutes: j?.labor_minutes !== undefined && j?.labor_minutes !== null ? Number(j?.labor_minutes || 0) : undefined,
      })
    } catch {
      const msg = '加载失败'
      message.error(msg)
      setLoadError(msg)
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

  async function save(submitForReview = false) {
    if (loading) return
    if (!shareJwt) { message.error('请先输入密码'); return }
    if (submitForReview && !canSubmitPublicDeepCleaning(record)) { message.error('此记录已提交或已审核，请仅保存材料'); return }
    setLoading(true)
    try {
      const v = await form.validateFields()
      if ([...beforeFiles, ...afterFiles, ...attachFiles].some(file => file.status === 'uploading' || file.status === 'error')) throw new Error('请等待材料上传成功后再保存')
      const payload = publicDeepCleaningPayload(v, { before: beforeUrls, after: afterUrls, attachments: attachUrls }, submitForReview)
      const res = await fetch(`${API_BASE}/public/deep-cleaning-share/${encodeURIComponent(shareId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shareJwt}` },
        body: JSON.stringify(payload)
      })
      const j = await res.json().catch(() => null)
      if (!res.ok) { message.error(j?.message || '保存失败'); return }
      message.success(submitForReview ? '已提交待审核，金额由管理员确认' : '已保存材料，审核状态和金额不变')
      await loadRecord()
    } catch (e: any) {
      if (!e?.errorFields) message.error(e?.message || '保存失败')
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

        {loadError && !loading ? (
          <Card style={{ borderRadius: 12 }}>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Alert type="error" message={loadError} showIcon />
              <Button onClick={loadRecord}>重新加载</Button>
            </Space>
          </Card>
        ) : null}

        {record ? (
          <>
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
          <Form form={form} layout="vertical" disabled={!shareJwt || loading}>
            <Alert type="info" showIcon message="此页面仅维护说明、工作记录与照片。完工提交后仍需管理员审核，由管理员确认实际执行人、金额及扣款方式；保存材料不会重新提交审核或改价。" style={{ marginBottom: 16 }} />
            <Space style={{ width: '100%' }} wrap>
              <Form.Item name="urgency" label="紧急程度" rules={[{ required: true }]} style={{ minWidth: 220, marginBottom: 0 }}>
                <Select options={urgencyOptions} />
              </Form.Item>
            </Space>

            <Typography.Paragraph type="secondary">预计完成：{record.eta ? dayjs(record.eta).format('YYYY-MM-DD') : '-'}；完成时间：{record.completed_at ? dayjs(record.completed_at).format('YYYY-MM-DD HH:mm') : '-'}（由任务流程维护）</Typography.Paragraph>
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
              </Space>
              <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>已有耗材记录只读。费用由管理员审核确认，不在公开链接修改。</Typography.Paragraph>
              <Table size="small" pagination={false} rowKey={(_, index) => String(index)} dataSource={safeJsonParse(record.consumables) || []} columns={[
                { title: '耗材', dataIndex: 'name' }, { title: '数量', dataIndex: 'qty' }, { title: '单位', dataIndex: 'unit' },
                { title: '原记录金额', dataIndex: 'cost', render: (value: any) => value == null || value === '' ? '-' : String(value) },
              ]} />
            </Card>

            <Space wrap>
              <Button onClick={() => { void save(false) }} loading={loading} disabled={!shareJwt || loading}>保存材料</Button>
              {canSubmitPublicDeepCleaning(record) ? <Button type="primary" onClick={() => { void save(true) }} loading={loading} disabled={!shareJwt || loading}>提交完工，等待审核</Button> : <Typography.Text type="secondary">已提交或已审核；补充材料不会更改审核结果。</Typography.Text>}
            </Space>
          </Form>
        </Card>
          </>
        ) : null}
      </Space>
    </div>
  )
}
