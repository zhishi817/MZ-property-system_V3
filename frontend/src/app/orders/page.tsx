"use client"
import { Table, Card, Space, Button, Modal, Form, Input, DatePicker, message, Select, Tag, InputNumber, Checkbox } from 'antd'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { API_BASE, getJSON, authHeaders } from '../../lib/api'
import { hasPerm } from '../../lib/auth'

type Order = { id: string; source?: string; checkin?: string; checkout?: string; status?: string; property_id?: string; property_code?: string; guest_name?: string; price?: number; cleaning_fee?: number; net_income?: number; avg_nightly_price?: number; nights?: number }
type CleaningTask = { id: string; status: 'pending'|'scheduled'|'done' }

export default function OrdersPage() {
  const [data, setData] = useState<Order[]>([])
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const [editOpen, setEditOpen] = useState(false)
  const [editForm] = Form.useForm()
  const [current, setCurrent] = useState<Order | null>(null)
  const [codeQuery, setCodeQuery] = useState('')
  const [dateRange, setDateRange] = useState<[any, any] | null>(null)
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string }[]>([])

  async function load() {
    const res = await getJSON<Order[]>('/orders')
    setData(res)
  }
  useEffect(() => { load(); getJSON<any>('/properties').then((j) => setProperties(Array.isArray(j) ? j : [])).catch(() => setProperties([])) }, [])

  async function openEdit(o: Order) {
    setCurrent(o)
    // 先展示弹窗并填充当前行数据，提升交互稳定性
    setEditOpen(true)
    const pid0 = o.property_id
    const p0 = (Array.isArray(properties) ? properties : []).find(x => x.id === pid0)
    editForm.setFieldsValue({
      ...o,
      property_id: pid0,
      property_code: p0 ? (p0.code || p0.address || pid0) : o.property_code,
      price: o.price != null ? o.price : 0,
      cleaning_fee: o.cleaning_fee != null ? o.cleaning_fee : 0,
      checkin: o.checkin ? dayjs(o.checkin) : undefined,
      checkout: o.checkout ? dayjs(o.checkout) : undefined,
    })
    // 再异步拉取完整数据并二次填充（失败时保持现有值）
    try {
      const full = await getJSON<Order>(`/orders/${o.id}`)
      const pid = full.property_id
      const p = (Array.isArray(properties) ? properties : []).find(x => x.id === pid)
      editForm.setFieldsValue({
        ...full,
        property_id: pid,
        property_code: p ? (p.code || p.address || pid) : full.property_code,
        price: full.price != null ? full.price : 0,
        cleaning_fee: full.cleaning_fee != null ? full.cleaning_fee : 0,
        checkin: full.checkin ? dayjs(full.checkin) : undefined,
        checkout: full.checkout ? dayjs(full.checkout) : undefined,
      })
    } catch {
      message.warning('加载订单详情失败，使用列表数据进行编辑')
    }
  }

  async function genCleaning(id: string) {
    const res = await fetch(`${API_BASE}/orders/${id}/generate-cleaning`, { method: 'POST' })
    if (res.ok) { message.success('已生成清洁任务') } else { message.error('生成失败') }
  }

  async function submitCreate() {
    const v = await form.validateFields()
    const nights = v.checkin && v.checkout ? Math.max(0, dayjs(v.checkout).diff(dayjs(v.checkin), 'day')) : 0
    const price = Number(v.price || 0)
    const cleaning = Number(v.cleaning_fee || 0)
    const lateFee = v.late_checkout ? 20 : Number(v.late_checkout_fee || 0)
    const cancelFee = Number(v.cancel_fee || 0)
    const net = Math.max(0, price + lateFee + cancelFee - cleaning)
    const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0
    const selectedNew = (Array.isArray(properties) ? properties : []).find(p => p.id === v.property_id)
    const payload = {
      source: v.source,
      status: v.status || 'confirmed',
      property_id: v.property_id,
      property_code: v.property_code || selectedNew?.code || selectedNew?.address || v.property_id,
      guest_name: v.guest_name,
      checkin: v.checkin.format('YYYY-MM-DD'),
      checkout: v.checkout.format('YYYY-MM-DD'),
      price,
      cleaning_fee: cleaning,
      net_income: net,
      avg_nightly_price: avg,
      nights,
      currency: 'AUD',
    }
    const res = await fetch(`${API_BASE}/orders/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload) })
    if (res.status === 201) {
      const created = await res.json()
      async function writeIncome(amount: number, cat: string, note: string) {
        if (!amount || amount <= 0) return
        const tx = { kind: 'income', amount: Number(amount), currency: 'AUD', occurred_at: v.checkout.format('YYYY-MM-DD'), note, category: cat, property_id: v.property_id, ref_type: 'order', ref_id: created?.id }
        await fetch(`${API_BASE}/finance`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(tx) }).catch(() => {})
      }
      await writeIncome(lateFee, 'late_checkout', 'Late checkout income')
      if ((v.status || '') === 'canceled') await writeIncome(cancelFee, 'cancel_fee', 'Cancelation fee')
      message.success('订单已创建'); setOpen(false); form.resetFields(); load()
    }
    else if (res.status === 200) {
      message.error('订单已存在')
    } else {
      let msg = '创建失败'
      try { const j = await res.json(); if (j?.message) msg = j.message } catch { try { msg = await res.text() } catch {} }
      message.error(msg)
    }
  }

  const columns = [
    { title: '房号', dataIndex: 'property_code' },
    { title: '来源', dataIndex: 'source' },
    { title: '客人', dataIndex: 'guest_name' },
    { title: '入住', dataIndex: 'checkin' },
    { title: '退房', dataIndex: 'checkout' },
    { title: '天数', dataIndex: 'nights' },
    { title: '总租金(AUD)', dataIndex: 'price' },
    { title: '清洁费', dataIndex: 'cleaning_fee' },
    { title: '总收入', dataIndex: 'net_income' },
    { title: '晚均价', dataIndex: 'avg_nightly_price' },
    { title: '状态', dataIndex: 'status' },
    { title: '操作', render: (_: any, r: Order) => (
      <Space>
        <Button onClick={() => openEdit(r)}>编辑</Button>
        <Button danger onClick={() => {
          Modal.confirm({
            title: '确认删除订单',
            content: `确定删除订单（房号：${r.property_code || ''}，入住：${r.checkin || ''}）？`,
            okText: '删除',
            okType: 'danger',
            cancelText: '取消',
            onOk: async () => {
              const res = await fetch(`${API_BASE}/orders/${r.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
              if (res.ok) { message.success('订单已删除'); load() } else { message.error('删除失败') }
            }
          })
        }}>删除</Button>
      </Space>
    ) },
  ]

  return (
    <Card title="订单管理" extra={hasPerm('order.sync') ? <Button type="primary" onClick={() => setOpen(true)}>新建订单</Button> : null}>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input placeholder="按房号搜索" allowClear value={codeQuery} onChange={(e) => setCodeQuery(e.target.value)} style={{ width: 200 }} />
        <DatePicker.RangePicker onChange={(v) => setDateRange(v as any)} />
      </Space>
      <Table rowKey={(r) => r.id} columns={columns as any} dataSource={data.filter(o => {
        const codeOk = !codeQuery || (o.property_code || '').toLowerCase().includes(codeQuery.trim().toLowerCase())
        const rangeOk = !dateRange || (!dateRange[0] || dayjs(o.checkin).diff(dateRange[0], 'day') >= 0) && (!dateRange[1] || dayjs(o.checkout).diff(dateRange[1], 'day') <= 0)
        return codeOk && rangeOk
      })} pagination={{ pageSize: 10 }} scroll={{ x: 'max-content' }} />
      <Modal open={open} onCancel={() => setOpen(false)} onOk={submitCreate} title="新建订单">
      <Form form={form} layout="vertical">
        <Form.Item name="source" label="来源" rules={[{ required: true }]}> 
          <Select options={[{ value: 'airbnb', label: 'airbnb' }, { value: 'booking', label: 'booking.com' }, { value: 'offline', label: '线下' }, { value: 'other', label: '其他' }]} />
        </Form.Item>
        <Form.Item name="status" label="状态" initialValue="confirmed"> 
          <Select options={[{ value: 'confirmed', label: '已确认' }, { value: 'canceled', label: '已取消' }]} />
        </Form.Item>
        <Form.Item name="property_id" label="房号" rules={[{ required: true }]}> 
          <Select
            showSearch
            optionFilterProp="label"
            options={(Array.isArray(properties) ? properties : []).map(p => ({ value: p.id, label: p.code || p.address || p.id }))}
            onChange={(val, opt) => {
              const label = (opt as any)?.label || ''
              form.setFieldsValue({ property_code: label })
            }}
          />
        </Form.Item>
        <Form.Item name="property_code" hidden><Input /></Form.Item>
        <Form.Item name="guest_name" label="客人姓名">
          <Input />
        </Form.Item>
        <Form.Item name="checkin" label="入住" rules={[{ required: true }]}> 
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="checkout" label="退房" rules={[{ required: true }]}> 
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="price" label="总租金(AUD)" rules={[{ required: true }]}> 
          <InputNumber min={0} step={1} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="cleaning_fee" label="清洁费" rules={[{ required: true }]}> 
          <InputNumber min={0} step={1} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="晚退收入">
          <Space>
            <Form.Item name="late_checkout" valuePropName="checked" noStyle>
              <Checkbox>晚退(+20)</Checkbox>
            </Form.Item>
            <Form.Item name="late_checkout_fee" noStyle>
              <InputNumber min={0} step={1} placeholder="自定义金额(可选)" />
            </Form.Item>
          </Space>
        </Form.Item>
        <Form.Item shouldUpdate>
          {() => {
            const st = form.getFieldValue('status')
            if (st === 'canceled') {
              return (
                <Form.Item name="cancel_fee" label="取消费(AUD)">
                  <InputNumber min={0} step={1} style={{ width: '100%' }} />
                </Form.Item>
              )
            }
            return null
          }}
        </Form.Item>
        <Form.Item shouldUpdate noStyle>
          {() => {
            const v = form.getFieldsValue()
            const nights = v.checkin && v.checkout ? Math.max(0, dayjs(v.checkout).diff(dayjs(v.checkin), 'day')) : 0
            const price = Number(v.price || 0)
            const cleaning = Number(v.cleaning_fee || 0)
            const lateFee = v.late_checkout ? 20 : Number(v.late_checkout_fee || 0)
            const cancelFee = Number(v.cancel_fee || 0)
            const net = Math.max(0, price + lateFee + cancelFee - cleaning)
            const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0
            return (
              <Card size="small" style={{ marginTop: 8 }}>
                <Space wrap>
                  <Tag color="blue">入住天数: {nights}</Tag>
                  <Tag color="green">总收入: {net}</Tag>
                  {v.late_checkout || v.late_checkout_fee ? <Tag color="purple">晚退收入: {lateFee}</Tag> : null}
                  {v.cancel_fee ? <Tag color="orange">取消费: {cancelFee}</Tag> : null}
                  <Tag color="purple">晚均价: {avg}</Tag>
                </Space>
              </Card>
            )
          }}
        </Form.Item>
      </Form>
    </Modal>
    <Modal open={editOpen} onCancel={() => setEditOpen(false)} onOk={async () => {
        const v = await editForm.validateFields()
        const nights = v.checkin && v.checkout ? Math.max(0, dayjs(v.checkout).diff(dayjs(v.checkin), 'day')) : 0
        const price = Number(v.price || 0)
        const cleaning = Number(v.cleaning_fee || 0)
        const net = Math.max(0, price - cleaning)
        const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0
        const selectedEdit = (Array.isArray(properties) ? properties : []).find(p => p.id === v.property_id)
        const payload = { ...v, property_code: (v.property_code || selectedEdit?.code || selectedEdit?.address || v.property_id), checkin: dayjs(v.checkin).format('YYYY-MM-DD'), checkout: dayjs(v.checkout).format('YYYY-MM-DD'), nights, net_income: net, avg_nightly_price: avg }
        const res = await fetch(`${API_BASE}/orders/${current?.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload) })
        if (res.ok) {
          async function writeIncome(amount: number, cat: string, note: string) {
            if (!amount || amount <= 0) return
            const tx = { kind: 'income', amount: Number(amount), currency: 'AUD', occurred_at: dayjs(v.checkout).format('YYYY-MM-DD'), note, category: cat, property_id: v.property_id, ref_type: 'order', ref_id: current?.id }
            await fetch(`${API_BASE}/finance`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(tx) }).catch(() => {})
          }
          const lateFee = v.late_checkout ? 20 : Number(v.late_checkout_fee || 0)
          const cancelFee = Number(v.cancel_fee || 0)
          await writeIncome(lateFee, 'late_checkout', 'Late checkout income')
          if ((v.status || '') === 'canceled') await writeIncome(cancelFee, 'cancel_fee', 'Cancelation fee')
          message.success('订单已更新'); setEditOpen(false); load()
        }
        else {
          let msg = '更新失败'
          try { const j = await res.json(); if (j?.message) msg = j.message } catch { try { msg = await res.text() } catch {} }
          message.error(msg)
        }
      }} title="编辑订单">
        <Form form={editForm} layout="vertical">
          <Form.Item name="source" label="来源" rules={[{ required: true }]}>
            <Select options={[{ value: 'airbnb', label: 'airbnb' }, { value: 'booking', label: 'booking.com' }, { value: 'offline', label: '线下' }, { value: 'other', label: '其他' }]} />
          </Form.Item>
          <Form.Item name="property_id" label="房号" rules={[{ required: true }]}> 
            <Select
              showSearch
              optionFilterProp="label"
              options={(Array.isArray(properties) ? properties : []).map(p => ({ value: p.id, label: p.code || p.address || p.id }))}
              onChange={(val, opt) => {
                const label = (opt as any)?.label || ''
                editForm.setFieldsValue({ property_code: label })
              }}
            />
          </Form.Item>
          <Form.Item name="property_code" hidden><Input /></Form.Item>
          <Form.Item name="guest_name" label="客人姓名"><Input /></Form.Item>
          <Form.Item name="checkin" label="入住" rules={[{ required: true }]}><DatePicker style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="checkout" label="退房" rules={[{ required: true }]}><DatePicker style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="price" label="总租金(AUD)"><InputNumber min={0} step={1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="cleaning_fee" label="清洁费"><InputNumber min={0} step={1} style={{ width: '100%' }} /></Form.Item>
        </Form>
    </Modal>
    </Card>
  )
}
  async function taskStatus(orderId: string) {
    const res = await fetch(`${API_BASE}/cleaning/order/${orderId}`)
    const tasks: CleaningTask[] = await res.json()
    if (!tasks.length) return <Tag>无任务</Tag>
    const anyScheduled = tasks.some(t => t.status === 'scheduled')
    const allDone = tasks.every(t => t.status === 'done')
    if (allDone) return <Tag color="green">已完成</Tag>
    if (anyScheduled) return <Tag color="blue">已排班</Tag>
    return <Tag color="orange">待安排</Tag>
  }
