import { Router } from 'express'
import { db } from '../store'
import { z } from 'zod'
import { requirePerm } from '../auth'
import { hasSupabase, supaSelect, supaInsert, supaUpdate } from '../supabase'

export const router = Router()

router.get('/tasks', (req, res) => {
  const { date } = req.query as { date?: string }
  if (!hasSupabase) {
    if (date) return res.json(db.cleaningTasks.filter((t) => t.date === date))
    return res.json(db.cleaningTasks)
  }
  supaSelect('cleaning_tasks', '*', date ? { date } : undefined)
    .then((data) => res.json(data))
    .catch((err) => res.status(500).json({ message: err.message }))
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
  if (!hasSupabase) return res.status(201).json(task)
  supaInsert('cleaning_tasks', task)
    .then((row) => res.status(201).json(row))
    .catch((err) => res.status(500).json({ message: err.message }))
})

router.get('/staff', (req, res) => {
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
  if (!hasSupabase) return res.json(task)
  supaUpdate('cleaning_tasks', task.id, { assignee_id: task.assignee_id, scheduled_at: task.scheduled_at, status: task.status })
    .then((row) => res.json(row))
    .catch((err) => res.status(500).json({ message: err.message }))
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

const patchSchema = z.object({ scheduled_at: z.string().optional(), status: z.enum(['pending','scheduled','done']).optional() })

router.patch('/tasks/:id', requirePerm('cleaning.task.assign'), (req, res) => {
  const { id } = req.params
  const parsed = patchSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const task = db.cleaningTasks.find((t) => t.id === id)
  if (!task) return res.status(404).json({ message: 'task not found' })
  if (parsed.data.scheduled_at) task.scheduled_at = parsed.data.scheduled_at
  if (parsed.data.status) task.status = parsed.data.status
  if (!hasSupabase) return res.json(task)
  supaUpdate('cleaning_tasks', task.id, parsed.data)
    .then((row) => res.json(row))
    .catch((err) => res.status(500).json({ message: err.message }))
})

router.get('/order/:orderId', (req, res) => {
  const order = db.orders.find(o => o.id === req.params.orderId)
  if (!order) return res.status(404).json({ message: 'order not found' })
  const tasks = db.cleaningTasks.filter(t => t.property_id === order.property_id && t.date === (order.checkout || t.date))
  res.json(tasks)
})

router.get('/capacity', (req, res) => {
  const { date } = req.query as { date?: string }
  const dateStr = date || new Date().toISOString().slice(0,10)
  const result = db.cleaners.map(c => {
    const assigned = db.cleaningTasks.filter(t => t.date === dateStr && t.assignee_id === c.id).length
    return { id: c.id, name: c.name, capacity_per_day: c.capacity_per_day, assigned, remaining: c.capacity_per_day - assigned }
  })
  res.json(result)
})