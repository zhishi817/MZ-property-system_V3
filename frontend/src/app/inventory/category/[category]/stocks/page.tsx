"use client"
import StocksView from '../../../_components/StocksView'
import LinenStocksDashboard from '../../../_components/LinenStocksDashboard'
import DailyStocksView from '../../../_components/DailyStocksView'
import ConsumableStocksView from '../../../_components/ConsumableStocksView'
import OtherStocksView from '../../../_components/OtherStocksView'
import { asInventoryCategory, categoryLabel } from '../../categoryMeta'

export default function CategoryStocksPage({ params }: any) {
  const c = asInventoryCategory(params?.category)
  if (!c) return <StocksView title="库存" />
  if (c === 'linen') return <LinenStocksDashboard />
  if (c === 'daily') return <DailyStocksView />
  if (c === 'consumable') return <ConsumableStocksView />
  if (c === 'other') return <OtherStocksView />
  return <StocksView title={`${categoryLabel(c)}库存`} category={c} />
}
