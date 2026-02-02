"use client"
import { Alert, Button, Card, DatePicker, Drawer, Form, Input, InputNumber, Popconfirm, Select, Space, Switch, Table, message } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { deleteJSON, getJSON, patchJSON, postJSON } from '../../../lib/api'
import { isFurnitureOwnerPayment, isFurnitureRecoverableCharge } from '../../../lib/statementBalances'
import { sortPropertiesByRegionThenCode } from '../../../lib/properties'

type Property = { id: string; code?: string; address?: string; region?: string }
type Tx = {
  id: string
  kind: 'income' | 'expense'
  amount: number
  currency: string
  property_id?: string
  occurred_at: string
  category?: string
  category_detail?: string
  note?: string
  ref_type?: string
  ref_id?: string
}

type FormValues = {
  kind: 'income' | 'expense'
  property_id?: string
  occurred_at?: any
  amount?: number
  currency?: string
  category?: string
  category_detail?: string
  note?: string
}

function fmt(n: number) {
  return (Number(n || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function isFurnitureTx(tx: Tx): boolean {
  return isFurnitureOwnerPayment(tx as any) || isFurnitureRecoverableCharge(tx as any)
}

export default function FinanceTransactionsPage() {
  const [txs, setTxs] = useState<Tx[]>([])
  const [properties, setProperties] = useState<Property[]>([])
  const [loading, setLoading] = useState(false)
  const [month, setMonth] = useState<any>(dayjs())
  const [pid, setPid] = useState<string | undefined>(undefined)
  const [onlyFurniture, setOnlyFurniture] = useState<boolean>(true)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Tx | null>(null)
  const [form] = Form.useForm<FormValues>()

  async function reload() {
    setLoading(true)
    try {
      const [fin, props] = await Promise.all([
        getJSON<Tx[]>('/finance').catch(() => [] as Tx[]),
        getJSON<Property[]>('/properties').catch(() => [] as Property[]),
      ])
      setTxs(Array.isArray(fin) ? fin : [])
      setProperties(Array.isArray(props) ? props : [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { reload().catch(() => {}) }, [])

  const propsById = useMemo(() => new Map((properties || []).map(p => [String(p.id), p])), [properties])

  const baseRows = useMemo(() => {
    const ms = dayjs(month).startOf('month')
    const list = (txs || [])
      .filter(t => {
        const d = String(t.occurred_at || '').slice(0, 10)
        if (d && !dayjs(d).isSame(ms, 'month')) return false
        if (pid && String(t.property_id || '') !== String(pid)) return false
        return true
      })
      .slice()
      .sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')) || String(b.id || '').localeCompare(String(a.id || '')))
    return list
  }, [txs, month, pid])

  const rows = useMemo(() => {
    return onlyFurniture ? baseRows.filter(isFurnitureTx) : baseRows
  }, [baseRows, onlyFurniture])

  function openNew(mode: 'furniture_charge' | 'furniture_paid' | 'other') {
    setEditing(null)
    const base: FormValues = {
      kind: mode === 'furniture_paid' ? 'income' : 'expense',
      currency: 'AUD',
      category: mode === 'furniture_charge' ? 'furniture_recoverable' : mode === 'furniture_paid' ? 'furniture_owner_payment' : undefined,
      occurred_at: dayjs(),
    }
    form.setFieldsValue(base)
    setOpen(true)
  }

  function openEdit(tx: Tx) {
    setEditing(tx)
    form.setFieldsValue({
      kind: tx.kind,
      property_id: tx.property_id,
      occurred_at: tx.occurred_at ? dayjs(String(tx.occurred_at).slice(0, 10)) : dayjs(),
      amount: Number(tx.amount || 0),
      currency: tx.currency || 'AUD',
      category: tx.category,
      category_detail: tx.category_detail,
      note: tx.note,
    })
    setOpen(true)
  }

  async function submit() {
    const v = await form.validateFields()
    const payload: any = {
      kind: v.kind,
      amount: Number(v.amount || 0),
      currency: String(v.currency || 'AUD'),
      property_id: v.property_id || undefined,
      occurred_at: v.occurred_at ? dayjs(v.occurred_at).format('YYYY-MM-DD') : undefined,
      category: v.category || undefined,
      category_detail: v.category_detail || undefined,
      note: v.note || undefined,
    }
    try {
      if (editing?.id) {
        await patchJSON(`/finance/${encodeURIComponent(editing.id)}`, payload)
        message.success('已更新')
      } else {
        await postJSON('/finance', payload)
        message.success('已创建')
      }
      setOpen(false)
      setEditing(null)
      form.resetFields()
      await reload()
    } catch (e: any) {
      message.error(e?.message || '保存失败')
    }
  }

  async function remove(tx: Tx) {
    try {
      await deleteJSON(`/finance/${encodeURIComponent(tx.id)}`)
      message.success('已删除')
      await reload()
    } catch (e: any) {
      message.error(e?.message || '删除失败')
    }
  }

  const columns: any[] = [
    { title: '日期', dataIndex: 'occurred_at', width: 120, render: (v: any) => String(v || '').slice(0, 10) },
    {
      title: '房源',
      dataIndex: 'property_id',
      width: 170,
      render: (v: any, r: Tx) => {
        const p = propsById.get(String(r.property_id || v || ''))
        return p ? (p.code || p.address || p.id) : (String(r.property_id || '') || '-')
      },
    },
    { title: '类型', dataIndex: 'kind', width: 90, render: (v: any) => v === 'income' ? '收入' : '支出' },
    { title: '类别', dataIndex: 'category', width: 190, render: (v: any) => String(v || '-') },
    { title: '备注', dataIndex: 'note', ellipsis: true },
    { title: '金额', dataIndex: 'amount', width: 130, align: 'right', render: (_: any, r: Tx) => (r.kind === 'expense' ? `-$${fmt(r.amount)}` : `$${fmt(r.amount)}`) },
    {
      title: '操作',
      width: 140,
      render: (_: any, r: Tx) => (
        <Space>
          <Button size="small" onClick={() => openEdit(r)}>编辑</Button>
          <Popconfirm title="确认删除该条交易？" okText="删除" cancelText="取消" onConfirm={() => remove(r)}>
            <Button size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const catOptions = [
    { value: 'furniture_recoverable', label: '家具费应收 (furniture_recoverable)' },
    { value: 'furniture_owner_payment', label: '房东已付家具费 (furniture_owner_payment)' },
  ]

  return (
    <Card
      title="交易流水（用于月报）"
      extra={
        <Space>
          <Button onClick={() => reload()}>刷新</Button>
          <Button type="primary" onClick={() => openNew('furniture_charge')}>新增家具应收</Button>
          <Button onClick={() => openNew('furniture_paid')}>新增房东家具付款</Button>
        </Space>
      }
    >
      <div style={{ display:'flex', gap: 12, alignItems:'center', marginBottom: 12, flexWrap:'wrap' }}>
        <DatePicker picker="month" value={month} onChange={setMonth as any} />
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: 260 }}
          placeholder="筛选房源"
          value={pid}
          onChange={setPid}
          options={sortPropertiesByRegionThenCode(properties as any).map(p => ({ value: p.id, label: p.code || p.address || p.id }))}
        />
        <span>只看家具相关</span>
        <Switch checked={onlyFurniture} onChange={setOnlyFurniture} />
      </div>
      {(onlyFurniture && baseRows.length > 0 && rows.length === 0) ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="本月有交易记录，但未被识别为“家具相关”"
          description="可能原因：类别不是 furniture_recoverable / furniture_owner_payment，或备注里未包含可识别的家具关键词。可先切换为显示全部，再编辑修正类别。"
          action={<Button size="small" onClick={() => setOnlyFurniture(false)}>显示全部</Button>}
        />
      ) : null}
      <Table
        loading={loading}
        size="small"
        pagination={{ pageSize: 50 }}
        rowKey={r => String((r as any).id)}
        dataSource={rows}
        columns={columns}
      />

      <Drawer
        open={open}
        width={520}
        title={editing ? '编辑交易' : '新增交易'}
        onClose={() => { setOpen(false); setEditing(null); form.resetFields() }}
        extra={<Space><Button onClick={() => { setOpen(false); setEditing(null); form.resetFields() }}>取消</Button><Button type="primary" onClick={submit}>保存</Button></Space>}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="kind" label="类型" rules={[{ required: true }]}>
            <Select options={[{ value:'expense', label:'支出' }, { value:'income', label:'收入' }]} />
          </Form.Item>
          <Form.Item name="property_id" label="房源" rules={[{ required: true, message: '请选择房源' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={sortPropertiesByRegionThenCode(properties as any).map(p => ({ value: p.id, label: p.code || p.address || p.id }))}
            />
          </Form.Item>
          <Form.Item name="occurred_at" label="日期" rules={[{ required: true, message: '请选择日期' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="amount" label="金额" rules={[{ required: true, message: '请输入金额' }]}>
            <InputNumber style={{ width:'100%' }} min={0} step={1} />
          </Form.Item>
          <Form.Item name="currency" label="币种" initialValue="AUD">
            <Select options={[{ value:'AUD', label:'AUD' }]} />
          </Form.Item>
          <Form.Item name="category" label="类别">
            <Select allowClear options={catOptions} placeholder="选择类别（家具相关建议用下拉）" />
          </Form.Item>
          <Form.Item name="category_detail" label="类别明细">
            <Input placeholder="可选" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={3} placeholder="例如：房东转入家具费、用于抵扣租金等" />
          </Form.Item>
        </Form>
      </Drawer>
    </Card>
  )
}
