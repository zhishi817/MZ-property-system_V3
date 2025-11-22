"use client"
import { Table, Card, Button, Modal, Form, Input, InputNumber, Space, message, Select, Tag } from 'antd'
import { useEffect, useState } from 'react'
import { API_BASE } from '../../lib/api'
import { hasPerm } from '../../lib/auth'

type Landlord = {
  id: string
  name: string
  phone?: string
  email?: string
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
  const [properties, setProperties] = useState<{ id: string; address: string }[]>([])
  const [query, setQuery] = useState('')

  async function load() {
    const res = await fetch(`${API_BASE}/landlords`).then(r => r.json())
    setData(res)
  }
  useEffect(() => { load() }, [])
  useEffect(() => { fetch(`${API_BASE}/properties`).then(r => r.json()).then(setProperties).catch(() => setProperties([])) }, [])
  useEffect(() => { setMounted(true) }, [])

  async function submitCreate() {
    const v = await form.validateFields()
    const res = await fetch(`${API_BASE}/landlords`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(v) })
    if (res.ok) { message.success('房东已创建'); setOpen(false); form.resetFields(); load() }
    else {
      let msg = '创建失败'
      try { const j = await res.json(); if (j?.message) msg = j.message } catch { try { msg = await res.text() } catch {} }
      message.error(msg)
    }
  }

  function openEdit(record: Landlord) { setCurrent(record); setEditOpen(true); editForm.setFieldsValue(record) }
  async function submitEdit() {
    const v = await editForm.validateFields()
    const res = await fetch(`${API_BASE}/landlords/${current?.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(v) })
    if (res.ok) { message.success('房东已更新'); setEditOpen(false); load() }
    else {
      let msg = '更新失败'
      try { const j = await res.json(); if (j?.message) msg = j.message } catch { try { msg = await res.text() } catch {} }
      message.error(msg)
    }
  }

  async function openDetail(id: string) {
    const r = await fetch(`${API_BASE}/landlords/${id}`).then(r => r.json())
    setDetail(r)
    setDetailOpen(true)
  }

  async function submitDelete() {
    if (!current) return
    const res = await fetch(`${API_BASE}/landlords/${current.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` } })
    if (res.ok) { message.success('房东已删除'); setCurrent(null); load() } else { const m = await res.json().catch(() => null); message.error(m?.message || '删除失败') }
  }

  function confirmDelete(record: Landlord) {
    setCurrent(record)
    Modal.confirm({
      title: '确认删除',
      content: `是否确认删除房东：${record.name}？此操作不可恢复。`,
      okText: '删除',
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
    if (res.ok) { message.success('删除口令已更新'); setSetPwdOpen(false); pwdForm.resetFields() }
    else { const m = await res.json().catch(() => null); message.error(m?.message || '更新失败') }
  }

  const columns = [
    { title: '姓名', dataIndex: 'name', ellipsis: true, responsive: ['xs','sm','md','lg','xl'] },
    { title: '联系方式', dataIndex: 'phone', ellipsis: true, responsive: ['xs','sm','md','lg','xl'] },
    { title: '邮箱', dataIndex: 'email', ellipsis: true, responsive: ['sm','md','lg','xl'] },
    { title: '管理费', dataIndex: 'management_fee_rate', render: (v: number) => (v != null ? `${(v * 100).toFixed(0)}%` : ''), responsive: ['sm','md','lg','xl'] },
    { title: 'BSB', dataIndex: 'payout_bsb', ellipsis: true, responsive: ['md','lg','xl'] },
    { title: '银行账户', dataIndex: 'payout_account', ellipsis: true, responsive: ['md','lg','xl'] },
    { title: '房源', dataIndex: 'property_ids', render: (ids: string[]) => (
      <Space wrap>
        {(ids || []).map(id => {
          const p = properties.find(x => x.id === id)
          return <Tag key={id}>{p ? p.address : id}</Tag>
        })}
      </Space>
    ), responsive: ['lg','xl'] },
    { title: '操作', fixed: 'right', render: (_: any, r: Landlord) => (
      <Space wrap>
        <Button size="small" onClick={() => openDetail(r.id)}>详情</Button>
        {hasPerm('landlord.manage') && <Button size="small" onClick={() => { setCurrent(r); setEditOpen(true); editForm.setFieldsValue(r) }}>编辑</Button>}
        {hasPerm('landlord.manage') && <Button size="small" danger onClick={() => confirmDelete(r)}>删除</Button>}
      </Space>
    ), responsive: ['xs','sm','md','lg','xl'] },
  ]

  if (!mounted) return null
  return (
    <Card title="房东管理" extra={
      <Space>
        <Input.Search allowClear placeholder="搜索房东" onSearch={setQuery} onChange={(e) => setQuery(e.target.value)} style={{ width: 240 }} />
        {hasPerm('landlord.manage') && <Button type="primary" onClick={() => setOpen(true)}>新增房东</Button>}
      </Space>
    }>
      <Table
        rowKey={(r) => r.id}
        columns={columns as any}
        dataSource={data.filter(l => {
          const q = query.trim().toLowerCase()
          if (!q) return true
          return (
            (l.name || '').toLowerCase().includes(q) ||
            (l.phone || '').toLowerCase().includes(q) ||
            (l.email || '').toLowerCase().includes(q)
          )
        })}
        pagination={{ pageSize: 10 }}
        size="small"
        scroll={{ x: 'max-content' }}
      />
      <Modal open={open} onCancel={() => setOpen(false)} onOk={submitCreate} title="新增房东">
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="房东姓名" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="phone" label="联系方式"><Input /></Form.Item>
          <Form.Item name="email" label="邮箱"><Input /></Form.Item>
          <Form.Item name="management_fee_rate" label="管理费">
            <InputNumber
              min={0}
              max={1}
              step={0.01}
              style={{ width: '100%' }}
              formatter={(value) => (value !== null && value !== undefined ? `${Math.round(Number(value) * 100)}%` : '')}
              parser={(value) => {
                const s = (value || '').toString().replace(/\s|%/g, '')
                const n = parseFloat(s)
                return isNaN(n) ? 0 : n / 100
              }}
            />
          </Form.Item>
          <Form.Item name="payout_bsb" label="BSB"><Input /></Form.Item>
          <Form.Item name="payout_account" label="银行账户"><Input /></Form.Item>
          <Form.Item name="property_ids" label="被管理的房源">
            <Select mode="multiple" placeholder="选择房源" options={properties.map(p => ({ value: p.id, label: p.address }))} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal open={editOpen} onCancel={() => setEditOpen(false)} onOk={submitEdit} title="编辑房东">
        <Form form={editForm} layout="vertical">
          <Form.Item name="name" label="房东姓名" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="phone" label="联系方式"><Input /></Form.Item>
          <Form.Item name="email" label="邮箱"><Input /></Form.Item>
          <Form.Item name="management_fee_rate" label="管理费">
            <InputNumber
              min={0}
              max={1}
              step={0.01}
              style={{ width: '100%' }}
              formatter={(value) => (value !== null && value !== undefined ? `${Math.round(Number(value) * 100)}%` : '')}
              parser={(value) => {
                const s = (value || '').toString().replace(/\s|%/g, '')
                const n = parseFloat(s)
                return isNaN(n) ? 0 : n / 100
              }}
            />
          </Form.Item>
          <Form.Item name="payout_bsb" label="BSB"><Input /></Form.Item>
          <Form.Item name="payout_account" label="银行账户"><Input /></Form.Item>
          <Form.Item name="property_ids" label="被管理的房源">
            <Select mode="multiple" placeholder="选择房源" options={properties.map(p => ({ value: p.id, label: p.address }))} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal open={detailOpen} onCancel={() => setDetailOpen(false)} footer={null} title="房东详情">
        <Form layout="vertical" initialValues={detail || {}}>
          <Form.Item label="房东姓名"><Input value={detail?.name} readOnly /></Form.Item>
          <Form.Item label="联系方式"><Input value={detail?.phone} readOnly /></Form.Item>
          <Form.Item label="邮箱"><Input value={detail?.email} readOnly /></Form.Item>
          <Form.Item label="管理费"><Input value={detail?.management_fee_rate != null ? `${(detail.management_fee_rate * 100).toFixed(0)}%` : ''} readOnly /></Form.Item>
          <Form.Item label="BSB"><Input value={detail?.payout_bsb} readOnly /></Form.Item>
          <Form.Item label="银行账户"><Input value={detail?.payout_account} readOnly /></Form.Item>
          <Form.Item label="房源">
            <Space wrap>
              {(detail?.property_ids || []).map(id => {
                const p = properties.find(x => x.id === id)
                return <Tag key={id}>{p ? p.address : id}</Tag>
              })}
            </Space>
          </Form.Item>
        </Form>
      </Modal>
      
      
    </Card>
  )
}