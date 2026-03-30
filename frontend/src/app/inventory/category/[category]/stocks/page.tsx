"use client"
import StocksView from '../../../_components/StocksView'
import { asInventoryCategory, categoryLabel } from '../../categoryMeta'

export default function CategoryStocksPage({ params }: any) {
  const c = asInventoryCategory(params?.category)
  if (!c) return <StocksView title="库存" />
  return <StocksView title={`${categoryLabel(c)}库存`} category={c} />
}

