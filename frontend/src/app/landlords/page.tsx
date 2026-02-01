"use client"
import { Table, Card, Button, Modal, Form, Input, InputNumber, Space, message, Select, Tag, Switch, Drawer, Descriptions, Divider, Row, Col } from 'antd'
import { useEffect, useState } from 'react'
import { API_BASE, getJSON } from '../../lib/api'
import { sortProperties, cmpPropertyCode } from '../../lib/properties'
import { hasPerm } from '../../lib/auth'

type Landlord = {
  id: string
  name: string
  phone?: string
  email?: string
  emails?: string[]
  management_fee_rate?: number
  payout_bsb?: string
  payout_account?: string
  property_ids?: string[]
}

export default function LandlordsPage() {
  const [mounted, setMounted] = useState(false)
  const [data, setData] = useState<Landlord[]>([])
  const [open, setOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [form] = Form.useForm()
  const [editForm] = Form.useForm()
  const [current, setCurrent] = useState<Landlord | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detail, setDetail] = useState<Landlord | null>(null)
  const [pwdForm] = Form.useForm()
  const [properties, setProperties] = useState<{ id: string; address?: string; code?: string }[]>([])
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  async function load() {
    const res = await getJSON<any>(`/landlords?include_archived=${showArchived ? 'true' : 'false'}`).catch(() => [])
    const arr = Array.isArray(res) ? res : []
    setData(showArchived ? arr : arr.filter((l: any) => !l.archived))
  }
  useEffect(() => { load() }, [showArchived])
  useEffect(() => { getJSON<any>('/properties').then((j) => setProperties(Array.isArray(j) ? j : [])).catch(() => setProperties([])) }, [])
  useEffect(() => { setMounted(true) }, [])

  async function submitCreate() {
    const v = await form.validateFields()
    const emails = Array.isArray((v as any).emails) ? (v as any).emails.filter(Boolean) : ((v as any).email ? [(v as any).email] : [])
    const payload = { ...v, emails }
    delete (payload as any).email
    const res = await fetch(`${API_BASE}/landlords`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(payload) })
    if (res.ok) { message.success('房东已创建'); setOpen(false); form.resetFields(); load() }
    else {
      let msg = '创建失败'
      try { const j = await res.json(); if (j?.message) msg = j.message } catch { try { msg = await res.text() } catch {} }
      message.error(msg)
    }
  }

  function openEdit(record: Landlord) {
    setCurrent(record); setEditOpen(true)
    const rr: any = record as any
    const emails = Array.isArray(rr.emails) ? rr.emails : (record.email ? [record.email] : [])
    editForm.setFieldsValue({ ...record, emails })
  }
  async function submitEdit() {
    const v = await editForm.validateFields()
    const emails = Array.isArray((v as any).emails) ? (v as any).emails.filter(Boolean) : ((v as any).email ? [(v as any).email] : [])
    const payload = { ...v, emails }
    delete (payload as any).email
    const res = await fetch(`${API_BASE}/landlords/${current?.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(payload) })
    if (res.ok) { message.success('房东已更新'); setEditOpen(false); load() }
    else {
      let msg = '更新失败'
      try { const j = await res.json(); if (j?.message) msg = j.message } catch { try { msg = await res.text() } catch {} }
      message.error(msg)
    }
  }

  async function openDetail(id: string) {
    const r = await getJSON<any>(`/landlords/${id}`).catch(() => null)
    setDetail(r)
    setDetailOpen(true)
  }

  async function submitDelete() {
    if (!current) return
    const res = await fetch(`${API_BASE}/landlords/${current.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` } })
    if (res.ok) { message.success('房东已归档'); setCurrent(null); load() } else { const m = await res.json().catch(() => null); message.error(m?.message || '归档失败') }
  }

  function confirmDelete(record: Landlord) {
    setCurrent(record)
    Modal.confirm({
      title: '确认归档',
      content: `是否确认归档房东：${record.name}？`,
      okText: '归档',
      okType: 'danger',
      cancelText: '取消',
      onOk: submitDelete,
    })
  }

  async function submitDeletePassword() {
    const v = await pwdForm.validateFields()
    const res = await fetch(`${API_BASE}/auth/delete-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
      body: JSON.stringify({ password: v.password })
    })
    if (res.ok) { message.success('删除口令已更新'); pwdForm.resetFields() }
    else { const m = await res.json().catch(() => null); message.error(m?.message || '更新失败') }
  }

  const columns = [
    { title: '姓名', dataIndex: 'name', ellipsis: true, responsive: ['xs','sm','md','lg','xl'] },
    { title: '联系方式', dataIndex: 'phone', ellipsis: true, responsive: ['xs','sm','md','lg','xl'] },
    { title: '邮箱', dataIndex: 'emails', ellipsis: true, responsive: ['sm','md','lg','xl'], render: (_: any, r: Landlord) => {
      const rr: any = r as any
      const arr = Array.isArray(rr.emails) ? rr.emails : (r.email ? [r.email] : [])
      return arr.length ? arr.join(', ') : ''
    } },
    { title: '管理费', dataIndex: 'management_fee_rate', render: (v: number) => (v != null ? `${(v * 100).toFixed(1)}%` : ''), responsive: ['sm','md','lg','xl'] },
    { title: 'BSB', dataIndex: 'payout_bsb', ellipsis: true, responsive: ['md','lg','xl'] },
    { title: '银行账户', dataIndex: 'payout_account', ellipsis: true, responsive: ['md','lg','xl'] },
    { title: '房源', dataIndex: 'property_ids', render: (ids: string[]) => (
      <Space wrap>
        {((ids || []).slice().sort((a,b)=> {
          const pa = properties.find(x=> x.id===a)
          const pb = properties.find(x=> x.id===b)
          return cmpPropertyCode(pa?.code, pb?.code)
        })).map(id => {
          const p = properties.find(x => x.id === id)
          const label = p ? (p.code || p.address || id) : id
          return <Tag key={id}>{label}</Tag>
        })}
      </Space>
    ), responsive: ['lg','xl'] },
    { title: '操作', fixed: 'right', render: (_: any, r: Landlord) => (
      <Space>
        <Button onClick={() => openDetail(r.id)}>详情</Button>
        {hasPerm('landlord.manage') && <Button onClick={() => openEdit(r)}>编辑</Button>}
        {hasPerm('landlord.manage') && <Button danger onClick={() => confirmDelete(r)}>归档</Button>}
      </Space>
    ), responsive: ['xs','sm','md','lg','xl'] },
  ]

  if (!mounted) return null
  return (
    <Card title="房东管理" extra={
      <Space>
        <span>显示归档</span>
        <Switch checked={showArchived} onChange={setShowArchived as any} />
        <Input.Search allowClear placeholder="搜索房东" onSearch={setQuery} onChange={(e) => setQuery(e.target.value)} style={{ width: 240 }} />
        <Button type="primary" disabled={!hasPerm('landlord.manage')} onClick={() => setOpen(true)}>新增房东</Button>
      </Space>
    }>
      <Table
        rowKey={(r) => r.id}
        columns={columns as any}
        dataSource={(Array.isArray(data) ? data : []).filter(l => {
          const q = query.trim().toLowerCase()
          if (!q) return true
          const propLabels = (l.property_ids || []).map(id => {
            const p = properties.find(x => x.id === id)
            return (p?.code || p?.address || id || '').toLowerCase()
          })
          return (
            (l.name || '').toLowerCase().includes(q) ||
            (l.phone || '').toLowerCase().includes(q) ||
            ((Array.isArray((l as any).emails) ? (l as any).emails.join(',') : (l.email || '')).toLowerCase().includes(q)) ||
            propLabels.some(s => s.includes(q))
          )
        })}
        pagination={{ pageSize: 10 }}
        size="small"
        scroll={{ x: 'max-content' }}
      />
      <Modal open={open} onCancel={() => setOpen(false)} onOk={submitCreate} title="新增房东" width={600}>
        <Form form={form} layout="vertical">
          <Divider orientation="left">基础信息</Divider>
          <Row gutter={16}>
            <Col span={12}><Form.Item name="name" label="房东姓名" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={12}><Form.Item name="phone" label="联系方式"><Input /></Form.Item></Col>
            <Col span={24}><Form.Item name="emails" label="邮箱" rules={[{ validator: (_, v) => (Array.isArray(v) ? v : []).every((x: any) => !x || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(x))) ? Promise.resolve() : Promise.reject('邮箱格式不正确') }]}>
              <Select mode="tags" tokenSeparators={[',',';',' ']} open={false} placeholder="输入后按回车，可添加多个邮箱" />
            </Form.Item></Col>
          </Row>
          <Divider orientation="left">财务信息</Divider>
          <Row gutter={16}>
            <Col span={8}><Form.Item name="management_fee_rate" label="管理费率">
              <InputNumber<number> min={0} max={1} step={0.001} precision={3} style={{ width: '100%' }} formatter={value => `${(Number(value) * 100).toFixed(1)}%`} parser={value => Number(value?.replace('%', '')) / 100} />
            </Form.Item></Col>
            <Col span={8}><Form.Item name="payout_bsb" label="BSB"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="payout_account" label="银行账户"><Input /></Form.Item></Col>
          </Row>
          <Divider orientation="left">管理房源</Divider>
          <Form.Item name="property_ids" label="关联房源">
            <Select
              mode="multiple"
              placeholder="选择房源"
              showSearch
              optionFilterProp="label"
              filterOption={(input, option)=> String((option as any)?.label||'').toLowerCase().includes(String(input||'').toLowerCase())}
              options={sortProperties(Array.isArray(properties)?properties:[]).map(p=>({ value: p.id, label: (p.code || p.address || p.id) }))}
            />
          </Form.Item>
        </Form>
      </Modal>
      <Drawer
        title="编辑房东"
        width={600}
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
          <Divider orientation="left">基础信息</Divider>
          <Row gutter={16}>
            <Col span={12}><Form.Item name="name" label="房东姓名" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={12}><Form.Item name="phone" label="联系方式"><Input /></Form.Item></Col>
            <Col span={24}><Form.Item name="emails" label="邮箱" rules={[{ validator: (_, v) => (Array.isArray(v) ? v : []).every((x: any) => !x || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(x))) ? Promise.resolve() : Promise.reject('邮箱格式不正确') }]}>
              <Select mode="tags" tokenSeparators={[',',';',' ']} open={false} placeholder="输入后按回车，可添加多个邮箱" />
            </Form.Item></Col>
          </Row>
          <Divider orientation="left">财务信息</Divider>
          <Row gutter={16}>
            <Col span={8}><Form.Item name="management_fee_rate" label="管理费率">
              <InputNumber<number> min={0} max={1} step={0.001} precision={3} style={{ width: '100%' }} formatter={value => `${(Number(value) * 100).toFixed(1)}%`} parser={value => Number(value?.replace('%', '')) / 100} />
            </Form.Item></Col>
            <Col span={8}><Form.Item name="payout_bsb" label="BSB"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="payout_account" label="银行账户"><Input /></Form.Item></Col>
          </Row>
          <Divider orientation="left">管理房源</Divider>
          <Form.Item name="property_ids" label="关联房源">
            <Select
              mode="multiple"
              placeholder="选择房源"
              showSearch
              optionFilterProp="label"
              filterOption={(input, option)=> String((option as any)?.label||'').toLowerCase().includes(String(input||'').toLowerCase())}
              options={sortProperties(Array.isArray(properties)?properties:[]).map(p=>({ value: p.id, label: (p.code || p.address || p.id) }))}
            />
          </Form.Item>
        </Form>
      </Drawer>
      <Drawer title="房东详情" width={600} onClose={() => setDetailOpen(false)} open={detailOpen}>
        {detail && (
          <>
            <Descriptions title="基础信息" bordered column={1} labelStyle={{ width: '120px' }}>
              <Descriptions.Item label="姓名">{detail.name}</Descriptions.Item>
              <Descriptions.Item label="联系方式">{detail.phone || '-'}</Descriptions.Item>
              <Descriptions.Item label="邮箱">
                {(Array.isArray(detail.emails) ? detail.emails : (detail.email ? [detail.email] : [])).join(', ') || '-'}
              </Descriptions.Item>
            </Descriptions>
            
            <Divider orientation="left">财务信息</Divider>
            <Descriptions bordered column={1} labelStyle={{ width: '120px' }}>
              <Descriptions.Item label="管理费率">{detail.management_fee_rate != null ? `${(detail.management_fee_rate * 100).toFixed(1)}%` : '-'}</Descriptions.Item>
              <Descriptions.Item label="BSB">{detail.payout_bsb || '-'}</Descriptions.Item>
              <Descriptions.Item label="银行账户">{detail.payout_account || '-'}</Descriptions.Item>
            </Descriptions>

            <Divider orientation="left">管理房源</Divider>
            <Space wrap>
              {((detail.property_ids || []).slice().sort((a,b)=> {
                const pa = properties.find(x=> x.id===a)
                const pb = properties.find(x=> x.id===b)
                return cmpPropertyCode(pa?.code, pb?.code)
              })).map(id => {
                const p = (Array.isArray(properties) ? properties : []).find(x => x.id === id)
                const label = p ? (p.code || p.address || id) : id
                return <Tag key={id}>{label}</Tag>
              })}
              {(!detail.property_ids || detail.property_ids.length === 0) && <span>暂无管理房源</span>}
            </Space>
          </>
        )}
      </Drawer>
      
      
    </Card>
  )
}
