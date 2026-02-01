"use client"
import { useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Card, DatePicker, Drawer, Form, Grid, Image, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography, Upload } from 'antd'
import type { UploadFile, UploadProps } from 'antd'
import dayjs from 'dayjs'
import { CheckCircleOutlined, EnvironmentOutlined, InfoCircleOutlined, PictureOutlined, ShareAltOutlined } from '@ant-design/icons'
import { API_BASE, apiCreate, apiDelete, apiUpdate, authHeaders, getJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'
import { sortProperties } from '../../../lib/properties'

type DeepCleaningRecord = {
  id: string
  property_id?: string
  code?: string
  property_code?: string
  work_no?: string
  occurred_at?: string
  worker_name?: string
  project_desc?: string
  started_at?: string
  ended_at?: string
  duration_minutes?: number
  category?: string
  status?: string
  urgency?: string
  submitter_name?: string
  submitted_at?: string
  created_by?: string
  assignee_id?: string
  eta?: string
  completed_at?: string
  details?: any
  notes?: string
  photo_urls?: string[]
  repair_notes?: string
  repair_photo_urls?: string[]
  attachment_urls?: string[]
  checklist?: any[]
  consumables?: any[]
  labor_minutes?: number
  labor_cost?: number
  review_status?: string
  review_notes?: string
  reviewed_by?: string
  reviewed_at?: string
  created_at?: string
  updated_at?: string
}

function safeJsonParse(v: any) {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') return v
  const s = String(v || '').trim()
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

function toUploadFileList(urls: string[] | undefined): UploadFile[] {
  return (Array.isArray(urls) ? urls : []).filter(Boolean).map((u, idx) => ({
    uid: `${idx}-${u}`,
    name: String(u).split('/').pop() || `file-${idx + 1}`,
    status: 'done',
    url: u,
  }))
}

function isImageUrl(u: string) {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(u || '')
}

function summaryFromDetails(details: any): string {
  const v = safeJsonParse(details)
  if (!v) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    const parts = v.map((x: any) => String(x?.content || x?.item || x?.desc || '').trim()).filter(Boolean)
    return parts.join('\n')
  }
  return String(v || '')
}

function fmtMinutes(m?: any): string {
  const n = Number(m)
  if (!Number.isFinite(n) || n < 0) return '-'
  const h = Math.floor(n / 60)
  const mm = n % 60
  if (h <= 0) return `${mm} 分钟`
  return `${h} 小时 ${mm} 分钟`
}

export default function DeepCleaningRecordsPage() {
  const { message, modal } = App.useApp()
  const screens = Grid.useBreakpoint()
  const isMobile = !screens.md
  const canWrite = hasPerm('property_deep_cleaning.write')
  const canAudit = hasPerm('property_deep_cleaning.audit') || hasPerm('rbac.manage')

  const [list, setList] = useState<DeepCleaningRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const [props, setProps] = useState<{ id: string; code?: string }[]>([])
  const [userOptions, setUserOptions] = useState<{ value: string; label: string }[]>([])

  const [filterPropertyId, setFilterPropertyId] = useState<string | undefined>(undefined)
  const [filterStatus, setFilterStatus] = useState<string | undefined>(undefined)
  const [filterCat, setFilterCat] = useState<string | undefined>(undefined)
  const [filterKeyword, setFilterKeyword] = useState('')
  const [dateRange, setDateRange] = useState<[any, any] | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<DeepCleaningRecord | null>(null)
  const [viewing, setViewing] = useState<DeepCleaningRecord | null>(null)

  const [createForm] = Form.useForm()
  const [editForm] = Form.useForm()

  const [createBeforeFiles, setCreateBeforeFiles] = useState<UploadFile[]>([])
  const [createAttachFiles, setCreateAttachFiles] = useState<UploadFile[]>([])
  const [editBeforeFiles, setEditBeforeFiles] = useState<UploadFile[]>([])
  const [editAfterFiles, setEditAfterFiles] = useState<UploadFile[]>([])
  const [editAttachFiles, setEditAttachFiles] = useState<UploadFile[]>([])

  const abortRef = useRef<AbortController | null>(null)

  const statusOptions = [
    { value: 'pending', label: '待清洁' },
    { value: 'assigned', label: '已分配' },
    { value: 'in_progress', label: '清洁中' },
    { value: 'completed', label: '待审核' },
    { value: 'canceled', label: '已取消' },
  ]
  const catOptions = ['入户走廊','客厅','厨房','卧室','阳台','浴室','全屋','其他'].map(x => ({ value: x, label: x }))
  const urgencyOptions = [
    { value: 'low', label: '低' },
    { value: 'normal', label: '中' },
    { value: 'high', label: '高' },
  ]
  const reviewOptions = [
    { value: 'pending', label: '待审核' },
    { value: 'approved', label: '已通过' },
    { value: 'rejected', label: '已驳回' },
  ]

  function statusTag(s?: string) {
    const v = String(s || '')
    const label = statusOptions.find(x => x.value === v)?.label || v || '-'
    if (v === 'pending') return <Tag color="default">{label}</Tag>
    if (v === 'assigned') return <Tag color="blue">{label}</Tag>
    if (v === 'in_progress') return <Tag color="orange">{label}</Tag>
    if (v === 'completed') return <Tag color="purple">{label}</Tag>
    if (v === 'canceled') return <Tag color="red">{label}</Tag>
    return <Tag>{label}</Tag>
  }
  function reviewTag(s?: string) {
    const v = String(s || '')
    const label = reviewOptions.find(x => x.value === v)?.label || v || '-'
    if (v === 'pending') return <Tag color="default">{label}</Tag>
    if (v === 'approved') return <Tag color="green">{label}</Tag>
    if (v === 'rejected') return <Tag color="red">{label}</Tag>
    return <Tag>{label}</Tag>
  }

  const propOptions = useMemo(() => sortProperties(props).map(p => ({ value: p.id, label: p.code || p.id })), [props])
  const userLabelMap = useMemo(() => Object.fromEntries(userOptions.map(x => [x.value, x.label])), [userOptions])

  async function uploadFile(file: File) {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`${API_BASE}/deep-cleaning/upload`, { method: 'POST', headers: authHeaders(), body: fd })
    if (!res.ok) {
      const j = await res.json().catch(()=>null)
      throw new Error(j?.message || `HTTP ${res.status}`)
    }
    const j = await res.json().catch(()=>null)
    const url = String(j?.url || '')
    if (!url) throw new Error('upload failed')
    return url
  }

  const makeUploadProps = (setFiles: (v: UploadFile[])=>void): UploadProps => ({
    multiple: true,
    accept: 'image/*,video/*',
    customRequest: async (options) => {
      const { file, onSuccess, onError } = options as any
      try {
        const url = await uploadFile(file as File)
        onSuccess?.({ url }, file)
      } catch (e: any) {
        onError?.(e)
      }
    },
    onChange: (info) => {
      const next = (info.fileList || []).map(f => {
        const r: any = (f as any).response
        if (r?.url) return { ...f, url: r.url, status: 'done' as any }
        return f
      })
      setFiles(next)
    },
  })

  async function loadProps() {
    try {
      const ps = await getJSON<any[]>('/properties').catch(()=>[])
      setProps(Array.isArray(ps) ? ps : [])
    } catch { setProps([]) }
  }
  async function loadUsers() {
    try {
      const users = await getJSON<any[]>('/rbac/users').catch(()=>[])
      const opts = (Array.isArray(users) ? users : []).map(u => ({ value: String(u?.id || ''), label: String(u?.username || u?.name || u?.id || '') })).filter(x => x.value && x.label)
      setUserOptions(opts)
    } catch { setUserOptions([]) }
  }
  async function loadList(reset?: boolean) {
    const showLoading = !list?.length
    if (showLoading) setLoading(true)
    try {
      try { abortRef.current?.abort() } catch {}
      const controller = new AbortController()
      abortRef.current = controller
      const params: Record<string, any> = {
        withTotal: '1',
        limit: String(pageSize),
        offset: String(Math.max(0, (page - 1) * pageSize)),
      }
      if (filterPropertyId) params.property_id = filterPropertyId
      if (filterStatus) params.status = filterStatus
      if (filterCat) params.category = filterCat
      if (dateRange?.[0]) params.submitted_at_from = dayjs(dateRange[0]).startOf('day').toISOString()
      if (dateRange?.[1]) params.submitted_at_to = dayjs(dateRange[1]).endOf('day').toISOString()
      if (filterKeyword.trim()) params.q = filterKeyword.trim()
      const qs = new URLSearchParams(params as any).toString()
      const res = await fetch(`${API_BASE}/crud/property_deep_cleaning?${qs}`, { cache: 'no-store', headers: authHeaders(), signal: controller.signal })
      if (res.status === 401) { window.location.href = '/login'; return }
      const data = await res.json().catch(()=>[])
      const items = Array.isArray(data) ? data : []
      const tot = Number(res.headers.get('x-total-count') || 0)
      if (Number.isFinite(tot) && tot >= 0) setTotal(tot)
      setList(items)
      if (reset) setPage(1)
    } catch {
      setList([])
      setTotal(0)
    } finally {
      if (showLoading) setLoading(false)
    }
  }

  useEffect(() => { loadProps(); loadUsers(); loadList(true) }, [])
  useEffect(() => {
    const t = setTimeout(() => { setPage(1); loadList(true) }, 250)
    return () => clearTimeout(t)
  }, [filterPropertyId, filterStatus, filterCat, filterKeyword, dateRange, pageSize])
  useEffect(() => { loadList(false) }, [page])

  const rows = useMemo(() => {
    const byId: Record<string, any> = Object.fromEntries((props || []).map(p => [String(p.id), p]))
    return (list || []).map(r => {
      const p = byId[String(r.property_id || '')]
      const code = p?.code || r.code || r.property_code || r.property_id || ''
      return { ...r, code }
    })
  }, [list, props])

  function openCreate() {
    createForm.resetFields()
    setCreateBeforeFiles([])
    setCreateAttachFiles([])
    createForm.setFieldsValue({
      status: 'pending',
      urgency: 'normal',
      occurred_at: dayjs(),
      checklist: [{ item: '全屋表面除尘', done: false }, { item: '厨房油污清洁', done: false }, { item: '浴室除垢消毒', done: false }],
      consumables: [],
      labor_minutes: undefined,
      labor_cost: undefined,
      review_status: 'pending',
    })
    setCreateOpen(true)
  }

  async function createSubmit() {
    const v = await createForm.validateFields()
    const beforeUrls = (createBeforeFiles || []).map(f => String((f as any).url || (f as any).response?.url || '')).filter(Boolean)
    const attachUrls = (createAttachFiles || []).map(f => String((f as any).url || (f as any).response?.url || '')).filter(Boolean)
    const payload: any = {
      property_id: v.property_id,
      occurred_at: v.occurred_at ? dayjs(v.occurred_at).format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
      category: v.category,
      status: v.status || 'pending',
      urgency: v.urgency || 'normal',
      assignee_id: v.assignee_id || '',
      eta: v.eta ? dayjs(v.eta).format('YYYY-MM-DD') : null,
      details: v.details ? String(v.details) : '[]',
      notes: v.notes ? String(v.notes) : '',
      photo_urls: beforeUrls,
      attachment_urls: attachUrls,
      checklist: Array.isArray(v.checklist) ? v.checklist : [],
      consumables: Array.isArray(v.consumables) ? v.consumables : [],
      labor_minutes: v.labor_minutes !== undefined ? Number(v.labor_minutes) : undefined,
      labor_cost: v.labor_cost !== undefined ? Number(v.labor_cost) : undefined,
      review_status: 'pending',
    }
    try {
      await apiCreate('property_deep_cleaning', payload)
      message.success('已新增清洁记录')
      setCreateOpen(false)
      loadList(true)
    } catch (e: any) {
      message.error(e?.message || '新增失败')
    }
  }

  function openEdit(r: DeepCleaningRecord) {
    setEditing(r)
    const checklist = safeJsonParse(r.checklist) || []
    const consumables = safeJsonParse(r.consumables) || []
    editForm.setFieldsValue({
      status: r.status || 'pending',
      urgency: r.urgency || 'normal',
      assignee_id: r.assignee_id || '',
      eta: r.eta ? dayjs(r.eta) : null,
      completed_at: r.completed_at ? dayjs(r.completed_at) : null,
      category: r.category || '',
      details: typeof r.details === 'string' ? r.details : (r.details ? JSON.stringify(r.details) : ''),
      notes: r.notes || '',
      repair_notes: r.repair_notes || '',
      checklist,
      consumables,
      labor_minutes: (r as any).labor_minutes !== undefined ? Number((r as any).labor_minutes || 0) : undefined,
      labor_cost: (r as any).labor_cost !== undefined ? Number((r as any).labor_cost || 0) : undefined,
      review_status: r.review_status || 'pending',
      review_notes: r.review_notes || '',
    })
    setEditBeforeFiles(toUploadFileList(r.photo_urls))
    setEditAfterFiles(toUploadFileList(r.repair_photo_urls))
    setEditAttachFiles(toUploadFileList(r.attachment_urls))
  }

  async function saveEdit() {
    if (!editing) return
    try {
      const v = (canWrite || canAudit) ? await editForm.validateFields() : await editForm.validateFields()
      const reviewPayload: any = {}
      if (canAudit) {
        reviewPayload.review_status = v.review_status || 'pending'
        reviewPayload.review_notes = v.review_notes || ''
      }

      if (canWrite) {
        const beforeUrls = (editBeforeFiles || []).map(f => String((f as any).url || (f as any).response?.url || '')).filter(Boolean)
        const afterUrls = (editAfterFiles || []).map(f => String((f as any).url || (f as any).response?.url || '')).filter(Boolean)
        const attachUrls = (editAttachFiles || []).map(f => String((f as any).url || (f as any).response?.url || '')).filter(Boolean)
        const payload: any = {
          status: v.status,
          urgency: v.urgency,
          assignee_id: v.assignee_id || '',
          eta: v.eta ? dayjs(v.eta).format('YYYY-MM-DD') : null,
          completed_at: v.completed_at ? dayjs(v.completed_at).toISOString() : null,
          category: v.category || '',
          details: v.details ? String(v.details) : '[]',
          notes: v.notes ? String(v.notes) : '',
          repair_notes: v.repair_notes ? String(v.repair_notes) : '',
          photo_urls: beforeUrls,
          repair_photo_urls: afterUrls,
          attachment_urls: attachUrls,
          checklist: Array.isArray(v.checklist) ? v.checklist : [],
          consumables: Array.isArray(v.consumables) ? v.consumables : [],
          labor_minutes: v.labor_minutes !== undefined ? Number(v.labor_minutes) : null,
          labor_cost: v.labor_cost !== undefined ? Number(v.labor_cost) : null,
        }
        await apiUpdate('property_deep_cleaning', String(editing.id), { ...payload })
      }

      if (canAudit) {
        const nextStatus = String(reviewPayload.review_status || 'pending')
        const nextNotes = String(reviewPayload.review_notes || '')
        const prevStatus = String(editing.review_status || 'pending')
        const prevNotes = String(editing.review_notes || '')
        const changed = nextStatus !== prevStatus || nextNotes !== prevNotes
        if (changed) {
          const res = await fetch(`${API_BASE}/deep-cleaning/review/${String(editing.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify(reviewPayload),
          })
          if (!res.ok) {
            const j = await res.json().catch(() => null)
            throw new Error(j?.message || `HTTP ${res.status}`)
          }
          await res.json().catch(() => null)
        }
      }

      message.success('已保存')
      setEditing(null)
      loadList(false)
    } catch (e: any) {
      message.error(e?.message || '保存失败')
    }
  }

  async function remove(id: string) {
    modal.confirm({
      title: '确认删除？',
      content: '删除后不可恢复',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await apiDelete('property_deep_cleaning', String(id))
          message.success('已删除')
          loadList(true)
        } catch (e: any) {
          message.error(e?.message || '删除失败')
        }
      }
    })
  }

  async function shareLink(r: DeepCleaningRecord) {
    try {
      const res = await fetch(`${API_BASE}/deep-cleaning/share-link/${r.id}`, { method: 'POST', headers: authHeaders() })
      const j = await res.json().catch(()=>null)
      if (!res.ok) throw new Error(j?.message || `HTTP ${res.status}`)
      const token = String(j?.token || '')
      if (!token) throw new Error('missing token')
      const origin = typeof window !== 'undefined' ? window.location.origin : ''
      const link = `${origin}/public/deep-cleaning-share/${token}`
      await navigator.clipboard?.writeText(link)
      message.success('已复制分享链接')
    } catch (e: any) {
      message.error(e?.message || '分享失败')
    }
  }

  const columns: any[] = [
    { title:'房号', dataIndex:'code', width: 120, ellipsis: true },
    { title:'工单号', dataIndex:'work_no', width: 160, render: (_: any, r: any) => String((r as any)?.work_no || (r as any)?.id || '') },
    { title:'清洁日期', dataIndex:'occurred_at', width: 120, render:(d:string)=> d ? dayjs(d).format('YYYY-MM-DD') : '-' },
    { title:'清洁人员', dataIndex:'worker_name', width: 140, ellipsis: true, render:(v:string)=> String(v || '-') },
    { title:'提交时间', dataIndex:'submitted_at', width: 160, render:(v:string, r: any)=> (v || (r as any)?.created_at) ? dayjs(v || (r as any)?.created_at).format('YYYY-MM-DD HH:mm') : '-' },
    { title:'区域', dataIndex:'category', width: 120 },
    { title:'状态', dataIndex:'status', width: 120, render:(s:string)=> statusTag(s) },
    { title:'审核', dataIndex:'review_status', width: 120, render:(s:string)=> reviewTag(s) },
    { title:'分配人员', dataIndex:'assignee_id', width: 160, render:(v:string)=> userLabelMap[String(v||'')] || String(v||'-') },
    { title:'操作', width: 320, render: (_:any, r:DeepCleaningRecord) => (
      <Space wrap>
        <Button onClick={()=>setViewing(r)}>详情</Button>
        <Button onClick={()=>shareLink(r)}>分享</Button>
        <Button onClick={()=>openEdit(r)} disabled={!(canWrite || canAudit)}>{canWrite ? '编辑' : '审核'}</Button>
        <Button danger onClick={()=>remove(String(r.id))} disabled={!hasPerm('property_deep_cleaning.delete')}>删除</Button>
      </Space>
    ) },
  ]

  return (
    <Space direction="vertical" style={{ width:'100%' }}>
      <Card title="深度清洁记录" extra={
        <Button type="primary" onClick={openCreate} disabled={!hasPerm('property_deep_cleaning.write')}>新增深度清洁</Button>
      }>
        <Space style={{ width:'100%', marginBottom: 12 }} wrap>
          <Select placeholder="房号" allowClear options={propOptions} value={filterPropertyId} onChange={v=>setFilterPropertyId(v)} style={{ width: isMobile ? '100%' : 180 }} />
          <Select placeholder="状态" allowClear options={statusOptions} value={filterStatus} onChange={v=>setFilterStatus(v)} style={{ width: isMobile ? '100%' : 160 }} />
          <Select placeholder="区域" allowClear options={catOptions} value={filterCat} onChange={v=>setFilterCat(v)} style={{ width: isMobile ? '100%' : 160 }} />
          <DatePicker.RangePicker value={dateRange as any} onChange={v=>setDateRange(v as any)} allowClear style={{ width: isMobile ? '100%' : undefined }} />
          <Input placeholder="关键词（工单/摘要/人员）" value={filterKeyword} onChange={e=>setFilterKeyword(e.target.value)} style={{ width: isMobile ? '100%' : 240 }} />
          <Button onClick={()=>{
            setFilterPropertyId(undefined); setFilterStatus(undefined); setFilterCat(undefined); setFilterKeyword(''); setDateRange(null)
            setPage(1)
            setTimeout(()=>loadList(true), 0)
          }}>重置</Button>
        </Space>
        <div style={{ width:'100%', overflowX:'auto' }}>
          <Table
            rowKey={r=>String((r as any).id)}
            dataSource={rows}
            loading={loading}
            pagination={{
              current: page,
              pageSize,
              total,
              showSizeChanger: true,
              onChange: (p, ps) => { setPage(p); setPageSize(ps) }
            }}
            scroll={{ x: 1200 }}
            columns={columns as any}
          />
        </div>
      </Card>

      <Modal open={createOpen} onCancel={()=>setCreateOpen(false)} onOk={createSubmit} title="新增深度清洁" okText="保存" width={isMobile ? '100%' : 780}>
        <Form form={createForm} layout="vertical">
          <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
            <Form.Item name="property_id" label="房号" rules={[{ required: true, message:'请选择房号' }]}>
              <Select options={propOptions} showSearch optionFilterProp="label" />
            </Form.Item>
            <Form.Item name="occurred_at" label="清洁日期" rules={[{ required: true, message:'请选择日期' }]}>
              <DatePicker style={{ width:'100%' }} />
            </Form.Item>
            <Form.Item name="category" label="区域" rules={[{ required: true, message:'请选择区域' }]}>
              <Select options={catOptions} />
            </Form.Item>
            <Form.Item name="urgency" label="紧急程度">
              <Select options={urgencyOptions} />
            </Form.Item>
            <Form.Item name="assignee_id" label="分配人员">
              <Select allowClear options={userOptions} showSearch optionFilterProp="label" />
            </Form.Item>
            <Form.Item name="eta" label="预计完成日期">
              <DatePicker style={{ width:'100%' }} />
            </Form.Item>
          </div>
          <Form.Item name="details" label="清洁摘要（可写清洁重点）">
            <Input.TextArea rows={3} placeholder="例如：厨房重油污、浴室除垢、全屋消毒" />
          </Form.Item>
          <Form.Item name="checklist" label="清洁项目清单">
            <Form.List name="checklist">
              {(fields, { add, remove }) => (
                <Space direction="vertical" style={{ width:'100%' }}>
                  {fields.map(f => (
                    <div key={f.key} style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 110px 1fr 60px', gap: 8, alignItems:'center' }}>
                      <Form.Item name={[f.name, 'item']} rules={[{ required: true, message:'请输入项目' }]} style={{ marginBottom: 0 }}>
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
          <Form.Item label="清洁前材料（图片/视频）">
            <Upload {...makeUploadProps(setCreateBeforeFiles)} fileList={createBeforeFiles} listType="picture">
              <Button>上传</Button>
            </Upload>
          </Form.Item>
          <Form.Item label="附件（图片/视频）">
            <Upload {...makeUploadProps(setCreateAttachFiles)} fileList={createAttachFiles}>
              <Button>上传</Button>
            </Upload>
          </Form.Item>
          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer open={!!editing} onClose={()=>setEditing(null)} title="编辑深度清洁" width={isMobile ? '100%' : 860} extra={
        <Button type="primary" onClick={saveEdit} disabled={!(canWrite || canAudit)}>保存</Button>
      }>
        <Form form={editForm} layout="vertical">
          <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
            <Form.Item name="status" label="状态" rules={[{ required: true }]}>
              <Select options={statusOptions} />
            </Form.Item>
            <Form.Item name="urgency" label="紧急程度">
              <Select options={urgencyOptions} />
            </Form.Item>
            <Form.Item name="assignee_id" label="分配人员">
              <Select allowClear options={userOptions} showSearch optionFilterProp="label" />
            </Form.Item>
            <Form.Item name="eta" label="预计完成日期">
              <DatePicker style={{ width:'100%' }} />
            </Form.Item>
            <Form.Item name="completed_at" label="完成时间">
              <DatePicker showTime style={{ width:'100%' }} />
            </Form.Item>
            <Form.Item name="category" label="区域">
              <Select options={catOptions} />
            </Form.Item>
          </div>
          <Form.Item name="details" label="清洁摘要">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="checklist" label="清洁项目清单">
            <Form.List name="checklist">
              {(fields, { add, remove }) => (
                <Space direction="vertical" style={{ width:'100%' }}>
                  {fields.map(f => (
                    <div key={f.key} style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 110px 1fr 60px', gap: 8, alignItems:'center' }}>
                      <Form.Item name={[f.name, 'item']} rules={[{ required: true, message:'请输入项目' }]} style={{ marginBottom: 0 }}>
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
                <Upload {...makeUploadProps(setEditBeforeFiles)} fileList={editBeforeFiles} listType="picture">
                  <Button>上传</Button>
                </Upload>
              </div>
              <div>
                <div style={{ marginBottom: 6, fontWeight: 600 }}>清洁后（图片/视频）</div>
                <Upload {...makeUploadProps(setEditAfterFiles)} fileList={editAfterFiles} listType="picture">
                  <Button>上传</Button>
                </Upload>
              </div>
              <div>
                <div style={{ marginBottom: 6, fontWeight: 600 }}>附件</div>
                <Upload {...makeUploadProps(setEditAttachFiles)} fileList={editAttachFiles}>
                  <Button>上传</Button>
                </Upload>
              </div>
            </Space>
          </Card>
          <Form.Item name="repair_notes" label="执行说明（完成确认）">
            <Input.TextArea rows={3} placeholder="例如：已完成厨房重油污处理，浴室除垢消毒，已更换耗材…" />
          </Form.Item>
          <Card size="small" title="耗材与工时" style={{ marginBottom: 12 }}>
            <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
              <Form.Item name="labor_minutes" label="工时（分钟）">
                <InputNumber min={0} style={{ width:'100%' }} />
              </Form.Item>
              <Form.Item name="labor_cost" label="人工成本（可选）">
                <InputNumber min={0} style={{ width:'100%' }} />
              </Form.Item>
            </div>
            <Form.Item name="consumables" label="耗材记录">
              <Form.List name="consumables">
                {(fields, { add, remove }) => (
                  <Space direction="vertical" style={{ width:'100%' }}>
                    {fields.map(f => (
                      <div key={f.key} style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 120px 120px 120px 60px', gap: 8, alignItems:'center' }}>
                        <Form.Item name={[f.name, 'name']} rules={[{ required: true, message:'名称必填' }]} style={{ marginBottom: 0 }}>
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
          {canAudit ? (
            <Card size="small" title="结果审核">
              <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
                <Form.Item name="review_status" label="审核结果">
                  <Select options={reviewOptions} />
                </Form.Item>
                <div />
              </div>
              <Form.Item name="review_notes" label="审核备注">
                <Input.TextArea rows={3} />
              </Form.Item>
            </Card>
          ) : null}
        </Form>
      </Drawer>

      <Drawer open={!!viewing} onClose={()=>setViewing(null)} placement="right" width={isMobile ? 420 : 780}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Title level={4} style={{ margin: 0 }}>深度清洁详情</Typography.Title>
          <Typography.Text type="secondary">工单号：{viewing?.work_no || viewing?.id || '-'}</Typography.Text>

          <div style={{ background:'#eef6ff', border:'1px solid #d5e9ff', borderRadius:16, padding:16 }}>
            <Space style={{ marginBottom:12 }}>
              <EnvironmentOutlined style={{ color:'#1677ff' }} />
              <Typography.Text style={{ color:'#1d39c4', fontWeight:600 }}>基本信息</Typography.Text>
            </Space>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
              <div>
                <Typography.Text type="secondary">房号</Typography.Text>
                <div style={{ fontSize:18, fontWeight:700, color:'#0b1738', marginTop:6 }}>{String(viewing?.code || viewing?.property_code || viewing?.property_id || '-')}</div>
              </div>
              <div>
                <Typography.Text type="secondary">状态</Typography.Text>
                <div style={{ marginTop:6 }}>{statusTag(viewing?.status)}</div>
              </div>
              <div>
                <Typography.Text type="secondary">清洁日期</Typography.Text>
                <div style={{ color:'#0b1738', marginTop:6 }}>{viewing?.occurred_at ? dayjs(viewing.occurred_at).format('YYYY-MM-DD') : '-'}</div>
              </div>
              <div>
                <Typography.Text type="secondary">区域</Typography.Text>
                <div style={{ color:'#0b1738', marginTop:6 }}>{String(viewing?.category || '-')}</div>
              </div>
              <div>
                <Typography.Text type="secondary">清洁人员</Typography.Text>
                <div style={{ color:'#0b1738', marginTop:6 }}>{String(viewing?.worker_name || viewing?.submitter_name || viewing?.created_by || '-')}</div>
              </div>
              <div>
                <Typography.Text type="secondary">提交时间</Typography.Text>
                <div style={{ color:'#0b1738', marginTop:6 }}>{(viewing?.submitted_at || viewing?.created_at) ? dayjs(viewing?.submitted_at || viewing?.created_at).format('YYYY-MM-DD HH:mm') : '-'}</div>
              </div>
            </div>
          </div>

          <div style={{ background:'#fff', border:'1px solid #eaeef5', borderRadius:16, padding:16 }}>
            <Space style={{ marginBottom:12 }}>
              <InfoCircleOutlined style={{ color:'#f0a500' }} />
              <Typography.Text style={{ color:'#0b1738', fontWeight:600 }}>清洁项目</Typography.Text>
            </Space>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
              <div style={{ gridColumn:'1 / span 2' }}>
                <Typography.Text type="secondary">项目描述</Typography.Text>
                <div style={{ whiteSpace:'pre-wrap', border:'1px solid #eef2f8', background:'#f7f9fc', padding:12, borderRadius:12, marginTop:6 }}>
                  {String(viewing?.project_desc || summaryFromDetails(viewing?.details) || viewing?.details || '') || '-'}
                </div>
              </div>
              <div>
                <Typography.Text type="secondary">开始时间</Typography.Text>
                <div style={{ color:'#0b1738', marginTop:6 }}>{viewing?.started_at ? dayjs(viewing.started_at).format('HH:mm') : '-'}</div>
              </div>
              <div>
                <Typography.Text type="secondary">结束时间</Typography.Text>
                <div style={{ color:'#0b1738', marginTop:6 }}>{viewing?.ended_at ? dayjs(viewing.ended_at).format('HH:mm') : '-'}</div>
              </div>
              <div>
                <Typography.Text type="secondary">清洁时长</Typography.Text>
                <div style={{ color:'#0b1738', marginTop:6 }}>{fmtMinutes(viewing?.duration_minutes)}</div>
              </div>
              <div>
                <Typography.Text type="secondary">审核</Typography.Text>
                <div style={{ marginTop:6 }}>{reviewTag(viewing?.review_status)}</div>
              </div>
              <div style={{ gridColumn:'1 / span 2' }}>
                <Typography.Text type="secondary">备注</Typography.Text>
                <div style={{ color:'#0b1738', marginTop:6, whiteSpace:'pre-wrap' }}>{String(viewing?.notes || '-')}</div>
              </div>
            </div>
          </div>

          {(Array.isArray(viewing?.photo_urls) && viewing!.photo_urls!.length) ? (
            <div style={{ background:'#fff', border:'1px solid #eaeef5', borderRadius:16, padding:16 }}>
              <Space style={{ marginBottom:12 }}>
                <PictureOutlined style={{ color:'#9254de' }} />
                <Typography.Text style={{ color:'#0b1738', fontWeight:600 }}>清洁前照片</Typography.Text>
              </Space>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:16 }}>
                {(Array.isArray(viewing?.photo_urls) ? viewing!.photo_urls! : []).map((u: string, i: number) => (
                  <div key={i} style={{ border:'1px solid #eaeef5', background:'#f1f6fb', borderRadius:12, padding:8 }}>
                    {isImageUrl(u) ? <Image src={u} width="100%" height={140} style={{ objectFit:'cover', borderRadius:8 }} /> : <a href={u} target="_blank" rel="noreferrer">{u.split('/').pop() || 'file'}</a>}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {(Array.isArray(viewing?.repair_photo_urls) && viewing!.repair_photo_urls!.length) ? (
            <div style={{ background:'#fff', border:'1px solid #eaeef5', borderRadius:16, padding:16 }}>
              <Space style={{ marginBottom:12 }}>
                <CheckCircleOutlined style={{ color:'#52c41a' }} />
                <Typography.Text style={{ color:'#0b1738', fontWeight:600 }}>清洁后照片</Typography.Text>
              </Space>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:16 }}>
                {(Array.isArray(viewing?.repair_photo_urls) ? viewing!.repair_photo_urls! : []).map((u: string, i: number) => (
                  <div key={i} style={{ border:'1px solid #eaeef5', background:'#f1f6fb', borderRadius:12, padding:8 }}>
                    {isImageUrl(u) ? <Image src={u} width="100%" height={140} style={{ objectFit:'cover', borderRadius:8 }} /> : <a href={u} target="_blank" rel="noreferrer">{u.split('/').pop() || 'file'}</a>}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {viewing ? (
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <Button onClick={()=>setViewing(null)}>关闭</Button>
              <Button icon={<ShareAltOutlined />} onClick={()=>shareLink(viewing)}>分享</Button>
            </div>
          ) : null}
        </Space>
      </Drawer>
    </Space>
  )
}
