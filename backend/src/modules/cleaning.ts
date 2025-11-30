import { Router } from 'express'
import { db } from '../store'
import { z } from 'zod'
import { requirePerm, requireAnyPerm } from '../auth'
import { hasSupabase, supaSelect, supaInsert, supaUpdate } from '../supabase'
import { hasPg, pgSelect, pgInsert, pgUpdate } from '../dbAdapter'

export const router = Router()

router.get('/tasks', requireAnyPerm(['cleaning.view','cleaning.schedule.manage','cleaning.task.assign']), (req, res) => {
  const { date } = req.query as { date?: string }
  if (hasPg) {
    pgSelect('cleaning_tasks', '*', date ? { date } : undefined)
      .then((data: any) => res.json(data))
      .catch((err: any) => res.status(500).json({ message: err.message }))
    return
  }
  if (hasSupabase) {
    supaSelect('cleaning_tasks', '*', date ? { date } : undefined)
      .then((data) => res.json(data))
      .catch((err) => res.status(500).json({ message: err.message }))
    return
  }
  if (date) {
    const d1 = date
    const d2 = (() => { try { return new Date(date + 'T00:00:00').toISOString().slice(0,10) } catch { return d1 } })()
    return res.json(db.cleaningTasks.filter((t) => t.date === d1 || t.date === d2))
  }
  return res.json(db.cleaningTasks)
})

const taskSchema = z.object({
  property_id: z.string().optional(),
  date: z.string(),
})

router.post('/tasks', (req, res) => {
  const parsed = taskSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { v4: uuid } = require('uuid')
  const task = { id: uuid(), property_id: parsed.data.property_id, date: parsed.data.date, status: 'pending' as const }
  db.cleaningTasks.push(task)
  if (hasPg) {
    pgInsert('cleaning_tasks', task as any)
      .then((row: any) => res.status(201).json(row || task))
      .catch((_err: any) => res.status(201).json(task))
    return
  }
  if (hasSupabase) {
    supaInsert('cleaning_tasks', task)
      .then((row) => res.status(201).json(row))
      .catch((err) => res.status(500).json({ message: err.message }))
    return
  }
  return res.status(201).json(task)
})

router.get('/staff', requireAnyPerm(['cleaning.view','cleaning.schedule.manage','cleaning.task.assign']), (req, res) => {
  res.json(db.cleaners)
})

const assignSchema = z.object({ assignee_id: z.string(), scheduled_at: z.string() })

router.post('/tasks/:id/assign', requirePerm('cleaning.task.assign'), (req, res) => {
  const { id } = req.params
  const parsed = assignSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const task = db.cleaningTasks.find((t) => t.id === id)
  if (!task) return res.status(404).json({ message: 'task not found' })
  const staff = db.cleaners.find((c) => c.id === parsed.data.assignee_id)
  if (!staff) return res.status(404).json({ message: 'staff not found' })
  const count = db.cleaningTasks.filter((t) => t.date === task.date && t.assignee_id === staff.id).length
  if (count >= staff.capacity_per_day) return res.status(409).json({ message: 'capacity exceeded' })
  task.assignee_id = staff.id
  task.scheduled_at = parsed.data.scheduled_at
  task.status = 'scheduled'
  if (hasPg) {
    pgUpdate('cleaning_tasks', task.id, { assignee_id: task.assignee_id, scheduled_at: task.scheduled_at, status: task.status } as any)
      .then((row: any) => res.json(row || task))
      .catch((_err: any) => res.json(task))
    return
  }
  if (hasSupabase) {
    supaUpdate('cleaning_tasks', task.id, { assignee_id: task.assignee_id, scheduled_at: task.scheduled_at, status: task.status })
      .then((row) => res.json(row))
      .catch((err) => res.status(500).json({ message: err.message }))
    return
  }
  return res.json(task)
})

router.post('/schedule/rebalance', requirePerm('cleaning.schedule.manage'), (req, res) => {
  const pending = db.cleaningTasks.filter((t) => t.status === 'pending')
  for (const t of pending) {
    const dayStaff = db.cleaners.sort((a, b) => a.capacity_per_day - b.capacity_per_day)
    for (const s of dayStaff) {
      const count = db.cleaningTasks.filter((x) => x.date === t.date && x.assignee_id === s.id).length
      if (count < s.capacity_per_day) {
        t.assignee_id = s.id
        t.scheduled_at = `${t.date}T10:00:00Z`
        t.status = 'scheduled'
        break
      }
    }
  }
  res.json({ updated: pending.length })
})

const patchSchema = z.object({ scheduled_at: z.string().optional(), status: z.enum(['pending','scheduled','done']).optional(), assignee_id: z.string().optional(), old_code: z.string().optional(), new_code: z.string().optional(), note: z.string().optional(), checkout_time: z.string().optional(), checkin_time: z.string().optional() })

