"use client"
import { App, Button, Card, DatePicker, Form, Input, InputNumber, Modal, Select, Space, Table, Tabs, Tag } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { getJSON, postJSON } from '../../../lib/api'

type Warehouse = { id: string; code: string; name: string; active: boolean }
type RoomType = { code: string; name: string; sort_order: number; active: boolean }
type TransferRow = {
  transfer_id: string
  from_warehouse_code?: string | null
  from_warehouse_name?: string | null
  to_warehouse_code?: string | null
  to_warehouse_name?: string | null
  item_name?: string | null
  item_sku?: string | null
  quantity: number
  note?: string | null
  created_at: string
}
type SuggestionLine = {
  to_warehouse_id: string
  to_warehouse_code: string
  to_warehouse_name: string
  room_type_code: string
  room_type_name: string
  current_sets: number
  demand_sets: number
  target_sets: number
  suggested_sets: number
  warehouse_capacity_sets?: number | null
  vehicle_load_sets: number
}
type SuggestionResp = {
  from_warehouse_id?: string | null
  from_warehouse_name?: string | null
  date_from: string
  date_to: string
  vehicle_capacity_sets: number
  vehicle_remaining_sets: number
  unmatched_properties: Array<{ property_code?: string | null }>
  lines: SuggestionLine[]
}
type DeliveryPlanRow = {
  id: string
  plan_date: string
  from_warehouse_code: string
  from_warehouse_name: string
  status: string
  line_count: number
  actual_sets_total: number
  suggested_sets_total: number
}

