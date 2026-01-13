import { extractFieldsFromHtml } from '../src/modules/jobs'

const sampleHtml = `
  <html><body>
    <h1>Sample Listing Name</h1>
    Confirmation code ABC123
    New booking confirmed! John Doe arrives
    Check-in Tue, 2 Jan
    Check-out Fri, 5 Jan
    You earn $450
    Cleaning fee $50
    3 nights room fee
  </body></html>
`

function show(label: string, d: Date) {
  const f = extractFieldsFromHtml(sampleHtml, d)
  console.log(label, { checkin: f.checkin, checkout: f.checkout })
}

show('header_2025-12-31', new Date('2025-12-31T12:00:00Z'))
show('header_2026-01-02', new Date('2026-01-02T12:00:00Z'))