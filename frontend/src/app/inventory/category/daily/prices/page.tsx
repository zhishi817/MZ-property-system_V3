"use client"

import DailyItemsPriceListView from '../../../_components/DailyItemsPriceListView'

export default function DailyPriceListPage() {
  return <DailyItemsPriceListView title="日用品价格表" endpointPrefix="/inventory" managePerm="inventory.po.manage" />
}
