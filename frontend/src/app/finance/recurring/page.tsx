"use client"
import { Card, Space, Button, Table, Tag, Drawer, Form, Input, InputNumber, Select, DatePicker, Statistic, App, Descriptions, Popconfirm, Row, Col, Divider } from 'antd'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import { useEffect, useRef, useState } from 'react'
import { API_BASE, getJSON, authHeaders } from '../../../lib/api'
import { sortProperties } from '../../../lib/properties'
import { isDueForMonth, shouldIncludeForMonth } from '../../../lib/recurringStartMonth'
import { isAutoPaidInRent } from '../../../lib/recurringPaymentRules'

type Recurring = { id: string; property_id?: string; property_ids?: string[]; scope?: 'company'|'property'; vendor?: string; category?: string; amount?: number; due_day_of_month?: number; frequency_months?: number; remind_days_before?: number; status?: string; last_paid_date?: string; next_due_date?: string; pay_account_name?: string; pay_bsb?: string; pay_account_number?: string; pay_ref?: string; payment_type?: 'bank_account'|'bpay'|'payid'|'rent_deduction'|'cash'; bpay_code?: string; pay_mobile_number?: string; expense_id?: string; expense_resource?: 'company_expenses'|'property_expenses'; fixed_expense_id?: string; report_category?: string; start_month_key?: string; is_paid?: boolean; is_due_month?: boolean; created_at?: string }
type ExpenseRow = { id: string; fixed_expense_id?: string; month_key?: string; due_date?: string; paid_date?: string; status?: string; property_id?: string; category?: string; amount?: number }
type Property = { id: string; code?: string; address?: string; region?: string }

dayjs.extend(customParseFormat)
dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.tz.setDefault('Australia/Melbourne')

