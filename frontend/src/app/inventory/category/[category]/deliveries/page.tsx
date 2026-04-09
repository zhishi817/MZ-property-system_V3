"use client"
import DeliveriesListView from '../../../_components/DeliveriesListView'
import DailyTransferRecordsView from '../../../_components/DailyTransferRecordsView'
import LinenTransfersView from '../../../_components/LinenTransfersView'
import ConsumableTransferRecordsView from '../../../_components/ConsumableTransferRecordsView'
import OtherTransferRecordsView from '../../../_components/OtherTransferRecordsView'
import { asInventoryCategory, categoryLabel } from '../../categoryMeta'

export default function CategoryDeliveriesPage({ params }: any) {
  const c = asInventoryCategory(params?.category)
  if (!c) return <DeliveriesListView title="配送记录" />
  if (c === 'linen') return <LinenTransfersView />
  if (c === 'daily') return <DailyTransferRecordsView />
  if (c === 'consumable') return <ConsumableTransferRecordsView />
  if (c === 'other') return <OtherTransferRecordsView />
  return <DeliveriesListView title={`${categoryLabel(c)}配送记录`} category={c} />
}
