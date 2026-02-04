"use client"
import { Card, Space, Button, Table, Tag, Drawer, Form, Input, InputNumber, Select, DatePicker, Statistic, App, Descriptions, Popconfirm, message as AntMessage, Row, Col, Divider } from 'antd'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import { useEffect, useState } from 'react'
import { API_BASE, getJSON, authHeaders } from '../../../lib/api'
import { sortProperties } from '../../../lib/properties'
import { shouldAutoMarkPaidForMonth, shouldIncludeForMonth } from '../../../lib/recurringStartMonth'

type Recurring = { id: string; property_id?: string; scope?: 'company'|'property'; vendor?: string; category?: string; amount?: number; due_day_of_month?: number; frequency_months?: number; remind_days_before?: number; status?: string; last_paid_date?: string; next_due_date?: string; pay_account_name?: string; pay_bsb?: string; pay_account_number?: string; pay_ref?: string; payment_type?: 'bank_account'|'bpay'|'payid'|'rent_deduction'|'cash'; bpay_code?: string; pay_mobile_number?: string; expense_id?: string; expense_resource?: 'company_expenses'|'property_expenses'; fixed_expense_id?: string; report_category?: string; start_month_key?: string; is_paid?: boolean; created_at?: string }
type ExpenseRow = { id: string; fixed_expense_id?: string; month_key?: string; due_date?: string; paid_date?: string; status?: string; property_id?: string; category?: string; amount?: number }
type Property = { id: string; code?: string; address?: string; region?: string }

dayjs.extend(customParseFormat)
dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.tz.setDefault('Australia/Melbourne')

