"use client"

import { Card, Col, Empty, Progress, Row, Space, Statistic, Table, Tag, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { getJSON } from '../../../lib/api'

type DashboardStock = {
  item_id: string
  item_name: string
  item_sku: string
  quantity: number
  threshold_effective: number
  status: 'normal' | 'warning' | 'out_of_stock'
  category: string
}

type CategoryDashboard = {
  category: string
  cards: {
    total_qty: number
    low_sku_count: number
    today_in_qty: number
    today_out_qty: number
  }
  stocks: DashboardStock[]
}

type ConsumableUsageRow = {
  id: string
  item_id: string
  item_name: string
  quantity: number
}

type DailyReplacementRow = {
  id: string
  item_name: string
  quantity: number
  status: string
}

type PurchaseOrderRow = {
  id: string
  po_no?: string | null
  supplier_name: string
  status: string
  ordered_date?: string | null
  created_at: string
  total_amount_inc_gst?: string | null
}

type TransferRecordRow = {
  id: string
  created_at: string
  from_warehouse_code: string
  to_warehouse_code: string
  quantity_total: number
  item_count: number
}

type RecentActivityRow = {
  id: string
  type: 'purchase' | 'delivery'
  category: 'linen' | 'daily' | 'consumable' | 'other'
  occurred_at: string
  title: string
  summary: string
  amount?: number | null
}

type RankRow = {
  name: string
  quantity: number
}

const CATEGORY_LABEL: Record<string, string> = {
  linen: '床品',
  daily: '日用品',
  consumable: '消耗品',
  other: '其他物品',
}

const PIE_COLORS = ['#2563eb', '#0f766e', '#ea580c', '#7c3aed']

function rankByQuantity<T extends { item_name: string; quantity: number }>(rows: T[], limit = 8): RankRow[] {
  const grouped = new Map<string, number>()
  for (const row of rows || []) {
    const key = String(row.item_name || '').trim()
    if (!key) continue
    grouped.set(key, Number(grouped.get(key) || 0) + Number(row.quantity || 0))
  }
  return Array.from(grouped.entries())
    .map(([name, quantity]) => ({ name, quantity }))
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, limit)
}

function formatDate(value?: string | null) {
  return value ? dayjs(value).format('YYYY-MM-DD') : '-'
}

function formatMoney(value?: number | null) {
  if (value == null) return '-'
  return `$${Number(value || 0).toFixed(2)} AUD`
}

function SectionTitle({ title, extra }: { title: string; extra?: string }) {
  return (
    <Space direction="vertical" size={2} style={{ marginBottom: 16 }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {title}
      </Typography.Title>
      {extra ? <Typography.Text type="secondary">{extra}</Typography.Text> : null}
    </Space>
  )
}

function KPIBlock({
  title,
  value,
  note,
  accent,
  loading,
}: {
  title: string
  value: number
  note: string
  accent: string
  loading: boolean
}) {
  return (
    <Card
      loading={loading}
      bodyStyle={{
        padding: 20,
        background: `linear-gradient(180deg, ${accent}12 0%, #ffffff 58%)`,
      }}
      style={{
        borderRadius: 20,
        border: `1px solid ${accent}22`,
        boxShadow: '0 10px 30px rgba(15, 23, 42, 0.04)',
      }}
    >
      <Typography.Text type="secondary">{title}</Typography.Text>
      <div style={{ marginTop: 10 }}>
        <Statistic value={value} valueStyle={{ fontSize: 32, fontWeight: 700, color: '#111827' }} />
      </div>
      <Typography.Text type="secondary">{note}</Typography.Text>
    </Card>
  )
}

function RankingChart({
  title,
  subtitle,
  data,
  color,
  emptyText,
  loading,
}: {
  title: string
  subtitle: string
  data: RankRow[]
  color: string
  emptyText: string
  loading: boolean
}) {
  return (
    <Card
      loading={loading}
      bodyStyle={{ padding: 20 }}
      style={{ borderRadius: 20, minHeight: 430, boxShadow: '0 10px 30px rgba(15, 23, 42, 0.04)' }}
    >
      <SectionTitle title={title} extra={subtitle} />
      {data.length ? (
        <div style={{ width: '100%', height: 320 }}>
          <ResponsiveContainer>
            <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, left: 8, bottom: 0 }}>
              <XAxis type="number" allowDecimals={false} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={126} axisLine={false} tickLine={false} />
              <Tooltip formatter={(value: any) => [Number(value || 0), '数量']} />
              <Bar dataKey="quantity" fill={color} radius={[0, 10, 10, 0]} barSize={18} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <Empty description={emptyText} style={{ paddingTop: 56 }} />
      )}
    </Card>
  )
}

