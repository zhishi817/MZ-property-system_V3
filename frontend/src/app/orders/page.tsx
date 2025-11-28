"use client"
import { Table, Card, Space, Button, Modal, Form, Input, DatePicker, message, Select, Tag, InputNumber, Checkbox, Upload } from 'antd'
import type { UploadProps } from 'antd'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { API_BASE, getJSON, authHeaders } from '../../lib/api'
import { hasPerm } from '../../lib/auth'

type Order = { id: string; source?: string; checkin?: string; checkout?: string; status?: string; property_id?: string; property_code?: string; guest_name?: string; guest_phone?: string; price?: number; cleaning_fee?: number; net_income?: number; avg_nightly_price?: number; nights?: number }
// guest_phone 在后端已支持，这里表单也支持录入
type CleaningTask = { id: string; status: 'pending'|'scheduled'|'done' }

export default function OrdersPage() {
  const [data, setData] = useState<Order[]>([])
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const [editOpen, setEditOpen] = useState(false)
  const [editForm] = Form.useForm()
  const [current, setCurrent] = useState<Order | null>(null)
  const [codeQuery, setCodeQuery] = useState('')
  const [dateRange, setDateRange] = useState<[any, any] | null>(null)
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string }[]>([])
  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(false)

  async function load() {
    const res = await getJSON<Order[]>('/orders')
    setData(res)
  }
  useEffect(() => { load(); getJSON<any>('/properties').then((j) => setProperties(Array.isArray(j) ? j : [])).catch(() => setProperties([])) }, [])

  async function openEdit(o: Order) {
    setCurrent(o)
    // 先展示弹窗并填充当前行数据，提升交互稳定性
    setEditOpen(true)
    const pid0 = o.property_id
    const p0 = (Array.isArray(properties) ? properties : []).find(x => x.id === pid0)
    editForm.setFieldsValue({
      ...o,
      property_id: pid0,
      property_code: p0 ? (p0.code || p0.address || pid0) : o.property_code,
      price: o.price != null ? o.price : 0,
      cleaning_fee: o.cleaning_fee != null ? o.cleaning_fee : 0,
      checkin: o.checkin ? dayjs(o.checkin) : undefined,
      checkout: o.checkout ? dayjs(o.checkout) : undefined,
      status: o.status || 'confirmed',
      guest_phone: (o as any).guest_phone || ''
    })
    // 再异步拉取完整数据并二次填充（失败时保持现有值）
    try {
      const full = await getJSON<Order>(`/orders/${o.id}`)
      const pid = full.property_id
      const p = (Array.isArray(properties) ? properties : []).find(x => x.id === pid)
      editForm.setFieldsValue({
        ...full,
        property_id: pid,
        property_code: p ? (p.code || p.address || pid) : full.property_code,
        price: full.price != null ? full.price : 0,
        cleaning_fee: full.cleaning_fee != null ? full.cleaning_fee : 0,
        checkin: full.checkin ? dayjs(full.checkin) : undefined,
        checkout: full.checkout ? dayjs(full.checkout) : undefined,
        status: full.status || 'confirmed',
        guest_phone: (full as any).guest_phone || ''
      })
    } catch {
      message.warning('加载订单详情失败，使用列表数据进行编辑')
    }
  }

  async function genCleaning(id: string) {
    const res = await fetch(`${API_BASE}/orders/${id}/generate-cleaning`, { method: 'POST' })
    if (res.ok) { message.success('已生成清洁任务') } else { message.error('生成失败') }
  }

  async function submitCreate() {
    const v = await form.validateFields()
    const nights = v.checkin && v.checkout ? Math.max(0, dayjs(v.checkout).diff(dayjs(v.checkin), 'day')) : 0
    const price = Number(v.price || 0)
    const cleaning = Number(v.cleaning_fee || 0)
    const lateFee = v.late_checkout ? 20 : Number(v.late_checkout_fee || 0)
    const cancelFee = Number(v.cancel_fee || 0)
    const net = Math.max(0, price + lateFee + cancelFee - cleaning)
    const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0
    const selectedNew = (Array.isArray(properties) ? properties : []).find(p => p.id === v.property_id)
    const payload = {
      source: v.source,
      status: v.status || 'confirmed',
      property_id: v.property_id,
      property_code: v.property_code || selectedNew?.code || selectedNew?.address || v.property_id,
      guest_name: v.guest_name,
      guest_phone: v.guest_phone,
      checkin: v.checkin.format('YYYY-MM-DD') + 'T12:00:00',
      checkout: v.checkout.format('YYYY-MM-DD') + 'T11:59:59',
      price,
      cleaning_fee: cleaning,
      net_income: net,
      avg_nightly_price: avg,
      nights,
      currency: 'AUD',
    }
    const res = await fetch(`${API_BASE}/orders/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload) })
    if (res.status === 201) {
      const created = await res.json()
      async function writeIncome(amount: number, cat: string, note: string) {
        if (!amount || amount <= 0) return
        const tx = { kind: 'income', amount: Number(amount), currency: 'AUD', occurred_at: v.checkout.format('YYYY-MM-DD'), note, category: cat, property_id: v.property_id, ref_type: 'order', ref_id: created?.id }
        await fetch(`${API_BASE}/finance`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(tx) }).catch(() => {})
      }
      await writeIncome(lateFee, 'late_checkout', 'Late checkout income')
      if ((v.status || '') === 'canceled') await writeIncome(cancelFee, 'cancel_fee', 'Cancelation fee')
      message.success('订单已创建'); setOpen(false); form.resetFields(); load()
    }
    else if (res.status === 200) {
      message.error('订单已存在')
    } else {
      let msg = '创建失败'
      try { const j = await res.json(); if (j?.message) msg = j.message } catch { try { msg = await res.text() } catch {} }
      message.error(msg)
    }
  }

  const columns = [
    { title: '房号', dataIndex: 'property_code' },
    { title: '来源', dataIndex: 'source' },
    { title: '客人', dataIndex: 'guest_name' },
    // 可按需求增加显示客人电话
    { title: '入住', dataIndex: 'checkin' },
    { title: '退房', dataIndex: 'checkout' },
    { title: '天数', dataIndex: 'nights' },
    { title: '总租金(AUD)', dataIndex: 'price' },
    { title: '清洁费', dataIndex: 'cleaning_fee' },
    { title: '总收入', dataIndex: 'net_income' },
    { title: '晚均价', dataIndex: 'avg_nightly_price' },
    { title: '状态', dataIndex: 'status' },
    { title: '操作', render: (_: any, r: Order) => (
      <Space>
        {hasPerm('order.write') ? <Button onClick={() => openEdit(r)}>编辑</Button> : null}
        {hasPerm('order.write') ? <Button danger onClick={() => {
          Modal.confirm({
            title: '确认删除订单',
            content: `确定删除订单（房号：${r.property_code || ''}，入住：${r.checkin || ''}）？`,
            okText: '删除',
            okType: 'danger',
            cancelText: '取消',
            onOk: async () => {
              const res = await fetch(`${API_BASE}/orders/${r.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
              if (res.ok) { message.success('订单已删除'); load() } else { message.error('删除失败') }
            }
          })
        }}>删除</Button> : null}
      </Space>
    ) },
  ]

  const sourceColor: Record<string, string> = {
    airbnb: '#FF9F97',
    booking: '#98B6EC',
    offline: '#DC8C03',
    other: '#98B6EC'
  }

  const baseMonth = calMonth || dayjs()
  const monthStart = baseMonth.startOf('month')
  const monthEnd = baseMonth.endOf('month')
  const monthOrders = (data || []).filter(o => calPid && o.property_id === calPid && o.checkin && o.checkout && dayjs(o.checkout!).isAfter(monthStart) && dayjs(o.checkin!).isBefore(monthEnd))
  const orderLane = (function(){
    const lanesEnd: number[] = []
    const map: Record<string, number> = {}
    const toDayIndex = (d: any) => d.startOf('day').diff(monthStart.startOf('day'), 'day')
    const segs = monthOrders.map(o => {
      const s = dayjs(o.checkin!).isAfter(monthStart) ? dayjs(o.checkin!) : monthStart
      const e = dayjs(o.checkout!).isBefore(monthEnd) ? dayjs(o.checkout!) : monthEnd
      return { id: o.id, startIdx: toDayIndex(s), endIdx: toDayIndex(e) }
    }).sort((a,b)=> a.startIdx - b.startIdx || a.endIdx - b.endIdx)
    for (const seg of segs) {
      let placed = false
      for (let i = 0; i < lanesEnd.length; i++) {
        if (seg.startIdx >= lanesEnd[i]) { map[seg.id] = i; lanesEnd[i] = seg.endIdx; placed = true; break }
      }
      if (!placed) { map[seg.id] = lanesEnd.length; lanesEnd.push(seg.endIdx) }
    }
    return map
  })()
  function dayCell(date: any) {
    if (!calPid) return null
    const orders = data
      .filter(o => o.property_id === calPid && o.checkin && o.checkout && dayjs(o.checkin!).diff(date, 'day') <= 0 && dayjs(o.checkout!).diff(date, 'day') > 0)
      .sort((a,b)=> dayjs(a.checkin!).valueOf() - dayjs(b.checkin!).valueOf())
    if (!orders.length) return null
    return (
      <div style={{ position:'relative', minHeight: 64, overflow:'visible' }}>
        {orders.slice(0,6).map((o)=> {
          const accent = sourceColor[o.source || 'other'] || '#999'
          const isStart = dayjs(o.checkin!).isSame(date, 'day')
          const isEnd = dayjs(o.checkout!).diff(date, 'day') === 1 // last day shown is checkout-1
          const radiusLeft = isStart ? 16 : 3
          const radiusRight = isEnd ? 16 : 3
          const lane = orderLane[o.id!] || 0
          return (
            <div key={o.id} style={{
              position:'absolute',
              left: -6,
              right: -6,
              top: 4 + lane * 22,
              height: 20,
              background: '#f5f5f5',
              color:'#000',
              borderRadius: `${radiusLeft}px ${radiusRight}px ${radiusRight}px ${radiusLeft}px`,
              padding:'0 8px',
              display:'flex',
              alignItems:'center',
              fontSize:11,
              lineHeight:'20px'
            }}>
              {isStart ? <span style={{ position:'absolute', left: -6, top:0, bottom:0, width: '33%', background: accent, borderRadius: `${radiusLeft}px 0 0 ${radiusLeft}px` }} /> : null}
              {isEnd ? <span style={{ position:'absolute', right: -6, top:0, bottom:0, width: '33%', background: accent, borderRadius: `0 ${radiusRight}px ${radiusRight}px 0` }} /> : null}
              <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginLeft: isStart ? '33%' : 0, marginRight: isEnd ? '33%' : 0 }}>{(o.guest_name || '').toString()} ${Number(o.price||0).toFixed(0)}</span>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <Card title="订单管理" extra={<Space>{hasPerm('order.sync') ? <Button type="primary" onClick={() => setOpen(true)}>新建订单</Button> : null}{hasPerm('order.manage') ? <Button onClick={() => setImportOpen(true)}>批量导入</Button> : null}</Space>}>
      <Space style={{ marginBottom: 12 }} wrap>
        <Radio.Group value={view} onChange={(e)=>setView(e.target.value)}>
          <Radio.Button value="list">列表</Radio.Button>
          <Radio.Button value="calendar">日历</Radio.Button>
        </Radio.Group>
        {view==='list' ? (
          <>
            <Input placeholder="按房号搜索" allowClear value={codeQuery} onChange={(e) => setCodeQuery(e.target.value)} style={{ width: 200 }} />
            <DatePicker.RangePicker onChange={(v) => setDateRange(v as any)} />
          </>
        ) : (
          <>
            <DatePicker picker="month" value={calMonth} onChange={setCalMonth as any} />
            <Select showSearch placeholder="选择房号" style={{ width: 220 }} value={calPid} onChange={setCalPid} options={properties.map(p=>({value:p.id,label:p.code||p.id}))} />
            <Button onClick={async () => {
              if (!calPid) { message.warning('请选择房号'); return }
              if (!calRef.current) return
              const style = `
                <style>
                  html, body { font-family: 'Times New Roman', Times, serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                  @page { margin: 12mm; size: A4 landscape; }
                  body { width: 277mm; margin: 0 auto; }
                  .cal-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
                  .cal-title { font-size:18px; font-weight:700; }
                </style>
              `
              const iframe = document.createElement('iframe')
              iframe.style.position = 'fixed'
              iframe.style.left = '-9999px'
              iframe.style.top = '-9999px'
              iframe.style.width = '0'
              iframe.style.height = '0'
              document.body.appendChild(iframe)
              const doc = iframe.contentDocument || (iframe as any).document
              const prop = properties.find(p=>p.id===calPid)
              const header = `<div class="cal-header"><div class="cal-title">订单日历 ${calMonth.format('YYYY-MM')}</div><div>${prop?.code || ''} ${prop?.address || ''}</div></div>`
              const html = `<html><head><title>Order Calendar</title>${style}<base href="${location.origin}"></head><body>${header}${calRef.current.innerHTML}</body></html>`
              doc.open(); doc.write(html); doc.close()
              await new Promise(r => setTimeout(r, 50))
              try { (iframe.contentWindow as any).focus(); (iframe.contentWindow as any).print() } catch {}
              setTimeout(() => { try { document.body.removeChild(iframe) } catch {} }, 500)
            }}>导出日历</Button>
          </>
        )}
      </Space>
      {view==='list' ? (
        <Table rowKey={(r) => r.id} columns={columns as any} dataSource={data.filter(o => {
          const codeOk = !codeQuery || (o.property_code || '').toLowerCase().includes(codeQuery.trim().toLowerCase())
          const rangeOk = !dateRange || (!dateRange[0] || dayjs(o.checkin).diff(dateRange[0], 'day') >= 0) && (!dateRange[1] || dayjs(o.checkout).diff(dateRange[1], 'day') <= 0)
          return codeOk && rangeOk
        })} pagination={{ pageSize: 10 }} scroll={{ x: 'max-content' }} />
      ) : (
        <div ref={calRef}>
          <Calendar value={calMonth} onChange={setCalMonth as any} fullscreen dateCellRender={dayCell as any} headerRender={() => null} />
        </div>
      )}
      <Modal open={open} onCancel={() => setOpen(false)} onOk={submitCreate} title="新建订单">
      <Form form={form} layout="vertical">
        <Form.Item name="source" label="来源" rules={[{ required: true }]}> 
          <Select options={[{ value: 'airbnb', label: 'airbnb' }, { value: 'booking', label: 'booking.com' }, { value: 'offline', label: '线下' }, { value: 'other', label: '其他' }]} />
        </Form.Item>
        <Form.Item name="status" label="状态" initialValue="confirmed"> 
          <Select options={[{ value: 'confirmed', label: '已确认' }, { value: 'canceled', label: '已取消' }]} />
        </Form.Item>
        <Form.Item name="property_id" label="房号" rules={[{ required: true }]}> 
          <Select
            showSearch
            optionFilterProp="label"
            options={(Array.isArray(properties) ? properties : []).map(p => ({ value: p.id, label: p.code || p.address || p.id }))}
            onChange={(val, opt) => {
              const label = (opt as any)?.label || ''
              form.setFieldsValue({ property_code: label })
            }}
          />
        </Form.Item>
        <Form.Item name="property_code" hidden><Input /></Form.Item>
        <Form.Item name="guest_name" label="客人姓名">
          <Input />
        </Form.Item>
        <Form.Item name="guest_phone" label="客人电话">
          <Input placeholder="用于生成旧/新密码（后四位）" />
        </Form.Item>
        <Form.Item name="checkin" label="入住" rules={[{ required: true }]}> 
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="checkout" label="退房" rules={[{ required: true }]}> 
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="price" label="总租金(AUD)" rules={[{ required: true }]}> 
          <InputNumber min={0} step={1} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="cleaning_fee" label="清洁费" rules={[{ required: true }]}> 
          <InputNumber min={0} step={1} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="晚退收入">
          <Space>
            <Form.Item name="late_checkout" valuePropName="checked" noStyle>
              <Checkbox>晚退(+20)</Checkbox>
            </Form.Item>
            <Form.Item name="late_checkout_fee" noStyle>
              <InputNumber min={0} step={1} placeholder="自定义金额(可选)" />
            </Form.Item>
          </Space>
        </Form.Item>
        <Form.Item shouldUpdate>
          {() => {
            const st = form.getFieldValue('status')
            if (st === 'canceled') {
              return (
                <Form.Item name="cancel_fee" label="取消费(AUD)">
                  <InputNumber min={0} step={1} style={{ width: '100%' }} />
                </Form.Item>
              )
            }
            return null
          }}
        </Form.Item>
        <Form.Item shouldUpdate noStyle>
          {() => {
            const v = form.getFieldsValue()
            const nights = v.checkin && v.checkout ? Math.max(0, dayjs(v.checkout).diff(dayjs(v.checkin), 'day')) : 0
            const price = Number(v.price || 0)
            const cleaning = Number(v.cleaning_fee || 0)
            const lateFee = v.late_checkout ? 20 : Number(v.late_checkout_fee || 0)
            const cancelFee = Number(v.cancel_fee || 0)
            const net = Math.max(0, price + lateFee + cancelFee - cleaning)
            const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0
            return (
              <Card size="small" style={{ marginTop: 8 }}>
                <Space wrap>
                  <Tag color="blue">入住天数: {nights}</Tag>
                  <Tag color="green">总收入: {net}</Tag>
                  {v.late_checkout || v.late_checkout_fee ? <Tag color="purple">晚退收入: {lateFee}</Tag> : null}
                  {v.cancel_fee ? <Tag color="orange">取消费: {cancelFee}</Tag> : null}
                  <Tag color="purple">晚均价: {avg}</Tag>
                </Space>
              </Card>
            )
          }}
        </Form.Item>
      </Form>
    </Modal>
    <Modal open={editOpen} onCancel={() => setEditOpen(false)} onOk={async () => {
        const v = await editForm.validateFields()
        const nights = v.checkin && v.checkout ? Math.max(0, dayjs(v.checkout).diff(dayjs(v.checkin), 'day')) : 0
        const price = Number(v.price || 0)
        const cleaning = Number(v.cleaning_fee || 0)
        const net = Math.max(0, price - cleaning)
        const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0
        const selectedEdit = (Array.isArray(properties) ? properties : []).find(p => p.id === v.property_id)
        const payload = { ...v, property_code: (v.property_code || selectedEdit?.code || selectedEdit?.address || v.property_id), checkin: dayjs(v.checkin).format('YYYY-MM-DD') + 'T12:00:00', checkout: dayjs(v.checkout).format('YYYY-MM-DD') + 'T11:59:59', nights, net_income: net, avg_nightly_price: avg }
        const res = await fetch(`${API_BASE}/orders/${current?.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ ...payload, force: true }) })
        if (res.ok) {
          async function writeIncome(amount: number, cat: string, note: string) {
            if (!amount || amount <= 0) return
            const tx = { kind: 'income', amount: Number(amount), currency: 'AUD', occurred_at: dayjs(v.checkout).format('YYYY-MM-DD'), note, category: cat, property_id: v.property_id, ref_type: 'order', ref_id: current?.id }
            await fetch(`${API_BASE}/finance`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(tx) }).catch(() => {})
          }
          const lateFee = v.late_checkout ? 20 : Number(v.late_checkout_fee || 0)
          const cancelFee = Number(v.cancel_fee || 0)
          await writeIncome(lateFee, 'late_checkout', 'Late checkout income')
          if ((v.status || '') === 'canceled') await writeIncome(cancelFee, 'cancel_fee', 'Cancelation fee')
          message.success('订单已更新'); setEditOpen(false); load()
        }
        else {
          let msg = '更新失败'
          try { const j = await res.json(); if (j?.message) msg = j.message } catch { try { msg = await res.text() } catch {} }
          message.error(msg)
        }
      }} title="编辑订单">
        <Form form={editForm} layout="vertical">
          <Form.Item name="source" label="来源" rules={[{ required: true }]}> 
            <Select options={[{ value: 'airbnb', label: 'airbnb' }, { value: 'booking', label: 'booking.com' }, { value: 'offline', label: '线下' }, { value: 'other', label: '其他' }]} />
          </Form.Item>
          <Form.Item name="status" label="状态" initialValue="confirmed"> 
            <Select options={[{ value: 'confirmed', label: '已确认' }, { value: 'canceled', label: '已取消' }]} />
          </Form.Item>
          <Form.Item name="property_id" label="房号" rules={[{ required: true }]}> 
            <Select
              showSearch
              optionFilterProp="label"
              options={(Array.isArray(properties) ? properties : []).map(p => ({ value: p.id, label: p.code || p.address || p.id }))}
              onChange={(val, opt) => {
                const label = (opt as any)?.label || ''
                editForm.setFieldsValue({ property_code: label })
              }}
            />
          </Form.Item>
          <Form.Item name="property_code" hidden><Input /></Form.Item>
          <Form.Item name="guest_name" label="客人姓名"><Input /></Form.Item>
          <Form.Item name="guest_phone" label="客人电话"><Input placeholder="用于生成旧/新密码（后四位）" /></Form.Item>
          <Form.Item name="checkin" label="入住" rules={[{ required: true }]}><DatePicker style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="checkout" label="退房" rules={[{ required: true }]}><DatePicker style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="price" label="总租金(AUD)"><InputNumber min={0} step={1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="cleaning_fee" label="清洁费"><InputNumber min={0} step={1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item label="晚退收入">
            <Space>
              <Form.Item name="late_checkout" valuePropName="checked" noStyle>
                <Checkbox>晚退(+20)</Checkbox>
              </Form.Item>
              <Form.Item name="late_checkout_fee" noStyle>
                <InputNumber min={0} step={1} placeholder="自定义金额(可选)" />
              </Form.Item>
            </Space>
          </Form.Item>
          <Form.Item shouldUpdate>
            {() => {
              const st = editForm.getFieldValue('status')
              if (st === 'canceled') {
                return (
                  <Form.Item name="cancel_fee" label="取消费(AUD)">
                    <InputNumber min={0} step={1} style={{ width: '100%' }} />
                  </Form.Item>
                )
              }
              return null
            }}
          </Form.Item>
          <Form.Item shouldUpdate noStyle>
            {() => {
              const v = editForm.getFieldsValue()
              const nights = v.checkin && v.checkout ? Math.max(0, dayjs(v.checkout).diff(dayjs(v.checkin), 'day')) : 0
              const price = Number(v.price || 0)
              const cleaning = Number(v.cleaning_fee || 0)
              const lateFee = v.late_checkout ? 20 : Number(v.late_checkout_fee || 0)
              const cancelFee = Number(v.cancel_fee || 0)
              const net = Math.max(0, price + lateFee + cancelFee - cleaning)
              const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0
              return (
                <Card size="small" style={{ marginTop: 8 }}>
                  <Space wrap>
                    <Tag color="blue">入住天数: {nights}</Tag>
                    <Tag color="green">总收入: {net}</Tag>
                    {v.late_checkout || v.late_checkout_fee ? <Tag color="purple">晚退收入: {lateFee}</Tag> : null}
                    {v.cancel_fee ? <Tag color="orange">取消费: {cancelFee}</Tag> : null}
                    <Tag color="purple">晚均价: {avg}</Tag>
                  </Space>
                </Card>
              )
            }}
          </Form.Item>
        </Form>
    </Modal>
    <Modal open={importOpen} onCancel={() => setImportOpen(false)} footer={null} title="批量导入订单">
      <Upload.Dragger {...uploadProps} disabled={importing}>
        <p>点击或拖拽上传 CSV 或 JSON 文件</p>
        <p>CSV 需包含列：source, property_code 或 property_id, guest_name, checkin, checkout, price, cleaning_fee, currency, status</p>
      </Upload.Dragger>
    </Modal>
    </Card>
  )
}
  async function taskStatus(orderId: string) {
    const res = await fetch(`${API_BASE}/cleaning/order/${orderId}`)
    const tasks: CleaningTask[] = await res.json()
    if (!tasks.length) return <Tag>无任务</Tag>
    const anyScheduled = tasks.some(t => t.status === 'scheduled')
    const allDone = tasks.every(t => t.status === 'done')
    if (allDone) return <Tag color="green">已完成</Tag>
    if (anyScheduled) return <Tag color="blue">已排班</Tag>
    return <Tag color="orange">待安排</Tag>
  }
  const uploadProps: UploadProps = {
    beforeUpload: async (file) => {
      setImporting(true)
      try {
        const text = await file.text()
        const isCsv = (file.type || '').includes('csv') || file.name.endsWith('.csv')
        const headers = { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': isCsv ? 'text/csv' : 'application/json' }
        const body = isCsv ? text : (() => { try { return JSON.stringify(JSON.parse(text)) } catch { return JSON.stringify([]) } })()
        const res = await fetch(`${API_BASE}/orders/import`, { method: 'POST', headers, body })
        const j = await res.json().catch(() => null)
        if (res.ok) { message.success(`导入完成：新增 ${j?.inserted || 0}，跳过 ${j?.skipped || 0}`); setImportOpen(false); load() } else { message.error(j?.message || '导入失败') }
      } catch { message.error('导入失败') }
      setImporting(false)
      return false
    },
    multiple: false,
    showUploadList: false,
    accept: '.csv,application/json,text/csv'
  }
