"use client"
import { Table, Card, Tag, Space, Button, message, Modal, Form, Input, Select, Image, Upload, Row, Col, Progress } from 'antd'
import { useEffect, useState, useRef } from 'react'
import { API_BASE } from '../../lib/api'
import { hasPerm } from '../../lib/auth'

type KeySet = { id: string; set_type: 'guest'|'spare_1'|'spare_2'|'other'; status: string; code?: string; items?: Array<{ id: string; item_type: 'key'|'fob'; code: string; photo_url?: string }> }
type Property = { id: string; code?: string; address: string }

export default function KeysPage() {
  const [sets, setSets] = useState<KeySet[]>([])
  const [properties, setProperties] = useState<Property[]>([])
  const [query, setQuery] = useState('')
  const [slotOpen, setSlotOpen] = useState(false)
  const [slotForm] = Form.useForm()
  const [ctx, setCtx] = useState<{ setId?: string; item?: any; item_type?: 'key'|'fob'; set_type?: KeySet['set_type']; property_code?: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadPct, setUploadPct] = useState(0)
  const prevSetsRef = useRef<KeySet[]>([])

  async function load() {
    try {
      const res = await fetch(`${API_BASE}/keys`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSets(await res.json())
    } catch (e: any) {
      message.error('钥匙数据加载失败，稍后重试')
      setSets([])
    }
    try {
      const p = await fetch(`${API_BASE}/properties`).then(r => r.json()).catch(() => [])
      setProperties(Array.isArray(p) ? p : [])
    } catch { setProperties([]) }
  }
  useEffect(() => { load() }, [])

  function xhrJSON(method: string, url: string, fd: FormData) {
    return new Promise<{ ok: boolean; status: number; json: any }>((resolve) => {
      const xhr = new XMLHttpRequest()
      xhr.open(method, url)
      xhr.setRequestHeader('Authorization', `Bearer ${localStorage.getItem('token') || ''}`)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setUploadPct(Math.round((e.loaded / e.total) * 100))
      }
      xhr.onreadystatechange = () => {
        if (xhr.readyState === 4) {
          let j: any = null
          try { j = JSON.parse(xhr.responseText) } catch { j = null }
          resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, json: j })
        }
      }
      xhr.send(fd)
    })
  }

  async function submitSlot() {
    const v = await slotForm.validateFields()
    if (!ctx?.setId || !ctx?.item_type) { message.error('缺少上下文'); return }
    const fd = new FormData()
    fd.append('code', v.code || '')
    if (v.photo && v.photo.file) fd.append('photo', v.photo.file as any)
    prevSetsRef.current = sets
    setUploading(true)
    setUploadPct(0)
    if (ctx.item) {
      const r = await xhrJSON('PATCH', `${API_BASE}/keys/sets/${ctx.setId}/items/${ctx.item.id}`, fd)
      if (r.ok) {
        const updated = r.json
        setSets(prev => prev.map(s => s.id === ctx.setId ? { ...s, items: (s.items || []).map(it => it.id === ctx.item.id ? { ...it, code: updated?.code ?? v.code, photo_url: updated?.photo_url ?? (it.photo_url) } : it) } : s))
        message.success('已更新'); setSlotOpen(false); slotForm.resetFields(); setUploading(false); setUploadPct(0); load()
      } else { setSets(prevSetsRef.current); const m = r.json; message.error(m?.message || '更新失败'); setUploading(false); setUploadPct(0) }
    } else {
      fd.append('item_type', ctx.item_type)
      if (ctx.set_type) fd.append('set_type', ctx.set_type)
      if (ctx.property_code) fd.append('property_code', ctx.property_code)
      const r = await xhrJSON('POST', `${API_BASE}/keys/sets/${ctx.setId}/items`, fd)
      if (r.ok) {
        const created = r.json
        setSets(prev => prev.map(s => s.id === ctx.setId ? { ...s, items: [...(s.items || []).filter(it => it.item_type !== ctx.item_type), { id: created?.id || Math.random().toString(36).slice(2), item_type: ctx.item_type!, code: v.code || '', photo_url: created?.photo_url }] } : s))
        message.success('已添加'); setSlotOpen(false); slotForm.resetFields(); setUploading(false); setUploadPct(0); load()
      } else { setSets(prevSetsRef.current); const m = r.json; message.error(m?.message || '添加失败'); setUploading(false); setUploadPct(0) }
    }
  }

  async function archiveProperty(code?: string) {
    if (!code) return
    const rows = await fetch(`${API_BASE}/keys/sets?property_code=${encodeURIComponent(code)}`).then(r => r.json()).catch(() => [])
    for (const s of (rows || [])) {
      await fetch(`${API_BASE}/keys/sets/${s.id}/flows`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ action: 'lost' }) })
    }
    message.success('已归档该房源所有套件')
    load()
  }

  const SLOT_DEFS: Array<{ label: string; set_type: KeySet['set_type']; item_type: 'key'|'fob' }> = [
    { label: '客人Fob', set_type: 'guest', item_type: 'fob' },
    { label: '客人钥匙', set_type: 'guest', item_type: 'key' },
    { label: '备用Fob-1', set_type: 'spare_1', item_type: 'fob' },
    { label: '备用钥匙-1', set_type: 'spare_1', item_type: 'key' },
    { label: '备用Fob-2', set_type: 'spare_2', item_type: 'fob' },
    { label: '备用钥匙-2', set_type: 'spare_2', item_type: 'key' },
    { label: '其他钥匙', set_type: 'other', item_type: 'key' },
  ]

  function findSet(property_code: string, set_type: KeySet['set_type']) {
    const matches = sets.filter(s => s.code === property_code && s.set_type === set_type)
    return matches.find(s => (s.items || []).length > 0) || matches[0]
  }

  function findItem(set?: KeySet, item_type?: 'key'|'fob') {
    if (!set) return null
    return (set.items || []).find(it => it.item_type === item_type) || null
  }

  async function openSlot(property_code: string, def: { set_type: KeySet['set_type']; item_type: 'key'|'fob' }) {
    const rows = await fetch(`${API_BASE}/keys/sets?property_code=${encodeURIComponent(property_code)}`).then(r => r.json()).catch(() => [])
    const s = (rows || []).find((x: any) => x.set_type === def.set_type)
    if (!s) { message.error('套件不存在'); return }
    setSets(prev => {
      const others = prev.filter(p => !(p.code === property_code && p.set_type === def.set_type))
      return [...others, { ...s, items: (prev.find(p => p.id === s.id)?.items) || [] }]
    })
    const it = findItem(s as any, def.item_type)
    setCtx({ setId: s.id, item: it || undefined, item_type: def.item_type, set_type: def.set_type, property_code })
    slotForm.setFieldsValue({ code: it?.code })
    setSlotOpen(true)
  }

  const filteredProps = properties.filter(p => {
    const q = query.trim().toLowerCase(); if (!q) return true
    return (p.code || '').toLowerCase().includes(q) || (p.address || '').toLowerCase().includes(q)
  })

  return (
    <Card title="钥匙管理" extra={<Space><Input.Search allowClear placeholder="搜索房源" onSearch={setQuery} onChange={(e) => setQuery(e.target.value)} style={{ width: 260 }} /></Space>}>
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        {filteredProps.map((p) => (
          <Card key={p.id} title={`Unit ${p.code || ''}`} extra={<Space>{hasPerm('keyset.manage') && <Button onClick={() => archiveProperty(p.code)} type="default">归档</Button>}</Space>}>
            <div style={{ color: '#888', marginTop: -8 }}>{p.address}</div>
            <div style={{ display: 'flex', gap: 16, overflowX: 'auto', paddingBottom: 8, marginTop: 12 }}>
              {SLOT_DEFS.map(def => {
                const set = findSet(p.code || '', def.set_type)
                const it = findItem(set || undefined, def.item_type)
                return (
                  <div key={`${p.id}-${def.set_type}-${def.item_type}`} style={{ minWidth: 180 }}>
                    <div style={{ border: '1px dashed #d9d9d9', borderRadius: 8, padding: 12, textAlign: 'center' }}>
                      <div style={{ height: 72, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {it?.photo_url ? <Image width={60} src={/^https?:\/\//.test(it.photo_url) ? it.photo_url : `${API_BASE}${it.photo_url}`} /> : <Tag>未上传</Tag>}
                      </div>
                      <div style={{ marginTop: 8, fontWeight: 500 }}>{def.label}</div>
                      <div style={{ marginTop: 6 }}><Tag>{it?.code || ''}</Tag></div>
                      {hasPerm('keyset.manage') && (
                        <Button size="small" style={{ marginTop: 8 }} onClick={() => openSlot(p.code || '', def)}>
                          {(it && (it.photo_url || it.code)) ? '编辑' : '添加'}
                        </Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>
        ))}
      </Space>
      <Modal open={slotOpen} onCancel={() => { if (!uploading) setSlotOpen(false) }} onOk={submitSlot} title="编辑/添加" okButtonProps={{ disabled: uploading, loading: uploading }} cancelButtonProps={{ disabled: uploading }}>
        <Form form={slotForm} layout="vertical">
          {uploading ? <Progress percent={uploadPct} size="small" /> : null}
          <Form.Item name="code" label="编号">
            <Input />
          </Form.Item>
          <Form.Item name="photo" label="照片">
            <Upload beforeUpload={() => false} maxCount={1} disabled={uploading}>
              <Button>选择文件</Button>
            </Upload>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}