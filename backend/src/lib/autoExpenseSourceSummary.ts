function toSummaryText(v: any, maxLen = 260): string {
  try {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'string' ? v.trim() : JSON.stringify(v)
    return String(s || '').trim().slice(0, maxLen)
  } catch {
    return String(v || '').trim().slice(0, maxLen)
  }
}

function parseMaybeJson(v: any): any {
  if (typeof v !== 'string') return v
  const s = v.trim()
  if (!s) return ''
  const head = s[0]
  if (head !== '{' && head !== '[') return s
  try { return JSON.parse(s) } catch { return s }
}

function pickSummaryFromDetails(detailsRaw: any): string {
  const v = parseMaybeJson(detailsRaw)
  if (!v) return ''
  if (Array.isArray(v)) {
    for (const it of v) {
      const c = toSummaryText((it as any)?.content)
      if (c) return c
      const i = toSummaryText((it as any)?.item)
      if (i) return i
      const s = toSummaryText(it)
      if (s) return s
    }
    return ''
  }
  if (typeof v === 'object') {
    const c = toSummaryText((v as any)?.content)
    if (c) return c
    const i = toSummaryText((v as any)?.item)
    if (i) return i
  }
  return toSummaryText(v)
}

export function maintenanceSourceSummary(row: any): string {
  const invoiceDesc = toSummaryText(row?.invoice_description_en)
  if (invoiceDesc) return invoiceDesc
  const detailsSummary = pickSummaryFromDetails(row?.details)
  if (detailsSummary) return detailsSummary
  const repairNotes = toSummaryText(row?.repair_notes)
  if (repairNotes) return repairNotes
  return ''
}

export function deepCleaningSourceSummary(row: any): string {
  const invoiceDesc = toSummaryText(row?.invoice_description_en)
  if (invoiceDesc) return invoiceDesc
  const projectDesc = toSummaryText(row?.project_desc)
  if (projectDesc) return projectDesc
  const detailsSummary = pickSummaryFromDetails(row?.details)
  if (detailsSummary) return detailsSummary
  return toSummaryText(row?.notes)
}

export function dailyNecessitiesSourceSummary(row: any): string {
  const invoiceDesc = toSummaryText(row?.invoice_description_en)
  if (invoiceDesc) return invoiceDesc
  const itemName = toSummaryText(row?.item_name, 120)
  const quantity = Number(row?.quantity || 0)
  const note = toSummaryText(row?.note, 180)
  const parts = [
    itemName ? `日用品更换：${itemName}` : '日用品更换',
    Number.isFinite(quantity) && quantity > 0 ? `数量 ${Math.trunc(quantity)}` : '',
    note,
  ].filter(Boolean)
  return parts.join('；').slice(0, 260)
}
