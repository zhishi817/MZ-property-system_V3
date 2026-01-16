"use client"
import { Card, Table, Select, Button, message, Popconfirm, Space } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { getJSON, API_BASE, authHeaders } from '../../lib/api'

type Onb = { id: string; property_id: string; address_snapshot?: string; onboarding_date?: string; status?: string; daily_items_total?: number; furniture_appliance_total?: number; decor_total?: number; oneoff_fees_total?: number; grand_total?: number }
type Property = { id: string; code?: string; address?: string }

export default function OnboardingListPage() {
  const [rows, setRows] = useState<Onb[]>([])
  const [properties, setProperties] = useState<Property[]>([])
  const [pid, setPid] = useState<string | undefined>(undefined)
  useEffect(() => { getJSON<Property[]>('/properties').then(setProperties).catch(()=>setProperties([])) }, [])
  async function refresh() {
    // 首选按 property_id 远程筛选
    const q = pid ? `?property_id=${encodeURIComponent(pid)}` : ''
    let list = await getJSON<Onb[]>(`/onboarding${q}`).catch(()=>[])
    // 兼容历史数据：若按 id 返回为空，尝试通过 code 或本地筛选
    if ((pid && (!list || list.length === 0))) {
      const prop = properties.find(p=>p.id===pid)
      const code = prop?.code
      if (code) {
        // 后端若支持 property_code，则使用之；否则退回到全量列表并本地过滤
        const byCode = await getJSON<Onb[]>(`/onboarding?property_code=${encodeURIComponent(code)}`).catch(()=>[])
        if (byCode && byCode.length) {
          list = byCode
        } else {
          const all = await getJSON<Onb[]>(`/onboarding`).catch(()=>[])
          list = (all || []).filter(r=>r.property_id===pid || r.property_id===code)
        }
      }
    }
    setRows(list || [])
  }
  useEffect(() => { refresh().catch(()=>{}) }, [pid])
  const fmtCurrency = (n: number | string | undefined) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(Number(n || 0))
  const columns = [
    { title:'房号', dataIndex:'property_id', render: (v: string) => (properties.find(p=>p.id===v)?.code || properties.find(p=>p.code===v)?.code || v) },
    { title:'地址', dataIndex:'address_snapshot' },
    { title:'上线日期', dataIndex:'onboarding_date', render: (v: string) => (v ? dayjs(v).format('DD/MM/YYYY') : '') },
    { title:'状态', dataIndex:'status' },
    { title:'日用品', dataIndex:'daily_items_total', align:'right' as const, render: (v: any) => fmtCurrency(v) },
    { title:'家具家电', dataIndex:'furniture_appliance_total', align:'right' as const, render: (v: any) => fmtCurrency(v) },
    { title:'软装', dataIndex:'decor_total', align:'right' as const, render: (v: any) => fmtCurrency(v) },
    { title:'上线费用', dataIndex:'oneoff_fees_total', align:'right' as const, render: (v: any) => fmtCurrency(v) },
    { title:'Grand Total', dataIndex:'grand_total', align:'right' as const, render: (v: any) => fmtCurrency(v) },
    { title:'操作', render: (_: any, r: Onb) => {
      const pidById = properties.find(p=>p.id===r.property_id)?.id
      const pidByCode = properties.find(p=>p.code===r.property_id)?.id
      const targetPid = pidById || pidByCode || r.property_id
      return (
        <Space>
          <Button onClick={() => { window.location.href = `/properties/${targetPid}/onboarding` }}>打开</Button>
          <Popconfirm title="确认删除此上新记录？" okText="删除" cancelText="取消" onConfirm={async () => {
            try {
              const res = await fetch(`${API_BASE}/onboarding/${encodeURIComponent(r.id)}`, { method:'DELETE', headers: { ...authHeaders() } })
              if (!res.ok) throw new Error(`HTTP ${res.status}`)
              message.success('已删除上新记录')
              await refresh()
            } catch (e: any) {
              message.error(e?.message || '删除失败')
            }
          }}>
            <Button danger>删除</Button>
          </Popconfirm>
        </Space>
      )
    } },
  ]
  return (
    <Card title="房源上新管理">
      <div style={{ marginBottom: 12, display:'flex', gap:8 }}>
        <Select allowClear showSearch optionFilterProp="label" style={{ width: 260 }} placeholder="按房号筛选" value={pid} onChange={setPid as any} options={properties.map(p=>({ value:p.id, label:p.code || p.address || p.id }))} />
        <Button type="primary" onClick={async () => { if (!pid) { message.warning('请先选择房号'); return }; try { const res = await fetch(`${API_BASE}/onboarding`, { method:'POST', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify({ property_id: pid }) }); if (!res.ok) throw new Error(`HTTP ${res.status}`); message.success('已创建上新记录'); await refresh() } catch (e: any) { message.error(e?.message || '创建失败') } }}>新建上新</Button>
      </div>
      <Table rowKey={(r)=>r.id} columns={columns as any} dataSource={rows} size="small" pagination={{ pageSize: 20 }} />
    </Card>
  )
}
