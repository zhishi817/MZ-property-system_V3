import fs from 'fs'
import path from 'path'
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

// 脱敏后的真实新模板形态：英文月份在日期前，日期节点可能被内联标签拆开，并重复出现同一日期卡。
const sanitizedMonthFirstHtml = `
<html><body>
  <div>Check-in details</div>
  <section class="date-card">
    <div><span>Check-in</span><span>Sun,</span><span>Jan</span><span>24,</span><span>2027</span></div>
    <div><span>Checkout</span><span>Thu,</span><span>Jan</span><span>28,</span><span>2027</span></div>
  </section>
  <section class="date-card-copy">
    <div>Check-in Sun, Jan 24, 2027</div>
    <div>Checkout Thu, Jan 28, 2027</div>
  </section>
  <p>4 nights room fee</p>
</body></html>`
const sanitizedMonthFirst = extractFieldsFromHtml(sanitizedMonthFirstHtml, new Date('2026-10-14T01:00:00Z'))
assertEqual(sanitizedMonthFirst.checkin, '2027-01-24', 'month-first cross-tag HTML checkin is parsed')
assertEqual(sanitizedMonthFirst.checkout, '2027-01-28', 'month-first cross-tag HTML checkout is parsed')
assertEqual(sanitizedMonthFirst.nights, 4, 'month-first HTML night count remains consistent')
assertEqual(sanitizedMonthFirst.raw_checkin_text, 'Sun, Jan 24, 2027', 'month-first HTML retains normalized raw checkin text')
assertEqual(sanitizedMonthFirst.raw_checkout_text, 'Thu, Jan 28, 2027', 'month-first HTML retains normalized raw checkout text')
assertEqual(sanitizedMonthFirst.year_inferred, false, 'month-first explicit year remains authoritative')
assertEqual(validateAirbnbStayDates(sanitizedMonthFirst.checkin, sanitizedMonthFirst.checkout, sanitizedMonthFirst.nights).reason, undefined, 'month-first HTML interval passes nights validation')

const mixedOrderHtml = `
<html><body><section>
  <div>Check-in Sun, Jan 24, 2027</div>
  <div>Checkout Thu, 28 Jan, 2027</div>
  <p>4 nights room fee</p>
</section></body></html>`
const mixedOrderResult = extractFieldsFromHtml(mixedOrderHtml, new Date('2026-10-14T01:00:00Z'))
assertEqual(mixedOrderResult.checkin, '2027-01-24', 'mixed-order parent selects the first date after the checkin label')
assertEqual(mixedOrderResult.checkout, '2027-01-28', 'mixed-order parent selects the first date after the checkout label')
assertEqual(validateAirbnbStayDates(mixedOrderResult.checkin, mixedOrderResult.checkout, mixedOrderResult.nights).reason, undefined, 'mixed English date orders retain a unique valid interval')

const crossTagChineseHtml = `
<html><body>
  <div><span>入</span><span>住</span><strong>2027年</strong><strong>2月</strong><strong>11日</strong></div>
  <div><span>退</span><span>房</span><strong>2027年</strong><strong>2月</strong><strong>14日</strong></div>
  <p>3晚房费</p>
</body></html>`
const crossTagChinese = extractFieldsFromHtml(crossTagChineseHtml, new Date('2026-10-14T01:00:00Z'))
assertEqual(crossTagChinese.checkin, '2027-02-11', 'cross-tag Chinese checkin remains supported')
assertEqual(crossTagChinese.checkout, '2027-02-14', 'cross-tag Chinese checkout remains supported')
assertEqual(crossTagChinese.nights, 3, 'cross-tag Chinese night count remains supported')
assertEqual(crossTagChinese.year_inferred, false, 'cross-tag Chinese explicit year remains authoritative')

const sanitizedPlainText = `
Check-in Sun, Jan 24, 2027
Checkout Thu, Jan 28, 2027
4 nights room fee
`
const plainTextResult = extractFieldsFromHtml('', new Date('2026-10-14T01:00:00Z'), sanitizedPlainText)
assertEqual(plainTextResult.checkin, '2027-01-24', 'plain-text month-first checkin is parsed')
assertEqual(plainTextResult.checkout, '2027-01-28', 'plain-text month-first checkout is parsed')
assertEqual(plainTextResult.nights, 4, 'plain-text month-first night count is parsed')
assertEqual(validateAirbnbStayDates(plainTextResult.checkin, plainTextResult.checkout, plainTextResult.nights).reason, undefined, 'plain-text interval passes nights validation')

const placeholderHtmlResult = extractFieldsFromHtml(
  '<html><body><div>Email content is available in the text part.</div></body></html>',
  new Date('2026-10-14T01:00:00Z'),
  sanitizedPlainText,
)
assertEqual(placeholderHtmlResult.checkin, '2027-01-24', 'plain-text dates fill a non-date placeholder HTML body')
assertEqual(placeholderHtmlResult.checkout, '2027-01-28', 'plain-text checkout fills a non-date placeholder HTML body')
assertEqual(validateAirbnbStayDates(placeholderHtmlResult.checkin, placeholderHtmlResult.checkout, placeholderHtmlResult.nights).reason, undefined, 'placeholder HTML plus plain-text interval passes nights validation')

const conflictingBodySources = extractFieldsFromHtml(
  '<html><body><div>Check-in Mon, Jan 25, 2027</div></body></html>',
  new Date('2026-10-14T01:00:00Z'),
  'Check-in Sun, Jan 24, 2027\nCheckout Thu, Jan 28, 2027',
)
assertEqual(conflictingBodySources.checkin, undefined, 'conflicting HTML and plain-text checkin candidates fail closed')
assertEqual(validateAirbnbStayDates(conflictingBodySources.checkin, conflictingBodySources.checkout, conflictingBodySources.nights).reason, 'CHECKIN_DATE_NOT_FOUND', 'cross-source conflict cannot silently synthesize a stay without nights')

const inferredMonthFirstPlainText = `
Check-in Sun, Jan 3
Checkout Wed, Jan 6
3 nights room fee
`
const inferredMonthFirst = extractFieldsFromHtml('', new Date('2026-12-20T01:00:00Z'), inferredMonthFirstPlainText)
assertEqual(inferredMonthFirst.checkin, '2027-01-03', 'month-first plain-text checkin crosses into the next year')
assertEqual(inferredMonthFirst.checkout, '2027-01-06', 'month-first plain-text checkout crosses into the next year')
assertEqual(inferredMonthFirst.year_inferred, true, 'month-first missing year retains inference audit flag')

const jobsSource = fs.readFileSync(path.resolve(__dirname, '../src/modules/jobs.ts'), 'utf8')
const failuresGetStart = jobsSource.indexOf("router.get('/email-orders-raw/failures'")
const failuresGetEnd = jobsSource.indexOf("router.post('/email-orders-raw/", failuresGetStart)
assertEqual(failuresGetStart >= 0, true, 'failure-list GET route exists')
assertEqual(failuresGetEnd > failuresGetStart, true, 'failure-list GET route boundary exists')
const failuresGetRoute = jobsSource.slice(failuresGetStart, failuresGetEnd)
assertEqual(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(failuresGetRoute), false, 'failure-list GET route is a pure query without implicit writes')

console.log('all tests passed')
