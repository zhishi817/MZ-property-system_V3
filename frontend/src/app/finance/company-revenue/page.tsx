"use client"
import { Card, DatePicker, Table, Space, Button, Modal, Form, InputNumber, Select, DatePicker as DP, Input, message } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { getJSON, API_BASE, authHeaders } from '../../../lib/api'

type Order = { id: string; price?: number; cleaning_fee?: number; checkin?: string; checkout?: string; property_id?: string }
type Tx = { id: string; kind: 'income'|'expense'; amount: number; currency: string; category?: string; occurred_at: string }
type Landlord = { id: string; management_fee_rate?: number; property_ids?: string[] }

export default function CompanyRevenuePage() {
  const [month, setMonth] = useState<any>(dayjs())
  const [orders, setOrders] = useState<Order[]>([])
  const [txs, setTxs] = useState<Tx[]>([])
  const [landlords, setLandlords] = useState<Landlord[]>([])
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string }[]>([])
  const [incomeOpen, setIncomeOpen] = useState(false)
  const [expenseOpen, setExpenseOpen] = useState(false)
  const [incomeForm] = Form.useForm()
  const [expenseForm] = Form.useForm()
  useEffect(() => {
    getJSON<Order[]>('/orders').then(setOrders).catch(()=>setOrders([]))
    getJSON<Tx[]>('/finance').then(setTxs).catch(()=>setTxs([]))
    getJSON<Landlord[]>('/landlords').then(setLandlords).catch(()=>setLandlords([]))
    getJSON<any>('/properties').then((j)=>setProperties(j||[])).catch(()=>setProperties([]))
  }, [])
  const ym = month ? { y: month.year(), m: month.month()+1 } : null
  const start = ym ? dayjs(`${ym.y}-${String(ym.m).padStart(2,'0')}-01`) : null
  const end = start ? start.endOf('month') : null
  const inMonth = (d?: string) => !!(d && start && end && dayjs(d).isAfter(start.subtract(1,'day')) && dayjs(d).isBefore(end.add(1,'day')))

  const mgmtFee = useMemo(() => {
    if (!start || !end) return 0
    const landByProp = new Map<string, Landlord>()
    landlords.forEach(l => (l.property_ids||[]).forEach(pid => landByProp.set(pid, l)))
    let sum = 0
    orders.filter(o => inMonth(o.checkout)).forEach(o => {
      const l = landByProp.get(o.property_id || '')
      const rate = l?.management_fee_rate || 0
      sum += Number(o.price || 0) * rate
    })
    return Math.round((sum + Number.EPSILON) * 100) / 100
  }, [orders, landlords, start, end])

  const cleaningIncome = useMemo(() => orders.filter(o => inMonth(o.checkout)).reduce((s,x)=> s + Number(x.cleaning_fee || 0), 0), [orders, start, end])
  const lateIncome = useMemo(() => txs.filter(t => t.kind==='income' && inMonth(t.occurred_at) && t.category==='late_checkout').reduce((s,x)=> s + Number(x.amount||0), 0), [txs, start, end])
  const cancelIncome = useMemo(() => txs.filter(t => t.kind==='income' && inMonth(t.occurred_at) && t.category==='cancel_fee').reduce((s,x)=> s + Number(x.amount||0), 0), [txs, start, end])
  const otherIncome = useMemo(() => txs.filter(t => t.kind==='income' && inMonth(t.occurred_at) && (t.category || 'other')==='other').reduce((s,x)=> s + Number(x.amount||0), 0), [txs, start, end])
  const totalIncome = mgmtFee + cleaningIncome + lateIncome + cancelIncome + otherIncome
  const totalExpense = useMemo(() => txs.filter(t=>t.kind==='expense' && inMonth(t.occurred_at)).reduce((s,x)=> s + Number(x.amount||0), 0), [txs, start, end])
  const net = Math.round(((totalIncome - totalExpense) + Number.EPSILON) * 100) / 100
  const fmt = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  async function submitIncome() {
    const v = await incomeForm.validateFields()
    const payload = { kind: 'income', amount: Number(v.amount || 0), currency: 'AUD', occurred_at: dayjs(v.date).format('YYYY-MM-DD'), category: v.category, note: v.note, property_id: v.property_id }
    const res = await fetch(`${API_BASE}/finance`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload) })
    if (res.ok) { message.success('收入已记录'); setIncomeOpen(false); incomeForm.resetFields(); getJSON<Tx[]>('/finance').then(setTxs).catch(()=>{}) } else { message.error('记录失败') }
  }
  async function submitExpense() {
    const v = await expenseForm.validateFields()
    const payload = { kind: 'expense', amount: Number(v.amount || 0), currency: 'AUD', occurred_at: dayjs(v.date).format('YYYY-MM-DD'), category: v.category, note: v.note, property_id: v.property_id }
    const res = await fetch(`${API_BASE}/finance`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload) })
    if (res.ok) { message.success('支出已记录'); setExpenseOpen(false); expenseForm.resetFields(); getJSON<Tx[]>('/finance').then(setTxs).catch(()=>{}) } else { message.error('记录失败') }
  }

  const rows = [
    { item: '管理费', value: mgmtFee },
    { item: '清洁费', value: cleaningIncome },
    { item: '晚退房费', value: lateIncome },
    { item: '订单取消费用', value: cancelIncome },
    { item: '其他收入', value: otherIncome },
  ]

  return (
    <Card title="公司营收" extra={<Space><Button onClick={() => setIncomeOpen(true)}>新建收入</Button><Button onClick={() => setExpenseOpen(true)} danger>新建支出</Button></Space>}>
      <div style={{ marginBottom: 12 }}>
        <DatePicker picker="month" value={month} onChange={setMonth as any} />
      </div>
      <Table rowKey={(r) => r.item} dataSource={rows} pagination={false} columns={[{ title:'项目', dataIndex:'item' }, { title:'金额(AUD)', dataIndex:'value', render:(v: number)=> `$${fmt(v)}` }]} />
      <div style={{ marginTop: 12, display:'flex', justifyContent:'space-between', fontWeight: 600 }}>
        <span>公司总收入</span><span>${fmt(totalIncome)}</span>
      </div>
      <div style={{ marginTop: 8, display:'flex', justifyContent:'space-between', fontWeight: 600 }}>
        <span>公司总支出</span><span>-${fmt(totalExpense)}</span>
      </div>
      <div style={{ marginTop: 8, display:'flex', justifyContent:'space-between', fontWeight: 700 }}>
        <span>公司净营收</span><span>${fmt(net)}</span>
      </div>

      <Modal title="新建收入" open={incomeOpen} onCancel={() => setIncomeOpen(false)} onOk={submitIncome}>
        <Form form={incomeForm} layout="vertical">
          <Form.Item name="date" label="日期" rules={[{ required: true }]}><DP style={{ width:'100%' }} /></Form.Item>
          <Form.Item name="amount" label="金额" rules={[{ required: true }]}><InputNumber min={0} step={1} style={{ width:'100%' }} /></Form.Item>
          <Form.Item name="category" label="类别" rules={[{ required: true }]}>
            <Select options={[{value:'mgmt_fee',label:'管理费'},{value:'cleaning_fee',label:'清洁费'},{value:'late_checkout',label:'晚退房费'},{value:'cancel_fee',label:'取消费'},{value:'other',label:'其他收入'}]} />
          </Form.Item>
          <Form.Item name="property_id" label="房号(可选)"><Select allowClear showSearch options={properties.map(p=>({value:p.id,label:p.code||p.address||p.id}))} /></Form.Item>
          <Form.Item name="note" label="备注"><Input /></Form.Item>
        </Form>
      </Modal>

      <Modal title="新建支出" open={expenseOpen} onCancel={() => setExpenseOpen(false)} onOk={submitExpense}>
        <Form form={expenseForm} layout="vertical">
          <Form.Item name="date" label="日期" rules={[{ required: true }]}><DP style={{ width:'100%' }} /></Form.Item>
          <Form.Item name="amount" label="金额" rules={[{ required: true }]}><InputNumber min={0} step={1} style={{ width:'100%' }} /></Form.Item>
          <Form.Item name="category" label="类别" rules={[{ required: true }]}>
            <Select options={[{value:'office',label:'办公'},{value:'tax',label:'税费'},{value:'service',label:'服务采购'},{value:'other',label:'其他支出'}]} />
          </Form.Item>
          <Form.Item name="property_id" label="房号(可选)"><Select allowClear showSearch options={properties.map(p=>({value:p.id,label:p.code||p.address||p.id}))} /></Form.Item>
          <Form.Item name="note" label="备注"><Input /></Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}

