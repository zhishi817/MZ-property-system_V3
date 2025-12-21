"use client"
import { Card, Descriptions, Space, Button, message, Table, InputNumber, Input, Modal } from 'antd'
import { useEffect, useState } from 'react'
import { API_BASE } from '../../../lib/api'
import dayjs from 'dayjs'
import { toDayStr } from '../../../lib/orders'
import { hasPerm } from '../../../lib/auth'

type Order = { id: string; source?: string; property_id?: string; checkin?: string; checkout?: string; status?: string }
type Deduction = { id: string; order_id: string; amount: number; currency?: string; item_desc?: string; note?: string; created_at?: string; is_active?: boolean }

export default function OrderDetail({ params }: { params: { id: string } }) {
  const [order, setOrder] = useState<Order | null>(null)
  const [staff, setStaff] = useState<{ id: string; name: string }[]>([])
  const [deductions, setDeductions] = useState<Deduction[]>([])
  const [dedAddOpen, setDedAddOpen] = useState(false)
  const [dedEdit, setDedEdit] = useState<Deduction | null>(null)
  const [dedAmount, setDedAmount] = useState<number>(0)
  const [dedDesc, setDedDesc] = useState<string>('')
  const [dedNote, setDedNote] = useState<string>('')

  async function load() {
    try {
      const o = await fetch(`${API_BASE}/orders/${params.id}`).then(r => r.json()).catch(() => null)
      setOrder(o || null)
    } catch { setOrder(null) }
    setStaff([])
    try {
      const ds = await fetch(`${API_BASE}/orders/${params.id}/internal-deductions`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } }).then(r => r.json()).catch(() => [])
      setDeductions(Array.isArray(ds) ? ds : [])
    } catch { setDeductions([]) }
  }
  useEffect(() => { load() }, [params.id])

  // 清洁任务模块已移除

  async function saveDeduction() {
    if (!order) return
    const payload = { amount: dedAmount, item_desc: dedDesc, note: dedNote }
    const res = await fetch(`${API_BASE}/orders/${order.id}/internal-deductions${dedEdit ? `/${dedEdit.id}` : ''}`, { method: dedEdit ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(payload) })
    if (res.ok) { message.success('已保存'); setDedAddOpen(false); setDedEdit(null); setDedAmount(0); setDedNote(''); load() } else { const m = await res.json().catch(()=>({})); message.error(m?.message || '保存失败') }
  }
  async function deleteDeduction(d: Deduction) {
    if (!order) return
    const res = await fetch(`${API_BASE}/orders/${order.id}/internal-deductions/${d.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
    if (res.ok) { message.success('已删除'); load() } else { const m = await res.json().catch(()=>({})); message.error(m?.message || '删除失败') }
  }

  return (
    <Card title="订单详情">
      {order && (
        <Descriptions bordered size="small" column={1}>
          <Descriptions.Item label="来源">{order.source}</Descriptions.Item>
          <Descriptions.Item label="入住">{order.checkin ? dayjs(toDayStr(order.checkin)).format('DD/MM/YYYY') : ''}</Descriptions.Item>
          <Descriptions.Item label="退房">{order.checkout ? dayjs(toDayStr(order.checkout)).format('DD/MM/YYYY') : ''}</Descriptions.Item>
          <Descriptions.Item label="状态">{order.status}</Descriptions.Item>
          <Descriptions.Item label="原始净额">{(order as any).net_income ?? 0}</Descriptions.Item>
          <Descriptions.Item label="内部扣减汇总">{(order as any).internal_deduction_total ?? 0}</Descriptions.Item>
          <Descriptions.Item label="可见净额">{(order as any).visible_net_income ?? ((order as any).net_income || 0)}</Descriptions.Item>
        </Descriptions>
      )}
      {/* 清洁任务模块已移除 */}

      {/* 清洁任务模块已移除 */}

      <Card title="内部扣减" style={{ marginTop: 16 }} extra={hasPerm('order.deduction.manage') && (<Button type="primary" onClick={() => { setDedEdit(null); setDedAmount(0); setDedDesc(''); setDedNote(''); setDedAddOpen(true) }}>新增</Button>)}>
        <Table size="small" pagination={false} dataSource={deductions} rowKey="id" columns={[
          { title: '金额', dataIndex: 'amount', align: 'right' },
          { title: '币种', dataIndex: 'currency' },
          { title: '事项描述', dataIndex: 'item_desc' },
          { title: '备注', dataIndex: 'note' },
          { title: '状态', dataIndex: 'is_active', render: (v: any) => v ? 'active' : 'void' },
          { title: '操作', render: (_: any, r: any) => hasPerm('order.deduction.manage') ? (
            <Space>
              <Button size="small" onClick={() => { setDedEdit(r); setDedAmount(Number(r.amount||0)); setDedDesc(r.item_desc || ''); setDedNote(r.note || ''); setDedAddOpen(true) }}>编辑</Button>
              <Button size="small" danger onClick={() => deleteDeduction(r)}>删除</Button>
            </Space>
          ) : null }
        ]} />
      </Card>

      <Modal title={dedEdit ? '编辑内部扣减' : '新增内部扣减'} open={dedAddOpen} onOk={saveDeduction} onCancel={() => { setDedAddOpen(false); setDedEdit(null) }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <InputNumber value={dedAmount} onChange={(v) => setDedAmount(Number(v||0))} min={0} style={{ width: '100%' }} />
          <Input value={dedDesc} onChange={(e) => setDedDesc(e.target.value)} placeholder="减扣事项描述" />
          <Input value={dedNote} onChange={(e) => setDedNote(e.target.value)} placeholder="备注" />
        </Space>
      </Modal>
    </Card>
  )
}