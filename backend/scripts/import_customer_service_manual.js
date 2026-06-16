#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const dotenv = require('dotenv')

dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config({ path: path.resolve(__dirname, '../.env.local'), override: true })
dotenv.config()

const DEFAULT_SOURCE =
  '/Users/zhishi/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/2.0b4.0.9/d219c3b9da8512838c1db2f28b10f90a/Message/MessageTemp/9e20f478899dc29eb19741386f9343c8/File/客服培训手册（整理版）.md'
const CATEGORY = 'customer_service_manual'
const AUDIENCE = 'managers'
const MANUAL_SLUG = 'cs-manual'

function argValue(flag) {
  const idx = process.argv.indexOf(flag)
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]
  const prefixed = process.argv.find((arg) => arg.startsWith(`${flag}=`))
  return prefixed ? prefixed.slice(flag.length + 1) : ''
}

const dryRun = process.argv.includes('--dry-run')
const keepSplit = process.argv.includes('--keep-split')
const sourceFile = path.resolve(argValue('--file') || process.env.CUSTOMER_SERVICE_MANUAL_MD || DEFAULT_SOURCE)

function stripHeading(line) {
  return String(line || '').replace(/^#{1,6}\s+/, '').trim()
}

function parseManual(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n')
  const h1 = lines.find((line) => /^#\s+/.test(String(line || '')))
  const title = stripHeading(h1 || '客服培训与实操手册')
  const blocks = []
  let paragraph = []
  let callout = []

  const flushParagraph = () => {
    const text = paragraph.join('\n').trim()
    if (text) blocks.push({ type: 'paragraph', text })
    paragraph = []
  }
  const flushCallout = () => {
    const text = callout.join('\n').trim()
    if (text) blocks.push({ type: 'callout', text })
    callout = []
  }

  for (const raw of lines) {
    const line = String(raw || '').trimEnd()
    const trimmed = line.trim()
    if (!trimmed || /^-{3,}$/.test(trimmed)) {
      flushCallout()
      flushParagraph()
      continue
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      flushCallout()
      flushParagraph()
      const level = heading[1].length
      if (level === 1) continue
      blocks.push({ type: 'heading', text: String(heading[2] || '').trim(), level })
      continue
    }
    if (trimmed.startsWith('>')) {
      flushParagraph()
      callout.push(trimmed.replace(/^>\s?/, '').trim())
      continue
    }
    flushCallout()
    paragraph.push(line)
  }
  flushCallout()
  flushParagraph()

  return {
    title,
    slug: MANUAL_SLUG,
    blocks,
  }
}

function countSections(blocks) {
  return blocks.filter((block) => block && block.type === 'heading').length
}

async function ensureSchema(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS cms_pages (
    id text PRIMARY KEY,
    slug text UNIQUE,
    title text,
    content text,
    status text,
    published_at date,
    page_type text NOT NULL DEFAULT 'generic',
    category text,
    guide_role text,
    pinned boolean NOT NULL DEFAULT false,
    urgent boolean NOT NULL DEFAULT false,
    audience_scope text,
    expires_at date,
    updated_at timestamptz DEFAULT now(),
    updated_by text,
    created_at timestamptz DEFAULT now()
  );`)
  await client.query(`ALTER TABLE cms_pages ADD COLUMN IF NOT EXISTS page_type text NOT NULL DEFAULT 'generic';`)
  await client.query(`ALTER TABLE cms_pages ADD COLUMN IF NOT EXISTS category text;`)
  await client.query(`ALTER TABLE cms_pages ADD COLUMN IF NOT EXISTS guide_role text;`)
  await client.query(`ALTER TABLE cms_pages ADD COLUMN IF NOT EXISTS audience_scope text;`)
  await client.query(`ALTER TABLE cms_pages ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();`)
  await client.query(`ALTER TABLE cms_pages ADD COLUMN IF NOT EXISTS updated_by text;`)
  await client.query(`CREATE INDEX IF NOT EXISTS idx_cms_pages_type_category ON cms_pages(page_type, category);`)
}

async function importManual(article) {
  const { Client } = require('pg')
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required for import')
  const client = new Client({ connectionString })
  await client.connect()
  try {
    await ensureSchema(client)
    await client.query('BEGIN')
    const content = JSON.stringify(article.blocks)
    const existing = await client.query('SELECT id FROM cms_pages WHERE slug=$1 LIMIT 1', [MANUAL_SLUG])
    let created = 0
    let updated = 0
    if (existing.rows[0]) {
      await client.query(
        `UPDATE cms_pages
         SET title=$1, content=$2, status='published', page_type='doc', category=$3, guide_role=NULL,
             audience_scope=$4, updated_at=now(), published_at=COALESCE(published_at, CURRENT_DATE)
         WHERE slug=$5`,
        [article.title, content, CATEGORY, AUDIENCE, MANUAL_SLUG],
      )
      updated = 1
    } else {
      await client.query(
        `INSERT INTO cms_pages (id, slug, title, content, status, published_at, page_type, category, guide_role, audience_scope, pinned, urgent, updated_at, created_at)
         VALUES ($1,$2,$3,$4,'published',CURRENT_DATE,'doc',$5,NULL,$6,false,false,now(),now())`,
        [crypto.randomUUID(), MANUAL_SLUG, article.title, content, CATEGORY, AUDIENCE],
      )
      created = 1
    }

    let removedSplit = 0
    if (!keepSplit) {
      const removed = await client.query(
        `DELETE FROM cms_pages
         WHERE page_type='doc'
           AND category=$1
           AND slug LIKE 'cs-manual:%'
           AND slug <> $2`,
        [CATEGORY, MANUAL_SLUG],
      )
      removedSplit = Number(removed?.rowCount || 0)
    }

    await client.query('COMMIT')
    return { created, updated, removedSplit }
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    throw error
  } finally {
    await client.end()
  }
}

async function main() {
  const markdown = fs.readFileSync(sourceFile, 'utf8')
  const manual = parseManual(markdown)
  console.log(`source=${sourceFile}`)
  console.log(`manual=${manual.slug} | ${manual.title}`)
  console.log(`blocks=${manual.blocks.length}`)
  console.log(`sections=${countSections(manual.blocks)}`)
  console.log(`cleanup_split=${keepSplit ? 'disabled' : 'enabled'}`)
  if (dryRun) return
  const result = await importManual(manual)
  console.log(`created=${result.created} updated=${result.updated} removed_split=${result.removedSplit}`)
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error)
  process.exit(1)
})
