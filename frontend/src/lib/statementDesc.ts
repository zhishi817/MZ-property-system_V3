"use client"

export type StatementLang = 'zh' | 'en'

export function normalizeStatementPunctuation(input: string, lang: StatementLang, preferredJoiner?: string): string {
  let s = String(input || '').trim()
  if (!s) return ''

  if (lang === 'en') {
    s = s.replace(/[、，]/g, ',')
    s = s.replace(/\s*,\s*/g, ', ')
    s = s.replace(/,\s*,+/g, ', ')
    s = s.replace(/\s*\/\s*/g, ' / ')
    s = s.replace(/\s{2,}/g, ' ')
  } else {
    const preferSlash = /\//.test(String(preferredJoiner || ''))
    if (preferSlash) {
      s = s.replace(/[、，]/g, '/')
      s = s.replace(/\s*\/\s*/g, '/')
      s = s.replace(/\/{2,}/g, '/')
    } else {
      s = s.replace(/\s*、\s*/g, '、')
    }
    s = s.replace(/\s{2,}/g, ' ')
  }

  return s.trim()
}

export function truncateWithEllipsis(input: string, maxChars: number): { text: string; truncated: boolean } {
  const s = String(input || '')
  if (!s) return { text: '', truncated: false }
  if (maxChars <= 0) return { text: '…', truncated: true }
  const arr = Array.from(s)
  if (arr.length <= maxChars) return { text: s, truncated: false }
  const head = arr.slice(0, Math.max(0, maxChars)).join('')
  return { text: `${head}…`, truncated: true }
}

export function formatStatementDesc(input: {
  items: string[]
  lang: StatementLang
  maxChars?: number
  joiner?: string
}): { text: string; full: string; truncated: boolean } {
  const uniq = Array.from(new Set((input.items || []).map(x => String(x || '').trim()).filter(Boolean)))
  const joiner = typeof input.joiner === 'string' ? input.joiner : (input.lang === 'en' ? ', ' : '、')
  const fullRaw = uniq.join(joiner)
  const full = normalizeStatementPunctuation(fullRaw, input.lang, joiner)
  if (!full) return { text: '-', full: '', truncated: false }
  if (typeof input.maxChars !== 'number' || !Number.isFinite(input.maxChars)) {
    return { text: full, full, truncated: false }
  }
  const { text: truncatedText, truncated } = truncateWithEllipsis(full, input.maxChars)
  const finalText = truncatedText
    .replace(/\s*,\s*…$/, '…')
    .replace(/\s*\/\s*…$/, '…')
    .trim()
  return { text: finalText || '-', full, truncated }
}
