"use client"
import dynamic from 'next/dynamic'
const PropertyRevenueView = dynamic(() => import('../../properties-overview/page'), { ssr: false })
export default function PerformanceRevenuePage() {
  return <PropertyRevenueView />
}
