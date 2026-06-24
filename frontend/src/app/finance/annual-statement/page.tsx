import { redirect } from 'next/navigation'
import { ANNUAL_REPORT_ROUTE } from '../../../lib/annualReport'

export default function LegacyAnnualStatementPage() {
  redirect(ANNUAL_REPORT_ROUTE)
}
