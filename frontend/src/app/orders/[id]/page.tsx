"use client"
import { Card, Descriptions, List, Badge, Space, Button, Drawer, Select, TimePicker, message } from 'antd'
import { useEffect, useState } from 'react'
import { API_BASE } from '../../../lib/api'
import dayjs from 'dayjs'
import { toDayStr } from '../../../lib/orders'
import { hasPerm } from '../../../lib/auth'

type Order = { id: string; source?: string; property_id?: string; checkin?: string; checkout?: string; status?: string }
type Task = { id: string; date: string; status: 'pending'|'scheduled'|'done'; assignee_id?: string; scheduled_at?: string }

export default function OrderDetail({ params }: { params: { id: string } }) {
  const [order, setOrder] = useState<Order | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [staff, setStaff] = useState<{ id: string; name: string }[]>([])
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Task | null>(null)

  async function load() {
    const o = await fetch(`${API_BASE}/orders`).then(r => r.json()).then((list: Order[]) => list.find(x => x.id === params.id))
    setOrder(o || null)
    const t = await fetch(`${API_BASE}/cleaning/order/${params.id}`).then(r => r.json())
    setTasks(t)
    const s = await fetch(`${API_BASE}/cleaning/staff`).then(r => r.json())
    setStaff(s)
  }
  useEffect(() => { load() }, [params.id])

  async function assign(assignee_id: string, time: any) {
    if (!selected) return
    const scheduled_at = dayjs((order?.checkout || selected.date) + ' ' + time.format('HH:mm')).toISOString()
    const res = await fetch(`${API_BASE}/cleaning/tasks/${selected.id}/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ assignee_id, scheduled_at }) })
    if (res.ok) { message.success('已分配'); setOpen(false); setSelected(null); load() } else { message.error('分配失败') }
  }

  async function adjustTime(task: Task, time: any) {
    const scheduled_at = dayjs((order?.checkout || task.date) + ' ' + time.format('HH:mm')).toISOString()
    const res = await fetch(`${API_BASE}/cleaning/tasks/${task.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ scheduled_at, status: 'scheduled' }) })
    if (res.ok) { message.success('已调整'); load() } else { message.error('调整失败') }
  }

  return (
    <Card title="订单详情">
      {order && (
        <Descriptions bordered size="small" column={1}>
          <Descriptions.Item label="来源">{order.source}</Descriptions.Item>
          <Descriptions.Item label="入住">{order.checkin ? dayjs(toDayStr(order.checkin)).format('DD/MM/YYYY') : ''}</Descriptions.Item>
          <Descriptions.Item label="退房">{order.checkout ? dayjs(toDayStr(order.checkout)).format('DD/MM/YYYY') : ''}</Descriptions.Item>
          <Descriptions.Item label="状态">{order.status}</Descriptions.Item>
        </Descriptions>
      )}
      <List
        style={{ marginTop: 16 }}
        header="清洁任务"
        dataSource={tasks}
        renderItem={(t) => (
          <List.Item actions={[
            hasPerm('cleaning.task.assign') && <Button onClick={() => { setSelected(t); setOpen(true) }}>分配</Button>,
            hasPerm('cleaning.task.assign') && <TimePicker format="HH:mm" onChange={(time) => adjustTime(t, time)} />,
          ].filter(Boolean) as any}>
            <Space>
              <Badge status={t.status === 'done' ? 'success' : t.status === 'scheduled' ? 'processing' : 'warning'} text={t.status} />
              <span>{dayjs(t.date).format('DD/MM/YYYY')}</span>
              {t.assignee_id && <span>负责人: {t.assignee_id}</span>}
              {t.scheduled_at && <span>时间: {dayjs(t.scheduled_at).format('HH:mm')}</span>}
            </Space>
          </List.Item>
        )}
      />

      <Drawer open={open} onClose={() => setOpen(false)} title="分配任务">
        {selected && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Select placeholder="选择人员" options={staff.map(s => ({ value: s.id, label: s.name }))} onChange={(id) => (window as any)._assignee = id} style={{ width: '100%' }} />
            <TimePicker format="HH:mm" onChange={(t) => (window as any)._time = t} style={{ width: '100%' }} />
            <Button type="primary" onClick={() => assign((window as any)._assignee, (window as any)._time)}>确认分配</Button>
          </Space>
        )}
      </Drawer>
    </Card>
  )
}