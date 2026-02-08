"use client"

import dayjs from 'dayjs'
import type { GstType, InvoiceLineItemInput } from './invoiceEditorModel'
import { normalizeLineItemsForSave } from './invoiceEditorModel'

export function buildInvoicePayload(values: any, status: string, discountAmount: number) {
  void status

  const t = String(values.invoice_type || 'invoice')
  const isQuote = t === 'quote'
  const isReceipt = t === 'receipt'
  const userItems = (values.line_items || []) as InvoiceLineItemInput[]
  const items0 = normalizeLineItemsForSave({ user_items: userItems, discount_amount: discountAmount })
  const items = (isQuote || isReceipt) ? items0.map((x) => ({ ...x, gst_type: 'GST_FREE' as GstType })) : items0

  return {
    company_id: values.company_id,
    invoice_type: t,
    currency: values.currency || 'AUD',
    customer_id: values.customer_id || undefined,
    bill_to_name: values.bill_to_name || undefined,
    bill_to_email: values.bill_to_email || undefined,
    bill_to_phone: values.bill_to_phone || undefined,
    bill_to_abn: values.bill_to_abn || undefined,
    bill_to_address: values.bill_to_address || undefined,
    payment_method: values.payment_method || undefined,
    payment_method_note: values.payment_method_note || undefined,
    notes: values.notes || undefined,
    terms: values.terms || undefined,
    issue_date: values.issue_date ? dayjs(values.issue_date).format('YYYY-MM-DD') : undefined,
    due_date: (!isQuote && !isReceipt && values.due_date) ? dayjs(values.due_date).format('YYYY-MM-DD') : undefined,
    valid_until: (isQuote && values.valid_until) ? dayjs(values.valid_until).format('YYYY-MM-DD') : undefined,
    line_items: items.map((x) => ({ description: x.description, quantity: Number(x.quantity), unit_price: Number(x.unit_price), gst_type: x.gst_type })),
  }
}
