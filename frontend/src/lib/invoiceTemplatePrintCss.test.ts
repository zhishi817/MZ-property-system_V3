import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

describe('invoice-template print css', () => {
  it('keeps consistent page margins in print', () => {
    const p = path.join(process.cwd(), 'public', 'invoice-templates', 'invoice-template.css')
    const s = fs.readFileSync(p, 'utf8')
    expect(s).toMatch(/@page\{\s*size:A4;\s*margin:20mm;\s*\}/)
    expect(s).toMatch(/@media print\{[\s\S]*?\.inv-page\{[\s\S]*?padding:0;[\s\S]*?\}/)
  })
})

