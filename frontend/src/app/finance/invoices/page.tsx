import { Suspense } from 'react'
import InvoicesCenterClient from './InvoicesCenterClient'

export default function InvoicesListPage() {
  return (
    <Suspense fallback={<div style={{ padding: 16 }}>加载中...</div>}>
      <InvoicesCenterClient />
    </Suspense>
  )
}
