"use client"
import { Card, Space, Button, Table, Tag, Modal, Form, Input, InputNumber, Select, DatePicker, Statistic, App } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useState } from 'react'
import { API_BASE, getJSON, authHeaders } from '../../../lib/api'

type Recurring = { id: string; property_id?: string; scope?: 'company'|'property'; vendor?: string; category?: string; amount?: number; due_day_of_month?: number; remind_days_before?: number; status?: string; last_paid_date?: string; next_due_date?: string; pay_account_name?: string; pay_bsb?: string; pay_account_number?: string; pay_ref?: string; expense_id?: string; expense_resource?: 'company_expenses'|'property_expenses' }
type Property = { id: string; code?: string; address?: string }

export default function RecurringPage() {
  const { message } = App.useApp()
  const [list, setList] = useState<Recurring[]>([])
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

  function fmt(d?: string) { const s = toDayStr(d); return s ? dayjs(s).format('DD/MM/YYYY') : '-' }
  function toDayStr(s?: string): string | undefined {
    if (!s) return undefined
    const t = String(s)
    const m1 = t.match(/^(\d{4}-\d{2}-\d{2})/)
    if (m1) return m1[1]
    const m2 = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
    if (m2) return `${m2[3]}-${m2[2]}-${m2[1]}`
    const d = dayjs(t)
    return d.isValid() ? d.format('YYYY-MM-DD') : undefined
  }
  function getLabel(p?: string) { const x = properties.find(pp=>pp.id===p); return x?.code || x?.address || '公司' }
  function statusTag(r: Recurring) {
    const today = dayjs().format('YYYY-MM-DD')
    if ((r.status||'')==='paused') return <Tag color="default">暂停</Tag>
    if ((r.status||'')==='paid') return <Tag color="green">已付款</Tag>
    const nd = toDayStr(r.next_due_date)
    if (nd && nd === today) return <Tag color="gold">今天到期</Tag>
    if (nd && dayjs(nd).isBefore(dayjs(), 'day')) {
      const days = dayjs().diff(dayjs(nd), 'day')
      return <Tag color="red">逾期 {days} 天</Tag>
    }
    return <Tag color="blue">待付款</Tag>
  }

  const columns = [
    { title:'对象', dataIndex:'property_id', render:(v:string, r:Recurring)=> r.scope==='company' || !v ? '公司' : getLabel(v) },
    { title:'收款方', dataIndex:'vendor' },
    { title:'类别', dataIndex:'category', render:(v:string, r:Recurring)=> v==='other' ? `其他: ${r.category_detail || ''}` : v },
    { title:'金额', dataIndex:'amount', render:(v:number)=> v!=null?`$${Number(v).toFixed(2)}`:'-' },
    { title:'到期日', dataIndex:'due_day_of_month' },
    { title:'提醒', dataIndex:'remind_days_before', render:(v:number)=> v!=null?`${v}天`:'-' },
    { title:'状态', key:'st', render:(_:any,r:Recurring)=> statusTag(r) },
    { title:'上次付款', dataIndex:'last_paid_date', render:(v:string)=> fmt(v) },
    { title:'下次到期', dataIndex:'next_due_date', render:(v:string)=> fmt(v) },
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
        <Button onClick={()=>{ setEditing(r); setOpen(true); form.setFieldsValue({ ...r, last_paid_date: r.last_paid_date ? dayjs(r.last_paid_date) : undefined }) }}>编辑</Button>
        {r.status === 'paid' ? (
          <Button onClick={async ()=>{
            const base = dayjs()
            const due = Number(r.due_day_of_month || 1)
            const dim = base.endOf('month').date()
            const nd = base.startOf('month').date(Math.min(due, dim)).format('YYYY-MM-DD')
            const isOver = dayjs().isAfter(dayjs(nd), 'day')
            const prevMonth = base.subtract(1,'month')
            const prevDim = prevMonth.endOf('month').date()
            const lp = prevMonth.startOf('month').date(Math.min(due, prevDim)).format('YYYY-MM-DD')
            const delDate = r.last_paid_date ? dayjs(r.last_paid_date).format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD')
            try {
              if (r.expense_id && r.expense_resource) {
                const del = await fetch(`${API_BASE}/crud/${r.expense_resource}/${r.expense_id}`, { method:'DELETE', headers: authHeaders() })
                if (!del.ok) throw new Error(`HTTP ${del.status}`)
              } else {
                const resType = (r.scope||'company')==='property' ? 'property_expenses' : 'company_expenses'
                const q = new URLSearchParams({ occurred_at: delDate, category: String(r.category||'other'), amount: String(Number(r.amount||0)), note: 'Monthly fixed payment' })
                if (resType==='property_expenses' && r.property_id) q.set('property_id', String(r.property_id))
                try {
                  const find = await fetch(`${API_BASE}/crud/${resType}?${q.toString()}`, { headers: authHeaders() })
                  if (find.ok) {
                    const arr = await find.json().catch(()=>[])
                    const id = Array.isArray(arr) && arr[0]?.id
                    if (id) {
                      await fetch(`${API_BASE}/crud/${resType}/${id}`, { method:'DELETE', headers: authHeaders() })
                    }
                  }
                } catch {}
              }
            } catch (e:any) {
              message.error(e?.message || '删除关联支出失败')
            }
            const payload = { status: isOver ? 'overdue' : 'active', last_paid_date: lp, next_due_date: nd, expense_id: null, expense_resource: null }
            try {
              const resp = await fetch(`${API_BASE}/crud/recurring_payments/${r.id}`, { method:'PATCH', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(payload) })
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
              message.success('已退回为未付')
              load()
            } catch (e: any) {
              message.error(e?.message || '退回失败')
            }
          }}>未付</Button>
        ) : (
          <Button onClick={async ()=>{
            const today = dayjs().format('YYYY-MM-DD')
            let expId: string | undefined
            let expRes: 'company_expenses'|'property_expenses' | undefined
            try {
              if ((r.scope||'company') === 'property' && r.property_id) {
                expRes = 'property_expenses'
                const body = { occurred_at: today, amount: Number(r.amount||0), currency: 'AUD', category: r.category || 'other', category_detail: r.vendor || '', note: 'Monthly fixed payment', property_id: r.property_id }
                const resp = await fetch(`${API_BASE}/crud/property_expenses`, { method:'POST', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(body) })
                if (resp.status === 409) {
                  // duplicate, proceed without linking
                } else if (resp.ok) {
                  const j = await resp.json().catch(()=>null)
                  expId = j?.id
                } else {
                  throw new Error(`HTTP ${resp.status}`)
                }
              } else {
                expRes = 'company_expenses'
                const body = { occurred_at: today, amount: Number(r.amount||0), currency: 'AUD', category: r.category || 'other', category_detail: r.vendor || '', note: 'Monthly fixed payment' }
                const resp = await fetch(`${API_BASE}/crud/company_expenses`, { method:'POST', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(body) })
                if (resp.status === 409) {
                  // duplicate, proceed without linking
                } else if (resp.ok) {
                  const j = await resp.json().catch(()=>null)
                  expId = j?.id
                } else {
                  throw new Error(`HTTP ${resp.status}`)
                }
              }
            } catch (e: any) {
              message.error(e?.message || '生成支出失败')
            }
            const base = dayjs()
            const due = Number(r.due_day_of_month || 1)
            const nextMonth = base.add(1,'month')
            const dim2 = nextMonth.endOf('month').date()
            const nd2 = nextMonth.startOf('month').date(Math.min(due, dim2)).format('YYYY-MM-DD')
            const payload = { last_paid_date: today, status: 'paid', next_due_date: nd2, expense_id: expId, expense_resource: expRes }
            try {
              const resp = await fetch(`${API_BASE}/crud/recurring_payments/${r.id}`, { method:'PATCH', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(payload) })
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
              message.success('已标记为已付')
              load()
            } catch (e: any) {
              message.error(e?.message || '更新固定支出失败')
            }
          }}>已付</Button>
        )}
      </Space>
    ) }
  ]

  const m = month || dayjs()
  const monthStart = m.startOf('month').format('YYYY-MM-DD')
  const monthEnd = m.endOf('month').format('YYYY-MM-DD')
  function computeNextDue(r: Recurring): string | undefined {
    if (r.next_due_date) return r.next_due_date
    const base = r.last_paid_date ? dayjs(r.last_paid_date) : dayjs()
    const due = Number(r.due_day_of_month || 1)
    const daysInMonth = base.endOf('month').date()
    const targetDayThis = Math.min(due, daysInMonth)
    const thisDue = base.startOf('month').date(targetDayThis)
    if (base.date() < targetDayThis) return thisDue.format('YYYY-MM-DD')
    const nextMonth = base.add(1,'month')
    const dim2 = nextMonth.endOf('month').date()
    return nextMonth.startOf('month').date(Math.min(due, dim2)).format('YYYY-MM-DD')
  }
  const enhanced = list.map(r => ({ ...r, next_due_date: computeNextDue(r) }))
  const monthKey = m.format('YYYY-MM')
  const unpaidRows = enhanced.filter(r => {
    const nd = toDayStr(r.next_due_date)
    const isPaid = String(r.status||'') === 'paid'
    const ndMonth = nd ? dayjs(nd).format('YYYY-MM') : ''
    return nd && ndMonth === monthKey && !isPaid
  })
  const paidRows = enhanced.filter(r => {
    const isPaid = String(r.status||'') === 'paid'
    const nd = toDayStr(r.next_due_date)
    const ndMonth = nd ? dayjs(nd).format('YYYY-MM') : ''
    return isPaid && nd && ndMonth === monthKey
  })
  const paidAmount = paidRows.reduce((s,r)=> s + Number(r.amount || 0), 0)
  const unpaidAmount = unpaidRows.reduce((s,r)=> s + Number(r.amount || 0), 0)
  const paidCount = paidRows.length
  const unpaidCount = unpaidRows.length
  const overdueCount = unpaidRows.filter(r => { const nd = toDayStr(r.next_due_date); return nd && dayjs(nd).isBefore(dayjs(), 'day') }).length

  async function submit() {
    if (saving) return
    setSaving(true)
    const v = await form.validateFields()
    const payload = { ...v, amount: v.amount!=null?Number(v.amount):undefined, last_paid_date: v.last_paid_date ? dayjs(v.last_paid_date).format('YYYY-MM-DD') : undefined }
    const url = editing ? `${API_BASE}/crud/recurring_payments/${editing.id}` : `${API_BASE}/crud/recurring_payments`
    const method = editing ? 'PATCH' : 'POST'
    const res = await fetch(url, { method, headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(editing?payload:{ id: crypto.randomUUID(), ...payload }) })
    if (res.ok) { setOpen(false); setEditing(null); form.resetFields(); load() }
    setSaving(false)
  }

  return (
    <Card title="固定支出" extra={<Space><DatePicker picker="month" value={month} onChange={(v)=> setMonth(v || dayjs())} /><Button type="primary" onClick={()=>{ setEditing(null); form.resetFields(); setOpen(true) }}>新增固定支出</Button></Space>}>
      <Space style={{ marginBottom: 12 }} wrap>
        <Card><Statistic title="本月未付总额" value={unpaidAmount} prefix="$" precision={2} /></Card>
        <Card><Statistic title="本月已付总额" value={paidAmount} prefix="$" precision={2} /></Card>
        <Card><Statistic title="已付/未付数量" value={`${paidCount} / ${unpaidCount}`} /></Card>
        <Card><Statistic title="逾期条数" value={overdueCount} valueStyle={{ color: overdueCount>0? 'red' : undefined }} /></Card>
        <Tag color="blue">月份筛选：{monthKey}</Tag>
      </Space>
      <Card title="固定支出" size="small" style={{ marginTop: 8 }}>
        <Table rowKey={(r)=>r.id} columns={columns as any} dataSource={unpaidRows} pagination={{ pageSize: 10 }} scroll={{ x: 'max-content' }}
          rowClassName={(r)=>{
            const today = dayjs().format('YYYY-MM-DD')
            const nd = toDayStr(r.next_due_date)
            const isPaid = String(r.status||'') === 'paid'
            if ((r.status||'')==='paused') return ''
            if (!isPaid && nd === today) return 'row-due-today'
            if (!isPaid && nd && dayjs(nd).isBefore(dayjs(), 'day')) return 'row-overdue'
            return ''
          }}
        />
        {unpaidRows.length === 0 ? <div style={{ margin:'8px 0', color:'#888' }}>本月无未支付固定支出</div> : null}
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
          <Form.Item name="last_paid_date" label="最后一次付款日期"><DatePicker style={{ width:'100%' }} /></Form.Item>
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
        .row-due-today { background: #fffbe6; }
        .row-overdue { background: #fff1f0; }
      `}</style>
    </Card>
  )
}