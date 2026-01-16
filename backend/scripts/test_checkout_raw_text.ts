import { extractFieldsFromHtml } from '../src/modules/jobs'

const html = `
  <html>
    <body>
      <div>Check outSun, 22 Feb</div>
      <div>You earn $123.45</div>
    </body>
  </html>
`

const headerDate = new Date('2025-02-20T10:00:00Z')
const res = extractFieldsFromHtml(html, headerDate)
console.log(JSON.stringify({ raw_checkout_text: res.raw_checkout_text, checkout: res.checkout }))
