"use client"
import { Card, Space, Button, Table, Tag, Modal, Form, Input, InputNumber, Select, DatePicker, Statistic, App, message as AntMessage } from 'antd'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import { useEffect, useState } from 'react'
import { API_BASE, getJSON, authHeaders } from '../../../lib/api'

type Recurring = { id: string; property_id?: string; scope?: 'company'|'property'; vendor?: string; category?: string; amount?: number; due_day_of_month?: number; remind_days_before?: number; status?: string; last_paid_date?: string; next_due_date?: string; pay_account_name?: string; pay_bsb?: string; pay_account_number?: string; pay_ref?: string; payment_type?: 'bank_account'|'bpay'|'payid'; bpay_code?: string; pay_mobile_number?: string; expense_id?: string; expense_resource?: 'company_expenses'|'property_expenses'; fixed_expense_id?: string; is_paid?: boolean }
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
    { title:'到期日', key:'due', render:(_:any,r:any)=> fmt(r.next_due_date || r.due_date) },
    { title:'提醒', dataIndex:'remind_days_before', render:(v:number)=> v!=null?`${v}天`:'-' },
    { title:'状态', key:'st', render:(_:any,r:any)=> statusTag(r) },
    { title:'上次付款', key:'paid', render:(_:any,r:any)=> fmt(r.paid_date) },
    { title:'下次到期', key:'next', render:(_:any,r:any)=> fmt(r.next_due_date) },
    { title:'付款账户', key:'acct', width: 280, render:(_:any,r:Recurring & any)=> {
      const type = r.payment_type
      const accountName = r.pay_account_name || r.account_name
      const bsb = r.pay_bsb || r.bsb
      const accNo = r.pay_account_number || r.account_number
      const bpayCode = r.bpay_code || r.pay_bpay_code
      const bpayRef = r.pay_ref || r.bpay_ref
      const mobile = r.pay_mobile_number || r.mobile_number
      return (
        <div style={{ fontSize:12, lineHeight:1.6, whiteSpace:'normal' }}>
          {type ? <div>付款类型: <span style={{ cursor:'pointer' }} onClick={(e)=>copyAtMouse(e, type)}>{type==='bank_account'?'Bank account': type==='bpay'?'Bpay':'PayID'}</span></div> : null}
          {accountName ? <div>收款方: <span style={{ cursor:'pointer' }} onClick={(e)=>copyAtMouse(e, accountName)}>{accountName}</span></div> : null}
          {(bsb || accNo) ? <div>BSB: <span style={{ cursor:'pointer' }} onClick={(e)=>copyAtMouse(e, bsb)}>{bsb || '-'}</span> | Acc: <span style={{ cursor:'pointer' }} onClick={(e)=>copyAtMouse(e, accNo)}>{accNo || '-'}</span></div> : null}
          {(bpayCode || bpayRef) ? <div>Bpay: <span style={{ cursor:'pointer' }} onClick={(e)=>copyAtMouse(e, bpayCode)}>{bpayCode || '-'}</span> | Ref: <span style={{ cursor:'pointer' }} onClick={(e)=>copyAtMouse(e, bpayRef)}>{bpayRef || '-'}</span></div> : null}
          {mobile ? <div>Mobile: <span style={{ cursor:'pointer' }} onClick={(e)=>copyAtMouse(e, mobile)}>{mobile}</span></div> : null}
        </div>
      )
    } },
    { title:'操作', key:'ops', render:(_:any,r:Recurring)=> (
      <Space>
        <Button onClick={()=>{ setEditing(r); setOpen(true); form.setFieldsValue({ ...r }) }}>编辑</Button>
        {r.is_paid ? (
          <Button onClick={async ()=>{
            try {
              const monthKey = m.format('YYYY-MM')
              const resType = (r.scope||'company')==='property' ? 'property_expenses' : 'company_expenses'
              const qs = new URLSearchParams({ fixed_expense_id: String((r as any).fixed_expense_id || r.id), month_key: monthKey })
              const listRes = await fetch(`${API_BASE}/crud/${resType}?${qs.toString()}`, { headers: authHeaders() })
              const arr = listRes.ok ? await listRes.json().catch(()=>[]) : []
              for (const it of Array.isArray(arr)?arr:[]) {
                if (it?.id) await fetch(`${API_BASE}/crud/${resType}/${it.id}`, { method:'DELETE', headers: authHeaders() })
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
            const dim = m.endOf('month').date()
            const dueISO = m.startOf('month').date(Math.min(dueDay, dim)).format('YYYY-MM-DD')
            const baseBody = { occurred_at: todayISO, amount: Number(r.amount||0), currency: 'AUD', category: r.category || 'other', note: 'Monthly fixed payment', fixed_expense_id: r.id, month_key: m.format('YYYY-MM'), due_date: dueISO, paid_date: todayISO, status: 'paid', property_id: r.property_id }
            try {
              const resType = (r.scope||'company')==='property' ? 'property_expenses' : 'company_expenses'
              // idempotent: check existing for this month
              const qs = new URLSearchParams({ fixed_expense_id: String(r.id), month_key: m.format('YYYY-MM') })
              const existingRes = await fetch(`${API_BASE}/crud/${resType}?${qs.toString()}`, { headers: authHeaders() })
              if (existingRes.ok) {
                const arr = await existingRes.json().catch(()=>[])
                if (Array.isArray(arr) && arr.length > 0) {
                  message.success('本月已存在已付记录')
                  await refreshMonth()
                  return
                }
              }
              const resp = await fetch(`${API_BASE}/crud/${resType}`, { method:'POST', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(baseBody) })
              if (!resp.ok) {
                if (resp.status === 409) {
                  // treat duplicate as success
                } else {
                  throw new Error(`HTTP ${resp.status}`)
                }
              }
              message.success('已标记为已付')
              await refreshMonth()
            } catch (e:any) {
              message.error(e?.message || '生成支出失败')
            }
          }}>已付</Button>
        )}
        <Button danger onClick={async()=>{ try { const resp = await fetch(`${API_BASE}/crud/recurring_payments/${r.id}`, { method:'DELETE', headers: authHeaders() }); if (!resp.ok) throw new Error(`HTTP ${resp.status}`); message.success('已删除'); await load(); await refreshMonth() } catch (e:any) { message.error(e?.message || '删除失败') } }}>删除</Button>
      </Space>
    ) }
  ]

  const m = month || nowAU()
  function computeNextDue(r: Recurring): string | undefined {
    if (r.next_due_date) return r.next_due_date
    const base = r.last_paid_date ? parseAU(r.last_paid_date) : nowAU()
    const due = Number(r.due_day_of_month || 1)
    const daysInMonth = base.endOf('month').date()
    const targetDayThis = Math.min(due, daysInMonth)
    const thisDue = base.startOf('month').date(targetDayThis)
    if (base.date() < targetDayThis) return thisDue.format('DD/MM/YYYY')
    const nextMonth = base.add(1,'month')
    const dim2 = nextMonth.endOf('month').date()
    return nextMonth.startOf('month').date(Math.min(due, dim2)).format('DD/MM/YYYY')
  }
  function dueForSelectedMonth(r: Recurring): string | undefined {
    const due = Number(r.due_day_of_month || 1)
    const dim = m.endOf('month').date()
    const day = Math.min(due, dim)
    return m.startOf('month').date(day).format('DD/MM/YYYY')
  }
  const enhanced = list.map(r => ({ ...r, next_due_date: dueForSelectedMonth(r), is_paid: String(r.status||'')==='paid' }))
  const monthKey = m.format('YYYY-MM')
  async function refreshMonth() {
    const pe = await fetch(`${API_BASE}/crud/property_expenses?month_key=${monthKey}`, { headers: authHeaders() }).then(r=>r.ok?r.json():[]).catch(()=>[])
    const ce = await fetch(`${API_BASE}/crud/company_expenses?month_key=${monthKey}`, { headers: authHeaders() }).then(r=>r.ok?r.json():[]).catch(()=>[])
    setExpenses([...(Array.isArray(pe)?pe:[]), ...(Array.isArray(ce)?ce:[])])
  }
  useEffect(()=>{ refreshMonth() },[monthKey])
  const tplById: Record<string, Recurring> = Object.fromEntries((list||[]).map(r=>[String(r.id), r]))
  const paidRows = (expenses||[]).filter(e=> String(e.status||'')==='paid' && String(e.month_key||'')===monthKey).map(e=>{
    const tpl = tplById[String(e.fixed_expense_id||'')] || {}
    return {
      id: String(e.fixed_expense_id||''),
      fixed_expense_id: String(e.fixed_expense_id||''),
      expense_id: String(e.id||''),
      property_id: e.property_id,
      scope: tpl.scope || (e.property_id ? 'property' : 'company'),
      vendor: (tpl as any).vendor,
      category: String(e.category||tpl.category||''),
      amount: Number(e.amount || tpl.amount || 0),
      due_day_of_month: tpl.due_day_of_month,
      remind_days_before: tpl.remind_days_before,
      status: 'paid',
      last_paid_date: e.paid_date,
      next_due_date: e.due_date,
      is_paid: true,
    } as Recurring
  })
  const templatesForMonth = enhanced.filter(t => { const ck = (t as any).created_at ? parseAU((t as any).created_at)?.format('YYYY-MM') : undefined; const eff = ck || '0001-01'; return eff <= monthKey && inSelectedMonth(t.next_due_date) })
  const allRows = templatesForMonth
    .map(t => ({ ...t, is_paid: !!paidRows.find(pr => String(pr.fixed_expense_id||'') === String(t.id)) }))
    .sort((a,b)=>{
      const ad = parseAU(a.next_due_date)
      const bd = parseAU(b.next_due_date)
      const av = ad ? ad.valueOf() : Number.POSITIVE_INFINITY
      const bv = bd ? bd.valueOf() : Number.POSITIVE_INFINITY
      return av - bv
    })
  const paidAmount = paidRows.reduce((s,r)=> s + Number(r.amount || 0), 0)
  const unpaidAmount = allRows.filter(r=>!r.is_paid).reduce((s,r)=> s + Number(r.amount || 0), 0)
  const paidCount = paidRows.length
  const unpaidCount = allRows.filter(r=>!r.is_paid).length
  const overdueCount = allRows.filter(r => { const nd = parseAU(r.next_due_date); return !r.is_paid && nd && nowAU().isAfter(nd, 'day') }).length
  const soonCount = allRows.filter(r => { const nd = parseAU(r.next_due_date); const remind = Number((r.remind_days_before ?? 3)); const t = nowAU(); return !r.is_paid && nd && t.isBefore(nd, 'day') && nd.startOf('day').diff(t.startOf('day'), 'day') > 0 && nd.startOf('day').diff(t.startOf('day'), 'day') <= remind }).length
  useEffect(()=>{ if (soonCount>0) { message.warning(`本月有${soonCount}条固定支出即将到期`) } },[monthKey, soonCount])

  async function submit() {
    if (saving) return
    setSaving(true)
    const v = await form.validateFields()
    const payload = { ...v, amount: v.amount!=null?Number(v.amount):undefined }
    try {
      if (editing) {
        const url = `${API_BASE}/crud/recurring_payments/${editing.id}`
        const res = await fetch(url, { method:'PATCH', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(payload) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setOpen(false); setEditing(null); form.resetFields(); await load(); await refreshMonth()
      } else {
        const newId = crypto.randomUUID()
        const body = { id: newId, ...payload }
        const res = await fetch(`${API_BASE}/crud/recurring_payments`, { method:'POST', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(body) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        if (v.initial_mark === 'paid') {
          const todayISO = nowAU().format('YYYY-MM-DD')
          const dueDay = Number(v.due_day_of_month || 1)
          const dim = m.endOf('month').date()
          const dueISO = m.startOf('month').date(Math.min(dueDay, dim)).format('YYYY-MM-DD')
          const baseBody = { occurred_at: todayISO, amount: Number(v.amount||0), currency: 'AUD', category: v.category || 'other', note: 'Monthly fixed payment', fixed_expense_id: newId, month_key: m.format('YYYY-MM'), due_date: dueISO, paid_date: todayISO, status: 'paid', property_id: v.property_id }
          const resType = (v.scope||'company')==='property' ? 'property_expenses' : 'company_expenses'
          const qs = new URLSearchParams({ fixed_expense_id: String(newId), month_key: m.format('YYYY-MM') })
          const existingRes = await fetch(`${API_BASE}/crud/${resType}?${qs.toString()}`, { headers: authHeaders() })
          if (existingRes.ok) {
            const arr = await existingRes.json().catch(()=>[])
            if (!(Array.isArray(arr) && arr.length > 0)) {
              await fetch(`${API_BASE}/crud/${resType}`, { method:'POST', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(baseBody) })
            }
          }
        }
        setOpen(false); setEditing(null); form.resetFields(); await load(); await refreshMonth()
      }
    } catch (e:any) {
      message.error(e?.message || '保存失败')
    }
    setSaving(false)
  }

  // removed normalization side-effect; display uses selected-month computation

  return (
    <Card title="固定支出" extra={<Space><DatePicker picker="month" value={month} onChange={(v)=> setMonth(v || dayjs())} /><Button type="primary" onClick={()=>{ setEditing(null); form.resetFields(); setOpen(true) }}>新增固定支出</Button></Space>}>
      <div className="stats-grid">
        <Card><Statistic title="本月未付总额" value={unpaidAmount} prefix="$" precision={2} /></Card>
        <Card><Statistic title="本月已付总额" value={paidAmount} prefix="$" precision={2} /></Card>
        <Card><Statistic title="已付/未付数量" value={`${paidCount} / ${unpaidCount}`} /></Card>
        <Card><Statistic title="逾期条数" value={overdueCount} valueStyle={{ color: overdueCount>0? 'red' : undefined }} /></Card>
        <Card><Statistic title="即将到期条数" value={soonCount} valueStyle={{ color: soonCount>0? 'orange' : undefined }} /></Card>
      </div>
      <Card title="固定支出" size="small" style={{ marginTop: 8 }}>
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
      
      <Modal open={open} onCancel={()=>setOpen(false)} onOk={submit} confirmLoading={saving} title={editing? '编辑固定支出':'新增固定支出'}>
        <Form form={form} layout="vertical">
          <Form.Item name="scope" label="对象" initialValue="company"><Select options={[{value:'company',label:'公司'},{value:'property',label:'房源'}]} /></Form.Item>
          <Form.Item noStyle shouldUpdate={(prev,cur)=>prev.scope!==cur.scope}>
            {()=> (form.getFieldValue('scope')==='property' ? (
              <Form.Item name="property_id" label="房号">
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  filterOption={(input, option)=> String((option as any)?.label||'').toLowerCase().includes(String(input||'').toLowerCase())}
                  filterSort={(a,b)=> String((a as any)?.region||'').localeCompare(String((b as any)?.region||'')) || String(a.label||'').localeCompare(String(b.label||''))}
                  options={(properties||[])
                    .slice()
                    .sort((a,b)=> String(a.region||'').localeCompare(String(b.region||'')) || String(a.code||a.address||a.id).localeCompare(String(b.code||b.address||b.id)))
                    .map(p=>({ value:p.id, label:p.code||p.address||p.id, region: p.region || '' }))}
                />
              </Form.Item>
            ) : null)}
          </Form.Item>
          <Form.Item name="vendor" label="支出事项" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="category" label="支出类别" rules={[{ required: true }]}><Select options={[
            {value:'房源租金',label:'房源租金'},
            {value:'公司仓库租金',label:'公司仓库租金'},
            {value:'公司办公室租金',label:'公司办公室租金'},
            {value:'车位租金',label:'车位租金'},
            {value:'密码盒',label:'密码盒'},
            {value:'车贷',label:'车贷'},
            {value:'other',label:'其他'}
          ]} /></Form.Item>
          <Form.Item noStyle shouldUpdate={(prev,cur)=>prev.category!==cur.category}>
            {()=> (form.getFieldValue('category')==='other' ? (
              <Form.Item name="category_detail" label="类别描述" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            ) : null)}
          </Form.Item>
          <Form.Item name="amount" label="金额"><InputNumber min={0} step={1} style={{ width:'100%' }} /></Form.Item>
          <Form.Item name="due_day_of_month" label="每月几号到期" rules={[{ required: true }]}><InputNumber min={1} max={31} style={{ width:'100%' }} /></Form.Item>
          <Form.Item label="提前提醒天数"><InputNumber value={3} disabled style={{ width:'100%' }} /></Form.Item>
          <Form.Item name="status" label="状态" initialValue="active"><Select options={[{value:'active',label:'active'},{value:'paused',label:'paused'}]} /></Form.Item>
          {editing ? null : (
            <Form.Item name="initial_mark" label="新增后状态" initialValue="unpaid"><Select options={[{value:'unpaid',label:'待支付'},{value:'paid',label:'已支付'}]} /></Form.Item>
          )}
          <Space direction="vertical" style={{ width:'100%' }}>
            <Form.Item name="payment_type" label="付款类型" initialValue="bank_account">
              <Select options={[{value:'bank_account',label:'Bank account'},{value:'bpay',label:'Bpay'},{value:'payid',label:'PayID'}]} />
            </Form.Item>
            <Form.Item name="pay_account_name" label="收款方"><Input /></Form.Item>
            <Form.Item noStyle shouldUpdate={(prev,cur)=>prev.payment_type!==cur.payment_type}>
              {()=> (form.getFieldValue('payment_type')==='bank_account' ? (
                <>
                  <Form.Item name="pay_bsb" label="BSB"><Input /></Form.Item>
                  <Form.Item name="pay_account_number" label="账户"><Input /></Form.Item>
                </>
              ) : null)}
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev,cur)=>prev.payment_type!==cur.payment_type}>
              {()=> (form.getFieldValue('payment_type')==='bpay' ? (
                <>
                  <Form.Item name="bpay_code" label="Bpay code"><Input /></Form.Item>
                  <Form.Item name="pay_ref" label="Ref"><Input /></Form.Item>
                </>
              ) : null)}
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev,cur)=>prev.payment_type!==cur.payment_type}>
              {()=> (form.getFieldValue('payment_type')==='payid' ? (
                <Form.Item name="pay_mobile_number" label="Mobile number"><Input /></Form.Item>
              ) : null)}
            </Form.Item>
          </Space>
        </Form>
      </Modal>
      <style jsx>{`
        .stats-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 12px; }
        .row-due-today { background: #fffbe6; }
        .row-overdue { background: #fff1f0; }
        .row-due-soon { background: #fff7e6; }
      `}</style>
    </Card>
  )
}
export function copyAtMouse(e: React.MouseEvent, val?: string) {
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
  function copy(val?: string) {
    const t = String(val || '').trim()
    if (!t) return
    try { navigator.clipboard.writeText(t); (message as any)?.open ? (message as any).open({ type:'success', content:'已复制', duration: 2 }) : AntMessage.success('已复制', 2) } catch {
      try {
        const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); (message as any)?.open ? (message as any).open({ type:'success', content:'已复制', duration: 2 }) : AntMessage.success('已复制', 2)
      } catch {}
    }
  }