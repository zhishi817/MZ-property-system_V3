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

  function splitItemDesc(raw) {
    var s0 = String(raw == null ? '' : raw).replace(/\r\n/g, '\n').trim()
    if (!s0) return { title: '-', content: '' }
    var parts = s0.split('\n')
    var title = String(parts.shift() || '').trim()
    var content = parts.join('\n').trim()
    if (!title && content) {
      var p2 = content.split('\n')
      title = String(p2.shift() || '').trim()
      content = p2.join('\n').trim()
    }
    return { title: title || '-', content: content }
  }

  function renderItemDescHtml(raw) {
    var d = splitItemDesc(raw)
    var html = '<div class="li-title">' + escapeHtml(d.title || '-') + '</div>'
    if (d.content) {
      var c = escapeHtml(d.content).replace(/\n/g, '<br/>')
      html += '<div class="li-content">' + c + '</div>'
    }
    return html
  }

  function renderLinesHtml(raw) {
    var s0 = String(raw == null ? '' : raw).replace(/\r\n/g, '\n')
    var lines = s0.split('\n').map(function (s) { return String(s || '').trim() }).filter(Boolean)
    if (!lines.length) lines = ['-']
    return lines.map(function (s) { return '<div class="inv-line">' + escapeHtml(s) + '</div>' }).join('')
  }

  function computeLine(item) {
    var qty = Number(item.quantity || 0)
    var unit = Number(item.unit_price || 0)
    var base = round2(qty * unit)
    var t = String(item.gst_type || 'GST_10')
    if (t === 'GST_INCLUDED_10') {
      var taxInc = round2(base / 11)
      var subInc = round2(base - taxInc)
      return { line_subtotal: subInc, tax_amount: taxInc, line_total: base }
    }
    var tax = 0
    if (t === 'GST_10') tax = round2(base * 0.1)
    var total = round2(base + tax)
    return { line_subtotal: base, tax_amount: tax, line_total: total }
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

  function gstLabel(items) {
    var hasInc = false, hasExc = false
    for (var i = 0; i < items.length; i++) {
      var t = String(items[i] && items[i].gst_type || '')
      if (t === 'GST_INCLUDED_10') hasInc = true
      else if (t === 'GST_10') hasExc = true
    }
    if (hasInc && !hasExc) return 'GST included'
    if (hasExc && !hasInc) return 'GST excluded'
    if (!hasInc && !hasExc) return 'No GST'
    return 'GST'
  }

  function payStatus(inv, totals) {
    var st = String(inv && inv.status || '')
    if (st === 'paid') return 'PAID'
    if (st === 'void') return 'VOID'
    if (st === 'refunded') return 'REFUNDED'
    if (Number(totals && totals.amount_due || 0) <= 0 && Number(totals && totals.total || 0) > 0) return 'PAID'
    return 'UNPAID'
  }

  function payMethodText(inv) {
    var m = String(inv && inv.payment_method || '').trim()
    var note = String(inv && inv.payment_method_note || '').trim()
    if (!m && !note) return ''
    if (!m) return note
    if (!note) return m
    return m + ' - ' + note
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
    var invType = String(inv && inv.invoice_type || 'invoice')
    var titleText = invType === 'quote' ? 'QUOTE' : (invType === 'receipt' ? 'RECEIPT' : 'INVOICE')
    var noLabel = invType === 'quote' ? 'QUOTE #' : (invType === 'receipt' ? 'RECEIPT #' : 'INVOICE #')
    var dateLabel = invType === 'receipt' ? 'Paid date' : 'Date'
    var thirdLabel = invType === 'quote' ? 'Valid until' : (invType === 'receipt' ? 'Paid via' : 'Due date')
    var thirdValue = invType === 'quote'
      ? ((inv.valid_until || '').slice(0, 10) || '-')
      : (invType === 'receipt'
        ? (payMethodText(inv) || '-')
        : ((inv.due_date || '').slice(0, 10) || '-'))
    var amountLabel = invType === 'receipt' ? 'Amount Received' : (invType === 'quote' ? 'Total' : 'Amount Due')
    var amountValue = invType === 'invoice' ? totals.amount_due : totals.total

    var addr = [
      company.address_line1,
      company.address_line2,
      [company.address_city, company.address_state, company.address_postcode].filter(Boolean).join(' '),
      company.address_country
    ].filter(Boolean).join('\n')

    var companyLines = []
    if (company.legal_name) companyLines.push(String(company.legal_name))
    if (addr) {
      var addrLines = String(addr).split('\n').map(function (s) { return String(s || '').trim() }).filter(Boolean)
      companyLines = companyLines.concat(addrLines)
    }
    if (company.phone) companyLines.push(String(company.phone))
    if (company.email) companyLines.push(String(company.email))
    if (company.abn) companyLines.push('ABN: ' + String(company.abn))
    var companyHtml = companyLines.length
      ? companyLines.map(function (s) {
        var cls = 'company-line'
        if (String(s).indexOf('@') >= 0) cls += ' is-email'
        return '<div class="' + cls + '">' + escapeHtml(s) + '</div>'
      }).join('')
      : '<div class="company-line">-</div>'

    var billTo = [
      inv.bill_to_name,
      inv.bill_to_address,
      inv.bill_to_phone,
      inv.bill_to_abn ? ('ABN: ' + inv.bill_to_abn) : null,
      inv.bill_to_email
    ].filter(Boolean).join('\n')

    var rows = items.map(function (x) {
      return (
        '<tr>' +
        '<td class="desc">' + renderItemDescHtml(x.description) + '</td>' +
        '<td class="nowrap num">' + escapeHtml(String(x.quantity == null ? '' : x.quantity)) + '</td>' +
        '<td class="nowrap num">$' + escapeHtml(formatMoney(x.unit_price || 0)) + '</td>' +
        '<td class="nowrap num">$' + escapeHtml(formatMoney(x.line_total || 0)) + '</td>' +
        '</tr>'
      )
    }).join('')

    var watermark = ''
    var st = String(inv.status || 'draft')
    if (st === 'draft') watermark = '<div class="inv-watermark"><span>DRAFT</span></div>'
    if (st === 'paid') watermark = '<div class="inv-watermark"><span>PAID</span></div>'

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
      '<table class="inv-header-table" cellspacing="0" cellpadding="0"><tr>' +
      '<td class="inv-logo-cell">' +
      '<div class="inv-logo-box">' +
      (company.logo_url ? ('<img alt="logo" crossorigin="anonymous" referrerpolicy="no-referrer" src="' + escapeHtml(company.logo_url) + '"/>') : '') +
      '</div>' +
      '</td>' +
      '<td class="inv-info-cell">' +
      '<div class="inv-doc-title">' +
      '<h1>' + escapeHtml(titleText) + '</h1>' +
      '<div style="margin-top:6px"><span class="' + badgeCls + '">' + escapeHtml(String(st).toUpperCase()) + '</span></div>' +
      '</div>' +
      '<div class="inv-company-td">' + companyHtml + '</div>' +
      '</td>' +
      '</tr></table>' +
      '<div class="inv-band">' +
      '<table class="inv-band-table" cellspacing="0" cellpadding="0"><tr>' +
      '<td class="inv-band-left">' +
      '<h3>BILL TO</h3>' +
      '<div class="text inv-lines" style="font-size:12px; color:rgba(17,24,39,0.75); white-space:normal; word-wrap:break-word;">' + renderLinesHtml(billTo || '-') + '</div>' +
      '</td>' +
      '<td class="inv-band-right">' +
      '<table class="inv-meta-table" cellspacing="0" cellpadding="0">' +
      '<tr><td class="k">' + escapeHtml(noLabel) + '</td><td class="v">' + escapeHtml(inv.invoice_no || '-') + '</td></tr>' +
      '<tr><td class="k">' + escapeHtml(dateLabel) + '</td><td class="v">' + escapeHtml((inv.issue_date || '').slice(0, 10) || '-') + '</td></tr>' +
      (invType === 'receipt' ? '' : ('<tr><td class="k">' + escapeHtml(thirdLabel) + '</td><td class="v">' + escapeHtml(thirdValue) + '</td></tr>')) +
      '</table>' +
      '</td>' +
      '</tr></table>' +
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
      '<table class="inv-footer-table" cellspacing="0" cellpadding="0"><tr>' +
      '<td class="inv-footer-left"></td>' +
      '<td class="inv-footer-right">' +
      '<div class="inv-card inv-summary-card">' +
      '<table class="inv-summary">' +
      '<tr><td>Subtotal</td><td>$' + escapeHtml(formatMoney(totals.subtotal)) + '</td></tr>' +
      (invType === 'invoice' ? ('<tr><td>' + escapeHtml(gstLabel(items)) + '</td><td>$' + escapeHtml(formatMoney(totals.tax_total)) + '</td></tr>') : '') +
      '<tr><td class="strong">Total</td><td class="strong">$' + escapeHtml(formatMoney(totals.total)) + '</td></tr>' +
      '</table>' +
      '<div class="inv-amount-due">' +
      '<table class="inv-amount-table" cellspacing="0" cellpadding="0"><tr>' +
      '<td class="label">' + escapeHtml(amountLabel) + '</td>' +
      '<td class="value">$' + escapeHtml(formatMoney(amountValue)) + '<span class="cur">' + escapeHtml(inv.currency || 'AUD') + '</span></td>' +
      '</tr></table>' +
      '<div class="inv-pay-status">' + escapeHtml(payStatus(inv, totals)) + '</div>' +
      ((invType === 'invoice' && payMethodText(inv)) ? ('<div class="inv-pay-method">' + escapeHtml(payMethodText(inv)) + '</div>') : '') +
      '</div>' +
      '</div>' +
      '</td>' +
      '</tr></table>' +
      (invType === 'invoice'
        ? ('<div class="inv-card inv-payment-bottom"><h3>Payment&nbsp;Instructions</h3><div class="text">' + escapeHtml(payInst || '-') + '</div></div>')
        : '') +
      (invType === 'quote' ? ('<div class="inv-disclaimer">本报价单仅供参考，具体以实际交易为准</div>') : '') +
      '</div>' +
      '</div>' +
      '</div>'
    )
  }

  function renderModern(data) {
    var d = normalizeData(data)
    var inv = d.inv, company = d.company, items = d.items, totals = d.totals
    var invType = String(inv && inv.invoice_type || 'invoice')
    var titleText = invType === 'quote' ? 'QUOTE' : (invType === 'receipt' ? 'RECEIPT' : 'TAX INVOICE')
    var noLabel = invType === 'quote' ? 'Quote # ' : (invType === 'receipt' ? 'Receipt # ' : 'Invoice # ')
    var dateLabel = invType === 'receipt' ? 'Paid date ' : 'Date '
    var thirdLabel = invType === 'quote' ? 'Valid until ' : (invType === 'receipt' ? 'Paid via ' : 'Due ')
    var thirdValue = invType === 'quote'
      ? ((inv.valid_until || '').slice(0, 10) || '-')
      : (invType === 'receipt'
        ? (payMethodText(inv) || '-')
        : ((inv.due_date || '').slice(0, 10) || '-'))
    var amountLabel = invType === 'receipt' ? 'Amount Received' : (invType === 'quote' ? 'Total' : 'Amount Due')
    var amountValue = invType === 'invoice' ? totals.amount_due : totals.total
    var rows = items.map(function (x) {
      return (
        '<tr>' +
        '<td class="desc">' + renderItemDescHtml(x.description) + '</td>' +
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
      (company.logo_url ? ('<img alt="logo" crossorigin="anonymous" referrerpolicy="no-referrer" src="' + escapeHtml(company.logo_url) + '"/>') : '') +
      '<div style="font-weight:800; color:var(--inv-primary); font-size:16px">' + escapeHtml(company.legal_name || '') + '</div>' +
      '</div>' +
      '<div class="inv-title">' +
      '<h1 style="color:var(--inv-primary)">' + escapeHtml(titleText) + '</h1>' +
      '<div class="company">' +
      escapeHtml(noLabel) + escapeHtml(inv.invoice_no || '-') + '\n' +
      escapeHtml(dateLabel) + escapeHtml((inv.issue_date || '').slice(0, 10) || '-') +
      (invType === 'receipt' ? '' : ('\n' + escapeHtml(thirdLabel) + escapeHtml(thirdValue))) +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="inv-band" style="background:rgba(0,82,217,0.05)">' +
      '<table class="inv-band-table" cellspacing="0" cellpadding="0"><tr>' +
      '<td class="inv-band-left"><h3>BILL TO</h3><div class="text inv-lines" style="font-size:12px; color:rgba(17,24,39,0.75); white-space:normal; word-wrap:break-word;">' +
      renderLinesHtml([inv.bill_to_name, inv.bill_to_address, inv.bill_to_phone, inv.bill_to_abn ? ('ABN: ' + inv.bill_to_abn) : null, inv.bill_to_email].filter(Boolean).join('\n') || '-') +
      '</div></td>' +
      '<td class="inv-band-right"><h3>ISSUER</h3><div class="text inv-lines" style="white-space:normal; word-wrap:break-word;">' +
      renderLinesHtml([company.abn ? ('ABN: ' + company.abn) : '', company.email, company.phone].filter(Boolean).join('\n') || '-') +
      '</div></td>' +
      '</tr></table>' +
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
      '<div class="inv-footer-right">' +
      '<div class="inv-card inv-summary-card" style="border-color:rgba(0,82,217,0.25)">' +
      '<table class="inv-summary">' +
      '<tr><td>Subtotal</td><td>$' + escapeHtml(formatMoney(totals.subtotal)) + '</td></tr>' +
      (invType === 'invoice' ? ('<tr><td>' + escapeHtml(gstLabel(items)) + '</td><td>$' + escapeHtml(formatMoney(totals.tax_total)) + '</td></tr>') : '') +
      '<tr><td class="strong">Total</td><td class="strong">$' + escapeHtml(formatMoney(totals.total)) + '</td></tr>' +
      '</table>' +
      '<div class="inv-amount-due" style="background:rgba(0,82,217,0.06)">' +
      '<div class="label">' + escapeHtml(amountLabel) + '</div>' +
      '<div class="value" style="color:var(--inv-primary)">$' + escapeHtml(formatMoney(amountValue)) + '<span class="cur">' + escapeHtml(inv.currency || 'AUD') + '</span><div class="inv-pay-status">' + escapeHtml(payStatus(inv, totals)) + '</div>' +
      ((invType === 'invoice' && payMethodText(inv)) ? ('<div class="inv-pay-method">' + escapeHtml(payMethodText(inv)) + '</div>') : '') +
      '</div>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '</div>' +
      (invType === 'invoice'
        ? ('<div class="inv-card inv-payment-bottom"><h3>Payment&nbsp;Instructions</h3><div class="text">' + escapeHtml(payInst || '-') + '</div></div>')
        : '') +
      (invType === 'quote' ? ('<div class="inv-disclaimer">本报价单仅供参考，具体以实际交易为准</div>') : '') +
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
