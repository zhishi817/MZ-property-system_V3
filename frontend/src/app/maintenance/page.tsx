"use client"
import { Card, Button, Table, Modal, Form, Input, DatePicker, Select, Space, InputNumber, App, Upload, Image, Tooltip } from 'antd'
import { PlusOutlined, EyeOutlined, DownloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { API_BASE, authHeaders, getJSON } from '../../lib/api'
import { jsPDF } from 'jspdf'
import type { UploadFile } from 'antd/es/upload/interface'

type Property = { id: string; code?: string }
type RecordRow = { id: string; property_id: string; occurred_at: string; worker_name: string; details?: any; notes?: string }
type Detail = { content?: string; item?: string; hours?: number; amount?: number }

export default function MaintenancePage() {
  const [list, setList] = useState<RecordRow[]>([])
  const [props, setProps] = useState<Property[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<RecordRow | null>(null)
  const [form] = Form.useForm()
  const { message } = App.useApp()
  const [details, setDetails] = useState<Detail[]>([])
  const [fileList, setFileList] = useState<UploadFile[]>([])
  const [invCfg, setInvCfg] = useState<any>(null)
  const [filterProp, setFilterProp] = useState<string>('')
  const [filterWorker, setFilterWorker] = useState<string>('')
  const [filterDate, setFilterDate] = useState<any>(null)
  const [selectedProp, setSelectedProp] = useState<{ value?: string, label?: string } | null>(null)

  function load() {
    Promise.all([
      getJSON<any[]>('/crud/property_maintenance').catch(()=>[]),
      getJSON<any[]>('/properties').catch(()=>[]),
    ]).then(([rows, ps])=>{ setList(Array.isArray(rows)? rows: []); setProps(Array.isArray(ps)? ps: []) })
  }
  useEffect(()=>{ load(); getJSON<any>('/config/invoice').then(setInvCfg).catch(()=>setInvCfg(null)) }, [])

  const propOptions = useMemo(()=> props.map(p=> ({ value: p.id, label: p.code || p.id })), [props])
  function addDetail() { setDetails(ds => [...ds, { content: '', item: '', hours: 0, amount: 0 }]) }
  function removeDetail(idx: number) { setDetails(ds => ds.filter((_, i) => i !== idx)) }
  function updateDetail(idx: number, key: keyof Detail, val: any) { setDetails(ds => ds.map((d, i) => i===idx ? { ...d, [key]: val } : d)) }

  function openCreate() { setEditing(null); form.resetFields(); setSelectedProp(null); setDetails([{ content: '', item: '', hours: 0, amount: 0 }]); setOpen(true) }
  function openEdit(row: RecordRow) {
    setEditing(row)
    form.setFieldsValue({ property_id: row.property_id, occurred_at: dayjs(row.occurred_at), worker_name: row.worker_name, notes: row.notes })
    setDetails(Array.isArray(row.details) ? row.details : (row.details ? JSON.parse(row.details) : []))
    const urls = Array.isArray((row as any).photo_urls) ? (row as any).photo_urls : []
    setPhotos(urls)
    setFileList(urls.map((u, i) => ({ uid: String(i), name: `photo-${i+1}`, status: 'done', url: u } as UploadFile)))
    const matched = props.find(p => String(p.id) === String(row.property_id))
    setSelectedProp(matched ? { value: matched.id, label: matched.code } : null)
    setOpen(true)
  }

  async function save() {
    const v = await form.validateFields()
    const selected = props.find(p => String(p.id) === String(v.property_id))
    const payload = { property_id: v.property_id, property_code: selected?.code, occurred_at: v.occurred_at.format('YYYY-MM-DD'), worker_name: v.worker_name, details, notes: v.notes || '', photo_urls: photos }
    if (editing) {
      const res = await fetch(`${API_BASE}/crud/property_maintenance/${editing.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(payload) })
      if (res.ok) { message.success('已更新'); setOpen(false); load() } else { try { const j = await res.json(); message.error(j?.message || '更新失败') } catch { message.error('更新失败') } }
    } else {
      const res = await fetch(`${API_BASE}/crud/property_maintenance`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(payload) })
      if (res.ok) { message.success('已创建'); setOpen(false); load() } else { try { const j = await res.json(); message.error(j?.message || '创建失败') } catch { message.error('创建失败') } }
    }
  }

  async function remove(id: string) {
    const res = await fetch(`${API_BASE}/crud/property_maintenance/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
    if (res.ok) { message.success('已删除'); load() } else { message.error('删除失败') }
  }

  async function buildInvoice(row: RecordRow) {
    const p = props.find(x => String(x.id) === String(row.property_id))
    const code = p?.code || (row as any).property_code || row.property_id
    const doc = new jsPDF('p','pt','a4')
    const fmt = (n: number) => `$${Number(n||0).toFixed(2)}`
    const items: Detail[] = Array.isArray(row.details) ? row.details : (row.details ? JSON.parse(row.details) : [])
    const subtotal = items.reduce((s, d) => s + Number(d.amount || 0), 0)
    const cfg = invCfg || {}
    const taxRate = Number(cfg.tax_rate ?? 0.10)
    const tax = Math.round(subtotal * taxRate * 100) / 100
    const total = Math.round((subtotal + tax) * 100) / 100
    const headY = 60
    doc.setFontSize(26)
    doc.text('INVOICE', 40, headY)
    doc.setFontSize(12)
    doc.text(String(cfg.company_name || 'Homixa Service Pty Ltd'), 40, headY + 28)
    doc.text(String(cfg.company_phone || '043260187'), 40, headY + 46)
    doc.text(`ABN : ${String(cfg.company_abn || '30666510863')}`, 40, headY + 64)
    try {
      const logoPath = String(cfg.logo_path || '/company-logo.png')
      const img = await fetch(logoPath).then(r=>r.blob()).then(b=>new Promise<string>((res)=>{ const fr = new FileReader(); fr.onload = ()=>res(String(fr.result)); fr.readAsDataURL(b) }))
      doc.addImage(img, 'PNG', 460, 40, 96, 96)
    } catch {}
    const boxY = headY + 110
    doc.setDrawColor(230)
    doc.roundedRect(40, boxY, 500, 100, 6, 6)
    doc.setFontSize(11)
    doc.text('BILL TO', 56, boxY + 22)
    doc.text('INVOICE NUMBER', 360, boxY + 22)
    doc.text('ISSUED', 360, boxY + 56)
    doc.setFontSize(12)
    doc.text('W Australia Property Pty Ltd', 56, boxY + 40)
    doc.text(String(code || ''), 56, boxY + 58)
    const invNo = `INV${new Date().toISOString().slice(0,10).replace(/-/g,'')}${String(row.id || '').slice(0,4)}`
    doc.text(invNo, 360, boxY + 40)
    doc.text(dayjs(row.occurred_at).format('DD MMM YYYY'), 360, boxY + 74)
    const tableY = boxY + 140
    doc.setDrawColor(240)
    doc.line(40, tableY, 540, tableY)
    doc.setFontSize(12)
    doc.text('ITEM', 56, tableY - 10)
    doc.text('PRICE', 356, tableY - 10)
    doc.text('QUANTITY', 436, tableY - 10)
    doc.text('AMOUNT', 506, tableY - 10)
    let y = tableY + 24
    const first = items[0]
    const name = String(first?.content || first?.item || 'Maintenance Task')
    const desc = String(first?.item ? first.item : (first?.content || ''))
    doc.setFontSize(12)
    doc.text(name, 56, y)
    doc.text(fmt(Number(first?.amount || 0)), 356, y, { align:'right' })
    doc.text('1', 460, y)
    doc.text(fmt(Number(first?.amount || 0)), 540, y, { align:'right' })
    y += 18
    doc.setFontSize(11)
    doc.setTextColor(80)
    if (desc) doc.text(desc, 56, y, { maxWidth: 280 })
    y += 40
    doc.setTextColor(0)
    doc.line(320, y - 20, 540, y - 20)
    doc.setFontSize(12)
    doc.text('Subtotal', 360, y)
    doc.text(fmt(subtotal), 540, y, { align:'right' })
    y += 18
    doc.text(`TAX (${Math.round(taxRate*100)}%)`, 360, y)
    doc.text(fmt(tax), 540, y, { align:'right' })
    y += 18
    doc.text('Total', 360, y)
    doc.text(fmt(total), 540, y, { align:'right' })
    y += 40
    doc.setFontSize(16)
    doc.text('Amount due', 360, y)
    doc.setFontSize(18)
    doc.text(fmt(total), 540, y, { align:'right' })
    y += 40
    doc.setFontSize(12)
    doc.text('Payment instruction', 40, y)
    y += 18
    doc.text(`Account Name: ${String(cfg.pay_account_name || 'Homixa Service Pty Ltd')}`, 40, y); y += 16
    doc.text(`BSB: ${String(cfg.pay_bsb || '062 692')}`, 40, y); y += 16
    doc.text(`Account No.: ${String(cfg.pay_account_no || '7600 0572')}`, 40, y)
    const filename = `maintenance_invoice_${code}_${row.occurred_at}.pdf`
    return { doc, filename }
  }

  async function previewInvoice(row: RecordRow) {
    const { doc } = await buildInvoice(row)
    const url = doc.output('bloburl')
    window.open(url, '_blank')
  }

  async function downloadInvoice(row: RecordRow) {
    const { doc, filename } = await buildInvoice(row)
    doc.save(filename)
  }

  const [photos, setPhotos] = useState<string[]>([])
  const dataAll = useMemo(()=> list.map(r => {
    const byId = props.find(p => String(p.id) === String(r.property_id))
    const byCode = props.find(p => String(p.code || '') === String(r.property_id))
    const code = byId?.code || (r as any).property_code || byCode?.code || r.property_id
    const detailsArr = Array.isArray(r.details) ? r.details : (r.details ? (()=>{ try { return JSON.parse(r.details) } catch { return [] } })() : [])
    const total = detailsArr.reduce((s: number, d: any)=> s + Number(d?.amount || 0), 0)
    const photosArr = Array.isArray((r as any).photo_urls) ? (r as any).photo_urls : []
    return { ...r, code, total, photos: photosArr, photo_count: photosArr.length }
  }), [list, props])
  const data = useMemo(() => dataAll.filter(r => {
    const okProp = filterProp ? String(r.code || '').toLowerCase().includes(filterProp.toLowerCase()) : true
    const okWorker = filterWorker ? String((r as any).worker_name || '').toLowerCase().includes(filterWorker.toLowerCase()) : true
    const okDate = filterDate ? dayjs(r.occurred_at).isSame(filterDate, 'day') : true
    return okProp && okWorker && okDate
  }), [dataAll, filterProp, filterWorker, filterDate])

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card title="房源维修" extra={<Button type="primary" onClick={openCreate}>新增维修记录</Button>}>
        <Space style={{ marginBottom: 12 }}>
          <Input placeholder="按房号搜索" allowClear value={filterProp} onChange={(e)=>setFilterProp(e.target.value)} style={{ width: 200 }} />
          <Input placeholder="按人员姓名搜索" value={filterWorker} onChange={(e)=>setFilterWorker(e.target.value)} style={{ width: 200 }} />
          <DatePicker value={filterDate as any} onChange={(v)=>setFilterDate(v as any)} />
          <Button onClick={()=>{ /* 实时过滤，保留按钮以符合习惯 */ }}>搜索</Button>
          <Button onClick={()=>{ setFilterProp(''); setFilterWorker(''); setFilterDate(null) }}>重置</Button>
        </Space>
        <Table style={{ marginTop: 12 }} rowKey={(r)=>r.id} dataSource={data} pagination={false} columns={[
          { title:'房号', dataIndex:'code' },
          { title:'日期', dataIndex:'occurred_at', render:(d:string)=> dayjs(d).format('YYYY-MM-DD') },
          { title:'工作人员', dataIndex:'worker_name' },
          { title:'合计', dataIndex:'total', render:(v:number)=> `$${Number(v||0).toFixed(2)}` },
          { title:'照片', dataIndex:'photos', render: (arr: string[] = []) => arr && arr.length ? (<Space>{arr.slice(0,3).map((u, i) => (<Image key={i} src={u} width={40} height={40} style={{ objectFit:'cover', borderRadius:4 }} />))}</Space>) : <span style={{ color:'#999' }}>无</span> },
          { title:'工作详情', dataIndex:'details', render: (d: any) => {
            const arr = Array.isArray(d) ? d : (typeof d === 'string' ? (()=>{ try { return JSON.parse(d) } catch { return [] } })() : [])
            return arr && arr.length ? (<div>{arr.map((it: any, idx: number) => (<div key={idx} style={{ fontSize: 12 }}>{`${it.content || ''} / ${it.item || ''} / ${it.hours || 0}h / $${Number(it.amount||0)}`}</div>))}</div>) : <span style={{ color:'#999' }}>无</span>
          } },
          { title:'备注', dataIndex:'notes' },
          { title:'操作', render: (_:any, r:any) => (
            <Space>
              <Button size="small" onClick={()=>openEdit(r)}>编辑</Button>
              <Button size="small" danger onClick={()=>remove(r.id)}>删除</Button>
              <Tooltip title="预览发票"><Button size="small" icon={<EyeOutlined />} onClick={()=>previewInvoice(r)} /></Tooltip>
              <Tooltip title="下载发票"><Button size="small" icon={<DownloadOutlined />} onClick={()=>downloadInvoice(r)} /></Tooltip>
            </Space>
          ) }
        ]} />
      </Card>
      <Modal open={open} onCancel={()=>setOpen(false)} onOk={save} title={editing ? '编辑维修记录' : '新增维修记录'} okText={editing ? '保存' : '创建'}>
        <Form form={form} layout="vertical">
          <Form.Item name="property_id" label="房源号" rules={[{ required: true }]}>
            <Select options={propOptions} showSearch optionFilterProp="label" onChange={(val)=>{
              const m = props.find(p=> String(p.id)===String(val))
              setSelectedProp(m ? { value: m.id, label: m.code } : null)
            }} />
          </Form.Item>
          <Form.Item name="occurred_at" label="日期" rules={[{ required: true }]}><DatePicker style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="worker_name" label="工作人员姓名" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label="上传照片">
            <Upload listType="picture" multiple fileList={fileList} onRemove={(f)=>{ setPhotos(arr => arr.filter(u => u !== (f.url || ''))); setFileList(fl => fl.filter(x => x.uid !== f.uid)); }} onPreview={(f)=>{ if (f.url) window.open(f.url, '_blank') }}
              customRequest={async ({ file, onSuccess, onError }: any) => {
              const fd = new FormData(); fd.append('file', file)
              try {
                const r = await fetch(`${API_BASE}/maintenance/upload`, { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }, body: fd })
                const j = await r.json()
                if (r.ok && j?.url) { setPhotos(arr => [...arr, j.url]); setFileList(fl => [...fl, { uid: Math.random().toString(36).slice(2), name: file.name, status: 'done', url: j.url } as UploadFile ]); onSuccess && onSuccess(j, file) } else { onError && onError(j) }
              } catch (e) { onError && onError(e) }
            }}>
              <Button>上传附件</Button>
            </Upload>
          </Form.Item>
          <div style={{ marginBottom: 8, fontWeight: 500 }}>工作详情</div>
          <Table size="small" pagination={false} dataSource={details.map((d,i)=>({ ...d, key: i }))} columns={[
            { title:'工作内容', dataIndex:'content', render: (_:any, r:any, idx:number)=> (<Input value={details[idx]?.content || ''} onChange={(e)=>updateDetail(idx,'content',e.target.value)} />) },
            { title:'工作事项', dataIndex:'item', render: (_:any, r:any, idx:number)=> (<Input value={details[idx]?.item || ''} onChange={(e)=>updateDetail(idx,'item',e.target.value)} />) },
            { title:'工时', dataIndex:'hours', render: (_:any, r:any, idx:number)=> (<InputNumber min={0} value={details[idx]?.hours || 0} onChange={(v)=>updateDetail(idx,'hours',v)} />) },
            { title:'金额', dataIndex:'amount', render: (_:any, r:any, idx:number)=> (<InputNumber min={0} value={details[idx]?.amount || 0} onChange={(v)=>updateDetail(idx,'amount',v)} />) },
            { title:'', render: (_:any, r:any, idx:number)=> (<Button size="small" danger onClick={()=>removeDetail(idx)}>删除</Button>) }
          ]} />
          <Button style={{ marginTop: 8 }} icon={<PlusOutlined />} onClick={addDetail}>
          </Button>
          <Form.Item name="notes" label="其他备注"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}