export default function InventoryOverviewPage() {
  const [loading, setLoading] = useState(false)
  const [dashboards, setDashboards] = useState<Record<string, CategoryDashboard>>({})
  const [consumableUsageRows, setConsumableUsageRows] = useState<ConsumableUsageRow[]>([])
  const [dailyReplacementRows, setDailyReplacementRows] = useState<DailyReplacementRow[]>([])
  const [purchaseRows, setPurchaseRows] = useState<RecentActivityRow[]>([])
  const [deliveryRows, setDeliveryRows] = useState<RecentActivityRow[]>([])

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const fromDate = dayjs().subtract(30, 'day').format('YYYY-MM-DD')
        const [
          linenDashboard,
          dailyDashboard,
          consumableDashboard,
          otherDashboard,
          consumableUsage,
          dailyReplacements,
          linenPurchases,
          dailyPurchases,
          consumablePurchases,
          otherPurchases,
          dailyDeliveries,
          consumableDeliveries,
          otherDeliveries,
        ] = await Promise.all([
          getJSON<CategoryDashboard>('/inventory/category-dashboard?category=linen'),
          getJSON<CategoryDashboard>('/inventory/category-dashboard?category=daily'),
          getJSON<CategoryDashboard>('/inventory/category-dashboard?category=consumable'),
          getJSON<CategoryDashboard>('/inventory/category-dashboard?category=other'),
          getJSON<ConsumableUsageRow[]>(`/inventory/consumable-usage-records?from=${encodeURIComponent(fromDate)}`),
          getJSON<DailyReplacementRow[]>(`/inventory/daily-replacements?from=${encodeURIComponent(fromDate)}&status=need_replace,replaced`),
          getJSON<PurchaseOrderRow[]>('/inventory/purchase-orders?category=linen'),
          getJSON<PurchaseOrderRow[]>('/inventory/purchase-orders?category=daily'),
          getJSON<PurchaseOrderRow[]>('/inventory/purchase-orders?category=consumable'),
          getJSON<PurchaseOrderRow[]>('/inventory/purchase-orders?category=other'),
          getJSON<TransferRecordRow[]>('/inventory/transfer-records?category=daily'),
          getJSON<TransferRecordRow[]>('/inventory/transfer-records?category=consumable'),
          getJSON<TransferRecordRow[]>('/inventory/transfer-records?category=other'),
        ])

        setDashboards({
          linen: linenDashboard,
          daily: dailyDashboard,
          consumable: consumableDashboard,
          other: otherDashboard,
        })
        setConsumableUsageRows(consumableUsage || [])
        setDailyReplacementRows(dailyReplacements || [])

        const purchaseActivity: RecentActivityRow[] = [
          ...(linenPurchases || []).map((row) => ({
            id: `purchase-linen-${row.id}`,
            type: 'purchase' as const,
            category: 'linen' as const,
            occurred_at: String(row.ordered_date || row.created_at || ''),
            title: row.po_no || row.id,
            summary: `${row.supplier_name || '-'} · ${row.status || '-'}`,
            amount: Number(row.total_amount_inc_gst || 0),
          })),
          ...(dailyPurchases || []).map((row) => ({
            id: `purchase-daily-${row.id}`,
            type: 'purchase' as const,
            category: 'daily' as const,
            occurred_at: String(row.ordered_date || row.created_at || ''),
            title: row.po_no || row.id,
            summary: `${row.supplier_name || '-'} · ${row.status || '-'}`,
            amount: Number(row.total_amount_inc_gst || 0),
          })),
          ...(consumablePurchases || []).map((row) => ({
            id: `purchase-consumable-${row.id}`,
            type: 'purchase' as const,
            category: 'consumable' as const,
            occurred_at: String(row.ordered_date || row.created_at || ''),
            title: row.po_no || row.id,
            summary: `${row.supplier_name || '-'} · ${row.status || '-'}`,
            amount: Number(row.total_amount_inc_gst || 0),
          })),
          ...(otherPurchases || []).map((row) => ({
            id: `purchase-other-${row.id}`,
            type: 'purchase' as const,
            category: 'other' as const,
            occurred_at: String(row.ordered_date || row.created_at || ''),
            title: row.po_no || row.id,
            summary: `${row.supplier_name || '-'} · ${row.status || '-'}`,
            amount: Number(row.total_amount_inc_gst || 0),
          })),
        ]

        const deliveryActivity: RecentActivityRow[] = [
          ...(dailyDeliveries || []).map((row) => ({
            id: `delivery-daily-${row.id}`,
            type: 'delivery' as const,
            category: 'daily' as const,
            occurred_at: String(row.created_at || ''),
            title: `${row.from_warehouse_code} → ${row.to_warehouse_code}`,
            summary: `${row.item_count} 项 · 共 ${row.quantity_total}`,
            amount: null,
          })),
          ...(consumableDeliveries || []).map((row) => ({
            id: `delivery-consumable-${row.id}`,
            type: 'delivery' as const,
            category: 'consumable' as const,
            occurred_at: String(row.created_at || ''),
            title: `${row.from_warehouse_code} → ${row.to_warehouse_code}`,
            summary: `${row.item_count} 项 · 共 ${row.quantity_total}`,
            amount: null,
          })),
          ...(otherDeliveries || []).map((row) => ({
            id: `delivery-other-${row.id}`,
            type: 'delivery' as const,
            category: 'other' as const,
            occurred_at: String(row.created_at || ''),
            title: `${row.from_warehouse_code} → ${row.to_warehouse_code}`,
            summary: `${row.item_count} 项 · 共 ${row.quantity_total}`,
            amount: null,
          })),
        ]

        setPurchaseRows(
          purchaseActivity
            .sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')))
            .slice(0, 8),
        )
        setDeliveryRows(
          deliveryActivity
            .sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')))
            .slice(0, 8),
        )
      } catch (e: any) {
        message.error(e?.message || '加载失败')
      } finally {
        setLoading(false)
      }
    }
    load().catch(() => {})
  }, [])

  const kpis = useMemo(() => {
    const allDashboards = Object.values(dashboards || {})
    const allStocks = allDashboards.flatMap((row) => row?.stocks || [])
    const totalQty = allDashboards.reduce((sum, row) => sum + Number(row?.cards?.total_qty || 0), 0)
    const lowStockCount = allStocks.filter((row) => row.status === 'warning' || row.status === 'out_of_stock').length
    const todayOutbound = allDashboards.reduce((sum, row) => sum + Number(row?.cards?.today_out_qty || 0), 0)
    const activeCategories = allDashboards.filter((row) => Number(row?.cards?.total_qty || 0) > 0).length
    return { totalQty, lowStockCount, todayOutbound, activeCategories }
  }, [dashboards])

  const lowStockRows = useMemo(() => {
    return Object.entries(dashboards || {})
      .flatMap(([category, dashboard]) =>
        (dashboard?.stocks || [])
          .filter((row) => row.status === 'warning' || row.status === 'out_of_stock')
          .map((row) => ({
            ...row,
            gap: Number(row.quantity || 0) - Number(row.threshold_effective || 0),
            categoryLabel: CATEGORY_LABEL[category] || category,
          })),
      )
      .sort((a, b) => a.gap - b.gap)
      .slice(0, 10)
  }, [dashboards])

  const categoryPieData = useMemo(() => {
    const rows = ['linen', 'daily', 'consumable', 'other'].map((category) => ({
      key: category,
      name: CATEGORY_LABEL[category],
      value: Number(dashboards?.[category]?.cards?.total_qty || 0),
    }))
    const total = rows.reduce((sum, row) => sum + row.value, 0)
    return rows
      .filter((row) => row.value > 0)
      .map((row) => ({
        ...row,
        percent: total > 0 ? Number(((row.value / total) * 100).toFixed(1)) : 0,
      }))
  }, [dashboards])

  const consumableRankData = useMemo(() => rankByQuantity(consumableUsageRows, 8), [consumableUsageRows])
  const dailyRankData = useMemo(() => rankByQuantity(dailyReplacementRows, 8), [dailyReplacementRows])

  const recentActivities = useMemo(() => {
    return [...purchaseRows, ...deliveryRows]
      .sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')))
      .slice(0, 12)
  }, [purchaseRows, deliveryRows])

  const lowStockColumns: ColumnsType<(typeof lowStockRows)[number]> = [
    {
      title: '品类',
      dataIndex: 'categoryLabel',
      width: 100,
      render: (value) => <Tag style={{ borderRadius: 999 }}>{value}</Tag>,
    },
    { title: '物品', dataIndex: 'item_name', ellipsis: true },
    {
      title: '库存 / 阈值',
      width: 140,
      render: (_, row) => `${row.quantity} / ${row.threshold_effective}`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: string) => (value === 'out_of_stock' ? <Tag color="red">缺货</Tag> : <Tag color="orange">偏低</Tag>),
    },
  ]

  const recentColumns: ColumnsType<RecentActivityRow> = [
    {
      title: '日期',
      dataIndex: 'occurred_at',
      width: 112,
      render: (value: string) => formatDate(value),
    },
    {
      title: '类型',
      dataIndex: 'type',
      width: 88,
      render: (value: 'purchase' | 'delivery') => (value === 'purchase' ? <Tag color="blue">采购</Tag> : <Tag color="green">配送</Tag>),
    },
    {
      title: '品类',
      dataIndex: 'category',
      width: 92,
      render: (value: string) => CATEGORY_LABEL[value] || value,
    },
    { title: '单号 / 路径', dataIndex: 'title', width: 180, ellipsis: true },
    { title: '摘要', dataIndex: 'summary', ellipsis: true },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 132,
      render: (value: number | null | undefined) => formatMoney(value),
    },
  ]

  return (
    <Space direction="vertical" size={18} style={{ width: '100%' }}>
      <Card
        bodyStyle={{ padding: 24 }}
        style={{
          borderRadius: 24,
          border: '1px solid #e5e7eb',
          background: 'linear-gradient(135deg, #f8fbff 0%, #ffffff 52%, #f8fafc 100%)',
          boxShadow: '0 12px 36px rgba(15, 23, 42, 0.05)',
        }}
      >
        <Space direction="vertical" size={4}>
          <Typography.Title level={3} style={{ margin: 0 }}>
            仓库总览
          </Typography.Title>
          <Typography.Text type="secondary">
            先聚焦库存总量、低库存风险、库存结构、消耗排行和近期采购 / 配送动态。
          </Typography.Text>
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <KPIBlock title="总库存量" value={kpis.totalQty} note="当前 4 个品类库存合计" accent="#2563eb" loading={loading} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <KPIBlock title="低库存预警" value={kpis.lowStockCount} note="优先处理缺货和低于阈值物品" accent="#dc2626" loading={loading} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <KPIBlock title="今日出库量" value={kpis.todayOutbound} note="汇总今日各品类出库数量" accent="#ea580c" loading={loading} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <KPIBlock title="有库存品类" value={kpis.activeCategories} note="当前有库存记录的品类数" accent="#0f766e" loading={loading} />
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card loading={loading} bodyStyle={{ padding: 20 }} style={{ borderRadius: 20, minHeight: 468, boxShadow: '0 10px 30px rgba(15, 23, 42, 0.04)' }}>
            <SectionTitle title="低库存预警列表" extra="按缺口从高到低排序，先看最需要补货的物品。" />
            <Table
              rowKey={(row) => `${row.categoryLabel}-${row.item_id}`}
              dataSource={lowStockRows}
              pagination={false}
              size="middle"
              locale={{ emptyText: <Empty description="暂无低库存预警" /> }}
              columns={lowStockColumns}
            />
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card loading={loading} bodyStyle={{ padding: 20 }} style={{ borderRadius: 20, minHeight: 468, boxShadow: '0 10px 30px rgba(15, 23, 42, 0.04)' }}>
            <SectionTitle title="各品类库存占比饼图" extra="帮助快速判断库存结构是否过于偏向某一类。" />
            {categoryPieData.length ? (
              <Row gutter={[12, 12]} align="middle">
                <Col span={14}>
                  <div style={{ width: '100%', height: 290 }}>
                    <ResponsiveContainer>
                      <PieChart>
                        <Pie data={categoryPieData} dataKey="value" nameKey="name" innerRadius={62} outerRadius={100} paddingAngle={3}>
                          {categoryPieData.map((_, index) => <Cell key={index} fill={PIE_COLORS[index % PIE_COLORS.length]} />)}
                        </Pie>
                        <Tooltip formatter={(value: any) => [Number(value || 0), '库存量']} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </Col>
                <Col span={10}>
                  <Space direction="vertical" size={12} style={{ width: '100%' }}>
                    {categoryPieData.map((row, index) => (
                      <div
                        key={row.key}
                        style={{
                          padding: '10px 12px',
                          borderRadius: 14,
                          border: '1px solid #f1f5f9',
                          background: '#fafcff',
                        }}
                      >
                        <Space align="start" size={10} style={{ width: '100%', justifyContent: 'space-between' }}>
                          <Space size={10}>
                            <span style={{ width: 10, height: 10, borderRadius: 999, background: PIE_COLORS[index % PIE_COLORS.length], display: 'inline-block', marginTop: 6 }} />
                            <div>
                              <Typography.Text strong>{row.name}</Typography.Text>
                              <div>
                                <Typography.Text type="secondary">{row.value} 件</Typography.Text>
                              </div>
                            </div>
                          </Space>
                          <Typography.Text strong>{row.percent}%</Typography.Text>
                        </Space>
                        <Progress percent={row.percent} showInfo={false} strokeColor={PIE_COLORS[index % PIE_COLORS.length]} trailColor="#edf2f7" style={{ marginTop: 8, marginBottom: 0 }} />
                      </div>
                    ))}
                  </Space>
                </Col>
              </Row>
            ) : (
              <Empty description="暂无库存数据" style={{ paddingTop: 68 }} />
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <RankingChart
            title="消耗品消耗量排行榜"
            subtitle="近 30 天内，按补充/消耗记录汇总。"
            data={consumableRankData}
            color="#0f766e"
            emptyText="近 30 天暂无消耗品记录"
            loading={loading}
          />
        </Col>
        <Col xs={24} xl={12}>
          <RankingChart
            title="日用品消耗量排行榜"
            subtitle="近 30 天内，按日用品反馈与更换记录汇总。"
            data={dailyRankData}
            color="#ea580c"
            emptyText="近 30 天暂无日用品更换记录"
            loading={loading}
          />
        </Col>
      </Row>

      <Card loading={loading} bodyStyle={{ padding: 20 }} style={{ borderRadius: 20, boxShadow: '0 10px 30px rgba(15, 23, 42, 0.04)' }}>
        <SectionTitle title="近期采购 / 配送记录" extra="按时间倒序展示床品、日用品、消耗品和其他物品的最近动态。" />
        <Table
          rowKey={(row) => row.id}
          dataSource={recentActivities}
          pagination={false}
          size="middle"
          locale={{ emptyText: <Empty description="暂无近期记录" /> }}
          columns={recentColumns}
        />
      </Card>
    </Space>
  )
}
