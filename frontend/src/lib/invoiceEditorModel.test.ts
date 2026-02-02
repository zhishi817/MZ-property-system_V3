import { describe, expect, test } from 'vitest'
import { computeLine, computeTotals, extractDiscount, normalizeLineItemsForSave, stableHash } from './invoiceEditorModel'

describe('invoiceEditorModel', () => {
  test('computeLine GST 10%', () => {
    const r = computeLine({ quantity: 2, unit_price: 50, gst_type: 'GST_10' })
    expect(r.line_subtotal).toBe(100)
    expect(r.tax_amount).toBe(10)
    expect(r.line_total).toBe(110)
  })

  test('computeLine GST free', () => {
    const r = computeLine({ quantity: 3, unit_price: 20, gst_type: 'GST_FREE' })
    expect(r.line_subtotal).toBe(60)
    expect(r.tax_amount).toBe(0)
    expect(r.line_total).toBe(60)
  })

  test('computeTotals sums correctly', () => {
    const lines = [
      { line_subtotal: 100, tax_amount: 10, line_total: 110 },
      { line_subtotal: 50, tax_amount: 0, line_total: 50 },
    ]
    const t = computeTotals(lines, 40)
    expect(t.subtotal).toBe(150)
    expect(t.tax_total).toBe(10)
    expect(t.total).toBe(160)
    expect(t.amount_paid).toBe(40)
    expect(t.amount_due).toBe(120)
  })

  test('normalizeLineItemsForSave trims and adds discount line', () => {
    const items = normalizeLineItemsForSave({
      user_items: [
        { description: '  A  ', quantity: 1, unit_price: 10, gst_type: 'GST_10' },
        { description: '', quantity: 1, unit_price: 10, gst_type: 'GST_10' },
      ],
      discount_amount: 5,
    })
    expect(items.length).toBe(2)
    expect(items[0].description).toBe('A')
    expect(items[1].description).toBe('Discount')
    expect(items[1].unit_price).toBe(-5)
    expect(items[1].gst_type).toBe('GST_FREE')
  })

  test('extractDiscount pulls discount out of line items', () => {
    const { discount_amount, user_items } = extractDiscount([
      { description: 'Service', quantity: 1, unit_price: 100, gst_type: 'GST_10' },
      { description: 'Discount', quantity: 1, unit_price: -12, gst_type: 'GST_FREE' },
    ])
    expect(discount_amount).toBe(12)
    expect(user_items.length).toBe(1)
    expect(String((user_items[0] as any).description)).toBe('Service')
  })

  test('stableHash ignores whitespace and normalizes numbers', () => {
    const a = stableHash({ name: '  X ', amt: 10, nested: { v: 1.234 } })
    const b = stableHash({ name: 'X', amt: 10.0000, nested: { v: 1.23 } })
    expect(a).toBe(b)
  })
})

