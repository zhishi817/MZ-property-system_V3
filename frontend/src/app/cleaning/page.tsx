"use client"
import { Card, Calendar, Badge, List, Drawer, Space, Button, Select, TimePicker, message, Progress, Alert } from 'antd'
import { useEffect, useState } from 'react'
import { API_BASE } from '../../lib/api'
import { hasPerm } from '../../lib/auth'
import dayjs from 'dayjs'

type Task = { id: string; date: string; status: 'pending'|'scheduled'|'done' }

export default function CleaningPage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [staff, setStaff] = useState<{ id: string; name: string }[]>([])
  const [capacity, setCapacity] = useState<{ id: string; name: string; capacity_per_day: number; assigned: number; remaining: number }[]>([])
  const [date, setDate] = useState(dayjs())
  const [open, setOpen] = useState(false)
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)

  async function load(dateStr?: string) {
    const tRes = await fetch(`${API_BASE}/cleaning/tasks${dateStr ? `?date=${dateStr}` : ''}`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
    const t = tRes.ok ? await tRes.json() : []
    setTasks(t)
    const cRes = await fetch(`${API_BASE}/cleaning/capacity?date=${dateStr || dayjs().format('YYYY-MM-DD')}`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
    const c = cRes.ok ? await cRes.json() : []
    setCapacity(c)
  }
  useEffect(() => {
    load(date.format('YYYY-MM-DD'))
    fetch(`${API_BASE}/cleaning/staff`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } }).then(r => r.ok ? r.json() : []).then(setStaff)
  }, [])

  function dateCellRender(value: any) {
    const day = value.format('YYYY-MM-DD')
    const dayTasks = tasks.filter(t => t.date === day)
    const counts = {
      scheduled: dayTasks.filter(t => t.status === 'scheduled').length,
      pending: dayTasks.filter(t => t.status === 'pending').length,
      done: dayTasks.filter(t => t.status === 'done').length,
    }
    const listData: { type: 'success'|'warning'|'error'; content: string }[] = []
    if (counts.scheduled) listData.push({ type: 'success', content: `已排班 ${counts.scheduled}` })
    if (counts.pending) listData.push({ type: 'warning', content: `待安排 ${counts.pending}` })
    if (counts.done) listData.push({ type: 'success', content: `已完成 ${counts.done}` })
    return (
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {listData.map((item, index) => (
          <li key={index}>
            <Badge status={item.type} text={item.content} />
          </li>
        ))}
      </ul>
    )
  }

  function onSelect(value: any) {
    setDate(value)
    load(value.format('YYYY-MM-DD'))
  }

  async function assign(task: Task, assignee_id: string, time: any) {
    const scheduled_at = dayjs(date.format('YYYY-MM-DD') + ' ' + time.format('HH:mm')).toISOString()
    const res = await fetch(`${API_BASE}/cleaning/tasks/${task.id}/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignee_id, scheduled_at }) })
    if (res.ok) { message.success('已分配'); setOpen(false); setSelectedTask(null); load(date.format('YYYY-MM-DD')) } else { message.error('分配失败') }
  }

  return (
    <Card title="清洁安排">
      <Calendar cellRender={(current) => dateCellRender(current)} onSelect={onSelect} />
      <List header="人员容量" dataSource={capacity} renderItem={(s) => (
        <List.Item>
          <Space>
            <span>{s.name}</span>
            <Progress percent={Math.min(100, Math.round((s.assigned / s.capacity_per_day) * 100))} style={{ width: 200 }} />
            <span>{s.assigned}/{s.capacity_per_day}</span>
            {s.assigned >= s.capacity_per_day && <Alert type="error" message="容量已满" showIcon />}
          </Space>
        </List.Item>
      )} />
      <List
        header={`任务列表 ${date.format('YYYY-MM-DD')}`}
        dataSource={tasks}
        renderItem={(item) => (
          <List.Item actions={[
            hasPerm('cleaning.task.assign') ? <Button onClick={() => { setSelectedTask(item); setOpen(true) }}>分配</Button> : null,
            hasPerm('cleaning.task.assign') ? <Button onClick={async () => { const time = dayjs().set('hour', 11).set('minute', 0); const scheduled_at = dayjs(date.format('YYYY-MM-DD') + ' ' + time.format('HH:mm')).toISOString(); const r = await fetch(`${API_BASE}/cleaning/tasks/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ scheduled_at, status: 'scheduled' }) }); if (r.ok) { message.success('已调整'); load(date.format('YYYY-MM-DD')) } else { message.error('调整失败') } }}>调整时间</Button> : null
          ]}>
            <Space>
              <Badge status={item.status === 'scheduled' ? 'success' : 'warning'} text={item.status} />
              <span>{item.date}</span>
            </Space>
          </List.Item>
        )}
      />
      <Drawer open={open} onClose={() => setOpen(false)} title="分配任务">
        {selectedTask && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Select placeholder="选择人员" options={staff.map(s => ({ value: s.id, label: s.name }))} onChange={(id) => (window as any)._assignee = id} style={{ width: '100%' }} />
            <TimePicker format="HH:mm" onChange={(t) => (window as any)._time = t} style={{ width: '100%' }} />
            {hasPerm('cleaning.task.assign') ? <Button type="primary" onClick={() => assign(selectedTask, (window as any)._assignee, (window as any)._time)}>确认分配</Button> : null}
          </Space>
        )}
      </Drawer>
    </Card>
  )
}