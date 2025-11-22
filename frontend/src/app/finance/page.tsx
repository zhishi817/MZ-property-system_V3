"use client"
import { Table, Card, Space, Button, Modal, Form, InputNumber, Select, DatePicker, Input, message } from 'antd'
import { useEffect, useState } from 'react'
import { API_BASE } from '../../lib/api'
import { hasPerm } from '../../lib/auth'

type Tx = { id: string; kind: 'income'|'expense'; amount: number; currency: string; occurred_at: string; note?: string }
type Payout = { id: string; landlord_id: string; period_from: string; period_to: string; amount: number; invoice_no?: string; status: string }
type Landlord = { id: string; name: string }

export default function FinancePage() {
  const [txs, setTxs] = useState<Tx[]>([])
  const [payouts, setPayouts] = useState<Payout[]>([])
  const [landlords, setLandlords] = useState<Landlord[]>([])
  const [txOpen, setTxOpen] = useState(false)
  const [payoutOpen, setPayoutOpen] = useState(false)
  const [txForm] = Form.useForm()
  const [pForm] = Form.useForm()

  async function load() {
    const t = await fetch(`${API_BASE}/finance`).then(r => r.json())
    const p = await fetch(`${API_BASE}/finance/payouts`).then(r => r.json())
    const l = await fetch(`${API_BASE}/landlords`).then(r => r.json())
    setTxs(t); setPayouts(p); setLandlords(l)
  }
  useEffect(() => { load() }, [])

  async function submitTx() {
    const v = await txForm.validateFields()
    const payload = { kind: v.kind, amount: v.amount, currency: v.currency, occurred_at: v.occurred_at.format('YYYY-MM-DD'), note: v.note }
    const res = await fetch(`${API_BASE}/finance`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(payload) })
    if (res.ok) { message.success('已记账'); setTxOpen(false); txForm.resetFields(); load() } else { message.error('记账失败') }
  }

  async function submitPayout() {
    const v = await pForm.validateFields()
    const payload = { landlord_id: v.landlord_id, period_from: v.period[0].format('YYYY-MM-DD'), period_to: v.period[1].format('YYYY-MM-DD'), amount: v.amount, invoice_no: v.invoice_no }
    const res = await fetch(`${API_BASE}/finance/payouts`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(payload) })
    if (res.ok) { message.success('结算已生成'); setPayoutOpen(false); pForm.resetFields(); load() } else { message.error('生成失败') }
  }

  const txCols = [
    { title: '类型', dataIndex: 'kind' },
    { title: '金额', dataIndex: 'amount' },
    { title: '币种', dataIndex: 'currency' },
    { title: '发生时间', dataIndex: 'occurred_at' },
    { title: '备注', dataIndex: 'note' },
  ]
  const payoutCols = [
    { title: '房东', dataIndex: 'landlord_id', render: (id: string) => landlords.find(l => l.id === id)?.name || id },
    { title: '起止', render: (_: any, r: Payout) => `${r.period_from} ~ ${r.period_to}` },
    { title: '金额', dataIndex: 'amount' },
    { title: '发票', dataIndex: 'invoice_no' },
    { title: '状态', dataIndex: 'status' },
  ]

  return (
    <Card title="财务管理" extra={hasPerm('finance.payout') ? <Space><Button onClick={() => setTxOpen(true)}>记账</Button><Button type="primary" onClick={() => setPayoutOpen(true)}>生成结算</Button></Space> : null}>
      <Table rowKey={(r) => r.id} columns={txCols as any} dataSource={txs} pagination={{ pageSize: 10 }} title={() => '收支流水'} />
      <Table rowKey={(r) => r.id} columns={payoutCols as any} dataSource={payouts} pagination={{ pageSize: 10 }} title={() => '房东结算'} style={{ marginTop: 16 }} />
      <Modal open={txOpen} onCancel={() => setTxOpen(false)} onOk={submitTx} title="记账">
        <Form form={txForm} layout="vertical">
          <Form.Item name="kind" label="类型" rules={[{ required: true }]}><Select options={[{ value: 'income', label: '收入' }, { value: 'expense', label: '支出' }]} /></Form.Item>
          <Form.Item name="amount" label="金额" rules={[{ required: true }]}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="currency" label="币种" initialValue="AUD" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="occurred_at" label="发生时间" rules={[{ required: true }]}><DatePicker style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="note" label="备注"><Input /></Form.Item>
        </Form>
      </Modal>
      <Modal open={payoutOpen} onCancel={() => setPayoutOpen(false)} onOk={submitPayout} title="生成结算">
        <Form form={pForm} layout="vertical">
          <Form.Item name="landlord_id" label="房东" rules={[{ required: true }]}><Select options={landlords.map(l => ({ value: l.id, label: l.name }))} /></Form.Item>
          <Form.Item name="period" label="账期" rules={[{ required: true }]}><DatePicker.RangePicker style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="amount" label="金额" rules={[{ required: true }]}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="invoice_no" label="发票号"><Input /></Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}