router.patch('/tasks/:id', requirePerm('cleaning.task.assign'), (req, res) => {
  const { id } = req.params
  const parsed = patchSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const task = db.cleaningTasks.find((t) => t.id === id)
  if (!task) return res.status(404).json({ message: 'task not found' })
  if (parsed.data.scheduled_at) task.scheduled_at = parsed.data.scheduled_at
  if (parsed.data.status) task.status = parsed.data.status
  if (parsed.data.assignee_id) task.assignee_id = parsed.data.assignee_id
  if (parsed.data.old_code !== undefined) task.old_code = parsed.data.old_code
  if (parsed.data.new_code !== undefined) task.new_code = parsed.data.new_code
  if (parsed.data.note !== undefined) task.note = parsed.data.note
  if (parsed.data.checkout_time !== undefined) task.checkout_time = parsed.data.checkout_time
  if (parsed.data.checkin_time !== undefined) task.checkin_time = parsed.data.checkin_time
  if (hasPg) {
    pgUpdate('cleaning_tasks', task.id, parsed.data as any)
      .then((row: any) => res.json(row || task))
      .catch((_err: any) => res.json(task))
    return
  }
  if (hasSupabase) {
    supaUpdate('cleaning_tasks', task.id, parsed.data)
      .then((row) => res.json(row))
      .catch((err) => res.status(500).json({ message: err.message }))
    return
  }
  return res.json(task)
})

router.get('/order/:orderId', requireAnyPerm(['cleaning.view','cleaning.schedule.manage','cleaning.task.assign']), (req, res) => {
  const order = db.orders.find(o => o.id === req.params.orderId)
  if (!order) return res.status(404).json({ message: 'order not found' })
  const tasks = db.cleaningTasks.filter(t => t.property_id === order.property_id && t.date === ((order.checkout || '').slice(0,10) || t.date))
  res.json(tasks)
})

router.get('/capacity', requireAnyPerm(['cleaning.view','cleaning.schedule.manage','cleaning.task.assign']), (req, res) => {
  const { date } = req.query as { date?: string }
  const dateStr = date || new Date().toISOString().slice(0,10)
  const d2 = (() => { try { return new Date(dateStr + 'T00:00:00').toISOString().slice(0,10) } catch { return dateStr } })()
  const result = db.cleaners.map(c => {
    const assigned = db.cleaningTasks.filter(t => (t.date === dateStr || t.date === d2) && t.assignee_id === c.id).length
    return { id: c.id, name: c.name, capacity_per_day: c.capacity_per_day, assigned, remaining: c.capacity_per_day - assigned }
  })
  res.json(result)
})

router.get('/calendar', (req, res) => {
  const { date } = req.query as { date?: string }
  const dateStr = date || new Date().toISOString().slice(0,10)
  const events: any[] = []
  const getCode = (pid?: string, fallback?: string) => {
    const p = db.properties.find(pp => pp.id === pid)
    return p?.code || fallback || ''
  }
  function last4(v?: string | null) { return (v || '').slice(-4) || null }
  for (const o of db.orders) {
    const ciDay = (o.checkin || '').slice(0,10)
    const coDay = (o.checkout || '').slice(0,10)
    const type = ciDay === dateStr ? 'checkin' : (coDay === dateStr ? 'checkout' : null)
    if (!type) continue
    const t = db.cleaningTasks.find(x => x.date === dateStr && x.property_id === o.property_id)
    const assignee = t?.assignee_id ? db.cleaners.find(c => c.id === t.assignee_id) : undefined
    const nights = (() => {
      if (o.nights) return o.nights
      if (o.checkin && o.checkout) {
        const ci = new Date(o.checkin); const co = new Date(o.checkout)
        const ms = co.getTime() - ci.getTime()
        return ms > 0 ? Math.round(ms / (1000 * 60 * 60 * 24)) : 0
      }
      return 0
    })()
    events.push({
      id: t?.id || null,
      order_id: o.id,
      property_id: o.property_id,
      property_code: getCode(o.property_id, o.property_code),
      type,
      nights,
      status: t?.status || 'pending',
      scheduled_at: t?.scheduled_at || null,
      assignee_id: t?.assignee_id || null,
      assignee_name: assignee?.name || null,
      old_code: t?.old_code || (type === 'checkout' ? last4((o as any).guest_phone) : null),
      new_code: t?.new_code || (type === 'checkin' ? last4((o as any).guest_phone) : null),
      note: t?.note || null,
    })
  }
  const dAlt = (() => { try { return new Date(dateStr + 'T00:00:00').toISOString().slice(0,10) } catch { return dateStr } })()
  for (const t of db.cleaningTasks.filter(x => x.date === dateStr || x.date === dAlt)) {
    const exists = events.some(e => e.id === t.id)
    if (exists) continue
    const assignee = t.assignee_id ? db.cleaners.find(c => c.id === t.assignee_id) : undefined
    events.push({
      id: t.id,
      order_id: null,
      property_id: t.property_id,
      property_code: getCode(t.property_id, ''),
      type: 'other',
      nights: null,
      status: t.status,
      scheduled_at: t.scheduled_at || null,
      assignee_id: t.assignee_id || null,
      assignee_name: assignee?.name || null,
      old_code: t.old_code || null,
      new_code: t.new_code || null,
      note: t.note || null,
    })
  }
  res.json(events)
})
