import { extractFieldsFromHtml, ymdInTz, inferYearByDelta } from '../src/modules/jobs'

function htmlWithMonths(ciMon: string, coMon: string, ciDay: number = 2, coDay: number = 5) {
  return `
  <html><body>
    Confirmation code TST123
    New booking confirmed! Alice arrives
    Check-in Tue, ${ciDay} ${ciMon}
    Check-out Fri, ${coDay} ${coMon}
    You earn $100
    Cleaning fee $0
    3 nights room fee
  </body></html>
  `
}

function assertEqual(a: any, b: any, label: string) {
  if (a !== b) throw new Error(`assert failed: ${label} expected=${b} got=${a}`)
}

function runCase(headerIso: string, ciMon: string, coMon: string, expectCi: string, expectCo: string) {
  const html = htmlWithMonths(ciMon, coMon)
  const f = extractFieldsFromHtml(html, new Date(headerIso))
  const ci = String(f.checkin || '')
  const co = String(f.checkout || '')
  assertEqual(ci, expectCi, `checkin date for ${headerIso} -> ${ciMon}`)
  assertEqual(co, expectCo, `checkout date for ${headerIso} -> ${coMon}`)
  console.log('ok', { headerIso, ciMon, coMon, ci, co })
}

// 12 -> 1 应为下一年
runCase('2025-12-15T12:00:00Z', 'Jan', 'Jan', '2026-01-02', '2026-01-05')

// 1 -> 12 应为上一年
runCase('2026-01-10T12:00:00Z', 'Dec', 'Dec', '2025-12-02', '2025-12-05')

// 同月
runCase('2026-05-10T12:00:00Z', 'May', 'May', '2026-05-02', '2026-05-05')

// 跨月（小差）
runCase('2026-01-10T12:00:00Z', 'Feb', 'Feb', '2026-02-02', '2026-02-05')

console.log('all tests passed')