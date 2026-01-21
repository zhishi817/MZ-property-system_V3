import { Router } from 'express'
import { requireAnyPerm } from '../auth'
import { addAudit } from '../store'
import { hasPg, pgRunInTransaction } from '../dbAdapter'

export const router = Router()

function currentMonthKeyAU(): string {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit' }).formatToParts(new Date())
  let y = '', m = ''
  for (const p of parts) { if ((p as any).type === 'year') y = (p as any).value; if ((p as any).type === 'month') m = (p as any).value }
  return `${y}-${m}`
}

function computeDueISO(monthKey: string, dueDay: number): string {
  const [ys, ms] = String(monthKey).split('-')
  const y = Number(ys)
  const m = Number(ms)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const d = Math.min(Number(dueDay || 1), lastDay)
  return `${String(y)}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`
}

router.patch('/payments/:id', requireAnyPerm(['recurring_payments.write','finance.tx.write']), async (req, res) => {
  if (!hasPg) return res.status(500).json({ message: 'pg not available' })
  const { id } = req.params
  const body = req.body || {}
  const allowed = ['amount','vendor','category','category_detail','due_day_of_month','frequency_months','status','pay_account_name','pay_bsb','pay_account_number','pay_ref','payment_type','bpay_code','pay_mobile_number']
  const payload: Record<string, any> = {}
  allowed.forEach(k => { if (body[k] != null) payload[k] = body[k] })
  const currentMonth = currentMonthKeyAU()
  try {
    const result = await pgRunInTransaction(async (client) => {
      const beforeRes = await client.query('SELECT * FROM recurring_payments WHERE id = $1', [id])
      const before = (beforeRes.rows?.[0]) || null
      if (!before) return { notFound: true }
      const keys = Object.keys(payload)
      const sets = keys.map((k, i) => `${k} = $${i + 1}`)
      const values = keys.map(k => payload[k])
      const sql = `UPDATE recurring_payments SET ${sets.length ? sets.join(', ') + ', ' : ''}updated_at = now() WHERE id = $${keys.length + 1} RETURNING *`
      const updRes = await client.query(sql, [...values, id])
      const updated = (updRes.rows?.[0]) || before
      const scope = String(updated.scope || before.scope || 'company')
      const table = scope === 'property' ? 'property_expenses' : 'company_expenses'
      const listRes = await client.query(`SELECT id, month_key FROM ${table} WHERE fixed_expense_id = $1 AND month_key >= $2 AND status = 'unpaid'`, [id, currentMonth])
      const rows: Array<{ id: string; month_key: string }> = Array.isArray(listRes.rows) ? listRes.rows.map((r: any) => ({ id: String(r.id), month_key: String(r.month_key || '') })) : []
      const amountChanged = Object.prototype.hasOwnProperty.call(payload, 'amount')
      const dueChanged = Object.prototype.hasOwnProperty.call(payload, 'due_day_of_month')
      const newAmount = Number(payload.amount || 0)
      const newDueDay = Number(payload.due_day_of_month || updated.due_day_of_month || before.due_day_of_month || 1)
      let cnt = 0
      for (const r of rows) {
        const sets2: string[] = []
        const vals2: any[] = []
        if (amountChanged) { sets2.push('amount = $1'); vals2.push(newAmount) }
        if (dueChanged) {
          const dueISO = computeDueISO(r.month_key, newDueDay)
          if (sets2.length) { sets2.push('due_date = $2'); vals2.push(dueISO) } else { sets2.push('due_date = $1'); vals2.push(dueISO) }
        }
        if (!sets2.length) continue
        const sql2 = `UPDATE ${table} SET ${sets2.join(', ')} WHERE id = $${vals2.length + 1}`
        await client.query(sql2, [...vals2, r.id])
        cnt++
      }
      addAudit('RecurringPayment', String(id), 'update-and-sync', before, updated, (req as any).user?.sub)
      return { updated, rowCount: cnt }
    })
    if ((result as any)?.notFound) return res.status(404).json({ message: 'not found' })
    const { updated, rowCount } = result as any
    return res.json({ ok: true, updated, syncedCount: rowCount, currentMonth })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update failed' })
  }
})

export default router
