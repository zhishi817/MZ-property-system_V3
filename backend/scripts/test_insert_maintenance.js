const { Pool } = require('pg')
require('dotenv').config({ path: require('path').resolve(process.cwd(), 'backend/.env.local'), override: true })
require('dotenv').config()

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1) }
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } })
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS property_maintenance (
      id text PRIMARY KEY,
      property_id text REFERENCES properties(id) ON DELETE SET NULL,
      occurred_at date NOT NULL,
      worker_name text,
      details text,
      notes text,
      created_by text,
      photo_urls jsonb,
      created_at timestamptz DEFAULT now()
    );`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_property_maintenance_pid ON property_maintenance(property_id);`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_property_maintenance_date ON property_maintenance(occurred_at);`)
    const id = require('crypto').randomUUID()
    const payload = {
      id,
      property_id: null,
      occurred_at: new Date().toISOString().slice(0,10),
      worker_name: 'Test Worker',
      details: JSON.stringify([{ content: 'replace filter', item: 'filter', hours: 1, amount: 50 }]),
      notes: 'Inserted by test script',
      created_by: 'script',
      photo_urls: ['https://example.com/photo1.jpg']
    }
    const sql = `INSERT INTO property_maintenance (id, property_id, occurred_at, worker_name, details, notes, created_by, photo_urls) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::text[]) RETURNING *`
    const res = await pool.query(sql, [payload.id, payload.property_id, payload.occurred_at, payload.worker_name, payload.details, payload.notes, payload.created_by, payload.photo_urls])
    console.log('Inserted row:', res.rows[0])
  } catch (e) {
    console.error('Insert failed:', e.message)
  } finally {
    await pool.end()
  }
}

main()