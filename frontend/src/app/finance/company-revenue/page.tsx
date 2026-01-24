"use client"
import { Card, DatePicker, Table, Space, Button, Modal, Form, InputNumber, Select, DatePicker as DP, Input, message, Segmented } from 'antd'
import { LeftOutlined, RightOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { getJSON, API_BASE, authHeaders, apiList, apiCreate, apiUpdate, apiDelete } from '../../../lib/api'
import { sortProperties } from '../../../lib/properties'

type Order = { id: string; price?: number; cleaning_fee?: number; checkin?: string; checkout?: string; property_id?: string }
type Tx = { id: string; kind: 'income'|'expense'; amount: number; currency: string; category?: string; occurred_at: string }
type Landlord = { id: string; name: string; management_fee_rate?: number; property_ids?: string[] }

export default function CompanyRevenuePage() {
  const [month, setMonth] = useState<any>(dayjs())
  const [orders, setOrders] = useState<Order[]>([])
  const [companyIncomes, setCompanyIncomes] = useState<any[]>([])
  const [companyExpenses, setCompanyExpenses] = useState<any[]>([])
  const [landlords, setLandlords] = useState<Landlord[]>([])
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string }[]>([])
  const [incomeOpen, setIncomeOpen] = useState(false)
  const [expenseOpen, setExpenseOpen] = useState(false)
  const [incomeForm] = Form.useForm()
  const [expenseForm] = Form.useForm()
  const [view, setView] = useState<'stats'|'details'>('stats')
  const [savingIncome, setSavingIncome] = useState(false)
  const [savingExpense, setSavingExpense] = useState(false)
  const [editingIncome, setEditingIncome] = useState<Tx | null>(null)
  const [editingExpense, setEditingExpense] = useState<any | null>(null)
  async function loadAll() {
    getJSON<Order[]>('/orders').then(setOrders).catch(()=>setOrders([]))
    apiList<any[]>('company_incomes').then((rows)=> setCompanyIncomes(Array.isArray(rows)?rows:[]) ).catch(()=>setCompanyIncomes([]))
    getJSON<Landlord[]>('/landlords').then(setLandlords).catch(()=>setLandlords([]))
    getJSON<any>('/properties').then((j)=>setProperties(j||[])).catch(()=>setProperties([]))
    apiList<any[]>('company_expenses').then((rows)=>{
      const arr = Array.isArray(rows) ? rows : []
      arr.sort((a:any,b:any)=> String(b.occurred_at).localeCompare(String(a.occurred_at)))
      setCompanyExpenses(arr)
    }).catch(()=>setCompanyExpenses([]))
  }
  useEffect(() => { loadAll() }, [])
  useEffect(() => {
    const ym = month ? `${month.year()}-${String(month.month()+1).padStart(2,'0')}` : ''
    if (ym) {
      fetch(`${API_BASE}/finance/company-incomes/backfill`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ month: ym }) }).catch(()=>{})
    }
    apiList<any[]>('company_expenses').then((rows)=>setCompanyExpenses(Array.isArray(rows)?rows:[])).catch(()=>{})
    apiList<any[]>('company_incomes').then((rows)=>setCompanyIncomes(Array.isArray(rows)?rows:[])).catch(()=>{})
  }, [month])
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
  const lateIncome = useMemo(() => companyIncomes.filter(t => inMonth(t.occurred_at) && t.category==='late_checkout').reduce((s,x)=> s + Number(x.amount||0), 0), [companyIncomes, start, end])
  const cancelIncome = useMemo(() => companyIncomes.filter(t => inMonth(t.occurred_at) && t.category==='cancel_fee').reduce((s,x)=> s + Number(x.amount||0), 0), [companyIncomes, start, end])
  const otherIncome = useMemo(() => companyIncomes.filter(t => inMonth(t.occurred_at) && (t.category || 'other')==='other').reduce((s,x)=> s + Number(x.amount||0), 0), [companyIncomes, start, end])
  const totalIncome = mgmtFee + cleaningIncome + lateIncome + cancelIncome + otherIncome
  const totalExpense = useMemo(() => (companyExpenses||[]).filter(e => inMonth(e.occurred_at)).reduce((s,x)=> s + Number(x.amount||0), 0), [companyExpenses, start, end])
  const net = Math.round(((totalIncome - totalExpense) + Number.EPSILON) * 100) / 100
  const fmt = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const incomeDetails = useMemo(() => (companyIncomes||[]).filter(t => inMonth(t.occurred_at)), [companyIncomes, start, end])
  const expenseDetails = useMemo(() => (companyExpenses||[]).filter(e => inMonth(e.occurred_at)), [companyExpenses, start, end])
  const catAgg = (list: { category?: string; amount: number }[]) => {
    const m = new Map<string, number>()
    list.forEach(x => m.set(x.category || 'other', (m.get(x.category || 'other') || 0) + Number(x.amount || 0)))
    return Array.from(m.entries()).map(([category, total]) => ({ category, total }))
  }
  const incomeAgg = useMemo(() => catAgg(incomeDetails.map(d => ({ category: d.category, amount: d.amount }))), [incomeDetails])
  const expenseAgg = useMemo(() => catAgg(expenseDetails.map(d => ({ category: d.category, amount: d.amount }))), [expenseDetails])
  const COL = { date: 120, category: 160, amount: 120, currency: 80, property: 160, other: 200, note: 240, ops: 140 }

  async function submitIncome() {
    if (savingIncome) return
    setSavingIncome(true)
    const v = await incomeForm.validateFields()
    const payload = { occurred_at: dayjs(v.date).format('YYYY-MM-DD'), amount: Number(v.amount || 0), currency: 'AUD', category: v.category, note: v.note, property_id: v.property_id }
    try {
      if (editingIncome) await apiUpdate('company_incomes', editingIncome.id, payload); else await apiCreate('company_incomes', payload)
      message.success(editingIncome ? '收入已更新' : '收入已记录')
      setIncomeOpen(false); incomeForm.resetFields(); setEditingIncome(null)
      apiList<any[]>('company_incomes').then((rows)=>setCompanyIncomes(Array.isArray(rows)?rows:[])).catch(()=>{})
    } catch (e:any) { message.error(e?.message || '记录失败') }
    setSavingIncome(false)
    setEditingIncome(null)
  }
  async function submitExpense() {
    if (savingExpense) return
    setSavingExpense(true)
    const v = await expenseForm.validateFields()
    const payload = { amount: Number(v.amount || 0), currency: 'AUD', occurred_at: dayjs(v.date).format('YYYY-MM-DD'), category: v.category, category_detail: v.category === 'other' ? (v.other_detail || '') : undefined, note: v.category === 'other' ? (v.note || '') : v.note }
    try {
      if (editingExpense) await apiUpdate('company_expenses', editingExpense.id, payload); else await apiCreate('company_expenses', payload)
      message.success(editingExpense ? '支出已更新' : '支出已记录')
      setExpenseOpen(false); expenseForm.resetFields(); setEditingExpense(null)
      apiList<any[]>('company_expenses').then((rows)=>setCompanyExpenses(Array.isArray(rows)?rows:[])).catch(()=>{})
    } catch (e: any) { message.error(e?.message || '记录失败') } finally { setSavingExpense(false) }
  }

  const rows = [
    { item: '管理费', value: mgmtFee },
    { item: '清洁费', value: cleaningIncome },
    { item: '晚退房费', value: lateIncome },
    { item: '订单取消费用', value: cancelIncome },
    { item: '其他收入', value: otherIncome },
  ]

  return (
    <Card title="公司营收" extra={<Space><Segmented options={[{label:'统计',value:'stats'},{label:'明细',value:'details'}]} value={view} onChange={setView as any} /><Button type="primary" onClick={() => { setEditingIncome(null); setIncomeOpen(true) }}>记录收入</Button><Button type="primary" danger onClick={() => { setEditingExpense(null); setExpenseOpen(true) }}>记录支出</Button></Space>}>
      <div style={{ marginBottom: 12 }}>
        <Space>
          <Button icon={<LeftOutlined />} onClick={() => setMonth((m:any)=> dayjs(m).subtract(1,'month'))} />
          <DatePicker picker="month" value={month} onChange={setMonth as any} />
          <Button icon={<RightOutlined />} onClick={() => setMonth((m:any)=> dayjs(m).add(1,'month'))} />
        </Space>
      </div>
      {view==='stats' ? (
        <>
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
          <div style={{ marginTop: 16 }}>
            <Table size="small" rowKey={(r)=>r.category} pagination={false} title={()=>'收入类别统计'} dataSource={incomeAgg} columns={[{title:'类别',dataIndex:'category'},{title:'金额',dataIndex:'total',render:(v:number)=>`$${fmt(v)}`}]} />
          </div>
          <div style={{ marginTop: 12 }}>
            <Table size="small" rowKey={(r)=>r.category} pagination={false} title={()=>'支出类别统计'} dataSource={expenseAgg} columns={[{title:'类别',dataIndex:'category'},{title:'金额',dataIndex:'total',render:(v:number)=>`$${fmt(v)}`}]} />
          </div>
        </>
      ) : (
        <>
          <Table rowKey={(r)=>r.id} title={()=>'收入明细'} pagination={{ pageSize: 10 }} dataSource={incomeDetails} columns={[{ title:'日期', dataIndex:'occurred_at', width: COL.date, render:(v:string)=> dayjs(v).format('DD/MM/YYYY') }, { title:'类别', dataIndex:'category', width: COL.category }, { title:'金额', dataIndex:'amount', width: COL.amount, align:'right', render:(v:number)=>`$${fmt(v)}` }, { title:'币种', dataIndex:'currency', width: COL.currency, align:'center' }, { title:'房号', dataIndex:'property_code', width: COL.property }, { title:'备注', dataIndex:'note', width: COL.note }, { title:'操作', key:'ops', width: COL.ops, align:'center', render: (_:any, r:any) => (<Space><Button onClick={() => { setEditingIncome(r); setIncomeOpen(true); incomeForm.setFieldsValue({ date: dayjs(r.occurred_at), amount: Number(r.amount||0), category: r.category, note: r.note, property_id: r.property_id }) }}>编辑</Button><Button danger onClick={() => { Modal.confirm({ title:'确认删除？', okType:'danger', onOk: async ()=> { try { await apiDelete('company_incomes', r.id); apiList<any[]>('company_incomes').then((rows)=>setCompanyIncomes(Array.isArray(rows)?rows:[])); message.success('已删除') } catch { message.error('删除失败') } } }) }}>删除</Button></Space>) }]} />
          <div style={{ height: 12 }} />
          <Table rowKey={(r)=>r.id} title={()=>'支出明细'} pagination={{ pageSize: 10 }} dataSource={expenseDetails} columns={[{ title:'日期', dataIndex:'occurred_at', width: COL.date, render:(v:string)=> dayjs(v).format('DD/MM/YYYY') }, { title:'类别', dataIndex:'category', width: COL.category }, { title:'金额', dataIndex:'amount', width: COL.amount, align:'right', render:(v:number)=>`$${fmt(v)}` }, { title:'币种', dataIndex:'currency', width: COL.currency, align:'center' }, { title:'其他支出描述', dataIndex:'category_detail', width: COL.other, render: (v:any, r:any) => (r.category === 'other' ? (v || '-') : '-') }, { title:'备注', dataIndex:'note', width: COL.note }, { title:'操作', key:'ops', width: COL.ops, align:'center', render: (_:any, r:any) => (<Space><Button onClick={() => { setEditingExpense(r); setExpenseOpen(true); expenseForm.setFieldsValue({ date: dayjs(r.occurred_at), amount: Number(r.amount||0), category: r.category, other_detail: r.category === 'other' ? r.category_detail : undefined, note: r.note }) }}>编辑</Button><Button danger onClick={() => { Modal.confirm({ title:'确认删除？', okType:'danger', onOk: async ()=> { try { await apiDelete('company_expenses', r.id); apiList<any[]>('company_expenses').then((rows)=>setCompanyExpenses(Array.isArray(rows)?rows:[])); message.success('已删除') } catch { message.error('删除失败') } } }) }}>删除</Button></Space>) }]} />
        </>
      )}

      <Modal title={editingIncome ? '编辑收入' : '记录收入'} open={incomeOpen} onCancel={() => { setIncomeOpen(false); setEditingIncome(null) }} onOk={submitIncome} confirmLoading={savingIncome}>
        <Form form={incomeForm} layout="vertical">
          <Form.Item name="date" label="日期" rules={[{ required: true }]}><DP style={{ width:'100%' }} /></Form.Item>
          <Form.Item name="amount" label="金额" rules={[{ required: true }]}><InputNumber min={0} step={1} style={{ width:'100%' }} /></Form.Item>
          <Form.Item name="category" label="类别" rules={[{ required: true }]}>
            <Select options={[{value:'mgmt_fee',label:'管理费'},{value:'cleaning_fee',label:'清洁费'},{value:'late_checkout',label:'晚退房费'},{value:'cancel_fee',label:'取消费'},{value:'other',label:'其他收入'}]} />
          </Form.Item>
          <Form.Item name="property_id" label="房号(可选)"><Select allowClear showSearch optionFilterProp="label" filterOption={(input, option)=> String((option as any)?.label||'').toLowerCase().includes(String(input||'').toLowerCase())} options={sortProperties(properties).map(p=>({value:p.id,label:p.code||p.address||p.id}))} /></Form.Item>
          <Form.Item name="note" label="备注"><Input /></Form.Item>
        </Form>
      </Modal>

      <Modal title={editingExpense ? '编辑支出' : '记录支出'} open={expenseOpen} onCancel={() => { setExpenseOpen(false); setEditingExpense(null) }} onOk={submitExpense} confirmLoading={savingExpense}>
          <Form form={expenseForm} layout="vertical">
            <Form.Item name="date" label="日期" rules={[{ required: true }]}><DP style={{ width:'100%' }} /></Form.Item>
            <Form.Item name="amount" label="金额" rules={[{ required: true }]}><InputNumber min={0} step={1} style={{ width:'100%' }} /></Form.Item>
            <Form.Item name="category" label="类别" rules={[{ required: true }]}> 
              <Select options={[{value:'office',label:'办公'},{value:'tax',label:'税费'},{value:'service',label:'服务采购'},{value:'other',label:'其他支出'}]} />
            </Form.Item>
            <Form.Item noStyle shouldUpdate>
              {() => {
                const v = expenseForm.getFieldValue('category')
                if (v === 'other') {
                  return (
                    <Form.Item name="other_detail" label="其他支出描述" rules={[{ required: true }]}> 
                      <Input />
                    </Form.Item>
                  )
                }
                return null
              }}
            </Form.Item>
            <Form.Item name="property_id" label="房号(可选)"><Select allowClear showSearch optionFilterProp="label" filterOption={(input, option)=> String((option as any)?.label||'').toLowerCase().includes(String(input||'').toLowerCase())} options={sortProperties(properties).map(p=>({value:p.id,label:p.code||p.address||p.id}))} /></Form.Item>
            <Form.Item name="note" label="备注"><Input /></Form.Item>
          </Form>
      </Modal>
    </Card>
  )
}
