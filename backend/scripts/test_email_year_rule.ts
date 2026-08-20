import { extractFieldsFromHtml, inferAirbnbEmailDate, validateAirbnbStayDates } from '../src/modules/jobs'

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

function runCase(headerIso: string, ciMon: string, coMon: string, expectCi: string, expectCo: string, ciDay: number = 2, coDay: number = 5) {
  const html = htmlWithMonths(ciMon, coMon, ciDay, coDay)
  const f = extractFieldsFromHtml(html, new Date(headerIso))
  const ci = String(f.checkin || '')
  const co = String(f.checkout || '')
  assertEqual(ci, expectCi, `checkin date for ${headerIso} -> ${ciMon}`)
  assertEqual(co, expectCo, `checkout date for ${headerIso} -> ${coMon}`)
  assertEqual(f.year_inferred, true, `missing-year flag for ${headerIso}`)
  console.log('ok', { headerIso, ciMon, coMon, ci, co })
}

// 12 -> 1 应为下一年。
runCase('2025-12-15T12:00:00Z', 'Jan', 'Jan', '2026-01-02', '2026-01-05')

// 1 -> 12 是同一年稍后的预订，不能回退到上一年。
runCase('2026-01-10T12:00:00Z', 'Dec', 'Dec', '2026-12-02', '2026-12-05')

// 同日入住不能跨年，之后的退房保留当年。
runCase('2026-05-10T12:00:00Z', 'May', 'May', '2026-05-10', '2026-05-12', 10, 12)

// 跨月但仍在当年。
runCase('2026-01-10T12:00:00Z', 'Feb', 'Feb', '2026-02-02', '2026-02-05')

// 本次事故：8 月确认的次年 2 月预订。
runCase('2026-08-09T12:58:18Z', 'Feb', 'Feb', '2027-02-07', '2027-02-15', 7, 15)

// 闰日只能落在有效的下一闰年。
assertEqual(inferAirbnbEmailDate(new Date('2027-08-09T00:00:00Z'), 2, 29).date, '2028-02-29', 'leap-day rollover')
assertEqual(inferAirbnbEmailDate(new Date('2027-08-09T00:00:00Z'), 4, 31).date, undefined, 'invalid calendar day is rejected')
assertEqual(inferAirbnbEmailDate(new Date('2026-08-09T00:00:00Z'), 2, 7, 2028).date, '2028-02-07', 'explicit year is authoritative')
assertEqual(inferAirbnbEmailDate(new Date('2026-01-01T13:30:00Z'), 1, 1).date, '2027-01-01', 'Melbourne day boundary is authoritative')

const explicit = extractFieldsFromHtml(htmlWithMonths('Feb', 'Feb', 7, 15).replace(/(Tue, 7 Feb|Fri, 15 Feb)/g, '$1, 2028'), new Date('2026-08-09T12:58:18Z'))
assertEqual(explicit.checkin, '2028-02-07', 'explicit checkin year is parsed from HTML')
assertEqual(explicit.checkout, '2028-02-15', 'explicit checkout year is parsed from HTML')
assertEqual(explicit.year_inferred, false, 'explicit HTML year does not set inferred flag')

const cardHeaderDate = new Date('2026-08-19T12:00:00Z')
const cardHtml = `
<html><body>
  <div>Check-in details</div>
  <div class="date-card">
    <div><span>Check-in</span><span>Thu, 20 Aug</span><span>3:00 pm</span></div>
    <div><span>Checkout</span><span>Fri, 21 Aug</span><span>10:00 am</span></div>
  </div>
  <p>1 night room fee</p>
</body></html>`
const card = extractFieldsFromHtml(cardHtml, cardHeaderDate)
assertEqual(card.checkin, '2026-08-20', 'date card checkin wins over earlier Check-in details text')
assertEqual(card.checkout, '2026-08-21', 'date card checkout is parsed as a pair')
assertEqual(card.nights, 1, 'singular night count is parsed')
assertEqual(card.raw_checkin_text, 'Thu, 20 Aug', 'date card retains raw checkin text')
assertEqual(card.raw_checkout_text, 'Fri, 21 Aug', 'date card retains raw checkout text')

const repeatedCard = extractFieldsFromHtml(cardHtml.replace('</body>', '<div>Check-in Thu, 20 Aug</div><div>Checkout Fri, 21 Aug</div></body>'), cardHeaderDate)
assertEqual(repeatedCard.checkin, '2026-08-20', 'duplicate checkin labels with the same date are idempotent')
assertEqual(repeatedCard.checkout, '2026-08-21', 'duplicate checkout labels with the same date are idempotent')
assertEqual(JSON.stringify(repeatedCard), JSON.stringify(extractFieldsFromHtml(cardHtml.replace('</body>', '<div>Check-in Thu, 20 Aug</div><div>Checkout Fri, 21 Aug</div></body>'), cardHeaderDate)), 'same message reparse is stable')

const missingCheckin = extractFieldsFromHtml('<html><body><div>Checkout Fri, 21 Aug</div><p>1 night room fee</p></body></html>', cardHeaderDate)
assertEqual(validateAirbnbStayDates(missingCheckin.checkin, missingCheckin.checkout, missingCheckin.nights).reason, 'CHECKIN_DATE_NOT_FOUND', 'missing checkin receives a stable failure code')

const missingCheckout = extractFieldsFromHtml('<html><body><div>Check-in Thu, 20 Aug</div><p>1 night room fee</p></body></html>', cardHeaderDate)
assertEqual(validateAirbnbStayDates(missingCheckout.checkin, missingCheckout.checkout, missingCheckout.nights).reason, 'CHECKOUT_DATE_NOT_FOUND', 'missing checkout receives a stable failure code')

const conflictingDates = extractFieldsFromHtml(cardHtml.replace('1 night room fee', '2 nights room fee'), cardHeaderDate)
assertEqual(validateAirbnbStayDates(conflictingDates.checkin, conflictingDates.checkout, conflictingDates.nights).reason, 'CHECKIN_CHECKOUT_NIGHTS_MISMATCH', 'date and night conflicts fail closed')

console.log('all tests passed')
