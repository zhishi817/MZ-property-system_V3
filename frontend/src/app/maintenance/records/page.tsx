"use client"
import { Card, Table, Space, Button, Input, Select, DatePicker, Modal, Form, App, Upload, Grid, Drawer, Image, InputNumber, Switch, Typography, Tag } from 'antd'
import { EnvironmentOutlined, InfoCircleOutlined, DollarCircleOutlined, PictureOutlined, CheckCircleOutlined, ShareAltOutlined } from '@ant-design/icons'
import html2canvas from 'html2canvas'
import { useSearchParams } from 'next/navigation'
import type { UploadFile } from 'antd/es/upload/interface'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { apiUpdate, apiDelete, apiCreate, getJSON, API_BASE, authHeaders } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'
import { sortProperties } from '../../../lib/properties'

type RepairOrder = {
  id: string
  property_id?: string
  category?: string
  category_detail?: string
  detail?: string
  details?: string
  attachment_urls?: string[]
  work_no?: string
  submitter_name?: string
  submitter_id?: string
  submitted_at?: string
  urgency?: 'urgent'|'normal'|'not_urgent'|'high'|'medium'|'low'
  status?: 'pending'|'assigned'|'in_progress'|'completed'|'canceled'
  assignee_id?: string
  eta?: string
  completed_at?: string
  remark?: string
  repair_notes?: string
  repair_photo_urls?: string[]
  photo_urls?: string[]
  maintenance_amount?: number | string | null
  has_parts?: boolean | null
  parts_amount?: number | string | null
  pay_method?: string | null
  pay_other_note?: string | null
}

