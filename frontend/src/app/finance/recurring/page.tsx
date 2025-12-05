"use client"
import { Card, Space, Button, Table, Tag, Modal, Form, Input, InputNumber, Select, DatePicker, Statistic, App } from 'antd'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import { useEffect, useState } from 'react'
import { API_BASE, getJSON, authHeaders } from '../../../lib/api'

type Recurring = { id: string; property_id?: string; scope?: 'company'|'property'; vendor?: string; category?: string; amount?: number; due_day_of_month?: number; remind_days_before?: number; status?: string; last_paid_date?: string; next_due_date?: string; pay_account_name?: string; pay_bsb?: string; pay_account_number?: string; pay_ref?: string; expense_id?: string; expense_resource?: 'company_expenses'|'property_expenses'; fixed_expense_id?: string; is_paid?: boolean }
type ExpenseRow = { id: string; fixed_expense_id?: string; month_key?: string; due_date?: string; paid_date?: string; status?: string; property_id?: string; category?: string; amount?: number }
type Property = { id: string; code?: string; address?: string }

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
    return <Tag color="blue">待付款</Tag>
  }

  const columns = [
    { title:'对象', dataIndex:'property_id', render:(v:string, r:any)=> (r.scope==='company' || !v) ? '公司' : getLabel(v) },
    { title:'收款方', dataIndex:'vendor' },
    { title:'类别', dataIndex:'category', render:(v:string)=> v==='other' ? '其他' : v },
    { title:'金额', dataIndex:'amount', render:(v:number)=> v!=null?`$${Number(v).toFixed(2)}`:'-' },
    { title:'到期日', key:'due', render:(_:any,r:any)=> fmt(r.next_due_date || r.due_date) },
    { title:'提醒', dataIndex:'remind_days_before', render:(v:number)=> v!=null?`${v}天`:'-' },
    { title:'状态', key:'st', render:(_:any,r:any)=> statusTag(r) },
    { title:'上次付款', key:'paid', render:(_:any,r:any)=> fmt(r.paid_date) },
    { title:'下次到期', key:'next', render:(_:any,r:any)=> fmt(r.next_due_date) },
    { title:'付款账户', key:'acct', render:(_:any,r:Recurring)=> (
      <div style={{ fontSize:12, lineHeight:1.4 }}>
        {r.pay_account_name ? <div>Name: {r.pay_account_name}</div> : null}
        {r.pay_bsb ? <div>BSB: {r.pay_bsb}</div> : null}
        {r.pay_account_number ? <div>Acc: {r.pay_account_number}</div> : null}
        {r.pay_ref ? <div>Ref: {r.pay_ref}</div> : null}
      </div>
    ) },
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
        <Button danger onClick={async()=>{ try { const resp = await fetch(`${API_BASE}/crud/fixed_expenses/${r.id}`, { method:'DELETE', headers: authHeaders() }); if (!resp.ok) throw new Error(`HTTP ${resp.status}`); message.success('已删除'); load() } catch (e:any) { message.error(e?.message || '删除失败') } }}>删除</Button>
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
  const allRows = templatesForMonth.map(t => ({ ...t, is_paid: !!paidRows.find(pr => String(pr.fixed_expense_id||'') === String(t.id)) }))
  const paidAmount = paidRows.reduce((s,r)=> s + Number(r.amount || 0), 0)
  const unpaidAmount = allRows.filter(r=>!r.is_paid).reduce((s,r)=> s + Number(r.amount || 0), 0)
  const paidCount = paidRows.length
  const unpaidCount = allRows.filter(r=>!r.is_paid).length
  const overdueCount = allRows.filter(r => { const nd = parseAU(r.next_due_date); return !r.is_paid && nd && nowAU().isAfter(nd, 'day') }).length

  async function submit() {
    if (saving) return
    setSaving(true)
    const v = await form.validateFields()
    const payload = { ...v, amount: v.amount!=null?Number(v.amount):undefined }
    const url = editing ? `${API_BASE}/crud/fixed_expenses/${editing.id}` : `${API_BASE}/crud/fixed_expenses`
    const method = editing ? 'PATCH' : 'POST'
    const res = await fetch(url, { method, headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(editing?payload:{ id: crypto.randomUUID(), ...payload }) })
    if (res.ok) { setOpen(false); setEditing(null); form.resetFields(); load() }
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
            return ''
          }}
        />
        {allRows.filter(r=>!r.is_paid).length === 0 ? <div style={{ margin:'8px 0', color:'#888' }}>本月无未支付固定支出</div> : null}
      </Card>
      <Card title="已支付固定支出" size="small" style={{ marginTop: 12 }}>
        <Table rowKey={(r)=>r.id} columns={columns as any} dataSource={paidRows} pagination={{ pageSize: 10 }} scroll={{ x: 'max-content' }} />
      </Card>
      <Modal open={open} onCancel={()=>setOpen(false)} onOk={submit} confirmLoading={saving} title={editing? '编辑固定支出':'新增固定支出'}>
        <Form form={form} layout="vertical">
          <Form.Item name="scope" label="对象" initialValue="company"><Select options={[{value:'company',label:'公司'},{value:'property',label:'房源'}]} /></Form.Item>
          <Form.Item noStyle shouldUpdate={(prev,cur)=>prev.scope!==cur.scope}>
            {()=> (form.getFieldValue('scope')==='property' ? (
              <Form.Item name="property_id" label="房号"><Select allowClear showSearch options={properties.map(p=>({ value:p.id, label:p.code||p.address||p.id }))} /></Form.Item>
            ) : null)}
          </Form.Item>
          <Form.Item name="vendor" label="收款方" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="category" label="类别" rules={[{ required: true }]}><Select options={[
            {value:'owners_corp',label:'物业(OC)'},
            {value:'council_rate',label:'市政费'},
            {value:'internet',label:'网费'},
            {value:'electricity',label:'电费'},
            {value:'water',label:'水费'},
            {value:'carpark',label:'车位费'},
            {value:'office_rent',label:'办公室租金'},
            {value:'salary',label:'工资'},
            {value:'insurance',label:'保险'},
            {value:'vehicle',label:'车辆相关'},
            {value:'loan',label:'贷款'},
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
          <Form.Item label="付款账户">
            <Space direction="vertical" style={{ width:'100%' }}>
              <Form.Item name="pay_account_name" label="名称"><Input /></Form.Item>
              <Form.Item name="pay_bsb" label="BSB"><Input /></Form.Item>
              <Form.Item name="pay_account_number" label="账户"><Input /></Form.Item>
              <Form.Item name="pay_ref" label="Ref"><Input /></Form.Item>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
      <style jsx>{`
        .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 12px; }
        .row-due-today { background: #fffbe6; }
        .row-overdue { background: #fff1f0; }
      `}</style>
    </Card>
  )
}