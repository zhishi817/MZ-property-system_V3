/* Invoice Template Runtime: HTML/CSS/JS + print-ready A4 */
(function () {
  function round2(n) {
    var x = Number(n || 0)
    return Math.round(x * 100) / 100
  }

  function formatMoney(n) {
    var x = Number(n || 0)
    if (!isFinite(x)) x = 0
    var s = round2(x).toFixed(2)
    var parts = s.split('.')
    var intPart = parts[0]
    var decPart = parts[1]
    var sign = ''
    if (intPart[0] === '-') { sign = '-'; intPart = intPart.slice(1) }
    var out = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return sign + out + '.' + decPart
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function computeLine(item) {
    var qty = Number(item.quantity || 0)
    var unit = Number(item.unit_price || 0)
    var sub = round2(qty * unit)
    var tax = 0
    if (String(item.gst_type || 'GST_10') === 'GST_10') tax = round2(sub * 0.1)
    var total = round2(sub + tax)
    return { line_subtotal: sub, tax_amount: tax, line_total: total }
  }

  function computeTotals(lines, paid) {
    var subtotal = 0, taxTotal = 0, total = 0
    for (var i = 0; i < lines.length; i++) {
      subtotal += Number(lines[i].line_subtotal || 0)
      taxTotal += Number(lines[i].tax_amount || 0)
      total += Number(lines[i].line_total || 0)
    }
    subtotal = round2(subtotal)
    taxTotal = round2(taxTotal)
    total = round2(total)
    var amountPaid = round2(paid)
    var due = round2(total - amountPaid)
    return { subtotal: subtotal, tax_total: taxTotal, total: total, amount_paid: amountPaid, amount_due: due }
  }

  function normalizeData(data) {
    var inv = data && data.invoice ? data.invoice : {}
    var company = data && data.company ? data.company : {}
    var items = Array.isArray(inv.line_items) ? inv.line_items : []
    var computed = items.map(function (x) {
      var c = computeLine(x)
      return Object.assign({}, x, c)
    })
    var totals = computeTotals(computed, inv.amount_paid || 0)
    var status = String(inv.status || 'draft')
    if (status === 'paid') totals.amount_due = 0
    return { inv: inv, company: company, items: computed, totals: totals }
  }

  function renderClassic(data) {
    var d = normalizeData(data)
    var inv = d.inv, company = d.company, items = d.items, totals = d.totals

    var addr = [
      company.address_line1,
      company.address_line2,
      [company.address_city, company.address_state, company.address_postcode].filter(Boolean).join(' '),
      company.address_country
    ].filter(Boolean).join('\n')

    var billTo = [
      inv.bill_to_name,
      inv.bill_to_address,
      inv.bill_to_email
    ].filter(Boolean).join('\n')

    var rows = items.map(function (x) {
      return (
        '<tr>' +
        '<td class="desc">' + escapeHtml(x.description || '-') + '</td>' +
        '<td class="nowrap num">' + escapeHtml(String(x.quantity == null ? '' : x.quantity)) + '</td>' +
        '<td class="nowrap num">$' + escapeHtml(formatMoney(x.unit_price || 0)) + '</td>' +
        '<td class="nowrap num">$' + escapeHtml(formatMoney(x.line_total || 0)) + '</td>' +
        '</tr>'
      )
    }).join('')

    var watermark = ''
    var st = String(inv.status || 'draft')
    if (st === 'draft') watermark = '<div class="inv-watermark">DRAFT</div>'
    if (st === 'paid') watermark = '<div class="inv-watermark">PAID</div>'

    var payInst = [
      (company.bank_account_name ? ('Account Name: ' + company.bank_account_name) : ''),
      (company.bank_bsb ? ('BSB: ' + company.bank_bsb) : ''),
      (company.bank_account_no ? ('Account No.: ' + company.bank_account_no) : ''),
      (company.payment_note ? String(company.payment_note) : '')
    ].filter(Boolean).join('\n')

    var badgeCls = st === 'paid' ? 'inv-badge is-paid' : 'inv-badge'

    return (
      '<div class="inv-preview-wrap">' +
      '<div class="inv-sheet">' +
      '<div class="inv-page inv-page-wrap">' +
      watermark +
      '<div class="inv-header">' +
      '<div class="inv-logo">' +
      (company.logo_url ? ('<img alt="logo" src="' + escapeHtml(company.logo_url) + '"/>') : '') +
      '</div>' +
      '<div class="inv-title">' +
      '<h1>INVOICE</h1>' +
      '<div style="margin-top:6px"><span class="' + badgeCls + '">' + escapeHtml(String(st).toUpperCase()) + '</span></div>' +
      '<div class="company">' +
      escapeHtml(company.legal_name || '') + '\n' +
      escapeHtml(addr) + '\n' +
      (company.phone ? escapeHtml(company.phone) + '\n' : '') +
      (company.email ? escapeHtml(company.email) + '\n' : '') +
      'ABN : ' + escapeHtml(company.abn || '') +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="inv-band">' +
      '<div>' +
      '<h3>BILL TO</h3>' +
      '<div class="text" style="white-space:pre-wrap; font-size:12px; color:rgba(17,24,39,0.75)">' + escapeHtml(billTo || '-') + '</div>' +
      '</div>' +
      '<div>' +
      '<div class="meta">' +
      '<div class="k">INVOICE #</div><div class="v">' + escapeHtml(inv.invoice_no || '-') + '</div>' +
      '<div class="k">Date</div><div class="v">' + escapeHtml((inv.issue_date || '').slice(0, 10) || '-') + '</div>' +
      '<div class="k">Due date</div><div class="v">' + escapeHtml((inv.due_date || '').slice(0, 10) || '-') + '</div>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<table class="inv-table">' +
      '<colgroup>' +
      '<col style="width:58%"/>' +
      '<col style="width:14%"/>' +
      '<col style="width:14%"/>' +
      '<col style="width:14%"/>' +
      '</colgroup>' +
      '<thead><tr>' +
      '<th>Item</th><th class="num">Quantity</th><th class="num">Price</th><th class="num">Amount</th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table>' +
      '<div class="inv-footer-grid">' +
      '<div class="inv-placeholder"></div>' +
      '<div>' +
      '<table class="inv-summary">' +
      '<tr><td>Subtotal</td><td>$' + escapeHtml(formatMoney(totals.subtotal)) + '</td></tr>' +
      '<tr><td>TAX included(10%)</td><td>$' + escapeHtml(formatMoney(totals.tax_total)) + '</td></tr>' +
      '<tr><td class="strong">Total</td><td class="strong">$' + escapeHtml(formatMoney(totals.total)) + '</td></tr>' +
      '</table>' +
      '<div class="inv-amount-due">' +
      '<div class="label">Amount Due</div>' +
      '<div class="value">$' + escapeHtml(formatMoney(totals.amount_due)) + '<span class="cur">' + escapeHtml(inv.currency || 'AUD') + '</span></div>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="inv-card inv-payment-bottom">' +
      '<h3>Payment Instructions</h3>' +
      '<div class="text">' + escapeHtml(payInst || '-') + '</div>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '</div>'
    )
  }

  function renderModern(data) {
    var d = normalizeData(data)
    var inv = d.inv, company = d.company, items = d.items, totals = d.totals
    var rows = items.map(function (x) {
      return (
        '<tr>' +
        '<td class="desc">' + escapeHtml(x.description || '-') + '</td>' +
        '<td class="nowrap num">' + escapeHtml(String(x.quantity == null ? '' : x.quantity)) + '</td>' +
        '<td class="nowrap num">$' + escapeHtml(formatMoney(x.unit_price || 0)) + '</td>' +
        '<td class="nowrap num">$' + escapeHtml(formatMoney(x.line_total || 0)) + '</td>' +
        '</tr>'
      )
    }).join('')
    var payInst = [
      (company.bank_account_name ? ('Account Name: ' + company.bank_account_name) : ''),
      (company.bank_bsb ? ('BSB: ' + company.bank_bsb) : ''),
      (company.bank_account_no ? ('Account No.: ' + company.bank_account_no) : ''),
      (company.payment_note ? String(company.payment_note) : '')
    ].filter(Boolean).join('\n')
    return (
      '<div class="inv-preview-wrap">' +
      '<div class="inv-sheet">' +
      '<div class="inv-page inv-page-wrap">' +
      '<div class="inv-header" style="border-bottom:1px solid rgba(0,82,217,0.25)">' +
      '<div class="inv-logo">' +
      (company.logo_url ? ('<img alt="logo" src="' + escapeHtml(company.logo_url) + '"/>') : '') +
      '<div style="font-weight:800; color:var(--inv-primary); font-size:16px">' + escapeHtml(company.legal_name || '') + '</div>' +
      '</div>' +
      '<div class="inv-title">' +
      '<h1 style="color:var(--inv-primary)">TAX INVOICE</h1>' +
      '<div class="company">' +
      'Invoice # ' + escapeHtml(inv.invoice_no || '-') + '\n' +
      'Date ' + escapeHtml((inv.issue_date || '').slice(0, 10) || '-') + '\n' +
      'Due ' + escapeHtml((inv.due_date || '').slice(0, 10) || '-') +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="inv-band" style="background:rgba(0,82,217,0.05)">' +
      '<div><h3>BILL TO</h3><div class="text" style="white-space:pre-wrap; font-size:12px; color:rgba(17,24,39,0.75)">' +
      escapeHtml([inv.bill_to_name, inv.bill_to_address, inv.bill_to_email].filter(Boolean).join('\n') || '-') +
      '</div></div>' +
      '<div><h3>ISSUER</h3><div class="text" style="white-space:pre-wrap">' +
      escapeHtml([company.abn ? ('ABN: ' + company.abn) : '', company.email, company.phone].filter(Boolean).join('\n')) +
      '</div></div>' +
      '</div>' +
      '<table class="inv-table">' +
      '<colgroup>' +
      '<col style="width:58%"/>' +
      '<col style="width:14%"/>' +
      '<col style="width:14%"/>' +
      '<col style="width:14%"/>' +
      '</colgroup>' +
      '<thead><tr>' +
      '<th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table>' +
      '<div class="inv-footer-grid">' +
      '<div class="inv-placeholder"></div>' +
      '<div>' +
      '<div class="inv-card" style="border-color:rgba(0,82,217,0.25)">' +
      '<table class="inv-summary">' +
      '<tr><td>Subtotal</td><td>$' + escapeHtml(formatMoney(totals.subtotal)) + '</td></tr>' +
      '<tr><td>GST (10%)</td><td>$' + escapeHtml(formatMoney(totals.tax_total)) + '</td></tr>' +
      '<tr><td class="strong">Total</td><td class="strong">$' + escapeHtml(formatMoney(totals.total)) + '</td></tr>' +
      '</table>' +
      '<div class="inv-amount-due" style="background:rgba(0,82,217,0.06)">' +
      '<div class="label">Amount Due</div>' +
      '<div class="value" style="color:var(--inv-primary)">$' + escapeHtml(formatMoney(totals.amount_due)) + '<span class="cur">' + escapeHtml(inv.currency || 'AUD') + '</span></div>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="inv-card inv-payment-bottom"><h3>Payment Instructions</h3><div class="text">' + escapeHtml(payInst || '-') + '</div></div>' +
      '</div></div></div>'
    )
  }

  function render(template, data) {
    if (template === 'modern') return renderModern(data)
    return renderClassic(data)
  }

  function boot() {
    var root = document.getElementById('invoice-root')
    if (!root) return
    var data = window.__INVOICE_DATA__ || {}
    var template = (window.__INVOICE_TEMPLATE__ || 'classic')
    root.innerHTML = render(template, data)
  }

  window.InvoiceTemplate = {
    render: render,
    formatMoney: formatMoney,
    boot: boot
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
