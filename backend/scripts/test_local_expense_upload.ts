import dotenv from 'dotenv'
import path from 'path'
import fs from 'fs'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config()
import { pgSelect, pgInsert } from '../src/dbAdapter'

async function main() {
  const uploadDir = path.join(process.cwd(), 'uploads')
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir)
  const fileArg = process.argv[2]
  const ext = fileArg ? path.extname(fileArg) : '.txt'
  const name = `invoices-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
  const dest = path.join(uploadDir, name)
  if (fileArg && fs.existsSync(fileArg)) {
    fs.copyFileSync(fileArg, dest)
  } else {
    fs.writeFileSync(dest, Buffer.from('local upload test'))
  }
  const url = `/uploads/${name}`
  console.log('Local stored URL:', url)
  try {
    const props = await pgSelect('properties', 'id,code') as any[]
    const pid = (props && props[0] && props[0].id) || null
    const id = require('uuid').v4()
    const row = await pgInsert('property_expenses', {
      id,
      property_id: pid,
      occurred_at: new Date().toISOString().slice(0,10),
      amount: 0.02,
      currency: 'AUD',
      category: 'other',
      category_detail: '本地上传测试',
      note: '测试脚本写入',
      invoice_url: url,
    })
    console.log('Inserted property_expenses:', row)
  } catch (e) {
    console.error('DB insert failed:', (e as any)?.message || e)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })