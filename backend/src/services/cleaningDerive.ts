import { hasPg, pgPool, pgSelect } from '../dbAdapter'
import { db } from '../store'

type DeriveOpts = { type?: string }

function dayOnly(s?: string | null): string | null {
  const v = String(s || '').slice(0, 10)
  return v || null
}

export async function deriveCleaningTaskFromOrder(orderId: string, opts?: DeriveOpts): Promise<any> {
  const t = String(opts?.type || 'checkout_cleaning')
  let order: any | null = null
  if (hasPg) {
    const rows: any[] = (await pgSelect('orders', '*', { id: orderId })) || []
    order = Array.isArray(rows) ? rows[0] : null
  } else {
    order = db.orders.find(o => o.id === orderId) || null
  }
  if (!order) throw new Error('order_not_found')
  const property_id = String(order.property_id || '') || null
  const date = dayOnly(order.checkout) || dayOnly(order.checkin) || dayOnly(order.updated_at) || null
  if (!date) throw new Error('order_missing_dates')
  const base: any = {
    order_id: order.id,
    type: t,
    property_id,
    date,
    status: 'pending',
    note: order.confirmation_code ? `code:${String(order.confirmation_code)}` : null,
    auto_managed: true,
    locked: false,
    reschedule_required: false,
  }
  const canceled = String(order.status || '').toLowerCase() === 'cancelled' || String(order.status || '').toLowerCase() === 'canceled'
  if (hasPg && pgPool) {
    const sql = `
      INSERT INTO cleaning_tasks(order_id, type, property_id, date, status, note, auto_managed, locked, reschedule_required)
      VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,true),COALESCE($8,false),false)
      ON CONFLICT (order_id, type) WHERE order_id IS NOT NULL DO UPDATE SET
        date = CASE WHEN NOT cleaning_tasks.locked AND COALESCE(cleaning_tasks.auto_managed, true) THEN EXCLUDED.date ELSE cleaning_tasks.date END,
        status = CASE WHEN $9::boolean THEN 'canceled' ELSE (
          CASE WHEN NOT cleaning_tasks.locked AND COALESCE(cleaning_tasks.auto_managed, true) THEN EXCLUDED.status ELSE cleaning_tasks.status END
        ) END,
        note = COALESCE(EXCLUDED.note, cleaning_tasks.note),
        reschedule_required = CASE WHEN (cleaning_tasks.locked OR NOT COALESCE(cleaning_tasks.auto_managed, true)) AND NOT $9::boolean THEN true ELSE cleaning_tasks.reschedule_required END
      RETURNING *
    `
    const params = [base.order_id, t, base.property_id, base.date, base.status, base.note, base.auto_managed, base.locked, canceled]
    const r = await pgPool.query(sql, params)
    return r?.rows?.[0] || base
  }
  // in-memory fallback
  const existing = db.cleaningTasks.find(ct => (ct as any).order_id === base.order_id && (ct as any).type === t)
  if (!existing) {
    const row = { id: require('uuid').v4(), ...base }
    ;(row as any).status = canceled ? 'canceled' : 'pending'
    db.cleaningTasks.push(row as any)
    return row
  }
  if (existing.locked || existing.auto_managed === false) {
    if (canceled && (existing as any).order_id) existing.status = 'canceled'
    existing.reschedule_required = existing.reschedule_required || !canceled
    return existing
  }
  existing.date = base.date
  existing.status = canceled ? 'canceled' : base.status
  existing.note = base.note || existing.note
  return existing
}

export async function deriveCleaningTasksForDateRange(from: string, to: string, type?: string): Promise<{ processed: number }>{
  const f = String(from).slice(0,10)
  const t = String(to).slice(0,10)
  let rows: any[] = []
  if (hasPg) {
    const sql = 'SELECT id FROM orders WHERE checkout >= $1 AND checkout <= $2'
    const rs = await pgPool!.query(sql, [f, t])
    rows = (rs?.rows || [])
  } else {
    rows = db.orders.filter(o => {
      const d = String(o.checkout || '').slice(0,10)
      return d >= f && d <= t
    }).map(o => ({ id: o.id }))
  }
  let n = 0
  for (const r of rows) { try { await deriveCleaningTaskFromOrder(String(r.id), { type }) ; n++ } catch {} }
  return { processed: n }
}

