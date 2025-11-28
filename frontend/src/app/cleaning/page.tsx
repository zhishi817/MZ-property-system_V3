"use client"
import { Card, Calendar, Badge, List, Drawer, Space, Button, Select, TimePicker, message, Progress, Alert, Input, Segmented } from 'antd'
import { useEffect, useState } from 'react'
import { API_BASE } from '../../lib/api'
import { hasPerm } from '../../lib/auth'
import dayjs from 'dayjs'

type Task = {
  id: string
  date: string
  status: 'pending'|'scheduled'|'done'
  property_id?: string
  assignee_id?: string
  scheduled_at?: string
  old_code?: string | null
  new_code?: string | null
  note?: string | null
  checkout_time?: string | null
  checkin_time?: string | null
}
type CalEvent = { id: string | null; order_id: string | null; property_id?: string; property_code?: string; type: 'checkin'|'checkout'|'other'|'combined'; nights?: number | null; status: 'pending'|'scheduled'|'done'; scheduled_at?: string | null; assignee_id?: string | null; assignee_name?: string | null; old_code?: string | null; new_code?: string | null; note?: string | null; has_checkin?: boolean; has_checkout?: boolean; checkout_time?: string | null; checkin_time?: string | null }
type Order = { id: string; property_id?: string; property_code?: string; checkin?: string; checkout?: string }

