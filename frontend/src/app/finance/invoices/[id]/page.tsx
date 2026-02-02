import { InvoiceEditor } from '../_components/InvoiceEditor'

export default function EditInvoicePage({ params }: { params: { id: string } }) {
  return <InvoiceEditor mode="edit" invoiceId={String(params?.id || '')} />
}
