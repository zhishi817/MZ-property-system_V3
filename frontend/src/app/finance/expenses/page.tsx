"use client"
import { Card, Form, Input, InputNumber, DatePicker, Select, Upload, Button, Table, Space, App, Modal, Alert, Radio } from 'antd'
import { UploadOutlined } from '@ant-design/icons'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { API_BASE, getJSON, authHeaders, apiList, apiCreate, apiUpdate, apiDelete } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'

type Tx = { id: string; kind: 'income'|'expense'; amount: number; currency: string; category?: string; category_detail?: string; property_id?: string; property_code?: string; invoice_url?: string; occurred_at: string; note?: string }

export default function ExpensesPage() {
  const [form] = Form.useForm()
  const { message, modal } = App.useApp()
  const [list, setList] = useState<Tx[]>([])
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string }[]>([])
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<Tx | null>(null)
  const [codeQuery, setCodeQuery] = useState('')
  const [catFilter, setCatFilter] = useState<string | undefined>(undefined)
  const [dateRange, setDateRange] = useState<[any, any] | null>(null)
  const [mode] = useState<'property'>('property')
  const role = (typeof window !== 'undefined') ? (localStorage.getItem('role') || sessionStorage.getItem('role')) : null
  const canViewList = hasPerm('finance.payout') || role === 'customer_service'
  async function load() {
    const resource = 'property_expenses'
    if (canViewList) {
      const rows: any[] = await apiList<any[]>(resource)
      const mapped: Tx[] = (rows || []).map((r: any) => ({ id: r.id, kind: 'expense', amount: Number(r.amount || 0), currency: r.currency || 'AUD', category: r.category, category_detail: r.category_detail, property_id: r.property_id || undefined, property_code: r.property_code || undefined, invoice_url: r.invoice_url, occurred_at: r.occurred_at, note: r.note }))
      setList(mapped)
    } else {
      setList([])
    }
  }
  useEffect(() => { load(); getJSON<any>('/properties?include_archived=true').then((j) => setProperties(Array.isArray(j) ? j : [])).catch(() => setProperties([])) }, [mode])
  async function submit() {
    if (saving) return
    setSaving(true)
    const v = await form.validateFields()
    const invoiceUrl = form.getFieldValue('invoice_url')
    const payload = {
      kind: 'expense',
      amount: Number(v.amount || 0),
      currency: v.currency || 'AUD',
      category: v.category,
      property_id: v.property_id,
      invoice_url: invoiceUrl,
      note: v.note,
      category_detail: v.category === 'other' ? (v.other_detail || '') : undefined,
      occurred_at: dayjs(v.occurred_at).format('YYYY-MM-DD')
    }
    const resource = 'property_expenses'
    try {
      if (editing) await apiUpdate(resource, editing.id, payload); else await apiCreate(resource, payload)
      message.success(editing ? '已更新支出' : '已记录支出'); form.resetFields(); setOpen(false); setEditing(null); load()
    } catch (e: any) {
      message.error(e?.message || '提交失败')
    } finally { setSaving(false) }
  }
  async function uploadFile(file: any) {
    const fd = new FormData(); fd.append('file', file)
    const res = await fetch(`${API_BASE}/finance/invoices`, { method: 'POST', headers: { ...authHeaders() }, body: fd })
    if (res.ok) { const j = await res.json(); form.setFieldsValue({ invoice_url: j.url }); message.success('上传成功') } else { message.error('上传失败') }
    return false
  }
  const CATS = [
    { value: 'electricity', label: '电费' },
    { value: 'water', label: '水费' },
    { value: 'gas_hot_water', label: '煤气/热水费' },
    { value: 'internet', label: '网费' },
    { value: 'consumables', label: '消耗品费' },
    { value: 'carpark', label: '车位费' },
    { value: 'owners_corp', label: '物业费' },
    { value: 'council_rate', label: '市政费' },
    { value: 'other', label: '其他' }
  ]
  const catLabel = (v?: string) => (CATS.find(c => c.value === v)?.label || v || '-')
  const columns = [
    { title: '日期', dataIndex: 'occurred_at', render: (v: string) => dayjs(v).format('DD/MM/YYYY') },
    { title: '房号', dataIndex: 'property_code', render: (v: string, r: any) => (v || (()=>{ const p = properties.find(x => x.id === r.property_id); return p?.code || r.property_id || '-' })()) },
    { title: '类别', dataIndex: 'category', render: (_: any, r: Tx) => {
      if (!r?.category) return '-'
      return r.category === 'other' ? `其他: ${r.category_detail || ''}` : catLabel(r.category)
    } },
    { title: '金额', dataIndex: 'amount' },
    { title: '币种', dataIndex: 'currency' },
    { title: '发票', dataIndex: 'invoice_url', render: (v: string) => {
      const url = v && /^https?:\/\//.test(v) ? v : (v ? `${API_BASE}${v}` : '')
      return url ? <a href={url} target="_blank" rel="noreferrer">查看</a> : '-'
    } },
    { title: '备注', dataIndex: 'note' },
    { title: '操作', render: (_: any, r: Tx) => hasPerm('finance.payout') ? (
      <Space>
        <Button onClick={() => { setEditing(r); setOpen(true); form.setFieldsValue({
          occurred_at: dayjs(r.occurred_at), property_id: r.property_id, category: r.category,
          other_detail: r.category === 'other' ? r.category_detail : undefined,
          amount: r.amount, currency: r.currency, note: r.note, invoice_url: r.invoice_url,
        }) }}>编辑</Button>
        <Button danger onClick={() => {
          modal.confirm({ title: '确认删除支出', okType: 'danger', onOk: async () => {
            const resource = 'property_expenses'
            try { await apiDelete(resource, r.id); message.success('已删除'); load() } catch (e: any) { message.error(e?.message || '删除失败') }
          } })
        }}>删除</Button>
      </Space>
    ) : null },
  ]
  return (
    <Card title="房源支出" extra={<Space>{hasPerm('finance.tx.write') ? <Button type="primary" onClick={() => { setEditing(null); form.resetFields(); setOpen(true) }}>记录支出</Button> : null}</Space>}>
      <Space style={{ marginBottom: 12 }} wrap>
        {canViewList ? (
          <>
            <Input placeholder="按房号搜索" allowClear value={codeQuery} onChange={(e) => setCodeQuery(e.target.value)} style={{ width: 200 }} />
            <Select allowClear placeholder="按类别筛选" value={catFilter} onChange={setCatFilter} style={{ width: 240 }} options={CATS.map(c => ({ value: c.value, label: c.label }))} />
            <DatePicker.RangePicker onChange={(v) => setDateRange(v as any)} format="DD/MM/YYYY" />
          </>
        ) : (
          <Alert type="info" message="您可以记录房源支出，列表明细对客服不可见" showIcon />
        )}
      </Space>
      {canViewList && (
        <Table rowKey={r => r.id} columns={columns as any} dataSource={list.filter(x => {
          const label = String((x as any).property_code || (()=>{ const p = properties.find(pp => pp.id === x.property_id); return p?.code || '' })() || '')
          const codeOk = (!codeQuery || label.toLowerCase().includes(codeQuery.trim().toLowerCase()))
          const catOk = !catFilter || x.category === catFilter
          const inRange = !dateRange || (!dateRange[0] || dayjs(x.occurred_at).diff(dateRange[0], 'day') >= 0) && (!dateRange[1] || dayjs(x.occurred_at).diff(dateRange[1], 'day') <= 0)
          const kindOk = x.kind === 'expense'
          const scopeOk = !!x.property_id
          return kindOk && scopeOk && codeOk && catOk && inRange
        })} pagination={{ pageSize: 10 }} scroll={{ x: 'max-content' }} />
      )}
      <Modal open={open} onCancel={() => setOpen(false)} onOk={submit} confirmLoading={saving} title="记录支出">
        <Form form={form} layout="vertical">
          <Form.Item name="occurred_at" label="日期" rules={[{ required: true }]}> 
            <DatePicker style={{ width: '100%' }} format="DD/MM/YYYY" />
          </Form.Item>
          <Form.Item name="property_id" label="房号" rules={[{ required: true }]}> 
            <Select showSearch options={properties.map(p => ({ value: p.id, label: p.code || p.id }))} />
          </Form.Item>
          <Form.Item name="category" label="类别" rules={[{ required: true }]}> 
            <Radio.Group optionType="button" buttonStyle="solid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(140px, 1fr))', gap: 12 }}>
              {CATS.map(c => (
                <Radio.Button
                  key={c.value}
                  value={c.value}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    textAlign: 'center',
                    padding: '10px 14px',
                    borderRadius: 9999,
                    minHeight: 40,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                >
                  {c.label}
                </Radio.Button>
              ))}
            </Radio.Group>
          </Form.Item>
          <Form.Item noStyle shouldUpdate>
            {() => {
              const v = form.getFieldValue('category')
              if (v === 'other') {
                return (
                  <Form.Item name="other_detail" label="其他明细" rules={[{ required: true }]}> 
                    <Input />
                  </Form.Item>
                )
              }
              return null
            }}
          </Form.Item>
          <Form.Item name="amount" label="金额" rules={[{ required: true }]}> 
            <InputNumber min={0} step={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="currency" initialValue="AUD" label="币种">
            <Select options={[{value:'AUD',label:'AUD'}]} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input />
          </Form.Item>
          <Form.Item label="发票">
            <Upload beforeUpload={uploadFile} maxCount={1} accept=".pdf,.jpg,.jpeg,.png">
              <Button icon={<UploadOutlined />}>上传发票</Button>
            </Upload>
            {form.getFieldValue('invoice_url') ? (
              <a href={form.getFieldValue('invoice_url')} target="_blank" rel="noreferrer" style={{ marginLeft: 8 }}>已上传，查看</a>
            ) : null}
          </Form.Item>
          <Form.Item name="invoice_url" hidden>
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