export default function CleaningPage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [staff, setStaff] = useState<{ id: string; name: string }[]>([])
  const [capacity, setCapacity] = useState<{ id: string; name: string; capacity_per_day: number; assigned: number; remaining: number }[]>([])
  const [date, setDate] = useState(dayjs())
  const [open, setOpen] = useState(false)
  const [selectedEvent, setSelectedEvent] = useState<CalEvent | null>(null)
  const [events, setEvents] = useState<CalEvent[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [dayOpen, setDayOpen] = useState(false)
  const [viewMode, setViewMode] = useState<'month'|'week'|'day'>('month')

  async function load(dateStr?: string) {
    try {
      const tRes = await fetch(`${API_BASE}/cleaning/tasks`)
      const tJson = await tRes.json()
      setTasks(Array.isArray(tJson) ? tJson : [])
    } catch {
      setTasks([])
    }
    try {
      const cRes = await fetch(`${API_BASE}/cleaning/capacity?date=${dateStr || dayjs().format('YYYY-MM-DD')}`)
      const cJson = await cRes.json()
      setCapacity(Array.isArray(cJson) ? cJson : [])
    } catch {
      setCapacity([])
    }
    try {
      const eRes = await fetch(`${API_BASE}/cleaning/calendar?date=${dateStr || dayjs().format('YYYY-MM-DD')}`)
      const eJson = await eRes.json()
      setEvents(Array.isArray(eJson) ? eJson : [])
    } catch { setEvents([]) }
    try {
      const oRes = await fetch(`${API_BASE}/orders`)
      const oJson = await oRes.json()
      setOrders(Array.isArray(oJson) ? oJson : [])
    } catch { setOrders([]) }
  }
  useEffect(() => {
    load(date.format('YYYY-MM-DD'))
    fetch(`${API_BASE}/cleaning/staff`).then(r => r.json()).then((j) => setStaff(Array.isArray(j) ? j : [])).catch(() => setStaff([]))
  }, [])

  function eventsForDay(day: string): CalEvent[] {
    const byProp: Record<string, CalEvent> = {}
    orders.forEach(o => {
      const ciDay = (o.checkin || '').slice(0,10)
      const coDay = (o.checkout || '').slice(0,10)
      const isCheckin = ciDay === day
      const isCheckout = coDay === day
      if (!isCheckin && !isCheckout) return
      const key = o.property_id || (o.property_code || '')
      const t: any = tasks.find(x => x.date === day && x.property_id === o.property_id)
      const assignee = t?.assignee_id ? staff.find(s => s.id === t.assignee_id) : undefined
      const nights = (() => {
        const ci = o.checkin ? new Date(o.checkin) : null
        const co = o.checkout ? new Date(o.checkout) : null
        if (ci && co) {
          const ms = co.getTime() - ci.getTime()
          return ms > 0 ? Math.round(ms / (1000 * 60 * 60 * 24)) : 0
        }
        return (o as any).nights || null
      })()
      const existing = byProp[key]
      const last4 = (v?: string | null) => (v || '').slice(-4) || null
      const base: CalEvent = existing || { id: t?.id || null, order_id: o.id, property_id: o.property_id, property_code: o.property_code, type: 'combined', nights, status: t?.status || 'pending', scheduled_at: t?.scheduled_at || null, assignee_id: t?.assignee_id || null, assignee_name: assignee?.name || null, old_code: t?.old_code || null, new_code: t?.new_code || null, note: t?.note || null, has_checkin: false, has_checkout: false, checkout_time: t?.checkout_time || null, checkin_time: t?.checkin_time || null }
      base.has_checkin = base.has_checkin || isCheckin
      base.has_checkout = base.has_checkout || isCheckout
      if (isCheckout && !base.old_code) (base as any).old_code = last4((o as any).guest_phone)
      if (isCheckin && !base.new_code) (base as any).new_code = last4((o as any).guest_phone)
      if (nights != null) base.nights = nights
      byProp[key] = base
    })
    tasks.filter(x => x.date === day).forEach(t => {
      const key = t.property_id || ''
      if (!key) return
      const assignee = t.assignee_id ? staff.find(s => s.id === t.assignee_id) : undefined
      const existing = byProp[key]
      if (existing) {
        existing.id = existing.id || t.id
        existing.status = t.status || existing.status
        existing.scheduled_at = t.scheduled_at || existing.scheduled_at
        existing.assignee_id = t.assignee_id || existing.assignee_id
        existing.assignee_name = assignee?.name || existing.assignee_name
        existing.old_code = (t as any).old_code || existing.old_code
        existing.new_code = (t as any).new_code || existing.new_code
        existing.note = (t as any).note || existing.note
        existing.checkout_time = (t as any).checkout_time || existing.checkout_time
        existing.checkin_time = (t as any).checkin_time || existing.checkin_time
      } else {
        byProp[key] = { id: t.id, order_id: null, property_id: t.property_id, property_code: '', type: 'other', nights: null, status: t.status, scheduled_at: t.scheduled_at || null, assignee_id: t.assignee_id || null, assignee_name: assignee?.name || null, old_code: (t as any).old_code || null, new_code: (t as any).new_code || null, note: (t as any).note || null, has_checkin: false, has_checkout: false, checkout_time: (t as any).checkout_time || null, checkin_time: (t as any).checkin_time || null }
      }
    })
    return Object.values(byProp)
  }

  function dateCellRenderBars(value: any) {
    const day = value.format('YYYY-MM-DD')
    const evs = eventsForDay(day)
    return (
      <div>
        {evs.map((ev, idx) => {
          const color = ev.has_checkout ? '#ffccc7' : ev.has_checkin ? '#d6e4ff' : '#fffbe6'
          return (
            <div key={idx} style={{ background: color, borderRadius: 4, padding: '2px 6px', marginBottom: 4, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }} onClick={() => { setSelectedEvent(ev); setOpen(true) }}>
              <span>{ev.property_code || ev.property_id || ''}</span>
              <span style={{ marginLeft: 6 }}>{ev.has_checkout ? '退房' : ''}{ev.has_checkin ? (ev.has_checkout ? ' 入住' : '入住') : ''}</span>
              {typeof ev.nights === 'number' && <span style={{ marginLeft: 6 }}>{ev.nights}晚</span>}
              {ev.assignee_name && <span style={{ marginLeft: 6 }}>{ev.assignee_name}</span>}
            </div>
          )
        })}
      </div>
    )
  }

  function dateCellRender(value: any) {
    const day = value.format('YYYY-MM-DD')
    const dayTasks = tasks.filter(t => t.date === day)
    const dayOrders = orders.filter(o => (o.checkin === day || o.checkout === day))
    const counts = {
      scheduled: dayTasks.filter(t => t.status === 'scheduled').length,
      pending: dayTasks.filter(t => t.status === 'pending').length,
      done: dayTasks.filter(t => t.status === 'done').length,
    }
    const listData: { type: 'success'|'warning'|'error'; content: string }[] = []
    if (counts.scheduled) listData.push({ type: 'success', content: `已排班 ${counts.scheduled}` })
    if (counts.pending) listData.push({ type: 'warning', content: `待安排 ${counts.pending}` })
    if (counts.done) listData.push({ type: 'success', content: `已完成 ${counts.done}` })
    const checkins = dayOrders.filter(o => o.checkin === day).length
    const checkouts = dayOrders.filter(o => o.checkout === day).length
    if (checkins) listData.push({ type: 'processing' as any, content: `入住 ${checkins}` })
    if (checkouts) listData.push({ type: 'error', content: `退房 ${checkouts}` })
    return (
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, cursor: 'pointer' }} onClick={() => { setDate(value); setDayOpen(true); load(day) }}>
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
    if (viewMode === 'day') setDayOpen(true)
  }

  async function ensureTask(e: CalEvent): Promise<string | null> {
    if (e.id) return e.id
    const pid = e.property_id
    if (!pid) return null
    const r = await fetch(`${API_BASE}/cleaning/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ property_id: pid, date: date.format('YYYY-MM-DD') }) })
    if (r.ok) { const j = await r.json(); return j?.id || null }
    return null
  }
  async function assign(e: CalEvent, assignee_id: string, time: any) {
    const tid = await ensureTask(e)
    if (!tid) { message.error('无法创建任务'); return }
    let scheduled_at = dayjs(date.format('YYYY-MM-DD') + ' 11:00').toISOString()
    try {
      const co = (window as any)._checkoutTime
      const ci = (window as any)._checkinTime
      if (co) {
        const base = dayjs(co)
        scheduled_at = dayjs(date.format('YYYY-MM-DD') + ' ' + base.format('HH:mm')).add(30, 'minute').toISOString()
      } else if (ci) {
        const base = dayjs(ci)
        scheduled_at = dayjs(date.format('YYYY-MM-DD') + ' ' + base.format('HH:mm')).subtract(60, 'minute').toISOString()
      }
    } catch {}
    const res = await fetch(`${API_BASE}/cleaning/tasks/${tid}/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ assignee_id, scheduled_at }) })
    if (res.ok) { message.success('已分配'); setOpen(false); setSelectedEvent(null); load(date.format('YYYY-MM-DD')) } else { message.error('分配失败') }
  }
  async function saveDetails(e: CalEvent, payload: any) {
    const tid = await ensureTask(e)
    if (!tid) { message.error('无法保存'); return }
    const r = await fetch(`${API_BASE}/cleaning/tasks/${tid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(payload) })
    if (r.ok) { message.success('已保存'); setOpen(false); setSelectedEvent(null); load(date.format('YYYY-MM-DD')) } else { message.error('保存失败') }
  }

  return (
    <Card title="清洁安排" extra={<Segmented options={[{label:'日',value:'day'},{label:'周',value:'week'},{label:'月',value:'month'}]} value={viewMode} onChange={(v:any)=>setViewMode(v)} />}>
      {viewMode === 'month' && <Calendar cellRender={(current) => dateCellRenderBars(current)} onSelect={onSelect} />}
      {viewMode === 'day' && (
        <List
          header={`当日安排 ${date.format('YYYY-MM-DD')}`}
          dataSource={eventsForDay(date.format('YYYY-MM-DD'))}
          renderItem={(ev) => (
            <List.Item actions={[<Button onClick={() => { setSelectedEvent(ev); setOpen(true) }}>编辑</Button>] }>
              <Space>
                <Badge status={ev.type === 'checkout' ? 'error' : ev.type === 'checkin' ? 'processing' : 'warning'} text={`${ev.type === 'checkout' ? '退房' : ev.type === 'checkin' ? '入住' : '其他'}`} />
                <Badge status={ev.status === 'done' ? 'success' : ev.status === 'scheduled' ? 'processing' : 'warning'} text={ev.status} />
                <span>{ev.property_code || ev.property_id || ''}</span>
                {typeof ev.nights === 'number' && <span>{ev.nights}晚</span>}
                {ev.assignee_name && <span>{ev.assignee_name}</span>}
              </Space>
            </List.Item>
          )}
        />
      )}
      {viewMode === 'week' && (
        <List
          header={`本周安排（从 ${dayjs(date).startOf('week').format('YYYY-MM-DD')} 起）`}
          dataSource={Array.from({length:7}).map((_,i)=> dayjs(date).startOf('week').add(i,'day').format('YYYY-MM-DD'))}
          renderItem={(d) => (
            <List.Item>
              <Space direction="vertical" style={{ width: '100%' }}>
                <div style={{ fontWeight: 600 }}>{d}</div>
                {eventsForDay(d).length === 0 ? <div style={{ color:'#999' }}>无安排</div> : eventsForDay(d).map((ev, idx) => (
                  <div key={idx} style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <Badge status={ev.type === 'checkout' ? 'error' : ev.type === 'checkin' ? 'processing' : 'warning'} text={`${ev.type === 'checkout' ? '退房' : ev.type === 'checkin' ? '入住' : '其他'}`} />
                    <span>{ev.property_code || ev.property_id || ''}</span>
                    {typeof ev.nights === 'number' && <span>{ev.nights}晚</span>}
                    {ev.assignee_name && <span>{ev.assignee_name}</span>}
                    <Button size="small" onClick={() => { setSelectedEvent(ev); setOpen(true) }}>编辑</Button>
                  </div>
                ))}
              </Space>
            </List.Item>
          )}
        />
      )}
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
        header={`清洁日程 ${date.format('YYYY-MM-DD')}`}
        dataSource={eventsForDay(date.format('YYYY-MM-DD'))}
        renderItem={(ev) => (
          <List.Item actions={[
            <Button onClick={() => { setSelectedEvent(ev); setOpen(true) }}>编辑</Button>,
          ]}>
            <Space>
              {ev.has_checkout && <Badge status="error" text="退房" />}
              {ev.has_checkin && <Badge status="processing" text="入住" />}
              {!ev.has_checkout && !ev.has_checkin && <Badge status="warning" text="清洁" />}
              <Badge status={ev.status === 'done' ? 'success' : ev.status === 'scheduled' ? 'processing' : 'warning'} text={ev.status} />
              <span>{ev.property_code || ev.property_id || ''}</span>
              {typeof ev.nights === 'number' && <span>{ev.nights}晚</span>}
              {ev.assignee_name && <span>{ev.assignee_name}</span>}
            </Space>
          </List.Item>
        )}
      />
      <Drawer open={open} onClose={() => setOpen(false)} title="编辑清洁安排">
        {selectedEvent && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
            <Space>
              {selectedEvent.has_checkout && <Badge status="error" text="退房" />}
              {selectedEvent.has_checkin && <Badge status="processing" text="入住" />}
              {!selectedEvent.has_checkout && !selectedEvent.has_checkin && <Badge status="warning" text="其他" />}
              {typeof selectedEvent.nights === 'number' && <span>{selectedEvent.nights}晚</span>}
              <span>{selectedEvent.property_code || selectedEvent.property_id || ''}</span>
            </Space>
            </div>
            <Select placeholder="选择人员" options={(Array.isArray(staff) ? staff : []).map(s => ({ value: s.id, label: s.name }))} onChange={(id) => (window as any)._assignee = id} style={{ width: '100%' }} />
            {/* 移除通用 Select time，改为具体入住/退房时间 */}
            <TimePicker format="HH:mm" placeholder="退房时间" defaultValue={selectedEvent.checkout_time ? dayjs(selectedEvent.checkout_time, 'HH:mm') : undefined} onChange={(t) => (window as any)._checkoutTime = t} style={{ width: '100%' }} />
            <TimePicker format="HH:mm" placeholder="入住时间" defaultValue={selectedEvent.checkin_time ? dayjs(selectedEvent.checkin_time, 'HH:mm') : undefined} onChange={(t) => (window as any)._checkinTime = t} style={{ width: '100%' }} />
            <Input placeholder="旧密码" defaultValue={selectedEvent.old_code || ''} onChange={(e) => (window as any)._old = e.target.value} />
            <Input placeholder="新密码" defaultValue={selectedEvent.new_code || ''} onChange={(e) => (window as any)._new = e.target.value} />
            <Input.TextArea placeholder="备注" defaultValue={selectedEvent.note || ''} onChange={(e) => (window as any)._note = e.target.value} rows={3} />
            <Space>
              <Button type="primary" onClick={() => assign(selectedEvent, (window as any)._assignee, null)}>分配</Button>
              <Button onClick={() => saveDetails(selectedEvent, { assignee_id: (window as any)._assignee, old_code: (window as any)._old, new_code: (window as any)._new, note: (window as any)._note, checkout_time: (window as any)._checkoutTime ? dayjs((window as any)._checkoutTime).format('HH:mm') : undefined, checkin_time: (window as any)._checkinTime ? dayjs((window as any)._checkinTime).format('HH:mm') : undefined })}>保存详情</Button>
            </Space>
          </Space>
        )}
      </Drawer>
      <Drawer open={dayOpen} onClose={() => setDayOpen(false)} title={`当天安排 ${date.format('YYYY-MM-DD')}`} width={720}>
        <List
          dataSource={eventsForDay(date.format('YYYY-MM-DD'))}
          renderItem={(ev) => (
            <List.Item actions={[<Button onClick={() => { setSelectedEvent(ev); setOpen(true) }}>编辑</Button>]}> 
              <Space direction="vertical" style={{ width: '100%' }}>
                <Space>
                  {ev.has_checkout && <Badge status="error" text="退房" />}
                  {ev.has_checkin && <Badge status="processing" text="入住" />}
                  {!ev.has_checkout && !ev.has_checkin && <Badge status="warning" text="清洁" />}
                  <Badge status={ev.status === 'done' ? 'success' : ev.status === 'scheduled' ? 'processing' : 'warning'} text={ev.status} />
                  <span>{ev.property_code || ev.property_id || ''}</span>
                  {typeof ev.nights === 'number' && <span>{ev.nights}晚</span>}
                </Space>
                <Space>
                  <span>旧密码：{ev.old_code || '-'}</span>
                  <span>新密码：{ev.new_code || '-'}</span>
                  <span>清洁工：{ev.assignee_name || '-'}</span>
                </Space>
                {ev.note && <div>备注：{ev.note}</div>}
              </Space>
            </List.Item>
          )}
        />
      </Drawer>
    </Card>
  )
}