export default function MaintenanceRecordsUnified() {
  const [list, setList] = useState<RepairOrder[]>([])
  const [props, setProps] = useState<{ id: string; code?: string }[]>([])
  const [filterCode, setFilterCode] = useState('')
  const [filterPropertyId, setFilterPropertyId] = useState<string | undefined>(undefined)
  const [filterWorkNo, setFilterWorkNo] = useState('')
  const [filterSubmitter, setFilterSubmitter] = useState('')
  const [filterKeyword, setFilterKeyword] = useState('')
  const [filterStatus, setFilterStatus] = useState<string | undefined>(undefined)
  const [filterCat, setFilterCat] = useState<string | undefined>(undefined)
  const [dateRange, setDateRange] = useState<[any, any] | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<RepairOrder | null>(null)
  const [form] = Form.useForm()
  const { message } = App.useApp()
  const [pwdOpen, setPwdOpen] = useState(false)
  const [pwdForm] = Form.useForm()
  const [viewOpen, setViewOpen] = useState(false)
  const [viewRow, setViewRow] = useState<RepairOrder | null>(null)
  const [files, setFiles] = useState<UploadFile[]>([])
  const [repairPhotos, setRepairPhotos] = useState<string[]>([])
  const [preFiles, setPreFiles] = useState<UploadFile[]>([])
  const [prePhotos, setPrePhotos] = useState<string[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm] = Form.useForm()
  const [createFiles, setCreateFiles] = useState<UploadFile[]>([])
  const [createPhotos, setCreatePhotos] = useState<string[]>([])
  const [userOptions, setUserOptions] = useState<{ value: string; label: string }[]>([])

  const screens = Grid.useBreakpoint()
  const isMobile = !screens.md
  const searchParams = useSearchParams()
  const captureEnabled = String(searchParams.get('capture') || '') === '1'

  async function loadProperties() {
    try {
      const ps = await getJSON<any[]>('/properties').catch(()=>[])
      setProps(Array.isArray(ps) ? ps : [])
    } catch { setProps([]) }
  }
  async function loadMaintenance(reset?: boolean) {
    setLoading(true)
    try {
      const params: Record<string, any> = {
        withTotal: '1',
        limit: String(pageSize),
        offset: String(Math.max(0, (page - 1) * pageSize)),
      }
      if (filterStatus) params.status = filterStatus
      if (filterCat) params.category = filterCat
      if (filterPropertyId) params.property_id = filterPropertyId
      if (dateRange?.[0]) params.submitted_at_from = dayjs(dateRange[0]).startOf('day').toISOString()
      if (dateRange?.[1]) params.submitted_at_to = dayjs(dateRange[1]).endOf('day').toISOString()
      const q = [filterKeyword, filterWorkNo, filterSubmitter, filterCode].map(s => String(s || '').trim()).filter(Boolean).join(' ')
      if (q) params.q = q
      const qs = new URLSearchParams(params as any).toString()
      const res = await fetch(`${API_BASE}/crud/property_maintenance?${qs}`, { cache: 'no-store', headers: authHeaders() })
      if (res.status === 401) { window.location.href = '/login'; return }
      const data = await res.json().catch(()=>[])
      const items = Array.isArray(data) ? data : []
      const tot = Number(res.headers.get('x-total-count') || 0)
      if (Number.isFinite(tot) && tot >= 0) setTotal(tot)
      if (isMobile) {
        if (reset || page === 1) setList(items)
        else {
          setList(prev => {
            const seen = new Set(prev.map(x => String(x.id)))
            const next = [...prev]
            for (const it of items) {
              if (!seen.has(String(it.id))) next.push(it)
            }
            return next
          })
        }
      } else {
        setList(items)
      }
    } catch {
      if (reset || page === 1 || !isMobile) setList([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { loadProperties() }, [])
  useEffect(() => {
    ;(async () => {
      try {
        const users = await getJSON<any[]>('/rbac/users').catch(()=>[])
        const opts = (Array.isArray(users) ? users : []).map(u => ({ value: String(u?.id || ''), label: String(u?.username || u?.name || u?.id || '') })).filter(x => x.value && x.label)
        setUserOptions(opts)
      } catch { setUserOptions([]) }
    })()
  }, [])
  useEffect(() => {
    const t = setTimeout(() => { setPage(1); loadMaintenance(true) }, 250)
    return () => clearTimeout(t)
  }, [filterCode, filterPropertyId, filterWorkNo, filterSubmitter, filterKeyword, filterStatus, filterCat, dateRange, pageSize])
  useEffect(() => { if (page > 1) loadMaintenance(false) }, [page])

  const rows = useMemo(() => {
    const byId: Record<string, any> = Object.fromEntries(props.map(p => [String(p.id), p]))
    return (list || []).map(r => {
      const p = byId[String(r.property_id || '')]
      const code = p?.code || r.property_id || ''
      return { ...r, code }
    })
  }, [list, props])

  const filtered = rows

  const propOptions = useMemo(() => sortProperties(props).map(p => ({ value: p.id, label: p.code || p.id })), [props])

  function openEdit(row: RepairOrder) {
    setEditing(row)
    form.setFieldsValue({
      status: row.status || 'pending',
      assignee_id: row.assignee_id || '',
      eta: row.eta ? dayjs(row.eta) : null,
      notes: (row as any).notes || (row as any).remark || '',
      urgency: row.urgency || 'normal',
      details: summaryFromDetails(row.details),
      maintenance_amount: (row as any)?.maintenance_amount !== undefined ? Number((row as any)?.maintenance_amount || 0) : undefined,
      has_parts: (row as any)?.has_parts ?? undefined,
      parts_amount: (row as any)?.parts_amount !== undefined ? Number((row as any)?.parts_amount || 0) : undefined,
      pay_method: (row as any)?.pay_method ?? undefined,
      pay_other_note: (row as any)?.pay_other_note ?? undefined,
    })
    const urls: string[] = Array.isArray(row.repair_photo_urls) ? row.repair_photo_urls! : []
    setRepairPhotos(urls)
    setFiles(urls.map((u: string, i: number) => ({ uid: String(i), name: `photo-${i+1}`, status: 'done', url: u } as UploadFile)))
    const preUrls: string[] = Array.isArray((row as any)?.photo_urls) ? (row as any)?.photo_urls! : []
    setPrePhotos(preUrls)
    setPreFiles(preUrls.map((u: string, i: number) => ({ uid: `pre-${i}`, name: `pre-${i+1}`, status: 'done', url: u } as UploadFile)))
    setOpen(true)
  }

  async function save() {
    const v = await form.validateFields()
    const payload: any = {
      status: v.status,
      assignee_id: v.assignee_id || undefined,
      eta: v.eta ? dayjs(v.eta).format('YYYY-MM-DD') : undefined,
      notes: v.notes || undefined,
      urgency: v.urgency || undefined
    }
    if (v.details) {
      try {
        payload.details = JSON.stringify([{ content: String(v.details || '') }])
      } catch {
        payload.details = String(v.details || '')
      }
    }
    const st = String(v.status || '')
    if (st === 'in_progress' || st === 'completed') {
      if (repairPhotos.length) payload.repair_photo_urls = repairPhotos
      if (v.repair_notes) payload.repair_notes = v.repair_notes
    }
    if (prePhotos.length) payload.photo_urls = prePhotos
    if (st === 'completed') {
      payload.completed_at = v.completed_at ? dayjs(v.completed_at).toDate().toISOString() : new Date().toISOString()
      if (v.maintenance_amount !== undefined) payload.maintenance_amount = Number(v.maintenance_amount || 0)
      if (v.has_parts !== undefined) payload.has_parts = !!v.has_parts
      if (v.parts_amount !== undefined) payload.parts_amount = Number(v.parts_amount || 0)
      if (v.pay_method) payload.pay_method = String(v.pay_method)
      if (String(v.pay_method || '') === 'other_pay' && v.pay_other_note) payload.pay_other_note = String(v.pay_other_note)
      if (String(v.pay_method || '') !== 'other_pay') payload.pay_other_note = undefined
    }
    try {
      if (editing) await apiUpdate('property_maintenance', editing.id, payload)
      message.success('已更新记录'); setOpen(false); setEditing(null); setPage(1); loadMaintenance(true)
    } catch (e: any) {
      message.error(e?.message || '保存失败')
    }
  }

  const statusWatch = Form.useWatch('status', form)
  const hasPartsWatch = Form.useWatch('has_parts', form)
  const payMethodWatch = Form.useWatch('pay_method', form)

  const catOptions = ['水电','家具','家电','墙面','其他'].map(x => ({ value: x, label: x }))
  const statusOptions = [
    { value: 'pending', label: '待维修' },
    { value: 'assigned', label: '已分配' },
    { value: 'in_progress', label: '维修中' },
    { value: 'completed', label: '已完成' },
  ]
  function statusLabel(s?: string) {
    const v = String(s || '')
    if (v === 'pending') return '待维修'
    if (v === 'assigned') return '已分配'
    if (v === 'in_progress') return '维修中'
    if (v === 'completed') return '已完成'
    if (v === 'canceled') return '已取消'
    return v || '-'
  }
  function statusTag(s?: string) {
    const v = String(s || '')
    const label = statusLabel(v)
    if (v === 'pending') return <Tag color="default">{label}</Tag>
    if (v === 'assigned') return <Tag color="blue">{label}</Tag>
    if (v === 'in_progress') return <Tag color="orange">{label}</Tag>
    if (v === 'completed') return <Tag color="green">{label}</Tag>
    if (v === 'canceled') return <Tag color="red">{label}</Tag>
    return <Tag>{label}</Tag>
  }

  function urgencyLabel(u?: string) {
    const s = String(u || '')
    if (s === 'urgent') return '紧急'
    if (s === 'normal') return '普通'
    if (s === 'not_urgent') return '不紧急'
    if (s === 'high') return '高'
    if (s === 'medium') return '中'
    if (s === 'low') return '低'
    return '-'
  }
  function urgencyTag(u?: string) {
    const label = urgencyLabel(u)
    if (String(u || '') === 'urgent') {
      return (
        <span style={{ display:'inline-block', padding:'2px 8px', border:'1px solid #ff4d4f', background:'#fff1f0', borderRadius:12, color:'#cf1322', fontSize:12 }}>
          {label}
        </span>
      )
    }
    return <span>{label}</span>
  }
  function fmtAmount(a?: any) {
    if (a === undefined || a === null || a === '') return '-'
    const n = Number(a)
    if (isNaN(n)) return String(a)
    try {
      return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n).replace('A$', '$')
    } catch {
      return `$${n.toFixed(2)}`
    }
  }
  function payMethodLabel(v?: string | null) {
    const s = String(v || '')
    if (!s) return '-'
    if (s === 'rent_deduction') return '租金扣除'
    if (s === 'tenant_pay') return '房客支付'
    if (s === 'company_pay') return '公司承担'
    if (s === 'landlord_pay') return '房东支付'
    if (s === 'other_pay') return '其他人支付'
    return s
  }
  function summaryFromDetails(details?: string) {
    const s = String(details || '')
    if (!s) return ''
    try {
      const arr = JSON.parse(s)
      if (Array.isArray(arr) && arr[0] && typeof arr[0].content === 'string') return arr[0].content
    } catch {}
    return s
  }
  function openView(r: RepairOrder) { setViewRow(r); setViewOpen(true) }
  async function shareLink(r: RepairOrder) {
    try {
      const res = await fetch(`${API_BASE}/maintenance/share-link/${r.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() } })
      const j = await res.json().catch(()=>null)
      if (!res.ok) { message.error(j?.message || '生成分享链接失败'); return }
      const origin = typeof window !== 'undefined' ? window.location.origin : ''
      const link = `${origin}/public/maintenance-share/${String(j?.token || '')}`
      try { await navigator.clipboard?.writeText(link) } catch {}
      message.success('已复制分享链接')
    } catch (e: any) {
      message.error('生成分享链接失败')
    }
  }
  async function remove(id: string) {
    try {
      await apiDelete('property_maintenance', id)
      message.success('已删除'); setPage(1); loadMaintenance(true)
    } catch (e: any) { message.error(e?.message || '删除失败') }
  }
  async function fetchAllForExport() {
    const all: any[] = []
    const limit = 500
    let offset = 0
    for (;;) {
      const params: Record<string, any> = { limit: String(limit), offset: String(offset) }
      if (filterStatus) params.status = filterStatus
      if (filterCat) params.category = filterCat
      if (filterPropertyId) params.property_id = filterPropertyId
      if (dateRange?.[0]) params.submitted_at_from = dayjs(dateRange[0]).startOf('day').toISOString()
      if (dateRange?.[1]) params.submitted_at_to = dayjs(dateRange[1]).endOf('day').toISOString()
      const q = [filterKeyword, filterWorkNo, filterSubmitter, filterCode].map(s => String(s || '').trim()).filter(Boolean).join(' ')
      if (q) params.q = q
      const qs = new URLSearchParams(params as any).toString()
      const res = await fetch(`${API_BASE}/crud/property_maintenance?${qs}`, { cache: 'no-store', headers: authHeaders() })
      if (res.status === 401) { window.location.href = '/login'; return [] }
      const data = await res.json().catch(()=>[])
      const items = Array.isArray(data) ? data : []
      if (!items.length) break
      all.push(...items)
      offset += items.length
      if (items.length < limit) break
      if (all.length > 20000) break
    }
    return all
  }
  function downloadBlob(filename: string, blob: Blob) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }
  async function exportExcel() {
    const key = 'export'
    message.loading({ content: '正在导出...', key, duration: 0 })
    try {
      const data = await fetchAllForExport()
      const byId: Record<string, any> = Object.fromEntries(props.map(p => [String(p.id), p]))
      const header = ['房号','工单号','状态','紧急程度','问题区域','问题摘要','提交人','提交时间','维修金额(AUD)','是否有配件费','配件费(AUD)','扣款方式','其他人备注']
      const rows = data.map(r => {
        const p = byId[String(r.property_id || '')]
        const code = p?.code || r.property_id || ''
        const summary = summaryFromDetails((r as any).details)
        return [
          code,
          String((r as any).work_no || ''),
          statusLabel((r as any).status),
          urgencyLabel((r as any).urgency),
          String((r as any).category || ''),
          String(summary || ''),
          String((r as any).submitter_name || ''),
          (r as any).submitted_at ? dayjs((r as any).submitted_at).format('YYYY-MM-DD HH:mm') : '',
          String((r as any).maintenance_amount ?? ''),
          (r as any).has_parts === true ? '是' : (r as any).has_parts === false ? '否' : '',
          String((r as any).parts_amount ?? ''),
          payMethodLabel((r as any).pay_method),
          String((r as any).pay_other_note || ''),
        ]
      })
      const csv = [header, ...rows].map(line => line.map(v => {
        const s = String(v ?? '')
        const escaped = s.replace(/"/g, '""')
        return `"${escaped}"`
      }).join(',')).join('\n')
      const bom = '\uFEFF'
      downloadBlob(`维修记录导出-${dayjs().format('YYYYMMDD-HHmm')}.csv`, new Blob([bom + csv], { type: 'text/csv;charset=utf-8' }))
      message.success({ content: '已导出（Excel 可直接打开 CSV）', key })
    } catch (e: any) {
      message.error({ content: e?.message || '导出失败', key })
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card title="维修记录">
        <Space style={{ marginBottom: 12, width: '100%' }} wrap>
          <Select placeholder="房号（精确）" allowClear options={propOptions} value={filterPropertyId} onChange={v=>setFilterPropertyId(v)} style={{ width: isMobile ? '100%' : 180 }} />
          <Input placeholder="按房号模糊搜索" value={filterCode} onChange={e=>setFilterCode(e.target.value)} style={{ width: isMobile ? '100%' : 180 }} />
          <Input placeholder="按工单号搜索" value={filterWorkNo} onChange={e=>setFilterWorkNo(e.target.value)} style={{ width: isMobile ? '100%' : 180 }} />
          <Input placeholder="按提交人搜索" value={filterSubmitter} onChange={e=>setFilterSubmitter(e.target.value)} style={{ width: isMobile ? '100%' : 180 }} />
          <Input placeholder="关键词搜索（区域/摘要/人员等）" value={filterKeyword} onChange={e=>setFilterKeyword(e.target.value)} style={{ width: isMobile ? '100%' : 240 }} />
          <Select placeholder="按分类" allowClear options={catOptions} value={filterCat} onChange={v=>setFilterCat(v)} style={{ width: isMobile ? '100%' : 160 }} />
          <Select placeholder="按状态" allowClear options={statusOptions} value={filterStatus} onChange={v=>setFilterStatus(v)} style={{ width: isMobile ? '100%' : 160 }} />
          <DatePicker.RangePicker
            value={dateRange as any}
            onChange={v=>setDateRange(v as any)}
            style={{ width: isMobile ? '100%' : undefined }}
            allowClear
            presets={[
              { label: '近7天', value: [dayjs().add(-6, 'day'), dayjs()] as any },
              { label: '近30天', value: [dayjs().add(-29, 'day'), dayjs()] as any },
            ] as any}
          />
          <Button onClick={()=>{ setPage(1); loadMaintenance(true) }} loading={loading}>搜索</Button>
          <Button onClick={()=>{
            setFilterPropertyId(undefined)
            setFilterCode('')
            setFilterWorkNo('')
            setFilterSubmitter('')
            setFilterKeyword('')
            setFilterStatus(undefined)
            setFilterCat(undefined)
            setDateRange(null)
            setPage(1)
            loadMaintenance(true)
          }}>重置</Button>
          <Button onClick={exportExcel}>导出Excel</Button>
          <Button type="primary" onClick={() => setCreateOpen(true)} style={{ marginLeft: isMobile ? 0 : 'auto', width: isMobile ? '100%' : undefined }}>新增维修记录</Button>
          {captureEnabled ? (
            <Button onClick={async ()=>{
              const el = document.querySelector('[data-page-root="maintenance-records"]') as HTMLElement
              const target = el || document.body
              const canvas = await html2canvas(target, { scale: 2 })
              const url = canvas.toDataURL('image/png')
              const a = document.createElement('a')
              a.href = url
              a.download = `maintenance-records-${window.innerWidth}.png`
              a.click()
            }} style={{ width: isMobile ? '100%' : undefined }}>导出截图</Button>
          ) : null}
        </Space>
        <div data-export-root="maintenance-records">
          {(() => {
            if (isMobile) {
              return (
                <Space direction="vertical" style={{ width: '100%' }} data-page-root="maintenance-records">
                  {filtered.map(r => (
                    <Card size="small" key={r.id} style={{ borderRadius: 12 }}>
                      <Space direction="vertical" style={{ width: '100%' }}>
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 8 }}>
                          <div>房号：{String((r as any).code || r.property_id || '')}</div>
                          <div>工单号：{String((r as any).work_no || '') || '-'}</div>
                          <div>状态：{statusTag(r.status)}</div>
                          <div>紧急：{urgencyTag(r.urgency)}</div>
                          <div>问题区域：{String(r.category || '-')}</div>
                          <div>提交人：{String(r.submitter_name || '-')}</div>
                          <div style={{ gridColumn:'1 / span 2' }}>提交时间：{r.submitted_at ? dayjs(r.submitted_at).format('YYYY-MM-DD HH:mm') : '-'}</div>
                          <div style={{ gridColumn:'1 / span 2' }}>问题摘要：{summaryFromDetails(r.details)}</div>
                          <div>维修金额：{fmtAmount((r as any).maintenance_amount)}</div>
                          <div>是否有配件费：{(r as any).has_parts === true ? '是' : (r as any).has_parts === false ? '否' : '-'}</div>
                          <div>配件费：{fmtAmount((r as any).parts_amount)}</div>
                          <div>扣款方式：{payMethodLabel((r as any).pay_method)}</div>
                          {(r as any).pay_method === 'other_pay' ? (
                            <div style={{ gridColumn:'1 / span 2' }}>其他人备注：{String((r as any).pay_other_note || '-')}</div>
                          ) : null}
                        </div>
                        <Space style={{ width:'100%' }}>
                          <Button size="large" style={{ flex:1 }} onClick={()=>openView(r)}>查看</Button>
                          <Button size="large" style={{ flex:1 }} onClick={()=>shareLink(r)} icon={<ShareAltOutlined />}>分享</Button>
                          <Button size="large" style={{ flex:1 }} onClick={()=>openEdit(r)} disabled={!hasPerm('property_maintenance.write')}>编辑</Button>
                          <Button size="large" style={{ flex:1 }} danger onClick={()=>remove(r.id)} disabled={!hasPerm('property_maintenance.delete')}>删除</Button>
                        </Space>
                      </Space>
                    </Card>
                  ))}
                  {list.length < total ? (
                    <Button block loading={loading} onClick={()=>setPage(p=>p+1)}>加载更多</Button>
                  ) : null}
                </Space>
              )
            }
            const columns = [
              { title:'房号', dataIndex:'code', width: 120 },
              { title:'工单号', dataIndex:'work_no', width: 160 },
              { title:'紧急程度', dataIndex:'urgency', width: 120, render:(u:string)=> urgencyTag(u) },
              { title:'问题区域', dataIndex:'category', width: 120 },
              { title:'问题摘要', dataIndex:'details', ellipsis: true, width: 280, render:(d:string)=> summaryFromDetails(d) },
              { title:'提交人', dataIndex:'submitter_name', width: 120 },
              { title:'提交时间', dataIndex:'submitted_at', width: 180, render:(d:string)=> d ? dayjs(d).format('YYYY-MM-DD HH:mm') : '-' },
              { title:'维修金额', dataIndex:'maintenance_amount', width: 140, render:(a:any)=> fmtAmount(a) },
              { title:'是否有配件费', dataIndex:'has_parts', width: 120, render:(b:boolean)=> b === true ? '是' : b === false ? '否' : '-' },
              { title:'配件费金额', dataIndex:'parts_amount', width: 140, render:(a:any)=> fmtAmount(a) },
              { title:'扣款方式', dataIndex:'pay_method', width: 140, render:(v:string)=> payMethodLabel(v) },
              { title:'其他人备注', dataIndex:'pay_other_note', width: 160 },
              { title:'状态', dataIndex:'status', width: 120, render:(s:string)=> statusTag(s) },
              { title:'完成时间', dataIndex:'completed_at', width: 180, render:(d:string)=> d ? dayjs(d).format('YYYY-MM-DD HH:mm') : '-' },
              { title:'分配人员', dataIndex:'assignee_id', width: 140 },
              { title:'操作', fixed: 'right' as const, width: 280, render: (_:any, r:RepairOrder) => (
                <Space>
                  <Button size="small" onClick={()=>openView(r)}>查看</Button>
                  <Button size="small" icon={<ShareAltOutlined />} onClick={()=>shareLink(r)}>分享</Button>
                  <Button size="small" onClick={()=>openEdit(r)} disabled={!hasPerm('property_maintenance.write')}>编辑</Button>
                  <Button size="small" danger onClick={()=>remove(r.id)} disabled={!hasPerm('property_maintenance.delete')}>删除</Button>
                </Space>
              ) },
            ]
            return (
              <div style={{ width:'100%', overflowX:'auto' }}>
                <Table
                  rowKey={r=>r.id}
                  dataSource={filtered}
                  loading={loading}
                  pagination={{
                    current: page,
                    pageSize,
                    total,
                    showSizeChanger: true,
                    onChange: (p, ps) => {
                      if (ps !== pageSize) { setPageSize(ps); setPage(1) } else { setPage(p) }
                    }
                  }}
                  scroll={{ x: 2200 }}
                  columns={columns as any}
                />
              </div>
            )
          })()}
        </div>
      </Card>
      <Drawer open={viewOpen} onClose={()=>setViewOpen(false)} placement="right" width={isMobile ? 420 : 720}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Title level={4} style={{ margin: 0 }}>维修详情</Typography.Title>
          <Typography.Text type="secondary">工单编号：{(viewRow as any)?.work_no || viewRow?.id}</Typography.Text>
          <div style={{ background:'#eef6ff', border:'1px solid #d5e9ff', borderRadius:16, padding:16 }}>
            <Space style={{ marginBottom:12 }}>
              <EnvironmentOutlined style={{ color:'#1677ff' }} />
              <Typography.Text style={{ color:'#1d39c4', fontWeight:600 }}>基本信息</Typography.Text>
            </Space>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
              <div>
                <Typography.Text type="secondary">房号</Typography.Text>
                <div style={{ fontSize:18, fontWeight:700, color:'#0b1738', marginTop:6 }}>{String((viewRow as any)?.code || viewRow?.property_id || '-')}</div>
              </div>
              <div>
                <Typography.Text type="secondary">紧急程度</Typography.Text>
                <div style={{ marginTop:6 }}>{urgencyTag(viewRow?.urgency)}</div>
              </div>
              <div>
                <Typography.Text type="secondary">问题区域</Typography.Text>
                <div style={{ color:'#0b1738', marginTop:6 }}>{String(viewRow?.category || '-')}</div>
              </div>
              <div>
                <Typography.Text type="secondary">提交人</Typography.Text>
                <div style={{ color:'#0b1738', marginTop:6 }}>{String(viewRow?.submitter_name || '-')}</div>
              </div>
              <div style={{ gridColumn:'1 / span 2' }}>
                <Space>
                  <InfoCircleOutlined style={{ color:'#1677ff' }} />
                  <Typography.Text type="secondary">提交时间</Typography.Text>
                </Space>
                <div style={{ color:'#0b1738', marginTop:6 }}>{viewRow?.submitted_at ? dayjs(viewRow?.submitted_at).format('YYYY-MM-DD HH:mm') : '-'}</div>
              </div>
            </div>
          </div>
          <div style={{ background:'#fff', border:'1px solid #eaeef5', borderRadius:16, padding:16 }}>
            <Space style={{ marginBottom:12 }}>
              <InfoCircleOutlined style={{ color:'#f0a500' }} />
              <Typography.Text style={{ color:'#0b1738', fontWeight:600 }}>问题详情</Typography.Text>
            </Space>
            <div style={{ whiteSpace:'pre-wrap', border:'1px solid #eef2f8', background:'#f7f9fc', padding:12, borderRadius:12 }}>
              {summaryFromDetails(viewRow?.details) || viewRow?.detail || ''}
            </div>
          </div>
          <div style={{ background:'#fff', border:'1px solid #eaeef5', borderRadius:16, padding:16 }}>
            <Space style={{ marginBottom:12 }}>
              <DollarCircleOutlined style={{ color:'#16c784' }} />
              <Typography.Text style={{ color:'#0b1738', fontWeight:600 }}>费用信息</Typography.Text>
            </Space>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, alignItems:'end' }}>
              <div>
                <Typography.Text type="secondary">维修金额</Typography.Text>
                <div style={{ fontSize:22, fontWeight:700, color:'#1677ff', marginTop:6 }}>{fmtAmount((viewRow as any)?.maintenance_amount)}</div>
              </div>
              <div>
                <Typography.Text type="secondary">配件费</Typography.Text>
                <div style={{ fontSize:22, fontWeight:700, color:'#1677ff', marginTop:6 }}>{fmtAmount((viewRow as any)?.parts_amount)}</div>
              </div>
              <div>
                <Typography.Text type="secondary" style={{ display:'block' }}>是否有配件费</Typography.Text>
                <div style={{ display:'inline-flex', alignItems:'center', gap:6, background:'#f0fff4', border:'1px solid #b7eb8f', borderRadius:20, padding:'2px 10px', marginTop:6, width:'fit-content' }}>
                  <CheckCircleOutlined style={{ color:'#52c41a' }} />
                  <span style={{ color:'#1677ff' }}>{(viewRow as any)?.has_parts === true ? '是' : (viewRow as any)?.has_parts === false ? '否' : '-'}</span>
                </div>
              </div>
              <div>
                <Typography.Text type="secondary">扣款方式</Typography.Text>
                <div style={{ color:'#0b1738', marginTop:6 }}>{payMethodLabel((viewRow as any)?.pay_method)}</div>
              </div>
            </div>
            {String((viewRow as any)?.pay_method || '') === 'other_pay' ? (
              <div style={{ marginTop:12 }}>
                <Typography.Text type="secondary">其他人备注</Typography.Text>
                <div style={{ color:'#0b1738' }}>{String((viewRow as any)?.pay_other_note || '-')}</div>
              </div>
            ) : null}
          </div>
          <div style={{ background:'#fff', border:'1px solid #eaeef5', borderRadius:16, padding:16 }}>
            <Space style={{ marginBottom:12 }}>
              <PictureOutlined style={{ color:'#9254de' }} />
              <Typography.Text style={{ color:'#0b1738', fontWeight:600 }}>维修前照片</Typography.Text>
            </Space>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:16 }}>
              {(Array.isArray((viewRow as any)?.photo_urls) ? (viewRow as any)!.photo_urls! : []).map((u: string, i: number) => (
                <div key={i} aria-label={`维修前照片 ${i+1}`} style={{ border:'1px solid #eaeef5', background:'#f1f6fb', borderRadius:12, padding:8 }}>
                  <Image src={u} width="100%" height={140} style={{ objectFit:'cover', borderRadius:8 }} />
                </div>
              ))}
            </div>
          </div>
          <div style={{ background:'#fff', border:'1px solid #eaeef5', borderRadius:16, padding:16 }}>
            <Space style={{ marginBottom:12 }}>
              <CheckCircleOutlined style={{ color:'#52c41a' }} />
              <Typography.Text style={{ color:'#0b1738', fontWeight:600 }}>维修后照片</Typography.Text>
            </Space>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:16 }}>
              {(Array.isArray(viewRow?.repair_photo_urls) ? viewRow!.repair_photo_urls! : []).map((u, i) => (
                <div key={i} aria-label={`维修后照片 ${i+1}`} style={{ border:'1px solid #eaeef5', background:'#f1f6fb', borderRadius:12, padding:8 }}>
                  <Image src={u} width="100%" height={140} style={{ objectFit:'cover', borderRadius:8 }} />
                </div>
              ))}
            </div>
          </div>
        </Space>
      </Drawer>
      <Modal open={pwdOpen} onCancel={()=>setPwdOpen(false)} onOk={async ()=>{
        const v = await pwdForm.validateFields()
        const pass = String(v.new_password || '')
        try {
          const res = await fetch(`${API_BASE}/public/cleaning-guide/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ new_password: pass })
          })
          if (res.ok) { message.success('已更新上报密码'); setPwdOpen(false); pwdForm.resetFields() } else {
            const j = await res.json().catch(()=>null); message.error(j?.message || '更新失败')
          }
        } catch (e: any) { message.error('更新失败') }
      }} title="设置房源报修表密码" okText="保存">
        <Form form={pwdForm} layout="vertical">
          <Form.Item
            name="new_password"
            label="新密码（4-6位数字）"
            rules={[
              { required: true, message: '请输入密码' },
              { validator: (_, val) => {
                const s = String(val || '')
                if (s.length < 4 || s.length > 6) return Promise.reject(new Error('长度需为4-6位'))
                if (!/^\d+$/.test(s)) return Promise.reject(new Error('仅允许数字'))
                return Promise.resolve()
              } }
            ]}
          >
            <Input placeholder="例如 1234" maxLength={6} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal open={createOpen} onCancel={()=>{ setCreateOpen(false); createForm.resetFields(); setCreateFiles([]); setCreatePhotos([]) }} onOk={async ()=>{
        const v = await createForm.validateFields()
        const payload: any = {
          property_id: v.property_id,
          category: v.category,
          status: 'pending',
          submitted_at: new Date().toISOString(),
        }
        if (v.details) {
          try { payload.details = JSON.stringify([{ content: String(v.details || '') }]) } catch { payload.details = String(v.details || '') }
        }
        if (v.submitter_name) payload.submitter_name = v.submitter_name
        if (createPhotos.length) payload.photo_urls = createPhotos
        try {
          await apiCreate('property_maintenance', payload)
          message.success('已新增维修记录')
          setCreateOpen(false); createForm.resetFields(); setCreateFiles([]); setCreatePhotos([])
          setPage(1); loadMaintenance(true)
        } catch (e: any) { message.error(e?.message || '新增失败') }
      }} title="新增维修记录" okText="保存">
        <Form form={createForm} layout="vertical">
          <Form.Item name="property_id" label="房号" rules={[{ required: true }]}>
            <Select
              options={propOptions}
              showSearch
              optionFilterProp="label"
              filterOption={(input, option) => {
                const lbl = String((option as any)?.label || '')
                return lbl.toLowerCase().includes(String(input || '').toLowerCase())
              }}
              filterSort={(a, b) => String((a as any).label || '').localeCompare(String((b as any).label || ''), 'zh')}
            />
          </Form.Item>
          <Form.Item name="category" label="问题区域" rules={[{ required: true }]}>
            <Select options={['入户走廊','客厅','厨房','卧室','阳台','浴室','其他'].map(x => ({ value:x, label:x }))} />
          </Form.Item>
          <Form.Item name="submitter_name" label="提交人" rules={[{ required: true }]}>
            <Input placeholder="请输入提交人姓名" />
          </Form.Item>
          <Form.Item name="details" label="问题摘要" rules={[{ required: true, min: 3 }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item label="维修前照片">
            <Upload listType="picture" multiple fileList={createFiles} onRemove={(f)=>{ setCreateFiles(fl=>fl.filter(x=>x.uid!==f.uid)); if (f.url) setCreatePhotos(u=>u.filter(x=>x!==f.url)) }}
              customRequest={async ({ file, onProgress, onSuccess, onError }: any) => {
                const fd = new FormData(); fd.append('file', file)
                try {
                  const xhr = new XMLHttpRequest()
                  xhr.open('POST', `${API_BASE}/maintenance/upload`)
                  const headers = authHeaders() as any
                  Object.keys(headers || {}).forEach(k => xhr.setRequestHeader(k, headers[k]))
                  const uid = Math.random().toString(36).slice(2)
                  setCreateFiles(fl => [...fl, { uid, name: (file as any)?.name || 'image', status: 'uploading', percent: 0 } as UploadFile])
                  xhr.upload.onprogress = (evt) => {
                    if (evt.lengthComputable && onProgress) {
                      const pct = Number((((evt.loaded || 0) / (evt.total || 1)) * 100).toFixed(0))
                      onProgress({ percent: pct })
                      setCreateFiles(fl => fl.map(x => x.uid === uid ? { ...x, percent: pct, status: 'uploading' } as UploadFile : x))
                    }
                  }
                  xhr.onreadystatechange = () => {
                    if (xhr.readyState === 4) {
                      try {
                        const j = JSON.parse(xhr.responseText || '{}')
                        if (xhr.status >= 200 && xhr.status < 300 && j?.url) {
                          setCreatePhotos(u=>[...u, j.url])
                          setCreateFiles(fl=>fl.map(x => x.uid === uid ? { ...x, status: 'done', url: j.url, percent: 100 } as UploadFile : x))
                          onSuccess && onSuccess(j, file)
                        } else {
                          setCreateFiles(fl => fl.map(x => x.uid === uid ? { ...x, status: 'error' } as UploadFile : x))
                          onError && onError(j)
                        }
                      } catch (e) { onError && onError(e) }
                    }
                  }
                  xhr.onerror = (e) => { onError && onError(e) }
                  xhr.send(fd)
                } catch (e) { onError && onError(e) }
              }}>
              <Button>上传照片</Button>
            </Upload>
          </Form.Item>
        </Form>
      </Modal>
      <Modal open={open} onCancel={()=>setOpen(false)} onOk={save} title="更新维修记录状态" okText="保存">
        <Form form={form} layout="vertical">
          <Form.Item name="status" label="状态" rules={[{ required: true }]}>
            <Select options={statusOptions} />
          </Form.Item>
          <Form.Item name="details" label="问题摘要"><Input.TextArea rows={3} /></Form.Item>
          <Space direction="vertical" style={{ width: '100%' }}>
            {(String(statusWatch || '') === 'pending' || String(statusWatch || '') === 'assigned' || String(statusWatch || '') === 'in_progress') ? (
              <>
                <Form.Item name="urgency" label="紧急程度">
                  <Select options={[
                    { value:'urgent', label:'紧急' },
                    { value:'normal', label:'普通' },
                    { value:'not_urgent', label:'不紧急' },
                  ]} />
                </Form.Item>
                <Form.Item name="assignee_id" label="分配维修人员">
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    options={userOptions}
                    placeholder="请选择维修人员"
                  />
                </Form.Item>
                <Form.Item name="eta" label="预计完成时间"><DatePicker style={{ width: '100%' }} /></Form.Item>
              </>
            ) : null}
            <Form.Item label="维修前照片">
              <Upload listType="picture" multiple fileList={preFiles} onRemove={(f)=>{ setPreFiles(fl=>fl.filter(x=>x.uid!==f.uid)); if ((f as any).url) setPrePhotos(u=>u.filter(x=>x!==(f as any).url)) }}
                customRequest={async ({ file, onProgress, onSuccess, onError }: any) => {
                  const fd = new FormData(); fd.append('file', file)
                  try {
                    const xhr = new XMLHttpRequest()
                    xhr.open('POST', `${API_BASE}/maintenance/upload`)
                    const headers = authHeaders() as any
                    Object.keys(headers || {}).forEach(k => xhr.setRequestHeader(k, headers[k]))
                    const uid = Math.random().toString(36).slice(2)
                    setPreFiles(fl => [...fl, { uid, name: (file as any)?.name || 'image', status: 'uploading', percent: 0 } as UploadFile])
                    xhr.upload.onprogress = (evt) => {
                      if (evt.lengthComputable && onProgress) {
                        const pct = Number((((evt.loaded || 0) / (evt.total || 1)) * 100).toFixed(0))
                        onProgress({ percent: pct })
                        setPreFiles(fl => fl.map(x => x.uid === uid ? { ...x, percent: pct, status: 'uploading' } as UploadFile : x))
                      }
                    }
                    xhr.onreadystatechange = () => {
                      if (xhr.readyState === 4) {
                        try {
                          const j = JSON.parse(xhr.responseText || '{}')
                          if (xhr.status >= 200 && xhr.status < 300 && j?.url) {
                            setPrePhotos(u=>[...u, j.url])
                            setPreFiles(fl => fl.map(x => x.uid === uid ? { ...x, status: 'done', url: j.url, percent: 100 } as UploadFile : x))
                            onSuccess && onSuccess(j, file)
                          } else {
                            setPreFiles(fl => fl.map(x => x.uid === uid ? { ...x, status: 'error' } as UploadFile : x))
                            onError && onError(j)
                          }
                        } catch (e) { onError && onError(e) }
                      }
                    }
                    xhr.onerror = (e) => { onError && onError(e) }
                    xhr.send(fd)
                  } catch (e) { onError && onError(e) }
                }}>
                <Button>上传照片</Button>
              </Upload>
            </Form.Item>
            {(String(statusWatch || '') === 'in_progress' || String(statusWatch || '') === 'completed') ? (
              <>
                <Form.Item name="repair_notes" label="维修记录描述"><Input.TextArea rows={3} /></Form.Item>
                <Form.Item label="维修后照片">
                  <Upload listType="picture" multiple fileList={files} onRemove={(f)=>{ setFiles(fl=>fl.filter(x=>x.uid!==f.uid)); if (f.url) setRepairPhotos(u=>u.filter(x=>x!==f.url)) }}
                    customRequest={async ({ file, onProgress, onSuccess, onError }: any) => {
                      const fd = new FormData(); fd.append('file', file)
                      try {
                        const xhr = new XMLHttpRequest()
                        xhr.open('POST', `${API_BASE}/maintenance/upload`)
                        const headers = authHeaders() as any
                        Object.keys(headers || {}).forEach(k => xhr.setRequestHeader(k, headers[k]))
                        const uid = Math.random().toString(36).slice(2)
                        setFiles(fl => [...fl, { uid, name: (file as any)?.name || 'image', status: 'uploading', percent: 0 } as UploadFile])
                        xhr.upload.onprogress = (evt) => {
                          if (evt.lengthComputable && onProgress) {
                            const pct = Number((((evt.loaded || 0) / (evt.total || 1)) * 100).toFixed(0))
                            onProgress({ percent: pct })
                            setFiles(fl => fl.map(x => x.uid === uid ? { ...x, percent: pct, status: 'uploading' } as UploadFile : x))
                          }
                        }
                        xhr.onreadystatechange = () => {
                          if (xhr.readyState === 4) {
                            try {
                              const j = JSON.parse(xhr.responseText || '{}')
                              if (xhr.status >= 200 && xhr.status < 300 && j?.url) {
                                setRepairPhotos(u=>[...u, j.url])
                                setFiles(fl => fl.map(x => x.uid === uid ? { ...x, status: 'done', url: j.url, percent: 100 } as UploadFile : x))
                                onSuccess && onSuccess(j, file)
                              } else {
                                setFiles(fl => fl.map(x => x.uid === uid ? { ...x, status: 'error' } as UploadFile : x))
                                onError && onError(j)
                              }
                            } catch (e) { onError && onError(e) }
                          }
                        }
                        xhr.onerror = (e) => { onError && onError(e) }
                        xhr.send(fd)
                      } catch (e) { onError && onError(e) }
                    }}>
                    <Button>上传照片</Button>
                  </Upload>
                </Form.Item>
              </>
            ) : null}
            {String(statusWatch || '') === 'completed' ? (
              <>
                <Typography.Text>费用信息</Typography.Text>
                <Form.Item name="maintenance_amount" label="维修金额（AUD）">
                  <InputNumber min={0} step={1} style={{ width:'100%' }} />
                </Form.Item>
                <Form.Item name="has_parts" label="是否包含配件费" valuePropName="checked">
                  <Switch />
                </Form.Item>
                <Form.Item name="parts_amount" label="配件费金额（AUD）" style={{ display: hasPartsWatch ? 'block' : 'none' }}>
                  <InputNumber min={0} step={1} style={{ width:'100%' }} />
                </Form.Item>
                <Form.Item name="pay_method" label="扣款方式">
                  <Select
                    options={[
                      { value:'rent_deduction', label:'租金扣除' },
                      { value:'tenant_pay', label:'房客支付' },
                      { value:'company_pay', label:'公司承担' },
                      { value:'landlord_pay', label:'房东支付' },
                      { value:'other_pay', label:'其他人支付' },
                    ]}
                  />
                </Form.Item>
                <Form.Item name="pay_other_note" label="其他人备注" style={{ display: String(payMethodWatch || '') === 'other_pay' ? 'block' : 'none' }}>
                  <Input />
                </Form.Item>
                <Form.Item name="completed_at" label="完成时间">
                  <DatePicker showTime style={{ width: '100%' }} />
                </Form.Item>
              </>
            ) : null}
          </Space>
          <Form.Item name="notes" label="维修备注"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}
