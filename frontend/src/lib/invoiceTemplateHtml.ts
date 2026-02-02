import { API_BASE } from './api'

export type InvoiceTemplateKey = 'classic' | 'modern'

export type InvoiceTemplateData = {
  invoice: any
  company: any
}

export function normalizeAssetUrl(url: string): string {
  const u = String(url || '')
  if (!u) return ''
  if (/^https?:\/\//i.test(u)) return u
  if (u.startsWith('/')) return `${API_BASE}${u}`
  return u
}

export function buildInvoiceTemplateHtml(params: { template: InvoiceTemplateKey; data: InvoiceTemplateData }) {
  const template = params.template || 'classic'
  const data = params.data || { invoice: { line_items: [] }, company: {} }
  const safeData = {
    invoice: { ...(data.invoice || {}) },
    company: { ...(data.company || {}) },
  }
  if (safeData.company && safeData.company.logo_url) {
    safeData.company.logo_url = normalizeAssetUrl(String(safeData.company.logo_url || ''))
  }
  const json = JSON.stringify(safeData).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Invoice Preview</title>
    <link rel="stylesheet" href="/invoice-templates/invoice-template.css" />
  </head>
  <body>
    <div id="invoice-root"></div>
    <script>
      window.__INVOICE_TEMPLATE__ = ${JSON.stringify(template)};
      window.__INVOICE_DATA__ = ${json};
    </script>
    <script src="/invoice-templates/invoice-template.js"></script>
  </body>
</html>`
}
