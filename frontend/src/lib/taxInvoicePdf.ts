import { jsPDF } from 'jspdf'

export type GstType = 'GST_10' | 'GST_FREE' | 'INPUT_TAXED'

export type InvoicePdfCompany = {
  legal_name: string
  trading_name?: string
  abn: string
  phone?: string
  email?: string
  address_line1?: string
  address_line2?: string
  address_city?: string
  address_state?: string
  address_postcode?: string
  address_country?: string
  logo_url?: string
  bank_account_name?: string
  bank_bsb?: string
  bank_account_no?: string
  payment_note?: string
  code?: string
}

export type InvoicePdfLineItem = {
  description: string
  quantity: number
  unit_price: number
  gst_type: GstType
  tax_amount?: number
  line_subtotal?: number
  line_total?: number
}

export type InvoicePdfData = {
  invoice_no?: string
  status?: string
  issue_date?: string
  due_date?: string
  bill_to_name?: string
  bill_to_email?: string
  bill_to_address?: string
  notes?: string
  terms?: string
  currency?: string
  subtotal?: number
  tax_total?: number
  total?: number
  amount_paid?: number
  amount_due?: number
  line_items: InvoicePdfLineItem[]
}

function round2(n: any) {
  const x = Number(n || 0)
  return Math.round(x * 100) / 100
}

function fmtMoney(n: any) {
  return `$${round2(n).toFixed(2)}`
}

function computeLine(item: { quantity: number; unit_price: number; gst_type: GstType }) {
  const qty = Number(item.quantity || 0)
  const unit = Number(item.unit_price || 0)
  const lineSubtotal = round2(qty * unit)
  let tax = 0
  if (item.gst_type === 'GST_10') tax = round2(lineSubtotal * 0.1)
  const lineTotal = round2(lineSubtotal + tax)
  return { line_subtotal: lineSubtotal, tax_amount: tax, line_total: lineTotal }
}

function computeTotals(lines: Array<{ line_subtotal: number; tax_amount: number; line_total: number }>, amountPaid: any) {
  const subtotal = round2(lines.reduce((s, x) => s + Number(x.line_subtotal || 0), 0))
  const taxTotal = round2(lines.reduce((s, x) => s + Number(x.tax_amount || 0), 0))
  const total = round2(lines.reduce((s, x) => s + Number(x.line_total || 0), 0))
  const paid = round2(amountPaid)
  const due = round2(total - paid)
  return { subtotal, tax_total: taxTotal, total, amount_paid: paid, amount_due: due }
}

function companyAddress(c: InvoicePdfCompany) {
  const parts = [
    c.address_line1,
    c.address_line2,
    [c.address_city, c.address_state, c.address_postcode].filter(Boolean).join(' '),
    c.address_country,
  ].map(s => String(s || '').trim()).filter(Boolean)
  return parts
}

async function fetchAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    return await new Promise<string>((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result || ''))
      fr.onerror = () => reject(new Error('read_failed'))
      fr.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

