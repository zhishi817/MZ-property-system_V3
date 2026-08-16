import { inferAirbnbEmailDate } from '../src/modules/jobs'

const cases = [
  { header: '2026-01-10T00:00:00Z', month: 4, day: 2, expect: '2026-04-02' },
  { header: '2025-12-15T00:00:00Z', month: 1, day: 2, expect: '2026-01-02' },
  { header: '2026-11-10T00:00:00Z', month: 1, day: 2, expect: '2027-01-02' },
  { header: '2026-01-10T00:00:00Z', month: 12, day: 2, expect: '2026-12-02' },
]

for (const c of cases) {
  const date = inferAirbnbEmailDate(new Date(c.header), c.month, c.day).date
  if (date !== c.expect) throw new Error(`expected ${c.expect}, got ${date}`)
  console.log(JSON.stringify({ header: c.header, month: c.month, day: c.day, result: date, expect: c.expect }))
}
