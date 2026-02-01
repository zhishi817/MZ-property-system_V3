"use client"
import { Table, Card, Button, Modal, Form, Input, InputNumber, Select, message, Space, Row, Col, Tag, Divider, Switch, AutoComplete, Drawer, Descriptions } from 'antd'
import React, { useEffect, useState } from 'react'
import { API_BASE } from '../../lib/api'
import { hasPerm } from '../../lib/auth'

type Property = { id: string; code?: string; address: string; type: string; capacity: number; region?: string; area_sqm?: number; landlord_id?: string }

export default function PropertiesPage() {
  const [mounted, setMounted] = useState(false)
  const [data, setData] = useState<Property[]>([])
  const [dicts, setDicts] = useState<any>({})
  const [landlords, setLandlords] = useState<{ id: string; name: string }[]>([])
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const [editOpen, setEditOpen] = useState(false)
  const [editForm] = Form.useForm()
  const [current, setCurrent] = useState<Property | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detail, setDetail] = useState<any>(null)
  const [typeSel, setTypeSel] = useState<string | undefined>(undefined)
  const [typeEdit, setTypeEdit] = useState<string | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [addrOptions, setAddrOptions] = useState<{ value: string; label: string }[]>([])
  const [addrTimer, setAddrTimer] = useState<any>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([])
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchForm] = Form.useForm()
  const [regionFilter, setRegionFilter] = useState<string | undefined>(undefined)
  async function getJson(url: string, init?: RequestInit) {
    try {
      const r = await fetch(url, init)
      if (!r.ok) return null
      return await r.json()
    } catch {
      return null
    }
  }
  function getBedroomCount(type?: string) {
    switch (type) {
      case '一房一卫': return 1
      case '两房一卫':
      case '两房两卫': return 2
      case '三房两卫':
      case '三房三卫': return 3
      default: return 0
    }
  }

  async function load() {
    const rows = await getJson(`${API_BASE}/properties?include_archived=${showArchived ? 'true' : 'false'}`)
    const arr = Array.isArray(rows) ? rows : []
    setData(showArchived ? arr : arr.filter((p: any) => !p.archived))
  }
  useEffect(() => {
    load()
    getJson(`${API_BASE}/config/dictionaries`).then((j) => setDicts(j || {}))
    getJson(`${API_BASE}/landlords`).then((j) => setLandlords(Array.isArray(j) ? j : []))
  }, [showArchived])
  useEffect(() => { setMounted(true) }, [])

  async function fetchAddrSuggestions(input: string) {
    const q = input.trim()
    if (!q) { setAddrOptions([]); return }
    try {
      const u = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=8&countrycodes=au&q=${encodeURIComponent(q + ' Melbourne VIC Australia')}`
      const res = await fetch(u, { headers: { 'Accept-Language': 'en' } })
      const rows = await res.json().catch(() => [])
      const opts = (rows || []).map((r: any) => {
        const a = r.address || {}
        const num = a.house_number || ''
        const road = a.road || a.pedestrian || a.cycleway || ''
        const suburb = a.suburb || a.neighbourhood || a.town || a.city || 'Melbourne'
        const state = a.state || 'VIC'
        const pc = a.postcode || ''
        const formatted = `${[num, road].filter(Boolean).join(' ')}${road || num ? ', ' : ''}${suburb}, ${state}${pc ? ' ' + pc : ''}, Australia`
        return { value: formatted, label: formatted }
      })
      setAddrOptions(opts)
    } catch { setAddrOptions([]) }
  }

  function handleAddrSearch(input: string) {
    if (addrTimer) clearTimeout(addrTimer)
    const t = setTimeout(() => fetchAddrSuggestions(input), 250)
    setAddrTimer(t)
  }

  async function submitCreate() {
    const v = await form.validateFields()
    const bedroomCount = getBedroomCount(v.type)
    const beds = (v.bedrooms || []).slice(0, bedroomCount)
    const bed_config = beds.map((b: string, i: number) => `Bedroom ${i + 1}: ${b || ''}`).join('; ')
    const airbnb_listing_name = v.listing_airbnb || ''
    const booking_listing_name = v.listing_booking || ''
    const listing_names = { other: v.listing_other || '' }
    if (![airbnb_listing_name, booking_listing_name, listing_names.other].some(x => String(x || '').trim())) { message.error('请至少填写一个平台的 Listing 名称'); return }
    const payload = { code: v.code, address: v.address, type: v.type, capacity: v.capacity, region: v.region === '其他' ? (v.region_other || '') : v.region, area_sqm: v.area_sqm, landlord_id: v.landlord_id, biz_category: v.biz_category, bed_config, aircon_model: v.aircon_model, bedroom_ac: v.bedroom_ac, access_guide_link: v.access_guide_link, garage_guide_link: v.garage_guide_link, building_name: v.building_name, building_facilities: v.building_facilities, building_facility_other: v.building_facility_other, building_contact_name: v.building_contact_name, building_contact_phone: v.building_contact_phone, building_contact_email: v.building_contact_email, tv_model: v.tv_model, notes: v.notes, listing_names, airbnb_listing_name, booking_listing_name }
    const res = await fetch(`${API_BASE}/properties`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(payload) })
    if (res.ok) { message.success('房源已创建'); setOpen(false); form.resetFields(); load() }
    else { let msg = '创建失败'; try { const j = await res.json(); if (j?.message) msg = j.message } catch { try { msg = await res.text() } catch {} } message.error(msg) }
  }

  async function openEdit(record: Property) {
    setCurrent(record)
    const full = await fetch(`${API_BASE}/properties/${record.id}`).then(r => r.json()).catch(() => record)
    setEditOpen(true)
    editForm.setFieldsValue({ ...full, listing_airbnb: full?.airbnb_listing_name || '', listing_booking: full?.booking_listing_name || '', listing_other: full?.listing_names?.other || '' })
    setTypeEdit(full?.type)
  }

  async function deleteProperty(id: string) {
    const res = await fetch(`${API_BASE}/properties/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` } })
    if (res.ok) { message.success('房源已归档'); load() } else { const m = await res.json().catch(() => null); message.error(m?.message || '归档失败') }
  }

  function confirmDelete(record: Property) {
    Modal.confirm({
      title: '确认归档',
      content: `是否确认归档房源：${record.code || record.address}？`,
      okText: '归档',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => deleteProperty(record.id),
    })
  }

  async function openDetail(id: string) {
    const r = await getJson(`${API_BASE}/properties/${id}`)
    setDetail(r || {})
    setDetailOpen(true)
  }

  async function submitEdit() {
    const v = await editForm.validateFields()
    const bedroomCount = getBedroomCount(v.type)
    const beds = (v.bedrooms || []).slice(0, bedroomCount)
    const bed_config = beds.map((b: string, i: number) => `Bedroom ${i + 1}: ${b || ''}`).join('; ')
    const airbnb_listing_name = v.listing_airbnb || ''
    const booking_listing_name = v.listing_booking || ''
    const listing_names = { other: v.listing_other || '' }
    if (![airbnb_listing_name, booking_listing_name, listing_names.other].some(x => String(x || '').trim())) { message.error('请至少填写一个平台的 Listing 名称'); return }
    const payload = { ...v, region: v.region === '其他' ? (v.region_other || '') : v.region, bed_config, listing_names, airbnb_listing_name, booking_listing_name }
    const res = await fetch(`${API_BASE}/properties/${current?.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(payload) })
    if (res.ok) { message.success('房源已更新'); setEditOpen(false); load() } else { message.error('更新失败') }
  }

  async function submitBatch() {
    const v = await batchForm.validateFields().catch(() => null)
    if (!v) return
    const payload: any = {}
    Object.entries(v).forEach(([k, val]) => {
      if (Array.isArray(val)) { if (val.length) payload[k] = val }
      else if (typeof val === 'string') { const t = val.trim(); if (t) payload[k] = t }
      else if (val !== undefined && val !== null) { payload[k] = val }
    })
    if (!Object.keys(payload).length) { message.warning('请至少填写一个要修改的字段'); return }
    const ids = selectedRowKeys.map(String)
    const results = await Promise.all(ids.map(id => submitPatch(id, payload)))
    const okCount = results.filter(Boolean).length
    message.success(`批量更新完成：成功 ${okCount} 条，失败 ${results.length - okCount} 条`)
    setBatchOpen(false); batchForm.resetFields(); setSelectedRowKeys([]); load()
  }

  const canWrite = hasPerm('properties.write') || hasPerm('property.write')
  const columns = [
    { title: '房号', dataIndex: 'code' },
    { title: '地址', dataIndex: 'address' },
    { title: '房型', dataIndex: 'type' },
    { title: '分类', dataIndex: 'biz_category', render: (v: string) => v === 'leased' ? '包租房源' : (v === 'management_fee' ? '管理费房源' : '-') },
    { title: '可住人数', dataIndex: 'capacity' },
    { title: '区域', dataIndex: 'region' },
    { title: '面积(㎡)', dataIndex: 'area_sqm' },
    { title: '操作', render: (_: any, r: Property) => (
      <Space>
        <Button onClick={() => openDetail(r.id)}>详情</Button>
        {canWrite && <Button onClick={() => openEdit(r)}>编辑</Button>}
        {canWrite && <Button danger onClick={() => confirmDelete(r)}>归档</Button>}
      </Space>
    ) },
  ]

  if (!mounted) return null
  return (
    <ErrorBoundary>
    <Card title="房源列表" extra={
      <Space>
        <span>显示归档</span>
        <Switch checked={showArchived} onChange={setShowArchived as any} />
        <Select allowClear placeholder="按区域筛选" value={regionFilter} onChange={setRegionFilter as any} style={{ width: 160 }} options={[{value:'Melbourne',label:'Melbourne'},{value:'Southbank',label:'Southbank'},{value:'South Melbourne',label:'South Melbourne'},{value:'West Melbourne',label:'West Melbourne'},{value:'St Kilda',label:'St Kilda'},{value:'Docklands',label:'Docklands'},{value:'未分区',label:'未分区'}]} />
        <Input.Search allowClear placeholder="搜索房源" onSearch={setQuery} onChange={(e) => setQuery(e.target.value)} style={{ width: 260 }} />
        {canWrite && <Button type="primary" onClick={() => setOpen(true)}>新建房源</Button>}
      </Space>
    }>
      {(() => {
        const q = query.trim().toLowerCase()
        const known = ['Melbourne','Southbank','South Melbourne','West Melbourne','St Kilda','Docklands']
        const matchQuery = (p: any) => {
          if (!q) return true
          return (
            (p.code || '').toLowerCase().includes(q) ||
            (p.address || '').toLowerCase().includes(q) ||
            (p.region || '').toLowerCase().includes(q) ||
            (p.type || '').toLowerCase().includes(q)
          )
        }
        const matchRegion = (p: any) => {
          if (!regionFilter) return true
          if (regionFilter === '未分区') return !p.region || String(p.region) === '其他'
          return String(p.region) === regionFilter
        }
        function cmpCode(a?: string, b?: string) {
          const A = String(a || '').trim().toUpperCase()
          const B = String(b || '').trim().toUpperCase()
          if (!A && !B) return 0
          if (!A) return 1
          if (!B) return -1
          const isDigitA = /\d/.test(A[0] || '')
          const isDigitB = /\d/.test(B[0] || '')
          if (isDigitA !== isDigitB) return isDigitA ? -1 : 1
          const tok = (s: string) => s.match(/\d+|[A-Z]+|[^A-Z0-9]+/g) || []
          const ta = tok(A)
          const tb = tok(B)
          const n = Math.min(ta.length, tb.length)
          for (let i = 0; i < n; i++) {
            const xa = ta[i]
            const xb = tb[i]
            const da = /^\d+$/.test(xa)
            const db = /^\d+$/.test(xb)
            if (da && db) {
              const va = Number(xa)
              const vb = Number(xb)
              if (va !== vb) return va - vb
            } else {
              const c = xa.localeCompare(xb)
              if (c !== 0) return c
            }
          }
          if (ta.length !== tb.length) return ta.length - tb.length
          return A.localeCompare(B)
        }
        const rows = data.filter(p => matchQuery(p) && matchRegion(p)).slice().sort((a,b)=> cmpCode(a.code, b.code))
        if (regionFilter) {
          return (
            <Table rowKey={(r:any)=>r.id} columns={columns as any} dataSource={rows} rowSelection={canWrite ? { selectedRowKeys, onChange: setSelectedRowKeys as any } : undefined} pagination={{ pageSize: 10 }} />
          )
        }
        const groups: { name: string, rows: any[] }[] = []
        const used = new Set<string>()
        for (const r of known) {
          const rs = rows.filter(x => String(x.region || '') === r).slice().sort((a,b)=> cmpCode(a.code, b.code))
          if (rs.length) { groups.push({ name: r, rows: rs }); used.add(r) }
        }
        const uniques = Array.from(new Set(rows.map(x => String(x.region || '未分区'))))
          .filter(name => name && name !== '其他' && !used.has(name) && name !== '未分区')
          .sort()
        for (const name of uniques) {
          const rs = rows.filter(x => String(x.region || '') === name).slice().sort((a,b)=> cmpCode(a.code, b.code))
          if (rs.length) groups.push({ name, rows: rs })
        }
        const unknown = rows.filter(x => !x.region || String(x.region) === '其他').slice().sort((a,b)=> cmpCode(a.code, b.code))
        if (unknown.length) groups.push({ name: '未分区', rows: unknown })
        return groups.map(g => (
          <div key={g.name}>
            <Divider orientation="left">{g.name}</Divider>
            <Table rowKey={(r:any)=>r.id} columns={columns as any} dataSource={g.rows} rowSelection={canWrite ? { selectedRowKeys, onChange: setSelectedRowKeys as any } : undefined} pagination={{ pageSize: 10 }} />
          </div>
        ))
      })()}
      {canWrite && (
        <Space style={{ marginTop: 12 }}>
          <Button disabled={!selectedRowKeys.length} onClick={() => setBatchOpen(true)}>批量编辑（已选 {selectedRowKeys.length} 条）</Button>
          {selectedRowKeys.length > 0 && <Button onClick={() => setSelectedRowKeys([])}>清空选择</Button>}
        </Space>
      )}
      <Modal open={open} onCancel={() => setOpen(false)} onOk={submitCreate} title="新建房源" width={900}>
        <Form form={form} layout="vertical">
          <Divider orientation="left">房源基础信息</Divider>
          <Row gutter={[16,16]}>
            <Col span={8}><Form.Item name="code" label="房号" rules={[{ required: true, message: '房号必填' }]}><Input placeholder="请输入房号" /></Form.Item></Col>
            <Col span={8}><Form.Item name="landlord_id" label="房源隶属房东"><Select allowClear options={landlords.map(l => ({ value: l.id, label: l.name }))} /></Form.Item></Col>
            <Col span={8}><Form.Item name="region" label="房源区域划分" rules={[{ required: true }]}>
              <Select options={[{value:'Melbourne',label:'Melbourne'},{value:'Southbank',label:'Southbank'},{value:'South Melbourne',label:'South Melbourne'},{value:'West Melbourne',label:'West Melbourne'},{value:'St Kilda',label:'St Kilda'},{value:'Docklands',label:'Docklands'},{value:'其他',label:'其他'}]} />
            </Form.Item></Col>
            <Form.Item noStyle shouldUpdate={(prev, cur) => prev.region !== cur.region}>
              {() => (form.getFieldValue('region') === '其他' ? (
                <Col span={8}><Form.Item name="region_other" label="其他区域"><Input /></Form.Item></Col>
              ) : null)}
            </Form.Item>
            <Col span={8}><Form.Item name="biz_category" label="房源分类" rules={[{ required: true, message: '请选择房源分类' }]}>
              <Select options={[{ value:'leased', label:'包租房源' }, { value:'management_fee', label:'管理费房源' }]} />
            </Form.Item></Col>
            <Col span={8}><Form.Item name="listing_airbnb" label="Airbnb Listing 名称"><Input placeholder="Airbnb上展示的Listing标题" /></Form.Item></Col>
            <Col span={8}><Form.Item name="listing_booking" label="Booking.com Listing 名称"><Input placeholder="Booking.com 上展示的Listing标题" /></Form.Item></Col>
            <Col span={8}><Form.Item name="listing_other" label="其他平台 Listing 名称"><Input placeholder="其他平台的Listing标题" /></Form.Item></Col>
            <Col span={24}><Form.Item name="address" label="房源地址（墨尔本）" rules={[{ required: true }]}> 
              <AutoComplete
                options={addrOptions}
                onSearch={handleAddrSearch}
                onSelect={(v) => form.setFieldsValue({ address: v })}
                style={{ width: '100%' }}
              >
                <Input placeholder="输入街道和门牌号，自动提示格式化地址" />
              </AutoComplete>
            </Form.Item></Col>
            <Col span={8}><Form.Item name="type" label="房型分类" rules={[{ required: true }]}><Select onChange={(v) => setTypeSel(v)} options={[{value:'一房一卫',label:'一房一卫'},{value:'两房一卫',label:'两房一卫'},{value:'两房两卫',label:'两房两卫'},{value:'三房两卫',label:'三房两卫'},{value:'三房三卫',label:'三房三卫'}]} /></Form.Item></Col>
            <Col span={8}><Form.Item name="capacity" label="可住人数" rules={[{ required: true }]}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="area_sqm" label="房源面积(㎡)"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="access_guide_link" label="入住指南链接"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="garage_guide_link" label="车库指南链接"><Input /></Form.Item></Col>
            {Array.from({ length: getBedroomCount(typeSel) || 0 }).map((_, i) => (
              <Col span={8} key={i}>
                <Form.Item name={['bedrooms', i]} label={`Bedroom ${i + 1} 床型`}>
                  <Select placeholder="选择床型" options={[{value:'Queen',label:'Queen'},{value:'King',label:'King'},{value:'Double',label:'Double'}]} />
                </Form.Item>
              </Col>
            ))}
          </Row>
          <Divider orientation="left">房源大楼信息</Divider>
          <Row gutter={[16,16]}>
            <Col span={12}><Form.Item name="building_name" label="大楼名称"><Input /></Form.Item></Col>
            <Col span={12}><Form.Item name="building_facilities" label="大楼设施"><Select mode="multiple" options={[...((dicts.facilities||[]).filter((v:string)=> !['elevator','parking'].includes(v.toLowerCase()))).map((v:string)=>({value:v,label:v})),{value:'Sauna',label:'Sauna'},{value:'Spa',label:'Spa'},{value:'其他',label:'其他'}]} /></Form.Item></Col>
            <Form.Item noStyle shouldUpdate={(prev, cur) => JSON.stringify(prev.building_facilities) !== JSON.stringify(cur.building_facilities)}>
              {() => (Array.isArray(form.getFieldValue('building_facilities')) && form.getFieldValue('building_facilities').includes('其他') ? (
                <Col span={12}><Form.Item name="building_facility_other" label="其他设施"><Input /></Form.Item></Col>
              ) : null)}
            </Form.Item>
            <Col span={8}><Form.Item name="building_facility_floor" label="设施所在楼层"><Input placeholder="如：LG/Level 2" /></Form.Item></Col>
            <Col span={8}><Form.Item name="building_contact_phone" label="大楼经理电话"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="building_contact_email" label="大楼经理邮箱"><Input /></Form.Item></Col>
            <Col span={24}><Form.Item name="building_notes" label="大楼其他备注"><Input.TextArea rows={2} /></Form.Item></Col>
          </Row>
          <Divider orientation="left">房源其他信息</Divider>
          <Row gutter={[16,16]}>
            <Col span={8}><Form.Item name="tv_model" label="电视型号"><Input placeholder="品牌/型号" /></Form.Item></Col>
            <Col span={8}><Form.Item name="aircon_model" label="空调型号"><Input placeholder="空调品牌/型号" /></Form.Item></Col>
            <Col span={8}><Form.Item name="bedroom_ac" label="卧室空调">
              <Select options={[{value:'none',label:'无'},{value:'master_only',label:'主卧有'},{value:'both',label:'两个卧室都有'}]} />
            </Form.Item></Col>
            <Col span={8}><Form.Item name="orientation" label="房源朝向"><Select allowClear options={[{value:'N',label:'北'},{value:'S',label:'南'},{value:'E',label:'东'},{value:'W',label:'西'},{value:'NE',label:'东北'},{value:'NW',label:'西北'},{value:'SE',label:'东南'},{value:'SW',label:'西南'}]} /></Form.Item></Col>
            <Col span={8}><Form.Item name="fireworks_view" label="可看新年烟花" valuePropName="checked"><Switch /></Form.Item></Col>
            <Col span={24}><Form.Item name="notes" label="其他备注"><Input.TextArea rows={3} /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>
      <Drawer title="房源详情" width={800} onClose={() => setDetailOpen(false)} open={detailOpen}>
        {detail && (
          <>
            <Descriptions title="房源基础信息" bordered column={2} labelStyle={{ width: '120px' }}>
              <Descriptions.Item label="房号">{detail.code}</Descriptions.Item>
              <Descriptions.Item label="房东">{landlords.find(l => l.id === detail.landlord_id)?.name || '-'}</Descriptions.Item>
              <Descriptions.Item label="区域">{detail.region}</Descriptions.Item>
              <Descriptions.Item label="房源分类">{detail.biz_category === 'leased' ? '包租房源' : (detail.biz_category === 'management_fee' ? '管理费房源' : '-')}</Descriptions.Item>
              <Descriptions.Item label="地址" span={2}>{detail.address}</Descriptions.Item>
              <Descriptions.Item label="房型">{detail.type}</Descriptions.Item>
              <Descriptions.Item label="可住人数">{detail.capacity} 人</Descriptions.Item>
              <Descriptions.Item label="面积">{detail.area_sqm ? `${detail.area_sqm} ㎡` : '-'}</Descriptions.Item>
              <Descriptions.Item label="卧室空调">{detail.bedroom_ac === 'none' ? '无' : (detail.bedroom_ac === 'master_only' ? '主卧有' : (detail.bedroom_ac === 'both' ? '两个卧室都有' : '-'))}</Descriptions.Item>
              <Descriptions.Item label="Airbnb Listing" span={2}>{detail.airbnb_listing_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Booking Listing" span={2}>{detail.booking_listing_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="其他 Listing" span={2}>{detail.listing_names?.other || '-'}</Descriptions.Item>
              <Descriptions.Item label="入住指南" span={2}>{detail.access_guide_link ? <a href={detail.access_guide_link} target="_blank" rel="noreferrer">{detail.access_guide_link}</a> : '-'}</Descriptions.Item>
              <Descriptions.Item label="车库指南" span={2}>{detail.garage_guide_link ? <a href={detail.garage_guide_link} target="_blank" rel="noreferrer">{detail.garage_guide_link}</a> : '-'}</Descriptions.Item>
              <Descriptions.Item label="床型配置" span={2}>{detail.bed_config || '-'}</Descriptions.Item>
            </Descriptions>

            <Divider orientation="left">大楼信息</Divider>
            <Descriptions bordered column={2} labelStyle={{ width: '120px' }}>
              <Descriptions.Item label="大楼名称">{detail.building_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="设施楼层">{detail.building_facility_floor || '-'}</Descriptions.Item>
              <Descriptions.Item label="大楼设施" span={2}>
                {(detail.building_facilities || []).length > 0 ? (
                  <Space wrap>
                    {(detail.building_facilities || []).map((f: string) => (<Tag key={f}>{f}</Tag>))}
                  </Space>
                ) : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="经理电话">{detail.building_contact_phone || '-'}</Descriptions.Item>
              <Descriptions.Item label="经理邮箱">{detail.building_contact_email || '-'}</Descriptions.Item>
              <Descriptions.Item label="大楼备注" span={2} style={{ whiteSpace: 'pre-wrap' }}>{detail.building_notes || '-'}</Descriptions.Item>
            </Descriptions>

            <Divider orientation="left">其他信息</Divider>
            <Descriptions bordered column={2} labelStyle={{ width: '120px' }}>
              <Descriptions.Item label="电视型号">{detail.tv_model || '-'}</Descriptions.Item>
              <Descriptions.Item label="空调型号">{detail.aircon_model || '-'}</Descriptions.Item>
              <Descriptions.Item label="朝向">{detail.orientation || '-'}</Descriptions.Item>
              <Descriptions.Item label="看烟花">{detail.fireworks_view ? '是' : '否'}</Descriptions.Item>
              <Descriptions.Item label="其他备注" span={2} style={{ whiteSpace: 'pre-wrap' }}>{detail.notes || '-'}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{detail.created_at || '-'}</Descriptions.Item>
              <Descriptions.Item label="最后修改">{detail.updated_at || '-'}</Descriptions.Item>
              <Descriptions.Item label="修改人">{detail.updated_by_name || detail.updated_by || '-'}</Descriptions.Item>
            </Descriptions>
          </>
        )}
      </Drawer>
      <Drawer
        title="编辑房源"
        width={800}
        onClose={() => setEditOpen(false)}
        open={editOpen}
        footer={
          <div style={{ textAlign: 'right' }}>
            <Space>
              <Button onClick={() => setEditOpen(false)}>取消</Button>
              <Button type="primary" onClick={submitEdit}>保存</Button>
            </Space>
          </div>
        }
      >
        <Form form={editForm} layout="vertical">
          <Divider orientation="left">房源基础信息</Divider>
          <Row gutter={[16,16]}>
            <Col span={8}><Form.Item name="code" label="房号" rules={[{ required: true, message: '房号必填' }]}><Input placeholder="请输入房号" /></Form.Item></Col>
            <Col span={8}><Form.Item name="landlord_id" label="房东"><Select allowClear options={landlords.map(l => ({ value: l.id, label: l.name }))} /></Form.Item></Col>
            <Col span={8}><Form.Item name="region" label="区域" rules={[{ required: true }]}>
              <Select options={[{value:'Melbourne',label:'Melbourne'},{value:'Southbank',label:'Southbank'},{value:'South Melbourne',label:'South Melbourne'},{value:'West Melbourne',label:'West Melbourne'},{value:'St Kilda',label:'St Kilda'},{value:'Docklands',label:'Docklands'},{value:'其他',label:'其他'}]} />
            </Form.Item></Col>
            <Form.Item noStyle shouldUpdate={(prev, cur) => prev.region !== cur.region}>
              {() => (editForm.getFieldValue('region') === '其他' ? (
                <Col span={8}><Form.Item name="region_other" label="其他区域"><Input /></Form.Item></Col>
              ) : null)}
            </Form.Item>
            <Col span={8}><Form.Item name="biz_category" label="房源分类" rules={[{ required: true, message: '请选择房源分类' }]}>
              <Select options={[{ value:'leased', label:'包租房源' }, { value:'management_fee', label:'管理费房源' }]} />
            </Form.Item></Col>
            <Col span={8}><Form.Item name="listing_airbnb" label="Airbnb Listing 名称"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="listing_booking" label="Booking.com Listing 名称"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="listing_other" label="其他平台 Listing 名称"><Input /></Form.Item></Col>
            <Col span={24}><Form.Item name="address" label="地址" rules={[{ required: true }]}> 
              <AutoComplete
                options={addrOptions}
                onSearch={handleAddrSearch}
                onSelect={(v) => editForm.setFieldsValue({ address: v })}
                style={{ width: '100%' }}
              >
                <Input placeholder="输入街道和门牌号，自动提示格式化地址" />
              </AutoComplete>
            </Form.Item></Col>
            <Col span={8}><Form.Item name="type" label="房型" rules={[{ required: true }]}><Select onChange={(v) => setTypeEdit(v)} options={[{value:'一房一卫',label:'一房一卫'},{value:'两房一卫',label:'两房一卫'},{value:'两房两卫',label:'两房两卫'},{value:'三房两卫',label:'三房两卫'},{value:'三房三卫',label:'三房三卫'}]} /></Form.Item></Col>
            <Col span={8}><Form.Item name="capacity" label="可住人数" rules={[{ required: true }]}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="area_sqm" label="面积(㎡)"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="access_guide_link" label="入住指南链接"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="garage_guide_link" label="车库指南链接"><Input /></Form.Item></Col>
            {Array.from({ length: getBedroomCount(typeEdit) || 0 }).map((_, i) => (
              <Col span={8} key={i}><Form.Item name={['bedrooms', i]} label={`Bedroom ${i + 1} 床型`}><Select placeholder="选择床型" options={[{value:'Queen',label:'Queen'},{value:'King',label:'King'},{value:'Double',label:'Double'}]} /></Form.Item></Col>
            ))}
          </Row>
          <Divider orientation="left">房源大楼信息</Divider>
          <Row gutter={[16,16]}>
            <Col span={12}><Form.Item name="building_name" label="大楼名称"><Input /></Form.Item></Col>
            <Col span={12}><Form.Item name="building_facilities" label="大楼设施"><Select mode="multiple" options={[...((dicts.facilities||[]).filter((v:string)=> !['elevator','parking'].includes(v.toLowerCase()))).map((v:string)=>({value:v,label:v})),{value:'Sauna',label:'Sauna'},{value:'Spa',label:'Spa'},{value:'其他',label:'其他'}]} /></Form.Item></Col>
            <Form.Item noStyle shouldUpdate={(prev, cur) => JSON.stringify(prev.building_facilities) !== JSON.stringify(cur.building_facilities)}>
              {() => (Array.isArray(editForm.getFieldValue('building_facilities')) && editForm.getFieldValue('building_facilities').includes('其他') ? (
                <Col span={12}><Form.Item name="building_facility_other" label="其他设施"><Input /></Form.Item></Col>
              ) : null)}
            </Form.Item>
            <Col span={8}><Form.Item name="building_facility_floor" label="设施所在楼层"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="building_contact_phone" label="大楼经理电话"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="building_contact_email" label="大楼经理邮箱"><Input /></Form.Item></Col>
            <Col span={24}><Form.Item name="building_notes" label="大楼其他备注"><Input.TextArea rows={2} /></Form.Item></Col>
          </Row>
          <Divider orientation="left">房源其他信息</Divider>
          <Row gutter={[16,16]}>
            <Col span={8}><Form.Item name="tv_model" label="电视型号"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="aircon_model" label="空调型号"><Input placeholder="空调品牌/型号" /></Form.Item></Col>
            <Col span={8}><Form.Item name="bedroom_ac" label="卧室空调">
              <Select options={[{value:'none',label:'无'},{value:'master_only',label:'主卧有'},{value:'both',label:'两个卧室都有'}]} />
            </Form.Item></Col>
            <Col span={8}><Form.Item name="orientation" label="房源朝向"><Select allowClear options={[{value:'N',label:'北'},{value:'S',label:'南'},{value:'E',label:'东'},{value:'W',label:'西'},{value:'NE',label:'东北'},{value:'NW',label:'西北'},{value:'SE',label:'东南'},{value:'SW',label:'西南'}]} /></Form.Item></Col>
            <Col span={8}><Form.Item name="fireworks_view" label="可看新年烟花" valuePropName="checked"><Switch /></Form.Item></Col>
            <Col span={24}><Form.Item name="notes" label="其他备注"><Input.TextArea rows={3} /></Form.Item></Col>
          </Row>
        </Form>
      </Drawer>
      <Modal open={batchOpen} onCancel={() => setBatchOpen(false)} onOk={submitBatch} title="批量编辑房源" width={800}>
        <Form form={batchForm} layout="vertical">
          <Divider orientation="left">批量修改字段（不填则不修改）</Divider>
          <Row gutter={[16,16]}>
            <Col span={24}><Form.Item name="address" label="地址"><Input placeholder="统一更新为此地址" /></Form.Item></Col>
            <Col span={12}><Form.Item name="building_name" label="大楼名称"><Input /></Form.Item></Col>
            <Col span={12}><Form.Item name="building_facility_floor" label="设施所在楼层"><Input placeholder="如：LG/Level 2" /></Form.Item></Col>
            <Col span={12}><Form.Item name="building_contact_phone" label="大楼经理电话"><Input /></Form.Item></Col>
            <Col span={12}><Form.Item name="building_contact_email" label="大楼经理邮箱"><Input /></Form.Item></Col>
            <Col span={24}><Form.Item name="building_facilities" label="大楼设施"><Select mode="multiple" options={(dicts.facilities || []).map((v: string) => ({ value: v, label: v }))} /></Form.Item></Col>
            <Col span={24}><Form.Item name="building_notes" label="大楼备注"><Input.TextArea rows={2} /></Form.Item></Col>
            <Col span={24}><Form.Item name="notes" label="房源备注"><Input.TextArea rows={3} /></Form.Item></Col>
          </Row>
          <Divider />
          <Space><Tag color="blue">将对 {selectedRowKeys.length} 条房源应用以上非空字段</Tag></Space>
        </Form>
      </Modal>
    </Card>
    </ErrorBoundary>
  )
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean }>{
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch() {}
  render() { return this.state.hasError ? <Card>页面加载失败</Card> : this.props.children }
}

async function submitPatch(id: string, payload: any) {
  try {
    const res = await fetch(`${API_BASE}/properties/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(payload) })
    return res.ok
  } catch { return false }
}
