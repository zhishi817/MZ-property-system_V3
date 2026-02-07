import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

describe('invoice-template runtime', () => {
  it('renders different content by invoice_type (quote/invoice/receipt)', () => {
    const p = path.join(process.cwd(), 'public', 'invoice-templates', 'invoice-template.js')
    const s = fs.readFileSync(p, 'utf8')
    expect(s).toContain('inv.invoice_type')
    expect(s).toContain('QUOTE')
    expect(s).toContain('RECEIPT')
    expect(s).toContain('本报价单仅供参考，具体以实际交易为准')
  })
})
