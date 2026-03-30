"use client"
import PurchaseOrdersListView from '../../../_components/PurchaseOrdersListView'
import { asInventoryCategory, categoryLabel } from '../../categoryMeta'

export default function CategoryPurchaseOrdersPage({ params }: any) {
  const c = asInventoryCategory(params?.category)
  if (!c) return <PurchaseOrdersListView title="采购记录" />
  return <PurchaseOrdersListView title={`${categoryLabel(c)}采购记录`} category={c} />
}