export default function RecurringPage() {
  const { message, modal } = App.useApp()
  const [list, setList] = useState<Recurring[]>([])
  const [expenses, setExpenses] = useState<ExpenseRow[]>([])
  const [properties, setProperties] = useState<Property[]>([])
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const [editing, setEditing] = useState<Recurring | null>(null)
  const [saving, setSaving] = useState(false)
  const [month, setMonth] = useState(dayjs())
  const [viewOpen, setViewOpen] = useState(false)
  const [viewing, setViewing] = useState<Recurring | null>(null)
  const [searchText, setSearchText] = useState('')
  const [rowMutating, setRowMutating] = useState<Record<string, 'pay' | 'unpay' | 'pause' | 'resume' | undefined>>({})
  const [pageLoading, setPageLoading] = useState(true)
  const [snapLoading, setSnapLoading] = useState(false)
  const [snapKey, setSnapKey] = useState<string>('')
  const [suppressSnapUntil, setSuppressSnapUntil] = useState(0)
  const reloadSeq = useRef(0)
  const lastLoadedAt = useRef(0)

  async function fetchRecurringPayments() {
    const resp = await fetch(`${API_BASE}/crud/recurring_payments`, { headers: authHeaders(), cache: 'no-store' })
    const rows = resp.ok ? await resp.json().catch(()=>[]) : []
    return Array.isArray(rows) ? rows : []
  }
  async function fetchProperties() {
    const props = await getJSON<Property[]>('/properties?include_archived=true').catch(()=>[])
    return Array.isArray(props) ? props : []
  }
  async function fetchMonthExpenses(mk: string) {
    const [pe, ce] = await Promise.all([
      fetch(`${API_BASE}/crud/property_expenses?month_key=${mk}`, { headers: authHeaders(), cache: 'no-store' }).then(r=>r.ok?r.json():[]).catch(()=>[]),
      fetch(`${API_BASE}/crud/company_expenses?month_key=${mk}`, { headers: authHeaders(), cache: 'no-store' }).then(r=>r.ok?r.json():[]).catch(()=>[]),
    ])
    return ([...(Array.isArray(pe)?pe:[]), ...(Array.isArray(ce)?ce:[])] as any[]) as ExpenseRow[]
  }
  async function load() {
    const [rows, props] = await Promise.all([fetchRecurringPayments(), fetchProperties()])
    setList(rows)
    setProperties(props)
  }

  function parseAU(s?: string) {
    if (!s) return undefined as any
    const t = String(s)
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(t)) return dayjs.tz(t, 'DD/MM/YYYY', 'Australia/Melbourne')
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return dayjs.tz(t, 'YYYY-MM-DD', 'Australia/Melbourne')
    const d = dayjs.tz(t, 'Australia/Melbourne')
    return d.isValid() ? d : undefined
  }
  function toISODate(s?: string) {
    const d = parseAU(s)
    return d ? d.format('YYYY-MM-DD') : ''
  }
  function normalizeIds(v: any): string[] {
    if (!v) return []
    if (Array.isArray(v)) return Array.from(new Set(v.map(x => String(x || '').trim()).filter(Boolean)))
    if (typeof v === 'string') {
      const s = v.trim()
      if (!s) return []
      if (s.startsWith('{') && s.endsWith('}')) {
        const inner = s.slice(1, -1)
        return Array.from(new Set(inner.split(',').map(x => String(x || '').trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)))
      }
      try {
        const j = JSON.parse(s)
        if (Array.isArray(j)) return Array.from(new Set(j.map(x => String(x || '').trim()).filter(Boolean)))
      } catch {}
      return [s]
    }
    return []
  }
  function betterExpense(a: ExpenseRow | undefined, b: ExpenseRow): ExpenseRow {
    if (!a) return b
    const aPaid = String(a.status || '') === 'paid'
    const bPaid = String(b.status || '') === 'paid'
    if (aPaid !== bPaid) return bPaid ? b : a
    const ap = toISODate(a.paid_date)
    const bp = toISODate(b.paid_date)
    if (ap !== bp) {
      if (bp && !ap) return b
      if (ap && !bp) return a
      if (bp > ap) return b
      if (ap > bp) return a
    }
    const ad = toISODate(a.due_date) || toISODate((a as any).occurred_at)
    const bd = toISODate(b.due_date) || toISODate((b as any).occurred_at)
    if (ad !== bd) {
      if (bd && !ad) return b
      if (ad && !bd) return a
      if (bd > ad) return b
      if (ad > bd) return a
    }
    return b
  }
  function buildExpByFixed(rows: ExpenseRow[]) {
    const map: Record<string, ExpenseRow> = {}
    for (const e of Array.isArray(rows) ? rows : []) {
      const fid = String((e as any).fixed_expense_id || '')
      if (!fid) continue
      map[fid] = betterExpense(map[fid], e)
    }
    return map
  }
  function nowAU() { return dayjs.tz(dayjs(), 'Australia/Melbourne') }
  function fmt(d?: string) { const m = parseAU(d); return m ? m.format('DD/MM/YYYY') : '-' }
  function getLabel(p?: string) { const x = properties.find(pp=>pp.id===p); return x?.code || x?.address || '公司' }
  function statusTag(r: Recurring & { is_paid?: boolean }) {
    const today = nowAU()
    if ((r.status||'')==='paused') return <Tag color="default">暂停</Tag>
    if ((r as any).is_due_month === false) return <Tag color="default">非到期</Tag>
    if (isAutoPaidInRent(r)) return <Tag color="green">已付款</Tag>
    if (r.is_paid) return <Tag color="green">已付款</Tag>
    const nd = parseAU(r.next_due_date)
    if (nd && nd.isSame(today, 'day')) return <Tag color="gold">今天到期</Tag>
    if (nd && today.isAfter(nd, 'day')) {
      const days = today.startOf('day').diff(nd.startOf('day'), 'day')
      return <Tag color="red">逾期 {days} 天</Tag>
    }
    if (nd && today.isBefore(nd, 'day')) {
      const days = nd.startOf('day').diff(today.startOf('day'), 'day')
      const remind = Number((r.remind_days_before ?? 3))
      if (days > 0 && days <= remind) return <Tag color="orange">即将到期 {days} 天</Tag>
    }
    return <Tag color="blue">待付款</Tag>
  }

  const columns = [
    { title:'对象', dataIndex:'property_id', render:(v:string, r:any)=> (r.scope==='company' || !v) ? '公司' : getLabel(v) },
    { title:'支出事项', dataIndex:'vendor' },
    { title:'支出类别', dataIndex:'category', render:(v:string)=> v==='other' ? '其他' : v },
    { title:'金额', dataIndex:'amount', render:(v:number)=> v!=null?`$${Number(v).toFixed(2)}`:'-' },
    { title:'到期日', key:'due', render:(_:any,r:any)=> {
      if ((r as Recurring).payment_type === 'rent_deduction') return '-'
      if ((r as any).is_due_month === false) return '-'
      const dueDay = Number(r.due_day_of_month || 1)
      const dim = m.endOf('month').date()
      const iso = m.startOf('month').date(Math.min(dueDay, dim)).format('YYYY-MM-DD')
      return fmt(iso)
    } },
    { title:'提醒', dataIndex:'remind_days_before', render:(v:number)=> v!=null?`${v}天`:'-' },
    { title:'状态', key:'st', render:(_:any,r:any)=> statusTag(r) },
    { title:'上次付款', key:'paid', render:(_:any,r:any)=> fmt(r.last_paid_date || r.paid_date) },
    { title:'下次到期', key:'next', render:(_:any,r:any)=> {
      if ((r as Recurring).payment_type === 'rent_deduction') return '-'
      return fmt(nextDueISOForRow(r))
    } },
    { title:'付款账户', key:'acct', width: 280, render:(_:any,r:Recurring & any)=> {
      const type = r.payment_type
      const accountName = r.pay_account_name || r.account_name
      const bsb = r.pay_bsb || r.bsb
      const accNo = r.pay_account_number || r.account_number
      const bpayCode = r.bpay_code || r.pay_bpay_code
      const bpayRef = r.pay_ref || r.bpay_ref
      const bankRef = r.pay_ref
      const mobile = r.pay_mobile_number || r.mobile_number
      if (type === 'rent_deduction') {
        return (
          <div style={{ fontSize:12, lineHeight:1.6, whiteSpace:'normal' }}>
            <div>付款类型: 租金扣除</div>
          </div>
        )
      }
      return (
        <div style={{ fontSize:12, lineHeight:1.6, whiteSpace:'normal' }}>
          {type ? <div>付款类型: <span style={{ cursor:'pointer' }} onClick={(e)=>copyAtMouse(e, type)}>{type==='bank_account'?'Bank account': type==='bpay'?'Bpay': type==='payid'?'PayID': type==='cash'?'现金':'PayID'}</span></div> : null}
          {accountName ? <div>收款方: <span style={{ cursor:'pointer' }} onClick={(e)=>copyAtMouse(e, accountName)}>{accountName}</span></div> : null}
          {(bsb || accNo) ? <div>BSB: <span style={{ cursor:'pointer' }} onClick={(e)=>copyAtMouse(e, bsb)}>{bsb || '-'}</span> | Acc: <span style={{ cursor:'pointer' }} onClick={(e)=>copyAtMouse(e, accNo)}>{accNo || '-'}</span></div> : null}
          {(bpayCode || bpayRef) ? <div>Bpay: <span style={{ cursor:'pointer' }} onClick={(e)=>copyAtMouse(e, bpayCode)}>{bpayCode || '-'}</span> | Ref: <span style={{ cursor:'pointer' }} onClick={(e)=>copyAtMouse(e, bpayRef)}>{bpayRef || '-'}</span></div> : null}
          {(type==='bank_account' && bankRef) ? <div>Ref: <span style={{ cursor:'pointer' }} onClick={(e)=>copyAtMouse(e, bankRef)}>{bankRef}</span></div> : null}
          {mobile ? <div>Mobile: <span style={{ cursor:'pointer' }} onClick={(e)=>copyAtMouse(e, mobile)}>{mobile}</span></div> : null}
        </div>
      )
    } },
    { title:'操作', key:'ops', render:(_:any,r:Recurring)=> (
      <Space>
        <Button onClick={()=>{ setViewing(r); setViewOpen(true) }}>查看</Button>
        <Button onClick={()=>{ const sm = (r as any).start_month_key ? dayjs.tz(`${String((r as any).start_month_key)}-01`, 'YYYY-MM-DD', 'Australia/Melbourne') : nowAU().startOf('month'); const pids = normalizeIds((r as any).property_ids); const pids2 = pids.length ? pids : (r.property_id ? [r.property_id] : []); setEditing(r); setOpen(true); form.setFieldsValue({ ...r, property_ids: pids2, start_month: sm, frequency_months: r.frequency_months ?? 1 }) }}>编辑</Button>
        {String(r.status || '') === 'paused' ? (
          <>
            <Button disabled>已停用</Button>
            <Popconfirm
              title="确认恢复该固定支出？恢复后将按规则重新生成本月/未来记录。"
              okText="恢复"
              cancelText="取消"
              onConfirm={async()=>{
                const id = String(r.id)
                if (rowMutating[id]) return
                setRowMutating(s => ({ ...s, [id]: 'resume' }))
                setSuppressSnapUntil(Date.now() + 4000)
                try {
                  const resp = await fetch(`${API_BASE}/recurring/payments/${id}/resume`, { method:'POST', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify({ month_key: monthKey }) })
                  if (!resp.ok) {
                    const txt = await resp.text().catch(()=> '')
                    throw new Error(txt || `HTTP ${resp.status}`)
                  }
                  message.success('已恢复')
                  await load()
                  await refreshMonth()
                } catch (e:any) {
                  message.error(e?.message || '恢复失败')
                } finally {
                  setRowMutating(s => ({ ...s, [id]: undefined }))
                }
              }}
            >
              <Button type="primary" loading={rowMutating[String(r.id)]==='resume'} disabled={!!rowMutating[String(r.id)]}>恢复</Button>
            </Popconfirm>
          </>
        ) : (
          <>
            {((r.payment_type === 'rent_deduction') || (r as any).is_due_month === false) ? null : (r.is_paid ? (
              <Popconfirm
                title="确认取消已付并标记为未付？"
                okText="确认"
                cancelText="取消"
                onConfirm={()=>{
                  modal.confirm({
                    title: '再次确认取消已付？',
                    content: '此操作会影响当月房源营收与报表。',
                    okText: '确认取消已付',
                    cancelText: '返回',
                    onOk: async () => {
                      const id = String(r.id)
                      if (rowMutating[id]) return
                      const monthKey = m.format('YYYY-MM')
                      const fixedId = String((r as any).fixed_expense_id || r.id)
                      const prevExpenses = (expenses||[]).filter(e => String(e.month_key||'')===monthKey && String(e.fixed_expense_id||'')===fixedId)
                      setRowMutating(s => ({ ...s, [id]: 'unpay' }))
                      const msgKey = `unpay-${id}-${monthKey}`
                      message.open({ type:'loading', content:'正在切换为未付…', key: msgKey, duration: 0 })
                      setExpenses(prev => prev.map(e => (String(e.month_key||'')===monthKey && String(e.fixed_expense_id||'')===fixedId) ? ({ ...e, status:'unpaid', paid_date: null } as any) : e))
                      try {
                        const resType = (r.scope||'company')==='property' ? 'property_expenses' : 'company_expenses'
                        const qs = new URLSearchParams({ fixed_expense_id: fixedId, month_key: monthKey })
                        const listRes = await fetch(`${API_BASE}/crud/${resType}?${qs.toString()}`, { headers: authHeaders() })
                        const arr = listRes.ok ? await listRes.json().catch(()=>[]) : []
                        const rows = Array.isArray(arr) ? arr : []
                        await Promise.all(rows.filter((it:any)=>it?.id).map((it:any)=> fetch(`${API_BASE}/crud/${resType}/${it.id}`, { method:'PATCH', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify({ status:'unpaid', paid_date: null }) })))
                        message.open({ type:'success', content:'已切换为未付', key: msgKey })
                        void refreshMonth()
                      } catch (e:any) {
                        setExpenses(prev => {
                          const rest = prev.filter(e => !(String(e.month_key||'')===monthKey && String(e.fixed_expense_id||'')===fixedId))
                          return [...rest, ...prevExpenses]
                        })
                        message.open({ type:'error', content:(e?.message || '切换失败'), key: msgKey })
                      } finally {
                        setRowMutating(s => ({ ...s, [id]: undefined }))
                      }
                    },
                  })
                }}
              >
                <Button loading={rowMutating[String(r.id)]==='unpay'} disabled={!!rowMutating[String(r.id)]}>取消已付</Button>
              </Popconfirm>
            ) : (
              <Button type="primary" loading={rowMutating[String(r.id)]==='pay'} disabled={!!rowMutating[String(r.id)]} onClick={async ()=>{
              const id = String(r.id)
              if (rowMutating[id]) return
              const todayISO = nowAU().format('YYYY-MM-DD')
              const dueDay = Number(r.due_day_of_month || 1)
              const freq = Number(r.frequency_months || 1)
              const dim = m.endOf('month').date()
              const dueISO = m.startOf('month').date(Math.min(dueDay, dim)).format('YYYY-MM-DD')
              const monthKey = m.format('YYYY-MM')
              const fixedId = String((r as any).fixed_expense_id || r.id)
              const prevExpenses = (expenses||[]).filter(e => String(e.month_key||'')===monthKey && String(e.fixed_expense_id||'')===fixedId)
              const prevTpl = (list||[]).find(x => String(x.id)===id)
              setRowMutating(s => ({ ...s, [id]: 'pay' }))
              const msgKey = `pay-${id}-${monthKey}`
              message.open({ type:'loading', content:'正在标记已付…', key: msgKey, duration: 0 })
              setExpenses(prev => {
                const rest = prev.filter(e => !(String(e.month_key||'')===monthKey && String(e.fixed_expense_id||'')===fixedId))
                const optimistic: ExpenseRow = {
                  id: prevExpenses?.[0]?.id || `optimistic-${id}-${monthKey}`,
                  fixed_expense_id: fixedId,
                  month_key: monthKey,
                  due_date: dueISO,
                  paid_date: todayISO,
                  status: 'paid',
                  property_id: r.property_id,
                  category: r.category,
                  amount: Number(r.amount || 0),
                }
                return [...rest, optimistic]
              })
              setList(prev => prev.map(x => String(x.id)===id ? ({ ...x, last_paid_date: todayISO, status:'active' } as any) : x))
              try {
                const resType = (r.scope||'company')==='property' ? 'property_expenses' : 'company_expenses'
                const qs = new URLSearchParams({ fixed_expense_id: fixedId, month_key: monthKey })
                const patchRows = async (rows: any[]) => {
                  await Promise.all(
                    rows
                      .filter((it: any) => it?.id)
                      .map((it: any) =>
                        fetch(`${API_BASE}/crud/${resType}/${it.id}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json', ...authHeaders() },
                          body: JSON.stringify({ paid_date: todayISO, status: 'paid', amount: Number(r.amount || 0), due_date: dueISO }),
                        })
                      )
                  )
                }

                const listRes1 = await fetch(`${API_BASE}/crud/${resType}?${qs.toString()}`, { headers: authHeaders() })
                const arr1 = listRes1.ok ? await listRes1.json().catch(()=>[]) : []
                const rows1 = Array.isArray(arr1) ? arr1 : []

                if (rows1.length) {
                  await patchRows(rows1)
                  const keepId = String(rows1[0]?.id || '')
                  if (keepId) {
                    setExpenses(prev => prev.map(e => (String(e.month_key||'')===monthKey && String(e.fixed_expense_id||'')===fixedId) ? ({ ...e, id: keepId } as any) : e))
                  }
                } else {
                  const createBody = { occurred_at: todayISO, amount: Number(r.amount||0), currency: 'AUD', category: r.category || 'other', note: 'Fixed payment', generated_from: 'recurring_payments', fixed_expense_id: fixedId, month_key: monthKey, due_date: dueISO, paid_date: todayISO, status: 'paid', property_id: r.property_id }
                  const createResp = await fetch(`${API_BASE}/crud/${resType}`, { method:'POST', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(createBody) })
                  if (createResp.ok) {
                    const created = await createResp.json().catch(()=>null)
                    if (created?.id) {
                      setExpenses(prev => prev.map(e => (String(e.month_key||'')===monthKey && String(e.fixed_expense_id||'')===fixedId) ? ({ ...e, id: String(created.id) } as any) : e))
                    }
                  } else if (createResp.status === 409) {
                    const listRes2 = await fetch(`${API_BASE}/crud/${resType}?${qs.toString()}`, { headers: authHeaders() })
                    const arr2 = listRes2.ok ? await listRes2.json().catch(()=>[]) : []
                    const rows2 = Array.isArray(arr2) ? arr2 : []
                    if (rows2.length) {
                      await patchRows(rows2)
                      const keepId = String(rows2[0]?.id || '')
                      if (keepId) {
                        setExpenses(prev => prev.map(e => (String(e.month_key||'')===monthKey && String(e.fixed_expense_id||'')===fixedId) ? ({ ...e, id: keepId } as any) : e))
                      }
                    }
                  } else {
                    const txt = await createResp.text().catch(()=> '')
                    throw new Error(txt || `HTTP ${createResp.status}`)
                  }
                }

                const nextBase = m.add(freq,'month')
                const nextDim = nextBase.endOf('month').date()
                const nextISO = nextBase.startOf('month').date(Math.min(dueDay, nextDim)).format('YYYY-MM-DD')
                const tplResp = await fetch(`${API_BASE}/crud/recurring_payments/${id}`, { method:'PATCH', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify({ last_paid_date: todayISO, next_due_date: nextISO, status: 'active', frequency_months: freq }) })
                if (!tplResp.ok) throw new Error(`HTTP ${tplResp.status}`)

                message.open({ type:'success', content:'已标记为已付', key: msgKey })
                void refreshMonth()
              } catch (e:any) {
                setExpenses(prev => {
                  const rest = prev.filter(e2 => !(String(e2.month_key||'')===monthKey && String(e2.fixed_expense_id||'')===fixedId))
                  return [...rest, ...prevExpenses]
                })
                if (prevTpl) setList(prev => prev.map(x => String(x.id)===id ? prevTpl : x))
                message.open({ type:'error', content:(e?.message || '标记失败'), key: msgKey })
              } finally {
                setRowMutating(s => ({ ...s, [id]: undefined }))
              }
            }}>已付</Button>
            ))}
            <Popconfirm
              title="确认停用该固定支出？停用后不再生成新记录，历史支出保留不受影响。"
              okText="停用"
              cancelText="取消"
              onConfirm={async()=>{
            const id = String(r.id)
            if (rowMutating[id]) return
            setRowMutating(s => ({ ...s, [id]: 'pause' }))
            setSuppressSnapUntil(Date.now() + 4000)
            try {
              const resp = await fetch(`${API_BASE}/recurring/payments/${r.id}/pause`, { method:'POST', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: '{}' })
              if (!resp.ok) {
                const txt = await resp.text().catch(()=> '')
                throw new Error(txt || `HTTP ${resp.status}`)
              }
              message.success('已停用')
              await load()
              await refreshMonth()
            } catch (e:any) {
              message.error(e?.message || '停用失败')
            } finally {
              setRowMutating(s => ({ ...s, [id]: undefined }))
            }
          }}
            >
              <Button danger loading={rowMutating[String(r.id)]==='pause'} disabled={!!rowMutating[String(r.id)]}>停用</Button>
            </Popconfirm>
          </>
        )}
      </Space>
    ) }
  ]

  const m = month || nowAU()
  const currentMonthKey = nowAU().format('YYYY-MM')
  function monthKeyToIndex(monthKey: string): number {
    const [ys, ms] = String(monthKey || '').split('-')
    const y = Number(ys)
    const mm = Number(ms)
    if (!Number.isFinite(y) || !Number.isFinite(mm) || mm < 1 || mm > 12) return NaN
    return y * 12 + (mm - 1)
  }
  function indexToMonthKey(idx: number): string {
    const y = Math.floor(idx / 12)
    const mm = (idx % 12) + 1
    return `${String(y)}-${String(mm).padStart(2, '0')}`
  }
  function dueForSelectedMonth(r: Recurring): string | undefined {
    if (r.payment_type === 'rent_deduction') return undefined
    const due = Number(r.due_day_of_month || 1)
    const dim = m.endOf('month').date()
    const day = Math.min(due, dim)
    return m.startOf('month').date(day).format('DD/MM/YYYY')
  }
  function nextDueISOForRow(r: Recurring): string | undefined {
    if (r.payment_type === 'rent_deduction') return undefined
    const startKey = String((r as any).start_month_key || '')
    const freq = Math.max(1, Math.min(24, Number(r.frequency_months || 1)))
    const dueDay = Number(r.due_day_of_month || 1)
    const selKey = m.format('YYYY-MM')
    if (!startKey || !/^\d{4}-\d{2}$/.test(startKey) || !/^\d{4}-\d{2}$/.test(selKey)) {
      const dim = m.endOf('month').date()
      return m.startOf('month').date(Math.min(dueDay, dim)).format('YYYY-MM-DD')
    }
    const sIdx = monthKeyToIndex(startKey)
    const selIdx = monthKeyToIndex(selKey)
    if (!Number.isFinite(sIdx) || !Number.isFinite(selIdx)) return undefined
    const isDue = isDueForMonth(startKey, selKey, freq)
    const nextIdx = (() => {
      if (selIdx < sIdx) return sIdx
      if (!isDue) return sIdx + (Math.floor((selIdx - sIdx) / freq) + 1) * freq
      return selIdx + ((r.is_paid ? freq : 0))
    })()
    const mk = indexToMonthKey(nextIdx)
    const mm = dayjs.tz(`${mk}-01`, 'YYYY-MM-DD', 'Australia/Melbourne')
    const dim = mm.endOf('month').date()
    return mm.startOf('month').date(Math.min(dueDay, dim)).format('YYYY-MM-DD')
  }
  const enhanced = list.map(r => ({ ...r, next_due_date: dueForSelectedMonth(r), is_paid: false }))
  const monthKey = m.format('YYYY-MM')
  async function refreshMonth() {
    const rows = await fetchMonthExpenses(monthKey)
    setExpenses(rows)
  }
  async function reloadAll() {
    const seq = ++reloadSeq.current
    setPageLoading(true)
    try {
      const [rows, monthRows] = await Promise.all([
        fetchRecurringPayments(),
        fetchMonthExpenses(monthKey),
      ])
      if (seq !== reloadSeq.current) return
      setList(rows)
      setExpenses(monthRows)
      lastLoadedAt.current = Date.now()
    } finally {
      if (seq === reloadSeq.current) setPageLoading(false)
    }
    void (async () => {
      const props = await fetchProperties()
      if (seq !== reloadSeq.current) return
      setProperties(props)
    })()
  }
  useEffect(()=>{ void reloadAll() },[monthKey])
  useEffect(()=>{
    const onVisible = () => {
      if (document.hidden) return
      if (Date.now() - (lastLoadedAt.current || 0) < 1500) return
      void reloadAll()
    }
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  },[monthKey])
  const monthExpenses = (expenses||[]).filter(e=> String(e.month_key||'')===monthKey)
  const expByFixed: Record<string, ExpenseRow> = buildExpByFixed(monthExpenses)
  const templatesForMonth = enhanced.filter(t => {
    const startKey = String((t as any).start_month_key || '')
    return shouldIncludeForMonth(startKey || undefined, monthKey)
  })
  const allRowsBase = templatesForMonth
    .map(t => {
      const startKey = String((t as any).start_month_key || '')
      const is_due_month = isDueForMonth(startKey || undefined, monthKey, Number((t as any).frequency_months || 1))
      const eRaw = expByFixed[String(t.id)]
      const e = is_due_month ? eRaw : undefined
      const amount = (is_due_month && e) ? Number(e.amount || 0) : Number(t.amount || 0)
      const category = (is_due_month && e) ? String(e.category || t.category || '') : t.category
      const paused = String((t as any).status || '') === 'paused'
      const autoPaidInRent = !paused && isAutoPaidInRent({ ...t, category } as any)
      const next_due_date = (!is_due_month || autoPaidInRent) ? undefined : (e ? e.due_date : dueForSelectedMonth(t))
      const is_paid = paused ? false : (!is_due_month ? true : (autoPaidInRent ? true : (e ? String(e.status||'')==='paid' : false)))
      return { ...t, amount, next_due_date, is_paid, is_due_month, status: (t.status||''), category }
    })
    .sort((a,b)=>{
      const aIsConsumables = String(a.category||'')==='消耗品费' || String(a.report_category||'')==='consumables'
      const bIsConsumables = String(b.category||'')==='消耗品费' || String(b.report_category||'')==='consumables'
      if (aIsConsumables !== bIsConsumables) return aIsConsumables ? 1 : -1
      const ac = a.created_at ? new Date(a.created_at).getTime() : 0
      const bc = b.created_at ? new Date(b.created_at).getTime() : 0
      if (ac !== bc) return bc - ac
      const ad = parseAU(a.next_due_date)
      const bd = parseAU(b.next_due_date)
      const av = ad ? ad.valueOf() : Number.POSITIVE_INFINITY
      const bv = bd ? bd.valueOf() : Number.POSITIVE_INFINITY
      return av - bv
    })
  const allRows = allRowsBase.filter(r => {
    const q = String(searchText||'').trim().toLowerCase()
    if (!q) return true
    if (r.scope==='company' || !r.property_id) return '公司'.includes(q) || 'company'.includes(q)
    const label = getLabel(r.property_id)
    return String(label||'').toLowerCase().includes(q)
  })
  const activeRows = allRows.filter(r => String((r as any).status || '') !== 'paused' && (r as any).is_due_month !== false)
  const paidAmount = activeRows.filter(r=>r.is_paid).reduce((s,r)=> s + Number(r.amount || 0), 0)
  const unpaidAmount = activeRows.filter(r=>!r.is_paid).reduce((s,r)=> s + Number(r.amount || 0), 0)
  const paidCount = activeRows.filter(r=>r.is_paid).length
  const unpaidCount = activeRows.filter(r=>!r.is_paid).length
  const overdueCount = activeRows.filter(r => { const nd = parseAU(r.next_due_date); return !r.is_paid && nd && nowAU().isAfter(nd, 'day') }).length
  const soonCount = activeRows.filter(r => { const nd = parseAU(r.next_due_date); const remind = Number((r.remind_days_before ?? 3)); const t = nowAU(); return !r.is_paid && nd && t.isBefore(nd, 'day') && nd.startOf('day').diff(t.startOf('day'), 'day') > 0 && nd.startOf('day').diff(t.startOf('day'), 'day') <= remind }).length
  useEffect(()=>{ if (soonCount>0) { message.warning(`本月有${soonCount}条固定支出即将到期`) } },[monthKey, soonCount])

  useEffect(()=>{
    (async()=>{
      if (pageLoading) return
      if (Date.now() < suppressSnapUntil) return
      if (snapKey === monthKey) return
      if (!templatesForMonth.length) return
      setSnapKey(monthKey)
      setSnapLoading(true)
      try {
        const candidates = templatesForMonth
          .filter((t) => String((t as any).status || '') !== 'paused')
          .filter((t) => {
            const startKey = String((t as any).start_month_key || '')
            return isDueForMonth(startKey || undefined, monthKey, Number((t as any).frequency_months || 1))
          })
          .filter((t) => {
            const mode = String((t as any).amount_mode || 'fixed')
            const hasRow = !!expByFixed[String(t.id)]
            return !hasRow || mode === 'percent_of_property_total_income'
          })
        const limit = Math.max(1, Math.min(3, Number((window as any).__ensureSnapConcurrency || 2)))
        let idx = 0
        let ok = 0
        let sawServerBusy = false
        const runOne = async (t: any) => {
          try {
            const resp = await fetch(`${API_BASE}/recurring/payments/${t.id}/ensure-snapshot`, { method:'POST', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify({ month_key: monthKey }) })
            if (!resp.ok) {
              if (resp.status === 503 || resp.status === 500) sawServerBusy = true
              return
            }
            ok++
          } catch {
            sawServerBusy = true
          }
        }
        const workers = Array.from({ length: Math.min(limit, candidates.length || 0) }).map(async () => {
          while (idx < candidates.length) {
            const cur = candidates[idx++]
            await runOne(cur)
          }
        })
        await Promise.all(workers)
        if (ok > 0) await refreshMonth()
        if (sawServerBusy) setSuppressSnapUntil(Date.now() + 60_000)
      } finally {
        setSnapLoading(false)
      }
    })()
  },[monthKey, templatesForMonth.length, pageLoading, suppressSnapUntil])

  async function submit() {
    if (saving) return
    setSaving(true)
    const v = await form.validateFields()
    const startMonthKey = v.start_month ? dayjs(v.start_month).format('YYYY-MM') : undefined
    const isReferral = String(v.amount_mode || 'fixed') === 'percent_of_property_total_income'
    const payload: any = {
      ...v,
      start_month_key: startMonthKey,
      report_category: (v.scope==='property' ? (v.report_category || defaultReportCategoryByName(v.category)) : undefined),
      frequency_months: v.frequency_months!=null ? Number(v.frequency_months) : undefined,
    }
    if (isReferral) {
      const pids = normalizeIds(v.property_ids)
      payload.property_ids = pids
      payload.property_id = (pids.length === 1) ? pids[0] : undefined
      payload.amount = undefined
      payload.rate_percent = v.rate_percent!=null ? Number(v.rate_percent) : undefined
      payload.income_base = v.income_base || 'total_income'
      payload.scope = 'company'
      payload.due_day_of_month = 6
      payload.frequency_months = 1
    } else {
      payload.amount = v.amount!=null ? Number(v.amount) : undefined
      if (payload.scope !== 'property') payload.property_id = undefined
      payload.property_ids = undefined
      payload.rate_percent = undefined
      payload.income_base = undefined
    }
    delete (payload as any).start_month
    try {
      if (editing) {
        const url = `${API_BASE}/recurring/payments/${editing.id}`
        const res = await fetch(url, { method:'PATCH', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(payload) })
        const j = await res.json().catch(()=>({}))
        if (!res.ok) throw new Error(String(j?.message || j?.invalid || `HTTP ${res.status}`))
        const n = Number(j?.syncedCount || 0)
        message.success(`未来未付记录已同步 ${n} 条`)
        setOpen(false); setEditing(null); form.resetFields(); await load(); await refreshMonth()
      } else {
        const newId = crypto.randomUUID()
        const startKey = String(startMonthKey || '')
        const initMark = (startKey && startKey > currentMonthKey) ? 'unpaid' : String(v.initial_mark || 'unpaid')
        const body = { id: newId, ...payload, initial_mark: initMark }
        const res = await fetch(`${API_BASE}/recurring/payments`, { method:'POST', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(body) })
        const j = await res.json().catch(()=>({}))
        if (!res.ok) throw new Error(String(j?.message || j?.invalid || `HTTP ${res.status}`))
        setOpen(false); setEditing(null); form.resetFields(); await load(); await refreshMonth()
      }
    } catch (e:any) {
      message.error(e?.message || '保存失败')
    }
    setSaving(false)
  }

  // removed normalization side-effect; display uses selected-month computation

  return (
    <Card title="固定支出" extra={<Space><DatePicker picker="month" value={month} onChange={(v)=> setMonth(v || dayjs())} /><Input allowClear placeholder="按房号搜索" value={searchText} onChange={(e)=> setSearchText(e.target.value)} style={{ width: 220 }} /><Button type="primary" onClick={()=>{ setEditing(null); form.resetFields(); form.setFieldsValue({ start_month: nowAU().startOf('month'), initial_mark: 'unpaid', frequency_months: 1, status: 'active', payment_type: 'bank_account', amount_mode: 'fixed' }); setOpen(true) }}>新增固定支出</Button></Space>}>
      <div className="stats-grid">
        <Card loading={pageLoading}><Statistic title="本月未付总额" value={unpaidAmount} prefix="$" precision={2} /></Card>
        <Card loading={pageLoading}><Statistic title="本月已付总额" value={paidAmount} prefix="$" precision={2} /></Card>
        <Card loading={pageLoading}><Statistic title="已付/未付数量" value={`${paidCount} / ${unpaidCount}`} /></Card>
        <Card loading={pageLoading}><Statistic title="逾期条数" value={overdueCount} valueStyle={{ color: overdueCount>0? 'red' : undefined }} /></Card>
        <Card loading={pageLoading}><Statistic title="即将到期条数" value={soonCount} valueStyle={{ color: soonCount>0? 'orange' : undefined }} /></Card>
      </div>
      <Card title="固定支出" size="small" style={{ marginTop: 8 }} loading={pageLoading}>
        <div style={{ margin:'8px 0', color:'#888' }}>修改将从本月起生效，历史或已支付记录不会变化。</div>
        <Table rowKey={(r)=>r.id} columns={columns as any} dataSource={(pageLoading ? [] : allRows)} loading={pageLoading || snapLoading} pagination={{ pageSize: 10 }} scroll={{ x: 'max-content' }}
          rowClassName={(r)=>{
            const today = nowAU()
            const nd = parseAU(r.next_due_date)
            const isPaid = !!(r as any).is_paid
            if ((r.status||'')==='paused') return ''
            if ((r as any).is_due_month === false) return ''
            if (!isPaid && nd && nd.isSame(today, 'day')) return 'row-due-today'
            if (!isPaid && nd && today.isAfter(nd, 'day')) return 'row-overdue'
            if (!isPaid && nd && today.isBefore(nd, 'day')) {
              const days = nd.startOf('day').diff(today.startOf('day'), 'day')
              const remind = Number((r.remind_days_before ?? 3))
              if (days > 0 && days <= remind) return 'row-due-soon'
            }
            return ''
          }}
        />
        {(!pageLoading && allRows.filter(r=>!r.is_paid).length === 0) ? <div style={{ margin:'8px 0', color:'#888' }}>本月无未支付固定支出</div> : null}
      </Card>
      
      <Drawer open={open} onClose={()=>setOpen(false)} title={editing? '编辑固定支出':'新增固定支出'} width={720} footer={
        <div style={{ textAlign: 'right' }}>
          <Space>
            <Button onClick={()=>setOpen(false)}>取消</Button>
            <Button type="primary" onClick={submit} loading={saving}>保存</Button>
          </Space>
        </div>
      }>
        <Form form={form} layout="vertical">
          <Divider orientation="left">基本信息</Divider>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item noStyle shouldUpdate={(prev,cur)=>prev.amount_mode!==cur.amount_mode}>
                {()=> (
                  <Form.Item name="scope" label="对象" initialValue="company">
                    <Select disabled={form.getFieldValue('amount_mode')==='percent_of_property_total_income'} options={[{value:'company',label:'公司'},{value:'property',label:'房源'}]} />
                  </Form.Item>
                )}
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="amount_mode" label="计费方式" initialValue="fixed">
                <Select options={[
                  { value: 'fixed', label: '固定金额' },
                  { value: 'percent_of_property_total_income', label: 'Referral（按上月房源总租金比例）' },
                ]} />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item noStyle shouldUpdate={(prev,cur)=> prev.amount_mode!==cur.amount_mode}>
            {()=> {
              const am = form.getFieldValue('amount_mode')
              if (am === 'percent_of_property_total_income') {
                form.setFieldsValue({ scope: 'company', due_day_of_month: 6, frequency_months: 1, amount: undefined, income_base: 'total_income', property_id: undefined })
              }
              return null
            }}
          </Form.Item>

          <Row gutter={16}>
            <Form.Item noStyle shouldUpdate={(prev,cur)=>prev.scope!==cur.scope || prev.amount_mode!==cur.amount_mode}>
              {()=> {
                const sc = form.getFieldValue('scope')
                const am = form.getFieldValue('amount_mode')
                const needProperty = sc === 'property' || am === 'percent_of_property_total_income'
                if (!needProperty) return <Col span={12}><div style={{ height: 62 }} /></Col>
                if (am === 'percent_of_property_total_income') {
                  return (
                    <Col span={12}>
                      <Form.Item name="property_ids" label="关联房源" rules={[{ required: true }]}>
                        <Select
                          mode="multiple"
                          allowClear
                          showSearch
                          optionFilterProp="label"
                          filterOption={(input, option)=> String((option as any)?.label||'').toLowerCase().includes(String(input||'').toLowerCase())}
                          options={sortProperties(properties||[]).map(p=>({ value:p.id, label:p.code||p.address||p.id }))}
                        />
                      </Form.Item>
                    </Col>
                  )
                }
                return (
                  <Col span={12}>
                    <Form.Item name="property_id" label="房号" rules={[{ required: true }]}>
                      <Select
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        filterOption={(input, option)=> String((option as any)?.label||'').toLowerCase().includes(String(input||'').toLowerCase())}
                        options={sortProperties(properties||[]).map(p=>({ value:p.id, label:p.code||p.address||p.id }))}
                      />
                    </Form.Item>
                  </Col>
                )
              }}
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev,cur)=>prev.amount_mode!==cur.amount_mode}>
              {()=> (form.getFieldValue('amount_mode')==='percent_of_property_total_income' ? (
                <Col span={12}>
                  <Form.Item name="rate_percent" label="百分比(%)" rules={[{ required: true }]}>
                    <InputNumber min={0} max={100} step={0.1} style={{ width:'100%' }} />
                  </Form.Item>
                </Col>
              ) : <Col span={12}><div style={{ height: 62 }} /></Col>)}
            </Form.Item>
          </Row>
          <Form.Item name="income_base" initialValue="total_income" hidden><Input /></Form.Item>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="vendor" label="支出事项" rules={[{ required: true }]}><Input /></Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="category" label="支出类别" rules={[{ required: true }]}><Select options={[
                {value:'房源租金',label:'房源租金'},
                {value:'公司仓库租金',label:'公司仓库租金'},
                {value:'公司办公室租金',label:'公司办公室租金'},
                {value:'车位租金',label:'车位租金'},
                {value:'密码盒',label:'密码盒'},
                {value:'消耗品费',label:'消耗品费'},
                {value:'车贷',label:'车贷'},
                {value:'other',label:'其他'}
              ]} /></Form.Item>
            </Col>
          </Row>
          
          <Form.Item noStyle shouldUpdate={(prev,cur)=> prev.category!==cur.category || prev.scope!==cur.scope}>
            {()=> {
              const cat = form.getFieldValue('category')
              const sc = form.getFieldValue('scope')
              if (sc==='property' && cat==='消耗品费') {
                form.setFieldsValue({ vendor: 'Consumable fee', report_category: 'consumables', payment_type: 'rent_deduction', initial_mark: 'paid', due_day_of_month: undefined })
              }
              return null
            }}
          </Form.Item>

          <Row gutter={16}>
            <Form.Item noStyle shouldUpdate={(prev,cur)=>prev.scope!==cur.scope || prev.category!==cur.category}>
              {()=> (form.getFieldValue('scope')==='property' ? (
                <Col span={12}>
                  <Form.Item name="report_category" label="营收报表归类" rules={[{ required: true }]} initialValue={defaultReportCategoryByName(form.getFieldValue('category'))}>
                    <Select options={[
                      { value: 'parking_fee', label: '车位费' },
                      { value: 'electricity', label: '电费' },
                      { value: 'water', label: '水费' },
                      { value: 'gas', label: '气费' },
                      { value: 'internet', label: '网费' },
                      { value: 'consumables', label: '消耗品费' },
                      { value: 'body_corp', label: '物业费' },
                      { value: 'council', label: '市政费' },
                      { value: 'other', label: '其他支出' },
                    ]} />
                  </Form.Item>
                </Col>
              ) : null)}
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev,cur)=>prev.category!==cur.category}>
              {()=> (form.getFieldValue('category')==='other' ? (
                <Col span={12}>
                  <Form.Item name="category_detail" label="类别描述" rules={[{ required: true }]}> 
                    <Input />
                  </Form.Item>
                </Col>
              ) : null)}
            </Form.Item>
          </Row>

          <Divider orientation="left">支付与周期</Divider>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="start_month"
                label="起始月份"
                rules={[{ required: true, message: '请选择起始月份' }]}
              >
                <DatePicker picker="month" style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Form.Item noStyle shouldUpdate={(prev, cur) => prev.start_month !== cur.start_month}>
              {() => {
                const sm = form.getFieldValue('start_month')
                const mk = sm ? dayjs(sm).format('YYYY-MM') : ''
                const isFuture = !!mk && mk > currentMonthKey
                return (
                  <Col span={12}>
                    <div style={{ height: 62, display: 'flex', alignItems: 'flex-end', paddingBottom: 4, color: isFuture ? '#fa8c16' : '#888' }}>
                      {isFuture ? '起始月份为未来月：不会自动标记历史月份，新增后状态固定为待支付' : '起始月份之前不生成记录；若起始月份在过去，历史月份将自动标记为已支付'}
                    </div>
                  </Col>
                )
              }}
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev,cur)=> prev.amount_mode!==cur.amount_mode}>
              {()=> (form.getFieldValue('amount_mode')==='percent_of_property_total_income' ? (
                <Col span={12}>
                  <Form.Item label="金额">
                    <Input disabled value="按上月收入自动计算（每月5号锁账）" />
                  </Form.Item>
                </Col>
              ) : (
                <Col span={12}>
                  <Form.Item name="amount" label="金额"><InputNumber min={0} step={1} style={{ width:'100%' }} /></Form.Item>
                </Col>
              ))}
            </Form.Item>
            <Col span={12}>
              <Form.Item name="status" label="状态" initialValue="active"><Select options={[{value:'active',label:'active'},{value:'paused',label:'paused'}]} /></Form.Item>
            </Col>
            <Form.Item noStyle shouldUpdate={(prev,cur)=> prev.payment_type!==cur.payment_type || prev.amount_mode!==cur.amount_mode}>
              {()=> (form.getFieldValue('payment_type')==='rent_deduction' ? null : (
                <Col span={12}>
                  <Form.Item name="due_day_of_month" label="每月几号到期" rules={[{ required: true }]}>
                    <InputNumber min={1} max={31} style={{ width:'100%' }} disabled={form.getFieldValue('amount_mode')==='percent_of_property_total_income'} />
                  </Form.Item>
                </Col>
              ))}
            </Form.Item>
            <Col span={12}>
              <Form.Item name="frequency_months" label="支付频率" initialValue={1}><Select options={[
                { value: 1, label: '每月一付' },
                { value: 3, label: '每三月一付' },
              ]} /></Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="提前提醒天数"><InputNumber value={3} disabled style={{ width:'100%' }} /></Form.Item>
            </Col>
            {editing ? null : (
              <Col span={12}>
                <Form.Item noStyle shouldUpdate={(prev, cur) => prev.start_month !== cur.start_month}>
                  {() => {
                    const sm = form.getFieldValue('start_month')
                    const mk = sm ? dayjs(sm).format('YYYY-MM') : ''
                    const isFuture = !!mk && mk > currentMonthKey
                    if (isFuture) form.setFieldsValue({ initial_mark: 'unpaid' })
                    return (
                      <Form.Item name="initial_mark" label="新增后状态" initialValue="unpaid">
                        <Select disabled={isFuture} options={[{ value: 'unpaid', label: '待支付' }, { value: 'paid', label: '已支付' }]} />
                      </Form.Item>
                    )
                  }}
                </Form.Item>
              </Col>
            )}
          </Row>

          <Divider orientation="left">付款详情</Divider>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="payment_type" label="付款类型" initialValue="bank_account">
                <Select options={[{value:'bank_account',label:'Bank account'},{value:'bpay',label:'Bpay'},{value:'payid',label:'PayID'},{value:'cash',label:'现金'},{value:'rent_deduction',label:'租金扣除'}]} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="pay_account_name" label="收款方"><Input /></Form.Item>
            </Col>
          </Row>
          
          <Form.Item noStyle shouldUpdate={(prev,cur)=>prev.payment_type!==cur.payment_type}>
            {()=> {
              const pt = form.getFieldValue('payment_type')
              if (pt === 'bank_account') {
                return (
                  <Row gutter={16}>
                    <Col span={8}><Form.Item name="pay_bsb" label="BSB"><Input /></Form.Item></Col>
                    <Col span={10}><Form.Item name="pay_account_number" label="账户"><Input /></Form.Item></Col>
                    <Col span={6}><Form.Item name="pay_ref" label="Reference"><Input /></Form.Item></Col>
                  </Row>
                )
              }
              if (pt === 'bpay') {
                return (
                  <Row gutter={16}>
                    <Col span={12}><Form.Item name="bpay_code" label="Bpay code"><Input /></Form.Item></Col>
                    <Col span={12}><Form.Item name="pay_ref" label="Ref"><Input /></Form.Item></Col>
                  </Row>
                )
              }
              if (pt === 'payid') {
                return (
                  <Row gutter={16}>
                    <Col span={12}><Form.Item name="pay_mobile_number" label="Mobile number"><Input /></Form.Item></Col>
                  </Row>
                )
              }
              return null
            }}
          </Form.Item>
        </Form>
      </Drawer>
      <Drawer open={viewOpen} onClose={()=>{ setViewOpen(false); setViewing(null) }} title="查看固定支出" width={640}>
        {viewing ? (
          <Descriptions bordered size="small" column={1} style={{ marginTop: 8 }}>
            <Descriptions.Item label="对象">{(viewing.scope==='company' || !viewing.property_id) ? '公司' : getLabel(viewing.property_id)}</Descriptions.Item>
            {String((viewing as any).amount_mode || '') === 'percent_of_property_total_income' ? (
              <Descriptions.Item label="关联房源">{(() => {
                const pids = normalizeIds((viewing as any).property_ids)
                const pids2 = pids.length ? pids : (viewing.property_id ? [viewing.property_id] : [])
                const labels = pids2.map((id: any) => getLabel(String(id))).filter(Boolean)
                return labels.length ? labels.join(', ') : '-'
              })()}</Descriptions.Item>
            ) : null}
            <Descriptions.Item label="计费方式">{String((viewing as any).amount_mode || 'fixed') === 'percent_of_property_total_income' ? 'Referral（按上月房源总租金比例）' : '固定金额'}</Descriptions.Item>
            {String((viewing as any).amount_mode || '') === 'percent_of_property_total_income' ? (
              <Descriptions.Item label="百分比(%)">{(() => {
                const n = Number((viewing as any).rate_percent)
                return Number.isFinite(n) ? String(n) : '-'
              })()}</Descriptions.Item>
            ) : null}
            <Descriptions.Item label="支出事项">{viewing.vendor || '-'}</Descriptions.Item>
            <Descriptions.Item label="支出类别">{viewing.category==='other' ? '其他' : (viewing.category || '-')}</Descriptions.Item>
            <Descriptions.Item label="类别描述">{(viewing as any).category_detail || '-'}</Descriptions.Item>
            <Descriptions.Item label="营收报表归类">{(() => { const m: Record<string,string> = { parking_fee:'车位费', electricity:'电费', water:'水费', gas:'气费', internet:'网费', consumables:'消耗品费', body_corp:'物业费', council:'市政费', other:'其他支出' }; const v = String(viewing.report_category||''); return m[v] || (v || '-') })()}</Descriptions.Item>
            <Descriptions.Item label="金额">{viewing.amount!=null?`$${Number(viewing.amount).toFixed(2)}`:'-'}</Descriptions.Item>
            <Descriptions.Item label="每月到期日">{dueForSelectedMonth(viewing) || '-'}</Descriptions.Item>
            <Descriptions.Item label="提醒">{viewing.remind_days_before!=null?`${viewing.remind_days_before}天`:'-'}</Descriptions.Item>
            <Descriptions.Item label="支付频率">{viewing.frequency_months ? `${viewing.frequency_months}月/次` : '每月一付'}</Descriptions.Item>
            <Descriptions.Item label="状态">{viewing.status || '-'}</Descriptions.Item>
            <Descriptions.Item label="上次付款">{fmt(viewing.last_paid_date)}</Descriptions.Item>
            <Descriptions.Item label="下次到期">{fmt(dueForSelectedMonth(viewing))}</Descriptions.Item>
            <Descriptions.Item label="付款类型">{viewing.payment_type==='bank_account'?'Bank account': viewing.payment_type==='bpay'?'Bpay': viewing.payment_type==='payid'?'PayID': viewing.payment_type==='cash'?'现金': viewing.payment_type==='rent_deduction'?'租金扣除':'-'}</Descriptions.Item>
            <Descriptions.Item label="收款方">{viewing.pay_account_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="BSB / Acc">{(viewing.pay_bsb||viewing.pay_account_number) ? `BSB: ${viewing.pay_bsb||'-'} | Acc: ${viewing.pay_account_number||'-'}` : '-'}</Descriptions.Item>
            <Descriptions.Item label="Bpay">{(viewing.bpay_code||viewing.pay_ref) ? `Code: ${viewing.bpay_code||'-'} | Ref: ${viewing.pay_ref||'-'}` : '-'}</Descriptions.Item>
            <Descriptions.Item label="Bank Ref">{viewing.payment_type==='bank_account' && viewing.pay_ref ? viewing.pay_ref : '-'}</Descriptions.Item>
            <Descriptions.Item label="Mobile">{viewing.pay_mobile_number || '-'}</Descriptions.Item>
          </Descriptions>
        ) : null}
      </Drawer>
      <style jsx>{`
        .stats-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 12px; }
        .row-due-today { background: #fffbe6; }
        .row-overdue { background: #fff1f0; }
        .row-due-soon { background: #fff7e6; }
      `}</style>
    </Card>
  )
}
function copyAtMouse(e: any, val?: string) {
  try { const t = String(val || '').trim(); if (!t) return; navigator.clipboard.writeText(t) } catch {}
  const x = (e as any).clientX || 0
  const y = (e as any).clientY || 0
  const tip = document.createElement('div')
  tip.textContent = '已复制'
  tip.style.position = 'fixed'
  tip.style.left = `${x + 12}px`
  tip.style.top = `${y + 12}px`
  tip.style.background = 'rgba(0,0,0,0.80)'
  tip.style.color = '#fff'
  tip.style.borderRadius = '6px'
  tip.style.padding = '6px 10px'
  tip.style.fontSize = '12px'
  tip.style.zIndex = '10000'
  tip.style.pointerEvents = 'none'
  document.body.appendChild(tip)
  window.setTimeout(() => { try { document.body.removeChild(tip) } catch {} }, 2000)
}
function defaultReportCategoryByName(cat?: string): string {
  const v = String(cat || '').toLowerCase()
  if (v.includes('carpark') || v.includes('车位')) return 'parking_fee'
  if (v.includes('owners') || v.includes('body') || v.includes('物业')) return 'body_corp'
  if (v.includes('internet') || v.includes('nbn') || v.includes('网')) return 'internet'
  if (v.includes('water') && !v.includes('hot')) return 'water'
  if (v.includes('electric')) return 'electricity'
  if (v.includes('gas') || v.includes('hot')) return 'gas'
  if (v.includes('consumable') || v.includes('消耗')) return 'consumables'
  if (v.includes('council') || v.includes('市政')) return 'council'
  return 'other'
}
