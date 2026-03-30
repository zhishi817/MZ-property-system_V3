"use client"
import DeliveriesListView from '../../../_components/DeliveriesListView'
import { asInventoryCategory, categoryLabel } from '../../categoryMeta'

export default function CategoryDeliveriesPage({ params }: any) {
  const c = asInventoryCategory(params?.category)
  if (!c) return <DeliveriesListView title="配送记录" />
  return <DeliveriesListView title={`${categoryLabel(c)}配送记录`} category={c} />
}