export async function buildTaxInvoicePdf(params: { invoice: InvoicePdfData; company: InvoicePdfCompany }) {
  const { invoice, company } = params
  const doc = new jsPDF('p', 'pt', 'a4')
  const headY = 60
  const pageW = 595
  const leftX = 40
  const rightX = pageW - 40
  const title = 'TAX INVOICE'

  const status = String(invoice.status || 'draft')
  if (status === 'draft' || status === 'paid') {
    const text = status === 'paid' ? 'PAID' : 'DRAFT'
    doc.saveGraphicsState()
    doc.setTextColor(230)
    doc.setFontSize(80)
    doc.text(text, pageW / 2, 420, { align: 'center', angle: 25 as any })
    doc.restoreGraphicsState()
  }

  doc.setFontSize(26)
  doc.text(title, leftX, headY)

  doc.setFontSize(12)
  doc.text(String(company.trading_name || company.legal_name || ''), leftX, headY + 28)
  const addr = companyAddress(company)
  let y = headY + 46
  for (const line of addr.slice(0, 3)) {
    doc.text(line, leftX, y)
    y += 16
  }
  if (company.phone) { doc.text(String(company.phone), leftX, y); y += 16 }
  doc.text(`ABN : ${String(company.abn || '')}`, leftX, y)

  const logoUrl = String(company.logo_url || '').trim()
  if (logoUrl) {
    const img = await fetchAsDataUrl(logoUrl)
    if (img) {
      const fmt = img.startsWith('data:image/jpeg') || img.startsWith('data:image/jpg') ? 'JPEG'
        : img.startsWith('data:image/png') ? 'PNG'
          : ''
      try {
        if (fmt) doc.addImage(img, fmt as any, 460, 40, 96, 96)
      } catch {}
    }
  }

  const boxY = headY + 110
  doc.setDrawColor(230)
  doc.roundedRect(40, boxY, 500, 110, 6, 6)
  doc.setFontSize(11)

  const invoiceNo = String(invoice.invoice_no || '')
  const issueDate = String(invoice.issue_date || '').slice(0, 10)
  const dueDate = String(invoice.due_date || '').slice(0, 10)
  const billTo = String(invoice.bill_to_name || '').trim() || String(invoice.bill_to_email || '').trim()
  doc.text('Invoice No', leftX + 10, boxY + 22)
  doc.text(invoiceNo || '-', leftX + 120, boxY + 22)
  doc.text('Issue Date', leftX + 10, boxY + 40)
  doc.text(issueDate || '-', leftX + 120, boxY + 40)
  doc.text('Due Date', leftX + 10, boxY + 58)
  doc.text(dueDate || '-', leftX + 120, boxY + 58)
  doc.text('Bill To', leftX + 10, boxY + 76)
  doc.text(billTo || '-', leftX + 120, boxY + 76)

  doc.text('Status', leftX + 310, boxY + 22)
  doc.text(status.toUpperCase(), leftX + 400, boxY + 22)

  const computedLines = (invoice.line_items || []).map((li) => {
    const c = computeLine({ quantity: li.quantity, unit_price: li.unit_price, gst_type: li.gst_type })
    return { ...li, ...c }
  })
  const totals = computeTotals(computedLines as any, Number(invoice.amount_paid || 0))

  doc.text('Subtotal', leftX + 310, boxY + 58)
  doc.text(fmtMoney(totals.subtotal), rightX - 20, boxY + 58, { align: 'right' })
  doc.text('GST', leftX + 310, boxY + 76)
  doc.text(fmtMoney(totals.tax_total), rightX - 20, boxY + 76, { align: 'right' })

  const amountDue = status === 'paid' ? 0 : totals.amount_due
  doc.setFontSize(16)
  doc.text('Amount due', leftX + 310, boxY + 102)
  doc.setFontSize(18)
  doc.text(fmtMoney(amountDue), rightX - 20, boxY + 102, { align: 'right' })
  doc.setFontSize(11)

  let tableY = boxY + 140
  doc.setDrawColor(230)
  doc.line(leftX, tableY, rightX, tableY)
  tableY += 14
  doc.setFontSize(11)
  doc.text('Description', leftX, tableY)
  doc.text('Qty', 360, tableY)
  doc.text('Unit', 420, tableY)
  doc.text('GST', 480, tableY)
  doc.text('Total', rightX, tableY, { align: 'right' })
  tableY += 10
  doc.line(leftX, tableY, rightX, tableY)
  tableY += 16

  const maxDescWidth = 300
  for (const li of computedLines) {
    const desc = String(li.description || '').trim() || '-'
    const lines = doc.splitTextToSize(desc, maxDescWidth) as string[]
    const rowHeight = Math.max(1, lines.length) * 14
    if (tableY + rowHeight > 700) {
      doc.addPage()
      tableY = 80
    }
    doc.text(lines, leftX, tableY)
    doc.text(String(li.quantity ?? ''), 360, tableY)
    doc.text(fmtMoney(li.unit_price), 420, tableY)
    doc.text(li.gst_type === 'GST_10' ? '10%' : (li.gst_type === 'GST_FREE' ? 'Free' : 'Input'), 480, tableY)
    doc.text(fmtMoney(li.line_total), rightX, tableY, { align: 'right' })
    tableY += rowHeight
    doc.setDrawColor(245)
    doc.line(leftX, tableY, rightX, tableY)
    tableY += 12
  }

  let totalsY = tableY + 8
  if (totalsY < 720) {
    doc.setFontSize(11)
    doc.text('Subtotal', 360, totalsY)
    doc.text(fmtMoney(totals.subtotal), rightX, totalsY, { align: 'right' })
    totalsY += 16
    doc.text('GST', 360, totalsY)
    doc.text(fmtMoney(totals.tax_total), rightX, totalsY, { align: 'right' })
    totalsY += 16
    doc.text('Total', 360, totalsY)
    doc.text(fmtMoney(totals.total), rightX, totalsY, { align: 'right' })
  }

  let payY = 760
  if (company.bank_account_name || company.bank_bsb || company.bank_account_no || company.payment_note) {
    doc.setFontSize(12)
    doc.text('Payment instruction', leftX, payY)
    payY += 18
    doc.setFontSize(11)
    if (company.bank_account_name) { doc.text(`Account Name: ${String(company.bank_account_name)}`, leftX, payY); payY += 16 }
    if (company.bank_bsb) { doc.text(`BSB: ${String(company.bank_bsb)}`, leftX, payY); payY += 16 }
    if (company.bank_account_no) { doc.text(`Account No.: ${String(company.bank_account_no)}`, leftX, payY); payY += 16 }
    if (company.payment_note) { doc.text(String(company.payment_note), leftX, payY); payY += 16 }
  }

  const filename = `tax_invoice_${invoiceNo || invoice.issue_date || invoice.due_date || 'draft'}.pdf`.replace(/[^\w\-\.]+/g, '_')
  return { doc, filename }
}
