"use client"
import { Button, Card, Col, Form, InputNumber, Modal, Row, Space, Statistic, Table, Tag, message } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { getJSON, putJSON } from '../../../lib/api'

type RoomType = { code: string; name: string; sort_order: number }
type ReservePolicy = { item_id: string; item_name: string; item_sku: string; linen_type_code?: string | null; reserve_qty: number }
type DashboardWarehouseRow = {
  warehouse_id: string
  warehouse_code: string
  warehouse_name: string
  linen_capacity_sets?: number | null
  is_sm: boolean
  counts_by_sub_type: Record<string, number>
  available_sets_by_room_type: Record<string, number>
}
type DashboardResp = {
  sm_warehouse_id?: string | null
  room_types: RoomType[]
  reserve_policies: ReservePolicy[]
  dispatchable_by_type: Record<string, number>
  pending_returns_by_type: Record<string, number>
  pending_refund_amount: number
  warehouses: DashboardWarehouseRow[]
}

export default function LinenStocksDashboard() {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<DashboardResp | null>(null)
  const [reserveOpen, setReserveOpen] = useState(false)
  const [reserveRow, setReserveRow] = useState<ReservePolicy | null>(null)
  const [reserveForm] = Form.useForm()

  async function load() {
    setLoading(true)
    try {
      const resp = await getJSON<DashboardResp>('/inventory/linen/dashboard')
      setData(resp || null)
    } catch (e: any) {
      message.error(e?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const smWarehouse = useMemo(() => (data?.warehouses || []).find((x) => x.is_sm) || null, [data])
  const roomTypes = useMemo(() => (data?.room_types || []).slice().sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)), [data])
  const subWarehouseRows = useMemo(() => (data?.warehouses || []).filter((x) => !x.is_sm), [data])

  const smReserveTotal = useMemo(() => (data?.reserve_policies || []).reduce((sum, row) => sum + Number(row.reserve_qty || 0), 0), [data])
  const pendingReturnsTotal = useMemo(() => Object.values(data?.pending_returns_by_type || {}).reduce((sum, qty) => sum + Number(qty || 0), 0), [data])
  const dispatchableTotal = useMemo(() => Object.values(data?.dispatchable_by_type || {}).reduce((sum, qty) => sum + Number(qty || 0), 0), [data])

  async function submitReserve() {
    const v = await reserveForm.validateFields()
    await putJSON('/inventory/linen/reserve-policies', {
      warehouse_id: data?.sm_warehouse_id,
      item_id: reserveRow?.item_id,
      reserve_qty: Number(v.reserve_qty || 0),
    })
    message.success('安全库存已更新')
    setReserveOpen(false)
    setReserveRow(null)
    await load()
  }

  const smCountsRows = useMemo(() => {
    const counts = smWarehouse?.counts_by_sub_type || {}
    return (data?.reserve_policies || []).map((row) => ({
      ...row,
      qty: Number(counts[String(row.linen_type_code || '')] || 0),
      dispatchable_qty: Number((data?.dispatchable_by_type || {})[String(row.linen_type_code || '')] || 0),
      pending_return_qty: Number((data?.pending_returns_by_type || {})[String(row.linen_type_code || '')] || 0),
    }))
  }, [data, smWarehouse])

  const smColumns: any[] = [
    { title: '床品', dataIndex: 'item_name', render: (_: any, r: any) => <Space><span>{r.item_name}</span><Tag>{r.item_sku}</Tag></Space> },
    { title: '总仓库存', dataIndex: 'qty' },
    { title: '安全库存', dataIndex: 'reserve_qty' },
    { title: '可配送', dataIndex: 'dispatchable_qty', render: (v: number, r: any) => v <= 0 && Number(r.reserve_qty || 0) > 0 ? <Tag color="red">{v}</Tag> : v },
    { title: '待返厂', dataIndex: 'pending_return_qty' },
    {
      title: '操作',
      dataIndex: '_op',
      render: (_: any, r: any) => (
        <Button onClick={() => {
          setReserveRow(r)
          setReserveOpen(true)
          reserveForm.setFieldsValue({ reserve_qty: r.reserve_qty })
        }}
        >
          设置安全库存
        </Button>
      ),
    },
  ]

  const subColumns: any[] = useMemo(() => {
    const base: any[] = [
      { title: '分仓', dataIndex: 'warehouse_name', render: (_: any, r: DashboardWarehouseRow) => `${r.warehouse_code} - ${r.warehouse_name}` },
      { title: '容量上限(套)', dataIndex: 'linen_capacity_sets', render: (v: number | null | undefined) => v ?? '-' },
    ]
    for (const roomType of roomTypes) {
      base.push({
        title: `${roomType.name}可用套数`,
        dataIndex: roomType.code,
        render: (_: any, r: DashboardWarehouseRow) => Number((r.available_sets_by_room_type || {})[roomType.code] || 0),
      })
    }
    return base
  }, [roomTypes])

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Row gutter={[12, 12]}>
        <Col xs={12} md={8} lg={6}><Card loading={loading}><Statistic title="总仓可配送件数" value={dispatchableTotal} /></Card></Col>
        <Col xs={12} md={8} lg={6}><Card loading={loading}><Statistic title="总仓安全库存件数" value={smReserveTotal} /></Card></Col>
        <Col xs={12} md={8} lg={6}><Card loading={loading}><Statistic title="待返厂件数" value={pendingReturnsTotal} /></Card></Col>
        <Col xs={12} md={8} lg={6}><Card loading={loading}><Statistic title="待退款金额" value={Number(data?.pending_refund_amount || 0)} precision={2} /></Card></Col>
      </Row>

      <Card title="SM 总仓床品看板" extra={<Button onClick={load} loading={loading}>刷新</Button>}>
        <Table rowKey={(r) => r.item_id} columns={smColumns} dataSource={smCountsRows} pagination={false} />
      </Card>

      <Card title="分仓套数看板">
        <Table rowKey={(r) => r.warehouse_id} columns={subColumns} dataSource={subWarehouseRows} pagination={false} />
      </Card>

      <Modal open={reserveOpen} title={`设置安全库存${reserveRow ? ` - ${reserveRow.item_name}` : ''}`} onCancel={() => setReserveOpen(false)} onOk={submitReserve}>
        <Form form={reserveForm} layout="vertical">
          <Form.Item name="reserve_qty" label="最小保留件数" rules={[{ required: true }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}
