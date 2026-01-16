import { inferYearByDelta } from '../src/modules/jobs'

const cases = [
  { baseYear: 2026, baseMonth: 1, parsedMonth: 4, expect: 2026 },
  { baseYear: 2025, baseMonth: 12, parsedMonth: 1, expect: 2026 },
  { baseYear: 2026, baseMonth: 11, parsedMonth: 1, expect: 2027 },
  { baseYear: 2026, baseMonth: 1, parsedMonth: 12, expect: 2025 },
]

for (const c of cases) {
  const y = inferYearByDelta(c.baseYear, c.baseMonth, c.parsedMonth)
  console.log(JSON.stringify({ base: `${c.baseYear}-${String(c.baseMonth).padStart(2,'0')}`, parsedMonth: c.parsedMonth, result: y, expect: c.expect }))
}
