import { describe, expect, test } from 'vitest'
import { buildInvoiceTemplateHtml, normalizeAssetUrl } from './invoiceTemplateHtml'

describe('invoiceTemplateHtml', () => {
  test('normalizeAssetUrl keeps absolute urls', () => {
    expect(normalizeAssetUrl('https://example.com/a.png')).toBe('https://example.com/a.png')
  })

  test('buildInvoiceTemplateHtml injects template and data safely', () => {
    const html = buildInvoiceTemplateHtml({
      template: 'classic',
      data: {
        invoice: { invoice_no: 'INV-1', status: 'draft', line_items: [{ description: '<b>x</b>', quantity: 1, unit_price: 1, gst_type: 'GST_10' }] },
        company: { legal_name: 'MZ', abn: '123', logo_url: '/uploads/logo.png' }
      }
    })
    expect(html).toContain('window.__INVOICE_TEMPLATE__')
    expect(html).toContain('classic')
    expect(html).toContain('INV-1')
    expect(html).toContain('\\u003c')
  })
})

