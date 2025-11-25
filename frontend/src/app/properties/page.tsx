"use client"
import { Table, Card, Button, Modal, Form, Input, InputNumber, Select, message, Space, Row, Col, Tag, Divider, Switch, AutoComplete } from 'antd'
import React, { useEffect, useState } from 'react'
import { API_BASE } from '../../lib/api'

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
    const payload = { code: v.code, address: v.address, type: v.type, capacity: v.capacity, region: v.region, area_sqm: v.area_sqm, landlord_id: v.landlord_id, bed_config, aircon_model: v.aircon_model, access_guide_link: v.access_guide_link, garage_guide_link: v.garage_guide_link, building_name: v.building_name, building_facilities: v.building_facilities, building_contact_name: v.building_contact_name, building_contact_phone: v.building_contact_phone, building_contact_email: v.building_contact_email, tv_model: v.tv_model, notes: v.notes }
    const res = await fetch(`${API_BASE}/properties`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(payload) })
    if (res.ok) { message.success('房源已创建'); setOpen(false); form.resetFields(); load() }
    else { let msg = '创建失败'; try { const j = await res.json(); if (j?.message) msg = j.message } catch { try { msg = await res.text() } catch {} } message.error(msg) }
  }

  async function openEdit(record: Property) {
    setCurrent(record)
    const full = await fetch(`${API_BASE}/properties/${record.id}`).then(r => r.json()).catch(() => record)
    setEditOpen(true)
    editForm.setFieldsValue(full)
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
    const payload = { ...v, bed_config }
    const res = await fetch(`${API_BASE}/properties/${current?.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(payload) })
    if (res.ok) { message.success('房源已更新'); setEditOpen(false); load() } else { message.error('更新失败') }
  }

  const columns = [
    { title: '房号', dataIndex: 'code' },
    { title: '地址', dataIndex: 'address' },
    { title: '房型', dataIndex: 'type' },
    { title: '可住人数', dataIndex: 'capacity' },
    { title: '区域', dataIndex: 'region' },
    { title: '面积(㎡)', dataIndex: 'area_sqm' },
    { title: '操作', render: (_: any, r: Property) => (<Space><Button onClick={() => openDetail(r.id)}>详情</Button><Button onClick={() => openEdit(r)}>编辑</Button><Button danger onClick={() => confirmDelete(r)}>归档</Button></Space>) },
  ]

  if (!mounted) return null
  return (
    <ErrorBoundary>
    <Card title="房源列表" extra={
      <Space>
        <span>显示归档</span>
        <Switch checked={showArchived} onChange={setShowArchived as any} />
        <Input.Search allowClear placeholder="搜索房源" onSearch={setQuery} onChange={(e) => setQuery(e.target.value)} style={{ width: 260 }} />
        <Button type="primary" onClick={() => setOpen(true)}>新建房源</Button>
      </Space>
    }>
      <Table
        rowKey={(r) => r.id}
        columns={columns as any}
        dataSource={data.filter(p => {
          const q = query.trim().toLowerCase()
          if (!q) return true
          return (
            (p.code || '').toLowerCase().includes(q) ||
            (p.address || '').toLowerCase().includes(q) ||
            (p.region || '').toLowerCase().includes(q) ||
            (p.type || '').toLowerCase().includes(q)
          )
        })}
        pagination={{ pageSize: 10 }}
      />
      <Modal open={open} onCancel={() => setOpen(false)} onOk={submitCreate} title="新建房源" width={900}>
        <Form form={form} layout="vertical">
          <Divider orientation="left">房源基础信息</Divider>
          <Row gutter={[16,16]}>
            <Col span={8}><Form.Item name="code" label="房号"><Input placeholder="留空自动生成" /></Form.Item></Col>
            <Col span={8}><Form.Item name="landlord_id" label="房源隶属房东"><Select allowClear options={landlords.map(l => ({ value: l.id, label: l.name }))} /></Form.Item></Col>
            <Col span={8}><Form.Item name="region" label="房源区域划分"><Select options={(dicts.regions || []).map((v: string) => ({ value: v, label: v }))} /></Form.Item></Col>
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
            <Col span={12}><Form.Item name="building_facilities" label="大楼设施"><Select mode="multiple" options={(dicts.facilities || []).map((v: string) => ({ value: v, label: v }))} /></Form.Item></Col>
            <Col span={8}><Form.Item name="building_facility_floor" label="设施所在楼层"><Input placeholder="如：LG/Level 2" /></Form.Item></Col>
            <Col span={8}><Form.Item name="building_contact_phone" label="大楼经理电话"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="building_contact_email" label="大楼经理邮箱"><Input /></Form.Item></Col>
            <Col span={24}><Form.Item name="building_notes" label="大楼其他备注"><Input.TextArea rows={2} /></Form.Item></Col>
          </Row>
          <Divider orientation="left">房源其他信息</Divider>
          <Row gutter={[16,16]}>
            <Col span={8}><Form.Item name="tv_model" label="电视型号"><Input placeholder="品牌/型号" /></Form.Item></Col>
            <Col span={8}><Form.Item name="aircon_model" label="空调型号"><Input placeholder="空调品牌/型号" /></Form.Item></Col>
            <Col span={8}><Form.Item name="orientation" label="房源朝向"><Select allowClear options={[{value:'N',label:'北'},{value:'S',label:'南'},{value:'E',label:'东'},{value:'W',label:'西'},{value:'NE',label:'东北'},{value:'NW',label:'西北'},{value:'SE',label:'东南'},{value:'SW',label:'西南'}]} /></Form.Item></Col>
            <Col span={8}><Form.Item name="fireworks_view" label="可看新年烟花" valuePropName="checked"><Switch /></Form.Item></Col>
            <Col span={24}><Form.Item name="notes" label="其他备注"><Input.TextArea rows={3} /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>
      <Modal open={detailOpen} onCancel={() => setDetailOpen(false)} footer={null} title="房源详情" width={900}>
        <Form layout="vertical" initialValues={detail || {}}>
          <Divider orientation="left">房源基础信息</Divider>
          <Row gutter={[16,16]}>
            <Col span={8}><Form.Item label="房号"><Input value={detail?.code} readOnly /></Form.Item></Col>
            <Col span={8}><Form.Item label="房东"><Input value={(landlords.find(l => l.id === detail?.landlord_id)?.name) || ''} readOnly /></Form.Item></Col>
            <Col span={8}><Form.Item label="区域"><Input value={detail?.region} readOnly /></Form.Item></Col>
            <Col span={24}><Form.Item label="地址"><Input value={detail?.address} readOnly /></Form.Item></Col>
            <Col span={8}><Form.Item label="房型"><Input value={detail?.type} readOnly /></Form.Item></Col>
            <Col span={8}><Form.Item label="可住人数"><Input value={detail?.capacity?.toString()} readOnly /></Form.Item></Col>
            <Col span={8}><Form.Item label="面积(㎡)"><Input value={detail?.area_sqm?.toString()} readOnly /></Form.Item></Col>
            <Col span={8}><Form.Item label="入住指南链接"><Input value={detail?.access_guide_link} readOnly /></Form.Item></Col>
            <Col span={8}><Form.Item label="车库指南链接"><Input value={detail?.garage_guide_link} readOnly /></Form.Item></Col>
            <Col span={8}><Form.Item label="床型配置"><Input value={detail?.bed_config} readOnly /></Form.Item></Col>
          </Row>
          <Divider orientation="left">房源大楼信息</Divider>
          <Row gutter={[16,16]}>
            <Col span={12}><Form.Item label="大楼名称"><Input value={detail?.building_name} readOnly /></Form.Item></Col>
            <Col span={12}><Form.Item label="大楼设施">
              <Space wrap>
                {(detail?.building_facilities || []).map((f: string) => (<Tag key={f}>{f}</Tag>))}
              </Space>
            </Form.Item></Col>
            <Col span={8}><Form.Item label="经理电话"><Input value={detail?.building_contact_phone} readOnly /></Form.Item></Col>
            <Col span={8}><Form.Item label="经理邮箱"><Input value={detail?.building_contact_email} readOnly /></Form.Item></Col>
            <Col span={8}><Form.Item label="设施楼层"><Input value={detail?.building_facility_floor} readOnly /></Form.Item></Col>
            <Col span={24}><Form.Item label="大楼备注"><Input.TextArea value={detail?.building_notes || ''} readOnly rows={2} /></Form.Item></Col>
          </Row>
          <Divider orientation="left">房源其他信息</Divider>
          <Row gutter={[16,16]}>
            <Col span={8}><Form.Item label="电视型号"><Input value={detail?.tv_model} readOnly /></Form.Item></Col>
            <Col span={8}><Form.Item label="空调型号"><Input value={detail?.aircon_model} readOnly /></Form.Item></Col>
            <Col span={8}><Form.Item label="朝向"><Input value={detail?.orientation || ''} readOnly /></Form.Item></Col>
            <Col span={8}><Form.Item label="可看烟花"><Input value={detail?.fireworks_view ? '是' : '否'} readOnly /></Form.Item></Col>
            <Col span={24}><Form.Item label="其他备注"><Input.TextArea value={detail?.notes || ''} readOnly rows={3} /></Form.Item></Col>
          </Row>
          <Space>
            <Tag>创建时间: {detail?.created_at || ''}</Tag>
            <Tag>最后修改: {detail?.updated_at || ''}</Tag>
          </Space>
        </Form>
      </Modal>
      <Modal open={editOpen} onCancel={() => setEditOpen(false)} onOk={submitEdit} title="编辑房源" width={900}>
        <Form form={editForm} layout="vertical">
          <Divider orientation="left">房源基础信息</Divider>
          <Row gutter={[16,16]}>
            <Col span={8}><Form.Item label="房号"><Input value={editForm.getFieldValue('code') || ''} readOnly /></Form.Item></Col>
            <Col span={8}><Form.Item name="landlord_id" label="房东"><Select allowClear options={landlords.map(l => ({ value: l.id, label: l.name }))} /></Form.Item></Col>
            <Col span={8}><Form.Item name="region" label="区域"><Select options={(dicts.regions || []).map((v: string) => ({ value: v, label: v }))} /></Form.Item></Col>
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
            <Col span={12}><Form.Item name="building_facilities" label="大楼设施"><Select mode="multiple" options={(dicts.facilities || []).map((v: string) => ({ value: v, label: v }))} /></Form.Item></Col>
            <Col span={8}><Form.Item name="building_facility_floor" label="设施所在楼层"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="building_contact_phone" label="大楼经理电话"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="building_contact_email" label="大楼经理邮箱"><Input /></Form.Item></Col>
            <Col span={24}><Form.Item name="building_notes" label="大楼其他备注"><Input.TextArea rows={2} /></Form.Item></Col>
          </Row>
          <Divider orientation="left">房源其他信息</Divider>
          <Row gutter={[16,16]}>
            <Col span={8}><Form.Item name="tv_model" label="电视型号"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="aircon_model" label="空调型号"><Input placeholder="空调品牌/型号" /></Form.Item></Col>
            <Col span={8}><Form.Item name="orientation" label="房源朝向"><Select allowClear options={[{value:'N',label:'北'},{value:'S',label:'南'},{value:'E',label:'东'},{value:'W',label:'西'},{value:'NE',label:'东北'},{value:'NW',label:'西北'},{value:'SE',label:'东南'},{value:'SW',label:'西南'}]} /></Form.Item></Col>
            <Col span={8}><Form.Item name="fireworks_view" label="可看新年烟花" valuePropName="checked"><Switch /></Form.Item></Col>
            <Col span={24}><Form.Item name="notes" label="其他备注"><Input.TextArea rows={3} /></Form.Item></Col>
          </Row>
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