export default function LinenTransfersView() {
  const { message } = App.useApp()
  const [tab, setTab] = useState('history')
  const [historyRows, setHistoryRows] = useState<TransferRow[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [roomTypes, setRoomTypes] = useState<RoomType[]>([])
  const [plans, setPlans] = useState<DeliveryPlanRow[]>([])
  const [suggestion, setSuggestion] = useState<SuggestionResp | null>(null)
  const [dateRange, setDateRange] = useState<[any, any] | null>([dayjs(), dayjs().add(7, 'day')])
  const [vehicleCapacity, setVehicleCapacity] = useState<number>(80)
  const [planOpen, setPlanOpen] = useState(false)
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [selectedPlanLine, setSelectedPlanLine] = useState<SuggestionLine | null>(null)
  const [selectedPlanId, setSelectedPlanId] = useState<string>('')
  const [planForm] = Form.useForm()
  const [dispatchForm] = Form.useForm()

  async function loadBase() {
    const [ws, rt] = await Promise.all([
      getJSON<Warehouse[]>('/inventory/warehouses'),
      getJSON<RoomType[]>('/inventory/room-types'),
    ])
    setWarehouses((ws || []).filter((w) => w.active))
    setRoomTypes((rt || []).filter((r) => r.active))
  }

  async function loadHistory() {
    const data = await getJSON<TransferRow[]>('/inventory/transfers?category=linen&limit=200')
    setHistoryRows(data || [])
  }

  async function loadPlans() {
    const data = await getJSON<DeliveryPlanRow[]>('/inventory/linen/delivery-plans')
    setPlans(data || [])
  }

  async function loadSuggestion() {
    const params = new URLSearchParams({
      date_from: dayjs(dateRange?.[0] || dayjs()).format('YYYY-MM-DD'),
      date_to: dayjs(dateRange?.[1] || dayjs().add(7, 'day')).format('YYYY-MM-DD'),
      vehicle_capacity_sets: String(vehicleCapacity || 80),
    })
    const data = await getJSON<SuggestionResp>(`/inventory/linen/delivery-suggestions?${params.toString()}`)
    setSuggestion(data || null)
  }

  useEffect(() => {
    loadBase()
      .then(async () => {
        await Promise.all([loadHistory(), loadPlans(), loadSuggestion()])
      })
      .catch((e) => message.error(e?.message || '加载失败'))
  }, [])

  async function createPlan() {
    const v = await planForm.validateFields()
    await postJSON('/inventory/linen/delivery-plans', {
      plan_date: dayjs(v.plan_date).format('YYYY-MM-DD'),
      date_from: suggestion?.date_from,
      date_to: suggestion?.date_to,
      from_warehouse_id: suggestion?.from_warehouse_id,
      vehicle_capacity_sets: suggestion?.vehicle_capacity_sets,
      note: v.note || undefined,
      lines: (suggestion?.lines || []).filter((x) => Number(x.suggested_sets || 0) > 0),
    })
    message.success('配送计划已保存')
    setPlanOpen(false)
    planForm.resetFields()
    await loadPlans()
  }

  async function createDispatch() {
    const v = await dispatchForm.validateFields()
    await postJSON('/inventory/transfers/room-type', {
      from_warehouse_id: suggestion?.from_warehouse_id,
      to_warehouse_id: selectedPlanLine?.to_warehouse_id,
      room_type_code: v.room_type_code,
      sets: Number(v.sets || selectedPlanLine?.suggested_sets || 0),
      delivery_plan_id: selectedPlanId || undefined,
      note: v.note || undefined,
    })
    message.success('已登记配送调拨')
    setDispatchOpen(false)
    dispatchForm.resetFields()
    setSelectedPlanLine(null)
    await Promise.all([loadHistory(), loadPlans()])
  }

  const historyColumns: any[] = [
    { title: '配送时间', dataIndex: 'created_at', render: (v: string) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '' },
    { title: '来源仓', render: (_: any, r: TransferRow) => `${r.from_warehouse_code || ''} - ${r.from_warehouse_name || ''}`.trim() },
    { title: '目标仓', render: (_: any, r: TransferRow) => `${r.to_warehouse_code || ''} - ${r.to_warehouse_name || ''}`.trim() },
    { title: '床品', render: (_: any, r: TransferRow) => `${r.item_name || '-'} ${r.item_sku ? `(${r.item_sku})` : ''}` },
    { title: '数量', dataIndex: 'quantity' },
    { title: '备注', dataIndex: 'note' },
  ]

  const suggestionColumns: any[] = [
    { title: '目标分仓', render: (_: any, r: SuggestionLine) => `${r.to_warehouse_code} - ${r.to_warehouse_name}` },
    { title: '房型', dataIndex: 'room_type_name' },
    { title: '当前套数', dataIndex: 'current_sets' },
    { title: '未来需求', dataIndex: 'demand_sets' },
    { title: '目标套数', dataIndex: 'target_sets' },
    { title: '建议配送', dataIndex: 'suggested_sets', render: (v: number) => v > 0 ? <Tag color="blue">{v}</Tag> : v },
    { title: '仓容量', dataIndex: 'warehouse_capacity_sets', render: (v: number | null | undefined) => v ?? '-' },
  ]

  const planColumns: any[] = [
    { title: '计划日期', dataIndex: 'plan_date' },
    { title: '来源仓', render: (_: any, r: DeliveryPlanRow) => `${r.from_warehouse_code} - ${r.from_warehouse_name}` },
    { title: '状态', dataIndex: 'status', render: (v: string) => <Tag color={v === 'dispatched' ? 'green' : 'blue'}>{v}</Tag> },
    { title: '建议总套数', dataIndex: 'suggested_sets_total' },
    { title: '实际配送套数', dataIndex: 'actual_sets_total' },
    { title: '分仓数', dataIndex: 'line_count' },
  ]

  const roomTypeOptions = useMemo(() => roomTypes.map((t) => ({ value: t.code, label: t.name })), [roomTypes])
  const targetWarehouseOptions = useMemo(() => warehouses.filter((w) => w.id !== suggestion?.from_warehouse_id).map((w) => ({ value: w.id, label: `${w.code} - ${w.name}` })), [warehouses, suggestion])

  return (
    <>
      <Card
        title="床品配送记录（按周补仓）"
        extra={<Button onClick={() => Promise.all([loadHistory(), loadPlans(), loadSuggestion()]).catch((e) => message.error(e?.message || '刷新失败'))}>刷新</Button>}
      >
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: 'history',
              label: '历史配送',
              children: <Table rowKey={(r) => `${r.transfer_id}-${r.item_sku}`} columns={historyColumns} dataSource={historyRows} pagination={{ pageSize: 20 }} />,
            },
            {
              key: 'suggestion',
              label: '配送建议',
              children: (
                <>
                  <Space wrap style={{ marginBottom: 12 }}>
                    <DatePicker.RangePicker value={dateRange as any} onChange={(v) => setDateRange(v as any)} allowClear={false} />
                    <Space>
                      <span>车容量(套)</span>
                      <InputNumber min={1} value={vehicleCapacity} onChange={(v) => setVehicleCapacity(Number(v || 80))} />
                    </Space>
                    <Button type="primary" onClick={() => loadSuggestion().catch((e) => message.error(e?.message || '加载建议失败'))}>生成建议</Button>
                    <Button onClick={() => { planForm.setFieldsValue({ plan_date: dayjs(), note: '' }); setPlanOpen(true) }}>保存为配送计划</Button>
                  </Space>
                  <Space direction="vertical" style={{ width: '100%', marginBottom: 12 }}>
                    <div>来源仓：{suggestion?.from_warehouse_name || '-'}</div>
                    <div>剩余车容量：{suggestion?.vehicle_remaining_sets ?? '-'}</div>
                    {suggestion?.unmatched_properties?.length ? <Tag color="orange">有 {suggestion.unmatched_properties.length} 个房源未匹配分仓，未计入建议</Tag> : null}
                  </Space>
                  <Table rowKey={(r) => `${r.to_warehouse_id}-${r.room_type_code}`} columns={suggestionColumns} dataSource={suggestion?.lines || []} pagination={false} />
                </>
              ),
            },
            {
              key: 'plans',
              label: '配送计划',
              children: (
                <>
                  <Table rowKey={(r) => r.id} columns={planColumns} dataSource={plans} pagination={{ pageSize: 20 }} />
                  <Card title="快速登记一笔房型配送" style={{ marginTop: 12 }}>
                    <Space wrap>
                      <Select value={selectedPlanId} onChange={setSelectedPlanId} style={{ width: 240 }} options={[{ value: '', label: '不关联计划' }, ...(plans || []).map((p) => ({ value: p.id, label: `${p.plan_date} / ${p.from_warehouse_code}` }))]} />
                      <Select
                        placeholder="目标分仓"
                        style={{ width: 240 }}
                        options={targetWarehouseOptions}
                        onChange={(toWarehouseId) => {
                          const next = {
                            to_warehouse_id: toWarehouseId,
                            to_warehouse_code: (warehouses.find((w) => w.id === toWarehouseId)?.code || ''),
                            to_warehouse_name: (warehouses.find((w) => w.id === toWarehouseId)?.name || ''),
                            room_type_code: roomTypeOptions[0]?.value || '',
                            room_type_name: roomTypeOptions[0]?.label || '',
                            current_sets: 0,
                            demand_sets: 0,
                            target_sets: 0,
                            suggested_sets: 1,
                            vehicle_load_sets: 1,
                          }
                          setSelectedPlanLine(next)
                          dispatchForm.setFieldsValue({ sets: 1, room_type_code: next.room_type_code, note: '' })
                          setDispatchOpen(true)
                        }}
                      />
                    </Space>
                  </Card>
                </>
              ),
            },
          ]}
        />
      </Card>

      <Modal open={planOpen} title="保存配送计划" onCancel={() => setPlanOpen(false)} onOk={createPlan}>
        <Form form={planForm} layout="vertical">
          <Form.Item name="plan_date" label="计划日期" rules={[{ required: true }]}><DatePicker style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="note" label="备注"><Input /></Form.Item>
        </Form>
      </Modal>

      <Modal open={dispatchOpen} title="登记房型配送" onCancel={() => setDispatchOpen(false)} onOk={createDispatch}>
        <Form form={dispatchForm} layout="vertical" initialValues={{ sets: selectedPlanLine?.suggested_sets || 1 }}>
          <Form.Item label="目标分仓"><div>{selectedPlanLine ? `${selectedPlanLine.to_warehouse_code} - ${selectedPlanLine.to_warehouse_name}` : '-'}</div></Form.Item>
          <Form.Item name="room_type_code" label="房型" rules={[{ required: true }]}>
            <Select options={roomTypeOptions} />
          </Form.Item>
          <Form.Item name="sets" label="配送套数" rules={[{ required: true }]}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="note" label="备注"><Input /></Form.Item>
        </Form>
      </Modal>
    </>
  )
}
