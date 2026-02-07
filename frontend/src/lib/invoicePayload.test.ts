import { describe, expect, it } from 'vitest'
import dayjs from 'dayjs'
import { buildInvoicePayload } from './invoicePayload'

describe('buildInvoicePayload', () => {
  it('builds invoice draft payload with due_date and gst types preserved', () => {
    const values = {
      company_id: 'c1',
      invoice_type: 'invoice',
      currency: 'AUD',
      issue_date: dayjs('2026-02-07'),
      due_date: dayjs('2026-02-21'),
      line_items: [
        { description: 'A', quantity: 1, unit_price: 100, gst_type: 'GST_10' },
      ],
    }
    const p: any = buildInvoicePayload(values, 'draft', 0)
    expect(p.invoice_type).toBe('invoice')
    expect(p.due_date).toBe('2026-02-21')
    expect(p.valid_until).toBeUndefined()
    expect(p.line_items[0].gst_type).toBe('GST_10')
  })

  it('builds quote draft payload with valid_until and gst hidden (GST_FREE)', () => {
    const values = {
      company_id: 'c1',
      invoice_type: 'quote',
      currency: 'AUD',
      issue_date: dayjs('2026-02-07'),
      valid_until: dayjs('2026-03-09'),
      due_date: dayjs('2026-02-21'),
      line_items: [
        { description: 'A', quantity: 2, unit_price: 50, gst_type: 'GST_10' },
      ],
    }
    const p: any = buildInvoicePayload(values, 'draft', 0)
    expect(p.invoice_type).toBe('quote')
    expect(p.valid_until).toBe('2026-03-09')
    expect(p.due_date).toBeUndefined()
    expect(p.line_items[0].gst_type).toBe('GST_FREE')
  })

  it('builds receipt draft payload with line items and gst hidden (GST_FREE)', () => {
    const values = {
      company_id: 'c1',
      invoice_type: 'receipt',
      currency: 'AUD',
      issue_date: dayjs('2026-02-07'),
      payment_method: 'cash',
      line_items: [
        { description: 'A', quantity: 1, unit_price: 100, gst_type: 'GST_10' },
        { description: 'B', quantity: 2, unit_price: 50, gst_type: 'GST_INCLUDED_10' },
      ],
    }
    const p: any = buildInvoicePayload(values, 'draft', 0)
    expect(p.invoice_type).toBe('receipt')
    expect(p.amount_paid).toBeUndefined()
    expect(p.paid_at).toBeUndefined()
    expect(p.due_date).toBeUndefined()
    expect(p.line_items).toHaveLength(2)
    expect(p.line_items[0].gst_type).toBe('GST_FREE')
    expect(p.line_items[1].gst_type).toBe('GST_FREE')
  })
})