export default function RecurringPage() {
  const { message } = App.useApp()
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

  async function load() {
    const rows = await fetch(`${API_BASE}/crud/recurring_payments`, { headers: authHeaders() }).then(r=>r.json()).catch(()=>[])
    setList(Array.isArray(rows)?rows:[])
    const props = await getJSON<Property[]>('/properties?include_archived=true').catch(()=>[])
    setProperties(Array.isArray(props)?props:[])
  }
  useEffect(()=>{ load() },[])

  function parseAU(s?: string) {
    if (!s) return undefined as any
    const t = String(s)
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(t)) return dayjs.tz(t, 'DD/MM/YYYY', 'Australia/Melbourne')
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return dayjs.tz(t, 'YYYY-MM-DD', 'Australia/Melbourne')
    const d = dayjs.tz(t, 'Australia/Melbourne')
    return d.isValid() ? d : undefined
  }
  function nowAU() { return dayjs.tz(dayjs(), 'Australia/Melbourne') }
  function fmt(d?: string) { const m = parseAU(d); return m ? m.format('DD/MM/YYYY') : '-' }
  function inSelectedMonth(d?: string) { const m = parseAU(d); return !!(m && m.format('YYYY-MM') === (month||dayjs()).format('YYYY-MM')) }
  function getLabel(p?: string) { const x = properties.find(pp=>pp.id===p); return x?.code || x?.address || '公司' }
  function statusTag(r: Recurring & { is_paid?: boolean }) {
    const today = nowAU()
    if ((r.status||'')==='paused') return <Tag color="default">暂停</Tag>
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
      const dueDay = Number(r.due_day_of_month || 1)
      const freq = Number(r.frequency_months || 1)
      const base = r.is_paid ? m.add(freq,'month') : m
      const dim = base.endOf('month').date()
      const iso = base.startOf('month').date(Math.min(dueDay, dim)).format('YYYY-MM-DD')
      return fmt(iso)
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
        <Button onClick={()=>{ const sm = (r as any).start_month_key ? dayjs.tz(`${String((r as any).start_month_key)}-01`, 'YYYY-MM-DD', 'Australia/Melbourne') : nowAU().startOf('month'); setEditing(r); setOpen(true); form.setFieldsValue({ ...r, start_month: sm, frequency_months: r.frequency_months ?? 1 }) }}>编辑</Button>
        {(r.payment_type === 'rent_deduction') ? null : (r.is_paid ? (
          <Button onClick={async ()=>{
            try {
              const monthKey = m.format('YYYY-MM')
              const resType = (r.scope||'company')==='property' ? 'property_expenses' : 'company_expenses'
              const qs = new URLSearchParams({ fixed_expense_id: String((r as any).fixed_expense_id || r.id), month_key: monthKey })
              const listRes = await fetch(`${API_BASE}/crud/${resType}?${qs.toString()}`, { headers: authHeaders() })
              const arr = listRes.ok ? await listRes.json().catch(()=>[]) : []
              for (const it of Array.isArray(arr)?arr:[]) {
                if (it?.id) await fetch(`${API_BASE}/crud/${resType}/${it.id}`, { method:'PATCH', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify({ status:'unpaid', paid_date: null }) })
              }
              message.success('已退回为未付')
              await refreshMonth()
            } catch (e:any) {
              message.error(e?.message || '退回失败')
            }
          }}>未付</Button>
        ) : (
          <Button onClick={async ()=>{
            const todayISO = nowAU().format('YYYY-MM-DD')
            const dueDay = Number(r.due_day_of_month || 1)
            const freq = Number(r.frequency_months || 1)
            try {
              const resType = (r.scope||'company')==='property' ? 'property_expenses' : 'company_expenses'
              for (let i = 0; i < freq; i++) {
                const mm = m.add(i, 'month')
                const dimi = mm.endOf('month').date()
                const dueISOi = mm.startOf('month').date(Math.min(dueDay, dimi)).format('YYYY-MM-DD')
                const monthKeyi = mm.format('YYYY-MM')
                const qs = new URLSearchParams({ fixed_expense_id: String(r.id), month_key: monthKeyi })
                const existingRes = await fetch(`${API_BASE}/crud/${resType}?${qs.toString()}`, { headers: authHeaders() })
                let rows: any[] = []
                if (existingRes.ok) {
                  const arr = await existingRes.json().catch(()=>[])
                  rows = Array.isArray(arr) ? arr : []
                }
                if (rows.length === 0) {
                  const bodyi = { occurred_at: todayISO, amount: Number(r.amount||0), currency: 'AUD', category: r.category || 'other', note: 'Fixed payment', generated_from: 'recurring_payments', fixed_expense_id: r.id, month_key: monthKeyi, due_date: dueISOi, paid_date: todayISO, status: 'paid', property_id: r.property_id }
                  const resp = await fetch(`${API_BASE}/crud/${resType}`, { method:'POST', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(bodyi) })
                  if (!resp.ok && resp.status !== 409) {
                    const errMsg = await resp.text().catch(()=> '')
                    console.error('POST fixed expense failed', monthKeyi, resp.status, errMsg)
                  }
                } else {
                  for (const it of rows) {
                    if (it?.id) {
                      await fetch(`${API_BASE}/crud/${resType}/${it.id}`, { method:'PATCH', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify({ paid_date: todayISO, status: 'paid', amount: Number(r.amount||0), due_date: dueISOi }) })
                    }
                  }
                }
              }
              const nextBase = m.add(freq,'month')
              const nextDim = nextBase.endOf('month').date()
              const nextISO = nextBase.startOf('month').date(Math.min(dueDay, nextDim)).format('YYYY-MM-DD')
              await fetch(`${API_BASE}/crud/recurring_payments/${r.id}`, { method:'PATCH', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify({ last_paid_date: todayISO, next_due_date: nextISO, status: 'active', frequency_months: freq }) })
              message.success('已标记为已付')
              await load(); await refreshMonth()
            } catch (e:any) {
              message.error(e?.message || '生成支出失败')
            }
          }}>已付</Button>
        ))}
        <Popconfirm title="确认停用该固定支出？停用后不再生成新记录，历史支出保留不受影响。" okText="停用" cancelText="取消" onConfirm={async()=>{ try { const resp = await fetch(`${API_BASE}/crud/recurring_payments/${r.id}`, { method:'DELETE', headers: authHeaders() }); if (!resp.ok) throw new Error(`HTTP ${resp.status}`); message.success('已停用'); await load(); await refreshMonth() } catch (e:any) { message.error(e?.message || '停用失败') } }}>
          <Button danger>停用</Button>
        </Popconfirm>
      </Space>
    ) }
  ]

  const m = month || nowAU()
  const currentMonthKey = nowAU().format('YYYY-MM')
  function computeNextDue(r: Recurring): string | undefined {
    if (r.payment_type === 'rent_deduction') return undefined
    if (r.next_due_date) return r.next_due_date
    const base = r.last_paid_date ? parseAU(r.last_paid_date) : nowAU()
    const due = Number(r.due_day_of_month || 1)
    const daysInMonth = base.endOf('month').date()
    const targetDayThis = Math.min(due, daysInMonth)
    const thisDue = base.startOf('month').date(targetDayThis)
    if (base.date() < targetDayThis) return thisDue.format('DD/MM/YYYY')
    const nextMonth = base.add(Number((form.getFieldValue('frequency_months') || 1)), 'month')
    const dim2 = nextMonth.endOf('month').date()
    return nextMonth.startOf('month').date(Math.min(due, dim2)).format('DD/MM/YYYY')
  }
  function dueForSelectedMonth(r: Recurring): string | undefined {
    if (r.payment_type === 'rent_deduction') return undefined
    const due = Number(r.due_day_of_month || 1)
    const dim = m.endOf('month').date()
    const day = Math.min(due, dim)
    return m.startOf('month').date(day).format('DD/MM/YYYY')
  }
  const enhanced = list.map(r => ({ ...r, next_due_date: dueForSelectedMonth(r), is_paid: false }))
  const monthKey = m.format('YYYY-MM')
  async function refreshMonth() {
    const pe = await fetch(`${API_BASE}/crud/property_expenses?month_key=${monthKey}`, { headers: authHeaders() }).then(r=>r.ok?r.json():[]).catch(()=>[])
    const ce = await fetch(`${API_BASE}/crud/company_expenses?month_key=${monthKey}`, { headers: authHeaders() }).then(r=>r.ok?r.json():[]).catch(()=>[])
    setExpenses([...(Array.isArray(pe)?pe:[]), ...(Array.isArray(ce)?ce:[])])
  }
  useEffect(()=>{ refreshMonth() },[monthKey])
  const tplById: Record<string, Recurring> = Object.fromEntries((list||[]).map(r=>[String(r.id), r]))
  const monthExpenses = (expenses||[]).filter(e=> String(e.month_key||'')===monthKey)
  const expByFixed: Record<string, ExpenseRow> = Object.fromEntries(monthExpenses.map(e=>[String(e.fixed_expense_id||''), e]))
  const templatesForMonth = enhanced.filter(t => {
    const inMonth = inSelectedMonth(dueForSelectedMonth(t))
    const include = (t as any).payment_type === 'rent_deduction' ? true : inMonth
    const startKey = String((t as any).start_month_key || '')
    return include && shouldIncludeForMonth(startKey || undefined, monthKey)
  })
  const allRowsBase = templatesForMonth
    .map(t => {
      const e = expByFixed[String(t.id)]
      const amount = e ? Number(e.amount || 0) : Number(t.amount || 0)
      const next_due_date = e ? e.due_date : dueForSelectedMonth(t)
      const is_paid = e ? String(e.status||'')==='paid' : false
      const category = e ? String(e.category || t.category || '') : t.category
      return { ...t, amount, next_due_date, is_paid, status: is_paid ? 'paid' : (t.status||''), category }
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
  const paidAmount = allRows.filter(r=>r.is_paid).reduce((s,r)=> s + Number(r.amount || 0), 0)
  const unpaidAmount = allRows.filter(r=>!r.is_paid).reduce((s,r)=> s + Number(r.amount || 0), 0)
  const paidCount = allRows.filter(r=>r.is_paid).length
  const unpaidCount = allRows.filter(r=>!r.is_paid).length
  const overdueCount = allRows.filter(r => { const nd = parseAU(r.next_due_date); return !r.is_paid && nd && nowAU().isAfter(nd, 'day') }).length
  const soonCount = allRows.filter(r => { const nd = parseAU(r.next_due_date); const remind = Number((r.remind_days_before ?? 3)); const t = nowAU(); return !r.is_paid && nd && t.isBefore(nd, 'day') && nd.startOf('day').diff(t.startOf('day'), 'day') > 0 && nd.startOf('day').diff(t.startOf('day'), 'day') <= remind }).length
  useEffect(()=>{ if (soonCount>0) { message.warning(`本月有${soonCount}条固定支出即将到期`) } },[monthKey, soonCount])

  const [snapKey, setSnapKey] = useState<string>('')
  useEffect(()=>{
    (async()=>{
      if (snapKey === monthKey) return
      const tasks = templatesForMonth.map(async (t)=>{
        const e = expByFixed[String(t.id)]
        const startKey = String((t as any).start_month_key || '')
        if (e) {
          if (shouldAutoMarkPaidForMonth(startKey || undefined, monthKey, currentMonthKey) && String(e.status || '') !== 'paid') {
            const resType = (t.scope||'company')==='property' ? 'property_expenses' : 'company_expenses'
            const dueDay = Number(t.due_day_of_month || 1)
            const dim = m.endOf('month').date()
            const dueISO = m.startOf('month').date(Math.min(dueDay, dim)).format('YYYY-MM-DD')
            try {
              await fetch(`${API_BASE}/crud/${resType}/${e.id}`, { method:'PATCH', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify({ status:'paid', paid_date: dueISO, due_date: dueISO }) })
            } catch {}
          }
          return
        }
        const resType = (t.scope||'company')==='property' ? 'property_expenses' : 'company_expenses'
        const dueDay = Number(t.due_day_of_month || 1)
        const dim = m.endOf('month').date()
        const dueISO = m.startOf('month').date(Math.min(dueDay, dim)).format('YYYY-MM-DD')
        const autoPaid = shouldAutoMarkPaidForMonth(startKey || undefined, monthKey, currentMonthKey)
        const body = { occurred_at: dueISO, amount: Number(t.amount||0), currency: 'AUD', category: t.category || 'other', note: 'Fixed payment snapshot', generated_from: 'recurring_payments', fixed_expense_id: t.id, month_key: monthKey, due_date: dueISO, status: autoPaid ? 'paid' : 'unpaid', paid_date: autoPaid ? dueISO : null, property_id: t.property_id }
        try {
          const qs = new URLSearchParams({ fixed_expense_id: String(t.id), month_key: monthKey })
          const existingRes = await fetch(`${API_BASE}/crud/${resType}?${qs.toString()}`, { headers: authHeaders() })
          let exists = false
          if (existingRes.ok) {
            const arr = await existingRes.json().catch(()=>[])
            exists = Array.isArray(arr) && arr.length > 0
          }
          if (!exists) {
            await fetch(`${API_BASE}/crud/${resType}`, { method:'POST', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(body) })
          }
        } catch {}
      })
      await Promise.all(tasks)
      setSnapKey(monthKey)
      await refreshMonth()
    })()
  },[monthKey, templatesForMonth.length])

  async function submit() {
    if (saving) return
    setSaving(true)
    const v = await form.validateFields()
    const startMonthKey = v.start_month ? dayjs(v.start_month).format('YYYY-MM') : undefined
    const payload = { ...v, start_month_key: startMonthKey, report_category: (v.scope==='property' ? (v.report_category || defaultReportCategoryByName(v.category)) : undefined), amount: v.amount!=null?Number(v.amount):undefined, frequency_months: v.frequency_months!=null?Number(v.frequency_months):undefined }
    delete (payload as any).start_month
    try {
      if (editing) {
        const url = `${API_BASE}/recurring/payments/${editing.id}`
        const res = await fetch(url, { method:'PATCH', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(payload) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const j = await res.json().catch(()=>({}))
        const n = Number(j?.syncedCount || 0)
        message.success(`未来未付记录已同步 ${n} 条`)
        setOpen(false); setEditing(null); form.resetFields(); await load(); await refreshMonth()
      } else {
        const newId = crypto.randomUUID()
        const startKey = String(startMonthKey || '')
        const initMark = (startKey && startKey > currentMonthKey) ? 'unpaid' : String(v.initial_mark || 'unpaid')
        const body = { id: newId, ...payload, initial_mark: initMark }
        const res = await fetch(`${API_BASE}/recurring/payments`, { method:'POST', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(body) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setOpen(false); setEditing(null); form.resetFields(); await load(); await refreshMonth()
      }
    } catch (e:any) {
      message.error(e?.message || '保存失败')
    }
    setSaving(false)
  }

  // removed normalization side-effect; display uses selected-month computation

  return (
    <Card title="固定支出" extra={<Space><DatePicker picker="month" value={month} onChange={(v)=> setMonth(v || dayjs())} /><Input allowClear placeholder="按房号搜索" value={searchText} onChange={(e)=> setSearchText(e.target.value)} style={{ width: 220 }} /><Button type="primary" onClick={()=>{ setEditing(null); form.resetFields(); form.setFieldsValue({ start_month: nowAU().startOf('month'), initial_mark: 'unpaid', frequency_months: 1, status: 'active', payment_type: 'bank_account' }); setOpen(true) }}>新增固定支出</Button></Space>}>
      <div className="stats-grid">
        <Card><Statistic title="本月未付总额" value={unpaidAmount} prefix="$" precision={2} /></Card>
        <Card><Statistic title="本月已付总额" value={paidAmount} prefix="$" precision={2} /></Card>
        <Card><Statistic title="已付/未付数量" value={`${paidCount} / ${unpaidCount}`} /></Card>
        <Card><Statistic title="逾期条数" value={overdueCount} valueStyle={{ color: overdueCount>0? 'red' : undefined }} /></Card>
        <Card><Statistic title="即将到期条数" value={soonCount} valueStyle={{ color: soonCount>0? 'orange' : undefined }} /></Card>
      </div>
      <Card title="固定支出" size="small" style={{ marginTop: 8 }}>
        <div style={{ margin:'8px 0', color:'#888' }}>修改将从本月起生效，历史或已支付记录不会变化。</div>
        <Table rowKey={(r)=>r.id} columns={columns as any} dataSource={allRows} pagination={{ pageSize: 10 }} scroll={{ x: 'max-content' }}
          rowClassName={(r)=>{
            const today = nowAU()
            const nd = parseAU(r.next_due_date)
            const isPaid = !!(r as any).is_paid
            if ((r.status||'')==='paused') return ''
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
        {allRows.filter(r=>!r.is_paid).length === 0 ? <div style={{ margin:'8px 0', color:'#888' }}>本月无未支付固定支出</div> : null}
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
              <Form.Item name="scope" label="对象" initialValue="company"><Select options={[{value:'company',label:'公司'},{value:'property',label:'房源'}]} /></Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item noStyle shouldUpdate={(prev,cur)=>prev.scope!==cur.scope}>
                {()=> (form.getFieldValue('scope')==='property' ? (
                  <Form.Item name="property_id" label="房号">
                    <Select
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      filterOption={(input, option)=> String((option as any)?.label||'').toLowerCase().includes(String(input||'').toLowerCase())}
                      options={sortProperties(properties||[]).map(p=>({ value:p.id, label:p.code||p.address||p.id }))}
                    />
                  </Form.Item>
                ) : <div style={{ height: 62 }} />)}
              </Form.Item>
            </Col>
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
            <Col span={12}>
              <Form.Item name="amount" label="金额"><InputNumber min={0} step={1} style={{ width:'100%' }} /></Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="status" label="状态" initialValue="active"><Select options={[{value:'active',label:'active'},{value:'paused',label:'paused'}]} /></Form.Item>
            </Col>
            <Form.Item noStyle shouldUpdate={(prev,cur)=> prev.payment_type!==cur.payment_type}>
              {()=> (form.getFieldValue('payment_type')==='rent_deduction' ? null : (
                <Col span={12}>
                  <Form.Item name="due_day_of_month" label="每月几号到期" rules={[{ required: true }]}><InputNumber min={1} max={31} style={{ width:'100%' }} /></Form.Item>
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
            <Descriptions.Item label="支出事项">{viewing.vendor || '-'}</Descriptions.Item>
            <Descriptions.Item label="支出类别">{viewing.category==='other' ? '其他' : (viewing.category || '-')}</Descriptions.Item>
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
