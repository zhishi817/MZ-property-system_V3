import { extractFieldsFromHtml } from '../src/modules/jobs'

const html = `
<html>
  <body>
    <table>
      <tr>
        <td>
          <a target="_blank" href="https://www.airbnb.com.au/rooms/333630947?check_in=2026-01-10&check_out=2026-01-12">link</a>
          <h2 class="heading2" style="font-size:22px;line-height:26px;color:#222222;font-weight:700;">Entire home/apt · "Hidden Gem" Cosy 1B apt in central Melbourne #2</h2>
        </td>
      </tr>
    </table>
    <div>
      <h3>Southbank home w Balcony #2Entire home/apt</h3>
    </div>
    <div>Confirmation code</div>
    <p>ABC12345</p>
    New booking confirmed! Jane Doe arrives
    Check-in Sat, 10 Jan
    Check-out Mon, 12 Jan
    You earn $500
    Cleaning fee $50
    2 nights room fee
  </body>
</html>`

const headerDate = new Date('2026-01-05T12:00:00Z')
const f = extractFieldsFromHtml(html, headerDate)
console.log(JSON.stringify({ listing_name: f.listing_name, confirmation_code: f.confirmation_code, checkin: f.checkin, checkout: f.checkout }, null, 2))