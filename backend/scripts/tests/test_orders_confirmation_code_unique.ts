import { pgPool } from '../../src/dbAdapter'

async function setup() {
  await pgPool.query("DELETE FROM orders WHERE confirmation_code IN ('TEST_CC_UNIQ_1','TEST_CC_UNIQ_2')")
}

async function testUniqueInsert() {
  await setup()
  await pgPool.query("INSERT INTO orders(id, property_id, checkin, checkout, confirmation_code, source, status) VALUES(gen_random_uuid(), 'test-prop', now(), now()+interval '1 day', 'TEST_CC_UNIQ_1', 'airbnb', 'confirmed')")
  let failed = false
  try {
    await pgPool.query("INSERT INTO orders(id, property_id, checkin, checkout, confirmation_code, source, status) VALUES(gen_random_uuid(), 'test-prop', now(), now()+interval '1 day', 'TEST_CC_UNIQ_1', 'airbnb_email', 'confirmed')")
  } catch { failed = true }
  console.log('unique_insert_conflict', failed)
}

async function run() { await testUniqueInsert() }

run().then(()=> process.exit(0)).catch((e)=> { console.error(e); process.exit(1) })
