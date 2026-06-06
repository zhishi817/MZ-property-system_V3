import { extractFieldsFromHtml } from '../src/modules/jobs'
import assert from 'assert'

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
assert.equal(f.price, 812)
assert.equal(f.cleaning_fee, 0)
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

const sampleHtmlAud = `
<html><body>
  <h1>Reservation confirmed</h1>
  <p>HMMWMMN3QW</p>
  <span>Check-in Fri, 13 June</span>
  <span>Check-out Sun, 15 June</span>
  <a href="https://airbnb.com/rooms/123">Waterfront 1BR Apt Docklands</a>
  <div>Guest paid A$98.94 x 2 nights A$197.88 Cleaning fee A$90.00 Total (AUD) A$362.12</div>
  <div>Host payout 2 nights room fee A$246.00 Cleaning fee A$90.00 Host service fee (3.0% + VAT) -A$9.50 You earn A$278.38</div>
</body></html>`

const fAud = extractFieldsFromHtml(sampleHtmlAud, new Date('2026-06-05T09:42:26Z'))
assert.equal(fAud.price, 278.38)
assert.equal(fAud.cleaning_fee, 90)
console.log('OK test_email_parse')
