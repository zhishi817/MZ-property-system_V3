"use client"

import { Button, Card, Empty, Progress, Space, Typography } from 'antd'
import { ArrowRightOutlined } from '@ant-design/icons'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import type { CompanyRevenueCategorySummary, CompanyRevenueKind } from '../../../../lib/companyRevenue'
import styles from '../page.module.css'

const INCOME_COLORS = ['#0f9f63', '#43c483', '#f6b73c', '#3d8bfd', '#c7ced9']
const EXPENSE_COLORS = ['#f04444', '#ff6b57', '#ff8a3d', '#f7b731', '#c7ced9', '#8b95a5']

function formatAmount(value: number) {
  return Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function CompanyRevenueComposition(props: {
  kind: CompanyRevenueKind
  title: string
  total: number
  data: CompanyRevenueCategorySummary[]
  onSelect: (category?: string) => void
}) {
  const colors = props.kind === 'income' ? INCOME_COLORS : EXPENSE_COLORS
  const chartData = props.data.filter((row) => row.total > 0)

  return (
    <Card
      className={styles.analysisCard}
      title={props.title}
      extra={<Button type="link" onClick={() => props.onSelect()}>查看全部明细 <ArrowRightOutlined /></Button>}
    >
      {chartData.length ? (
        <div className={styles.compositionLayout}>
          <div className={styles.chartWrap}>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={chartData}
                  dataKey="total"
                  nameKey="label"
                  innerRadius={62}
                  outerRadius={92}
                  paddingAngle={2}
                  stroke="#fff"
                  strokeWidth={2}
                >
                  {chartData.map((row, index) => (
                    <Cell key={row.category} fill={colors[index % colors.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(value: number) => [`$${formatAmount(value)}`, '金额']} />
              </PieChart>
            </ResponsiveContainer>
            <div className={styles.chartCenter}>
              <Typography.Text type="secondary">{props.kind === 'income' ? '总收入' : '总支出'}</Typography.Text>
              <strong>${formatAmount(props.total)}</strong>
            </div>
          </div>

          <div className={styles.rankingList}>
            {props.data.map((row, index) => (
              <button
                type="button"
                className={styles.rankingRow}
                key={row.category}
                onClick={() => props.onSelect(row.category)}
              >
                <Space size={10} className={styles.rankingLabel}>
                  <span className={styles.rankNumber}>{index + 1}</span>
                  <span className={styles.colorDot} style={{ background: colors[index % colors.length] }} />
                  <span>{row.label}</span>
                </Space>
                <Progress
                  className={styles.rankingProgress}
                  percent={row.percentage}
                  showInfo={false}
                  strokeColor={colors[index % colors.length]}
                  trailColor="#eef1f5"
                  size="small"
                />
                <span className={styles.rankingAmount}>${formatAmount(row.total)}</span>
                <span className={styles.rankingPercent}>{row.percentage.toFixed(1)}%</span>
              </button>
            ))}
          </div>
        </div>
      ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本月暂无数据" />}
    </Card>
  )
}
