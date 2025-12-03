import dotenv from 'dotenv'
import path from 'path'
import fs from 'fs'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config()
import { r2Upload, hasR2 } from '../src/r2'
import { pgSelect, pgInsert } from '../src/dbAdapter'

async function main() {
  const fileArg = process.argv[2]
  const buf = fileArg && fs.existsSync(fileArg)
    ? fs.readFileSync(fileArg)
    : Buffer.from('hello r2')
  const ext = fileArg ? path.extname(fileArg) : '.txt'
  if (!hasR2) {
    console.log('R2 not configured; set env R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE')
    return
  }
  const key = `expenses/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
  const url = await r2Upload(key, 'application/octet-stream', buf)
  console.log('Uploaded URL:', url)
  try {
    const props = await pgSelect('properties', 'id,code') as any[]
    const pid = (props && props[0] && props[0].id) || null
    const id = require('uuid').v4()
    const row = await pgInsert('property_expenses', {
      id,
      property_id: pid,
      occurred_at: new Date().toISOString().slice(0,10),
      amount: 0.01,
      currency: 'AUD',
      category: 'other',
      category_detail: '测试上传',
      note: '测试脚本写入',
      invoice_url: url,
    })
    console.log('Inserted property_expenses:', row)
  } catch (e) {
    console.error('DB insert failed:', (e as any)?.message || e)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })