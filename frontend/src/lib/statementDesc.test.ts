import { describe, expect, it } from 'vitest'
import { formatStatementDesc, normalizeStatementPunctuation, truncateWithEllipsis } from './statementDesc'

describe('normalizeStatementPunctuation', () => {
  it('keeps Chinese punctuation in zh mode', () => {
    expect(normalizeStatementPunctuation('维修、清洁 、 更换', 'zh')).toBe('维修、清洁、更换')
  })

  it('converts Chinese list punctuation to English comma in en mode', () => {
    expect(normalizeStatementPunctuation('Lockbox storage fee、Cleaning of filter，Replacement', 'en')).toBe('Lockbox storage fee, Cleaning of filter, Replacement')
  })
})

describe('truncateWithEllipsis', () => {
  it('handles extreme length boundaries', () => {
    expect(truncateWithEllipsis('abcd', 0)).toEqual({ text: '…', truncated: true })
    expect(truncateWithEllipsis('abcd', 1).text).toBe('a…')
    expect(truncateWithEllipsis('abcd', 4)).toEqual({ text: 'abcd', truncated: false })
  })
})

describe('formatStatementDesc', () => {
  it('formats long Chinese text with 、 and ellipsis', () => {
    const items = Array.from({ length: 30 }).map((_, i) => `中文事项${i + 1}`)
    const out = formatStatementDesc({ items, lang: 'zh', maxChars: 40 })
    expect(out.full.includes('、')).toBe(true)
    expect(out.text.endsWith('…')).toBe(true)
    expect(out.text.length).toBeGreaterThan(0)
  })

  it('converts 、 to English punctuation in en mode', () => {
    const items = ['Lockbox storage fee', 'Cleaning of air outlets', 'Replacement of shower spring']
    const out = formatStatementDesc({ items: ['A、B', ...items], lang: 'en', maxChars: 200 })
    expect(out.full.includes('、')).toBe(false)
    expect(out.full.includes(', ')).toBe(true)
  })

  it('handles very long text and preserves compatibility', () => {
    const items = [Array.from({ length: 500 }).map(() => 'x').join('')]
    const out = formatStatementDesc({ items, lang: 'en', maxChars: 50 })
    expect(out.text).toMatch(/…$/)
    expect(out.full.length).toBeGreaterThan(out.text.length)
  })
})

