import { extractFieldsFromHtml } from '../src/modules/jobs'

const headerDate = new Date('2026-01-15T12:00:00Z')
const sampleHtml = `
<html><body>
  <h1>Reservation confirmed</h1>
  <div class="normal-container">
    <p>HMY12345AB</p>
  </div>
  <div>
    <span>Check-in Feb 01</span>
    <span>Check-out Feb 05</span>
  </div>
  <p>You earn $812.00</p>
  <p>Cleaning fee $0.00</p>
  <p>Entire apartment · 2306/371 Little Lonsdale</p>
  <a href="https://airbnb.com/rooms/123">View listing</a>
</body></html>`

const f = extractFieldsFromHtml(sampleHtml, headerDate)
console.log(JSON.stringify({
  confirmation_code: f.confirmation_code,
  checkin: f.checkin,
  checkout: f.checkout,
  price: f.price,
  cleaning_fee: f.cleaning_fee,
  listing_name: f.listing_name,
  year_inferred: f.year_inferred,
  probe: f.probe ? true : false,
}, null, 2))
