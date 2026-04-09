"use client"

import DailyItemsPriceListView from '../../inventory/_components/DailyItemsPriceListView'

export default function OnboardingPricesPage() {
  return <DailyItemsPriceListView title="日用品价格表" endpointPrefix="/onboarding" managePerm="onboarding.manage" />
}
