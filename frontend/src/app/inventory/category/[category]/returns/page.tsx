"use client"
import { Card } from 'antd'
import MovementsListView from '../../../_components/MovementsListView'
import LinenReturnsDamageView from '../../../_components/LinenReturnsDamageView'
import { asInventoryCategory, categoryLabel } from '../../categoryMeta'

export default function CategoryReturnsPage({ params }: any) {
  const c = asInventoryCategory(params?.category)
  if (!c) return <MovementsListView title="退货/报损记录" fixedType="out" showReasonFilter />
  if (c !== 'linen') return <Card title={`${categoryLabel(c)}退货/报损记录`}>该分类暂不支持退货/报损记录。</Card>
  return <LinenReturnsDamageView />
}
