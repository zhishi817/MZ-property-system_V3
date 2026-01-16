"use client"
import { Card, Table, Select, Input, InputNumber, Button, Space, message, Drawer, Form } from 'antd'
import { useEffect, useState } from 'react'
import { getJSON, API_BASE, authHeaders } from '../../../lib/api'

type PriceItem = { id: string; category?: string; item_name: string; unit_price: number; currency?: string; is_active?: boolean }
type PriceItemExt = PriceItem & { unit?: string; default_quantity?: number }

export default function OnboardingPricesPage() {
  const [rows, setRows] = useState<PriceItemExt[]>([])
  const [cat, setCat] = useState<string>('卧室')
  const [name, setName] = useState<string>('')
  const [unit, setUnit] = useState<number>(0)
  const [unitText, setUnitText] = useState<string>('')
  const [defQty, setDefQty] = useState<number>(1)
  const [editOpen, setEditOpen] = useState(false)
  const [editItem, setEditItem] = useState<PriceItem | null>(null)
  const [form] = Form.useForm()
  async function refresh() {
    const qs = cat ? `?category=${encodeURIComponent(cat)}` : ''
    const list = await getJSON<PriceItemExt[]>(`/onboarding/daily-items-prices${qs}`).catch(()=>[])
    setRows(list || [])
  }
  useEffect(() => { refresh().catch(()=>{}) }, [cat])
  async function addOne() {
    if (!cat) { message.warning('请选择分类'); return }
    if (!name) { message.warning('请输入名称'); return }
    if (unit == null || Number(unit) < 0) { message.warning('请输入有效单价'); return }
    try {
      const res = await fetch(`${API_BASE}/onboarding/daily-items-prices`, { method:'POST', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify({ category: cat, item_name: name, unit_price: unit, unit: unitText || null, default_quantity: defQty }) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setName(''); setUnit(0)
      await refresh()
      message.success('已添加')
    } catch (e: any) { message.error(e?.message || '添加失败') }
  }
  async function importCSV(file: File) {
    try {
      const text = await file.text()
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      const items: any[] = []
      for (const ln of lines) {
        const parts = ln.split(',').map(s => s.trim())
        if (parts.length < 2) continue
        const category = parts[0]
        const item_name = parts[1]
        const unit_price = Number(parts[2] || 0)
        items.push({ category, item_name, unit_price })
      }
      if (!items.length) { message.warning('CSV 内容为空或格式错误'); return }
      const res = await fetch(`${API_BASE}/onboarding/daily-items-prices/bulk`, { method:'POST', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(items) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await refresh()
      message.success(`已导入 ${items.length} 条`)
    } catch (e: any) { message.error(e?.message || '导入失败') }
  }
  const columns = [
    { title:'分类', dataIndex:'category' },
    { title:'名称', dataIndex:'item_name' },
    { title:'单位', dataIndex:'unit' },
    { title:'标准数量', dataIndex:'default_quantity', align:'right' as const },
    { title:'单价', dataIndex:'unit_price', align:'right' as const, render:(v: number) => `$${Number(v||0).toFixed(2)}` },
    { title:'操作', render: (_: any, r: PriceItemExt) => (
      <Space>
        <Button onClick={() => { setEditItem(r); form.setFieldsValue({ category: r.category || '', item_name: r.item_name, unit_price: r.unit_price, unit: r.unit, default_quantity: r.default_quantity || 1 }); setEditOpen(true) }}>编辑</Button>
        <Button danger onClick={async () => { try { const res = await fetch(`${API_BASE}/onboarding/daily-items-prices/${r.id}`, { method:'DELETE', headers: { ...authHeaders() } }); if (!res.ok) throw new Error(`HTTP ${res.status}`); message.success('已删除'); await refresh() } catch (e: any) { message.error(e?.message || '删除失败') } }}>删除</Button>
      </Space>
    ) },
  ]
  return (
    <Card title="日用品价格表">
      <div style={{ display:'flex', gap:8, marginBottom:12 }}>
        <Select style={{ width: 160 }} value={cat} onChange={setCat as any} options={[{value:'卧室',label:'卧室'},{value:'厨房',label:'厨房'},{value:'卫生间',label:'卫生间'},{value:'其他',label:'其他'}]} />
        <Input style={{ width: 260 }} placeholder="物品名称" value={name} onChange={(e)=> setName(e.target.value)} />
        <span style={{ alignSelf:'center' }}>单位</span>
        <Input style={{ width: 120 }} placeholder="单位(如 件/包/套)" value={unitText} onChange={(e)=> setUnitText(e.target.value)} />
        <span style={{ alignSelf:'center' }}>标准数量</span>
        <InputNumber min={1} style={{ width: 120 }} placeholder="数量" value={defQty} onChange={(v)=> setDefQty(Number(v||1))} />
        <span style={{ alignSelf:'center' }}>单价</span>
        <InputNumber min={0} style={{ width: 160 }} placeholder="单价" value={unit} onChange={(v)=> setUnit(Number(v||0))} />
        <Space>
          <Button type="primary" onClick={addOne}>添加</Button>
        </Space>
      </div>
      <Table rowKey={(r)=>r.id} columns={columns as any} dataSource={rows} size="small" pagination={{ pageSize: 20 }} />
      <Drawer
        title="编辑日用品价格"
        placement="right"
        width={380}
        open={editOpen}
        onClose={() => setEditOpen(false)}
        extra={<Space><Button onClick={() => setEditOpen(false)}>取消</Button><Button type="primary" onClick={async () => {
          try {
            const v = await form.validateFields()
            if (!editItem) return
            const res = await fetch(`${API_BASE}/onboarding/daily-items-prices/${editItem.id}`, { method:'PATCH', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify({ category: v.category, item_name: v.item_name, unit_price: Number(v.unit_price || 0), unit: v.unit || null, default_quantity: v.default_quantity != null ? Number(v.default_quantity) : null }) })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            setEditOpen(false)
            message.success('已更新')
            await refresh()
          } catch (e: any) { message.error(e?.message || '更新失败') }
        }}>保存</Button></Space>}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="category" label="分类" rules={[{ required: true }]}>
            <Select options={[{value:'卧室',label:'卧室'},{value:'厨房',label:'厨房'},{value:'卫生间',label:'卫生间'},{value:'其他',label:'其他'}]} />
          </Form.Item>
          <Form.Item name="item_name" label="名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="unit" label="单位">
            <Input placeholder="如 件/包/套" />
          </Form.Item>
          <Form.Item name="default_quantity" label="标准数量">
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="unit_price" label="单价" rules={[{ required: true }] }>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Drawer>
    </Card>
  )
}
