"use client"
import { Card, Table, Space, Button, Input, Select, DatePicker, Modal, Form, InputNumber, Radio, App } from 'antd'
import { Upload } from 'antd'
import type { UploadFile } from 'antd/es/upload/interface'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { apiList, apiUpdate, apiDelete, apiCreate, getJSON, API_BASE, authHeaders } from '../../lib/api'
import { hasPerm } from '../../lib/auth'

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
}

export default function RepairsPage() {
  const [list, setList] = useState<RepairOrder[]>([])
  const [props, setProps] = useState<{ id: string; code?: string }[]>([])
  const [filterCode, setFilterCode] = useState('')
  const [filterWorkNo, setFilterWorkNo] = useState('')
  const [filterSubmitter, setFilterSubmitter] = useState('')
  const [filterStatus, setFilterStatus] = useState<string | undefined>(undefined)
  const [filterCat, setFilterCat] = useState<string | undefined>(undefined)
  const [dateRange, setDateRange] = useState<[any, any] | null>(null)
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
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm] = Form.useForm()
  const [createFiles, setCreateFiles] = useState<UploadFile[]>([])
  const [createPhotos, setCreatePhotos] = useState<string[]>([])

  async function load() {
    try {
      const rows = await apiList<RepairOrder[]>('property_maintenance').catch(()=>[])
      const ps = await getJSON<any[]>('/properties').catch(()=>[])
      setList(Array.isArray(rows) ? rows : [])
      setProps(Array.isArray(ps) ? ps : [])
    } catch { setList([]); setProps([]) }
  }
  useEffect(() => { load() }, [])

  const rows = useMemo(() => {
    const byId: Record<string, any> = Object.fromEntries(props.map(p => [String(p.id), p]))
    return (list || []).map(r => {
      const p = byId[String(r.property_id || '')]
      const code = p?.code || r.property_id || ''
      return { ...r, code }
    })
  }, [list, props])

  const filtered = useMemo(() => rows.filter(r => {
    const okCode = filterCode ? String(r.code || '').toLowerCase().includes(filterCode.toLowerCase()) : true
    const okWorkNo = filterWorkNo ? String((r as any).work_no || '').toLowerCase().includes(filterWorkNo.toLowerCase()) : true
    const okSubmitter = filterSubmitter ? String(r.submitter_name || '').toLowerCase().includes(filterSubmitter.toLowerCase()) : true
    const okStatus = filterStatus ? String(r.status || '') === filterStatus : true
    const okCat = filterCat ? String(r.category || '') === filterCat : true
    const okDate = dateRange ? (() => {
      const d = r.submitted_at ? new Date(r.submitted_at) : null
      if (!d) return true
      const s = dateRange[0]; const e = dateRange[1]
      const sd = s ? new Date(dayjs(s).format('YYYY-MM-DD')).getTime() : Number.NEGATIVE_INFINITY
      const ed = e ? new Date(dayjs(e).format('YYYY-MM-DD')).getTime() : Number.POSITIVE_INFINITY
      const dt = d.getTime()
      return dt >= sd && dt <= ed
    })() : true
    return okCode && okWorkNo && okSubmitter && okStatus && okCat && okDate
  }), [rows, filterCode, filterWorkNo, filterSubmitter, filterStatus, filterCat, dateRange])

  function openEdit(row: RepairOrder) {
    setEditing(row)
    form.setFieldsValue({
      status: row.status || 'pending',
      assignee_id: row.assignee_id || '',
      eta: row.eta ? dayjs(row.eta) : null,
      remark: row.remark || '',
      urgency: row.urgency || 'normal',
      details: summaryFromDetails(row.details)
    })
    setOpen(true)
  }

  async function save() {
    const v = await form.validateFields()
    const payload: any = {
      status: v.status,
      assignee_id: v.assignee_id || undefined,
      eta: v.eta ? dayjs(v.eta).format('YYYY-MM-DD') : undefined,
      remark: v.remark || undefined,
      urgency: v.urgency || undefined
    }
    if (v.details) {
      try {
        payload.details = JSON.stringify([{ content: String(v.details || '') }])
      } catch {
        payload.details = String(v.details || '')
      }
    }
    if (repairPhotos.length) payload.repair_photo_urls = repairPhotos
    if (v.repair_notes) payload.repair_notes = v.repair_notes
    if (String(v.status || '') === 'completed') payload.completed_at = new Date().toISOString()
    try {
      if (editing) await apiUpdate('property_maintenance', editing.id, payload)
      message.success('已更新工单'); setOpen(false); setEditing(null); load()
    } catch (e: any) {
      message.error(e?.message || '保存失败')
    }
  }

  const catOptions = ['水电','家具','家电','墙面','其他'].map(x => ({ value: x, label: x }))
  const statusOptions = [
    { value: 'pending', label: '待处理' },
    { value: 'assigned', label: '已分配' },
    { value: 'in_progress', label: '维修中' },
    { value: 'completed', label: '已完成' },
    { value: 'canceled', label: '已取消' },
  ]

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
  async function remove(id: string) {
    try {
      await apiDelete('property_maintenance', id)
      message.success('已删除'); load()
    } catch (e: any) { message.error(e?.message || '删除失败') }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card title="待维修管理">
        <Space style={{ marginBottom: 12 }}>
          <Button
            onClick={() => {
              try {
                const origin = typeof window !== 'undefined' ? window.location.origin : ''
                const link = `${origin}/public/repair-report`
                navigator.clipboard?.writeText(link)
                message.success('已复制分享链接')
              } catch {}
            }}
          >
            复制分享链接
          </Button>
          <Button
            type="link"
            onClick={() => {
              try {
                const origin = typeof window !== 'undefined' ? window.location.origin : ''
                const link = `${origin}/public/repair-report`
                window.open(link, '_blank')
              } catch {}
            }}
          >
            打开外部上报页
          </Button>
          <Button onClick={() => setPwdOpen(true)}>设置上报密码</Button>
          <Button type="primary" onClick={() => setCreateOpen(true)} style={{ marginLeft: 'auto' }}>新增维修记录</Button>
        </Space>
        <Space style={{ marginBottom: 12 }}>
          <Input placeholder="按房号搜索" value={filterCode} onChange={e=>setFilterCode(e.target.value)} style={{ width: 180 }} />
          <Input placeholder="按工单号搜索" value={filterWorkNo} onChange={e=>setFilterWorkNo(e.target.value)} style={{ width: 180 }} />
          <Input placeholder="按提交人搜索" value={filterSubmitter} onChange={e=>setFilterSubmitter(e.target.value)} style={{ width: 180 }} />
          <Select placeholder="按分类" allowClear options={catOptions} value={filterCat} onChange={v=>setFilterCat(v)} style={{ width: 160 }} />
          <Select placeholder="按状态" allowClear options={statusOptions} value={filterStatus} onChange={v=>setFilterStatus(v)} style={{ width: 160 }} />
          <DatePicker.RangePicker value={dateRange as any} onChange={v=>setDateRange(v as any)} />
          <Button onClick={()=>{ /* 保留按钮，实时过滤 */ }}>搜索</Button>
          <Button onClick={()=>{ setFilterCode(''); setFilterWorkNo(''); setFilterSubmitter(''); setFilterStatus(undefined); setFilterCat(undefined); setDateRange(null) }}>重置</Button>
        </Space>
        {(() => {
          const columns = [
            { title:'房号', dataIndex:'code', width: 120 },
            { title:'工单号', dataIndex:'work_no', width: 160 },
            { title:'问题区域', dataIndex:'category', width: 120 },
            { title:'问题摘要', dataIndex:'details', ellipsis: true, width: 280, render:(d:string)=> summaryFromDetails(d) },
            { title:'提交人', dataIndex:'submitter_name', width: 120 },
            { title:'提交时间', dataIndex:'submitted_at', width: 180, render:(d:string)=> d ? dayjs(d).format('YYYY-MM-DD HH:mm') : '-' },
            { title:'紧急程度', dataIndex:'urgency', width: 120, render:(u:string)=> urgencyTag(u) },
            { title:'当前状态', dataIndex:'status', width: 120 },
            { title:'分配人员', dataIndex:'assignee_id', width: 140 },
            { title:'操作', fixed: 'right' as const, width: 220, render: (_:any, r:RepairOrder) => (
              <Space>
                <Button size="small" onClick={()=>openView(r)}>查看</Button>
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
                pagination={{ pageSize: 10 }}
                scroll={{ x: 1600 }}
                columns={columns as any}
              />
            </div>
          )
        })()}
      </Card>
      <Modal open={viewOpen} onCancel={()=>setViewOpen(false)} footer={null} title="维修详情">
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>工单ID：{viewRow?.id}</div>
          <div>房号：{(viewRow as any)?.code || viewRow?.property_id}</div>
          <div>问题区域：{viewRow?.category}</div>
          <div>紧急程度：{urgencyLabel(viewRow?.urgency)}</div>
          <div>提交人：{viewRow?.submitter_name}</div>
          <div>提交时间：{viewRow?.submitted_at ? dayjs(viewRow?.submitted_at).format('YYYY-MM-DD HH:mm') : '-'}</div>
          <div>问题详情：</div>
          <div style={{ whiteSpace:'pre-wrap', border:'1px solid #eee', padding:8, borderRadius:6 }}>{summaryFromDetails(viewRow?.details) || viewRow?.detail || ''}</div>
          <div>附件：</div>
          <Space wrap>
            {(Array.isArray(viewRow?.attachment_urls) ? viewRow!.attachment_urls! : []).map((u, i) => (
              <a key={i} href={u} target="_blank" rel="noreferrer">附件{i+1}</a>
            ))}
          </Space>
        </Space>
      </Modal>
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
      }} title="设置维修上报表密码" okText="保存">
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
        const workNo = `R-${dayjs().format('YYYYMMDD')}-${Math.random().toString(36).slice(2,4)}${Math.random().toString(36).slice(2,2)}`
        const payload: any = {
          property_id: v.property_id,
          category: v.category,
          status: 'pending',
          submitted_at: new Date().toISOString(),
          work_no: workNo
        }
        if (v.details) {
          try { payload.details = JSON.stringify([{ content: String(v.details || '') }]) } catch { payload.details = String(v.details || '') }
        }
        if (createPhotos.length) payload.photo_urls = createPhotos
        try {
          await apiCreate('property_maintenance', payload)
          message.success('已新增维修记录')
          setCreateOpen(false); createForm.resetFields(); setCreateFiles([]); setCreatePhotos([])
          load()
        } catch (e: any) { message.error(e?.message || '新增失败') }
      }} title="新增维修记录" okText="保存">
        <Form form={createForm} layout="vertical">
          <Form.Item name="property_id" label="房号" rules={[{ required: true }]}>
            <Select options={props.map(p => ({ value: p.id, label: p.code || p.id }))} showSearch optionFilterProp="label" />
          </Form.Item>
          <Form.Item name="category" label="问题区域" rules={[{ required: true }]}>
            <Select options={['入户走廊','客厅','厨房','卧室','阳台','浴室','其他'].map(x => ({ value:x, label:x }))} />
          </Form.Item>
          <Form.Item name="details" label="问题摘要" rules={[{ required: true, min: 3 }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item label="附件照片">
            <Upload listType="picture" multiple fileList={createFiles} onRemove={(f)=>{ setCreateFiles(fl=>fl.filter(x=>x.uid!==f.uid)); if (f.url) setCreatePhotos(u=>u.filter(x=>x!==f.url)) }}
              customRequest={async ({ file, onSuccess, onError }: any) => {
                const fd = new FormData(); fd.append('file', file)
                try {
                  const r = await fetch(`${API_BASE}/maintenance/upload`, { method: 'POST', headers: { ...authHeaders() }, body: fd })
                  const j = await r.json()
                  if (r.ok && j?.url) { setCreatePhotos(u=>[...u, j.url]); setCreateFiles(fl=>[...fl, { uid: Math.random().toString(36).slice(2), name: file.name, status: 'done', url: j.url } as UploadFile]); onSuccess && onSuccess(j, file) } else { onError && onError(j) }
                } catch (e) { onError && onError(e) }
              }}>
              <Button>上传照片</Button>
            </Upload>
          </Form.Item>
        </Form>
      </Modal>
      <Modal open={open} onCancel={()=>setOpen(false)} onOk={save} title="更新工单状态" okText="保存">
        <Form form={form} layout="vertical">
          <Form.Item name="status" label="状态" rules={[{ required: true }]}>
            <Select options={statusOptions} />
          </Form.Item>
          <Form.Item name="details" label="问题摘要"><Input.TextArea rows={3} /></Form.Item>
          <Form.Item name="urgency" label="紧急程度">
            <Select options={[
              { value:'urgent', label:'紧急' },
              { value:'normal', label:'普通' },
              { value:'not_urgent', label:'不紧急' },
            ]} />
          </Form.Item>
          <Form.Item name="repair_notes" label="维修记录描述"><Input.TextArea rows={3} /></Form.Item>
          <Form.Item label="维修照片">
            <Upload listType="picture" multiple fileList={files} onRemove={(f)=>{ setFiles(fl=>fl.filter(x=>x.uid!==f.uid)); if (f.url) setRepairPhotos(u=>u.filter(x=>x!==f.url)) }}
              customRequest={async ({ file, onSuccess, onError }: any) => {
                const fd = new FormData(); fd.append('file', file)
                try {
                  const r = await fetch(`${API_BASE}/maintenance/upload`, { method: 'POST', headers: { ...authHeaders() }, body: fd })
                  const j = await r.json()
                  if (r.ok && j?.url) { setRepairPhotos(u=>[...u, j.url]); setFiles(fl=>[...fl, { uid: Math.random().toString(36).slice(2), name: file.name, status: 'done', url: j.url } as UploadFile]); onSuccess && onSuccess(j, file) } else { onError && onError(j) }
                } catch (e) { onError && onError(e) }
              }}>
              <Button>上传照片</Button>
            </Upload>
          </Form.Item>
          <Form.Item name="assignee_id" label="分配维修人员"><Input /></Form.Item>
          <Form.Item name="eta" label="预计完成时间"><DatePicker style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="remark" label="维修备注"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}
