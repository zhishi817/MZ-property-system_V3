import assert from 'assert'

process.env.DATABASE_URL = ''
process.env.NEON_DATABASE_URL = ''
process.env.NEON_DATABASE_URL_PROD = ''

async function main() {
  const {
    classifyAirbnbOrderSubject,
    extractFieldsFromHtml,
    NOT_WHITELISTED_EMAIL_AUDIT,
  } = await import('../../src/modules/jobs')

  assert.strictEqual(classifyAirbnbOrderSubject('订单已确认 - Test Guest 将于2月11日抵达'), 'confirmed')
  assert.strictEqual(classifyAirbnbOrderSubject('新预订已确认！Test Guest 将于2月11日抵达'), 'confirmed')
  assert.strictEqual(classifyAirbnbOrderSubject('预订已确认 - TST23XX83F'), 'confirmed')
  assert.strictEqual(classifyAirbnbOrderSubject('预订已更改 - TST23XX83F'), 'altered')
  assert.strictEqual(classifyAirbnbOrderSubject('订单已取消 - TST23XX83F'), 'cancelled')
  assert.strictEqual(classifyAirbnbOrderSubject('Reservation confirmed - TST23XX83F'), 'confirmed')
  assert.strictEqual(classifyAirbnbOrderSubject('如何取消订单'), null)
  assert.strictEqual(classifyAirbnbOrderSubject('Write a review for Test Guest'), null)

  const html = `
    <html><body>
      <h1>新预订已确认！ Test Guest 将于2月11日抵达。</h1>
      <p>TST23XX83F</p>
      <a href="https://www.airbnb.com/rooms/123456">演示房源#4整套房子/公寓</a>
      <section><span>入住</span><strong>2月11日</strong></section>
      <section><span>退房</span><strong>2月21日</strong></section>
      <p>10晚房费</p>
      <p>清洁费 A$105.00</p>
      <p>你的收入为 A$2,142.59</p>
    </body></html>
  `
  const fields = extractFieldsFromHtml(html, new Date('2026-09-29T20:05:00+10:00'))
  assert.deepStrictEqual(
    {
      confirmation_code: fields.confirmation_code,
      guest_name: fields.guest_name,
      listing_name: fields.listing_name,
      checkin: fields.checkin,
      checkout: fields.checkout,
      nights: fields.nights,
      price: fields.price,
      cleaning_fee: fields.cleaning_fee,
      year_inferred: fields.year_inferred,
    },
    {
      confirmation_code: 'TST23XX83F',
      guest_name: 'Test Guest',
      listing_name: '演示房源#4',
      checkin: '2027-02-11',
      checkout: '2027-02-21',
      nights: 10,
      price: 2142.59,
      cleaning_fee: 105,
      year_inferred: true,
    },
  )

  assert.deepStrictEqual(NOT_WHITELISTED_EMAIL_AUDIT, {
    status: 'skipped',
    reason: 'not_matched',
    error_code: 'not_whitelisted',
  })

  console.log('airbnb localized email tests passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
