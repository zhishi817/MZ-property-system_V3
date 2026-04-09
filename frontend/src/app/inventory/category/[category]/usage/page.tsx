"use client"
import MovementsListView from '../../../_components/MovementsListView'
import ConsumableUsageRecordsView from '../../../_components/ConsumableUsageRecordsView'
import { asInventoryCategory, categoryLabel } from '../../categoryMeta'

export default function CategoryUsagePage({ params }: any) {
  const c = asInventoryCategory(params?.category)
  if (!c) return <MovementsListView title="使用记录" fixedType="out" showReasonFilter />
  if (c === 'consumable') return <ConsumableUsageRecordsView />
  return <MovementsListView title={`${categoryLabel(c)}使用记录`} category={c} fixedType="out" showReasonFilter />
}
