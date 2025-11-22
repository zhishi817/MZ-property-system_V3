"use client"
import { Table, Card, Space, Button, Modal, Form, Input, DatePicker, message, Select, Tag } from 'antd'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { API_BASE, getJSON } from '../../lib/api'
import { hasPerm } from '../../lib/auth'

type Order = { id: string; source?: string; checkin?: string; checkout?: string; status?: string; property_id?: string }
type CleaningTask = { id: string; status: 'pending'|'scheduled'|'done' }

export default function OrdersPage() {
  const [data, setData] = useState<Order[]>([])
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()

  async function load() {
    const res = await getJSON<Order[]>('/orders')
    setData(res)
  }
  const [statusMap, setStatusMap] = useState<Record<string,string>>({})
  useEffect(() => { load() }, [])
  useEffect(() => { refreshStatus() }, [data])

  async function refreshStatus() {
    const entries: [string,string][] = []
    for (const o of data) {
      const res = await fetch(`${API_BASE}/cleaning/order/${o.id}`)
      const tasks: CleaningTask[] = await res.json()
      let s = '无任务'
      if (tasks.length) {
        const anyScheduled = tasks.some(t => t.status === 'scheduled')
        const allDone = tasks.every(t => t.status === 'done')
        s = allDone ? '已完成' : anyScheduled ? '已排班' : '待安排'
      }
      entries.push([o.id, s])
    }
    setStatusMap(Object.fromEntries(entries))
  }

  async function genCleaning(id: string) {
    const res = await fetch(`${API_BASE}/orders/${id}/generate-cleaning`, { method: 'POST' })
    if (res.ok) { message.success('已生成清洁任务') } else { message.error('生成失败') }
  }

  async function submitCreate() {
    const v = await form.validateFields()
    const payload = {
      source: v.source,
      property_id: v.property_id,
      checkin: v.checkin.format('YYYY-MM-DD'),
      checkout: v.checkout.format('YYYY-MM-DD'),
    }
    const res = await fetch(`${API_BASE}/orders/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(payload) })
    if (res.ok) { message.success('订单已创建并联动清洁'); setOpen(false); form.resetFields(); load() } else { message.error('创建失败') }
  }

  const columns = [
    { title: '来源', dataIndex: 'source' },
    { title: '入住', dataIndex: 'checkin' },
    { title: '退房', dataIndex: 'checkout' },
    { title: '状态', dataIndex: 'status' },
    { title: '清洁任务', render: (_: any, r: Order) => {
      const s = statusMap[r.id]
      if (s === '已完成') return <Tag color="green">已完成</Tag>
      if (s === '已排班') return <Tag color="blue">已排班</Tag>
      if (s === '待安排') return <Tag color="orange">待安排</Tag>
      return <Tag>无任务</Tag>
    } },
    { title: '操作', render: (_: any, r: Order) => (<Space>{hasPerm('order.manage') && <Button onClick={() => genCleaning(r.id)}>生成清洁</Button>}<a href={`/orders/${r.id}`}>查看</a></Space>) },
  ]

  return (
    <Card title="订单管理" extra={hasPerm('order.sync') ? <Button type="primary" onClick={() => setOpen(true)}>新建订单</Button> : null}>
      <Table rowKey={(r) => r.id} columns={columns as any} dataSource={data} pagination={{ pageSize: 10 }} />
      <Modal open={open} onCancel={() => setOpen(false)} onOk={submitCreate} title="新建订单">
        <Form form={form} layout="vertical">
          <Form.Item name="source" label="来源" rules={[{ required: true }]}>
            <Select options={[{ value: 'airbnb', label: 'airbnb' }, { value: 'offline', label: 'offline' }, { value: 'other', label: 'other' }]} />
          </Form.Item>
          <Form.Item name="property_id" label="房源ID">
            <Input />
          </Form.Item>
          <Form.Item name="checkin" label="入住" rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="checkout" label="退房" rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
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