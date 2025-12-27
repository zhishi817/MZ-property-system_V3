import { Router } from 'express'
import { z } from 'zod'
import { requirePerm } from '../auth'
import { hasPg, pgPool, pgSelect, pgInsertOnConflictDoNothing, pgInsert, pgRunInTransaction } from '../dbAdapter'
import { v4 as uuid } from 'uuid'

type JobMode = 'incremental' | 'backfill'

function toDateOnly(y: number, m: number, d: number): string {
  const mm = String(m).padStart(2, '0')
  const dd = String(d).padStart(2, '0')
  return `${y}-${mm}-${dd}`
}
function parseMonthStr(s: string): number | null { const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']; const idx = months.indexOf(s.toLowerCase().slice(0,3)); return idx >= 0 ? idx + 1 : null }
function round2(n?: number): number | undefined { if (n == null) return undefined; const x = Number(n); if (!isFinite(x)) return undefined; return Number(x.toFixed(2)) }

async function withAdvisoryLock<T>(key: number, fn: () => Promise<T>): Promise<T> {
  if (!pgPool) return await fn()
  const got = await pgPool.query('SELECT pg_try_advisory_lock($1) AS ok', [key])
  const ok = !!(got?.rows?.[0]?.ok)
  if (!ok) throw Object.assign(new Error('job already running'), { status: 409 })
  try {
    const res = await fn()
    return res
  } finally {
    try { await pgPool.query('SELECT pg_advisory_unlock($1)', [key]) } catch {}
  }
}

async function ensureEmailState(account: string) {
  if (!pgPool) return
  await pgPool.query('INSERT INTO email_sync_state(account, last_uid, last_checked_at) VALUES($1, 0, now()) ON CONFLICT(account) DO NOTHING', [account])
}
async function getEmailState(account: string): Promise<{ last_uid: number; last_checked_at?: string; last_backfill_at?: string }> {
  if (!pgPool) return { last_uid: 0 }
  const rs = await pgPool.query('SELECT last_uid, last_checked_at, last_backfill_at FROM email_sync_state WHERE account=$1', [account])
  const r = rs?.rows?.[0]
  return { last_uid: Number(r?.last_uid || 0), last_checked_at: r?.last_checked_at, last_backfill_at: r?.last_backfill_at }
}
async function setEmailStateIncremental(account: string, lastUid: number) {
  if (!pgPool) return
  await pgPool.query('UPDATE email_sync_state SET last_uid=$2, last_checked_at=now() WHERE account=$1', [account, lastUid])
}
async function setEmailStateBackfill(account: string) { if (!pgPool) return; await pgPool.query('UPDATE email_sync_state SET last_checked_at=now(), last_backfill_at=now() WHERE account=$1', [account]) }

function getAccounts(): Array<{ user: string; pass: string; folder: string }> {
  const list: Array<{ user: string; pass: string; folder: string }> = []
  const u = String(process.env.AIRBNB_IMAP_USER || '').trim()
  const p = String(process.env.AIRBNB_IMAP_PASS || '').trim()
  const f = String(process.env.AIRBNB_IMAP_FOLDER || 'INBOX').trim()
  if (u && p) list.push({ user: u, pass: p, folder: f })
  const combo = String(process.env.AIRBNB_IMAP_ACCOUNTS || '').trim()
  if (combo) {
    combo.split(';').map(s => s.trim()).filter(Boolean).forEach(pair => {
      const [uu, pp] = pair.split(':')
      if (uu && pp) list.push({ user: uu.trim(), pass: pp.trim(), folder: f })
    })
  }
  return list
}

async function loadPropertyIndex(): Promise<Record<string, string>> {
  const byName: Record<string, string> = {}
  try {
    if (hasPg) {
      const rowsRaw: any = await pgSelect('properties', 'id,airbnb_listing_name')
      const rows: any[] = Array.isArray(rowsRaw) ? rowsRaw : []
      rows.forEach((p: any) => { const nm = String(p.airbnb_listing_name || '').trim().toLowerCase(); if (nm) byName[nm] = String(p.id) })
    }
  } catch {}
  return byName
}

function normalizeText(s: string): string { return String(s || '').replace(/\s+/g, ' ').trim() }

function extractFieldsFromHtml(html: string, headerYear: number): {
  confirmation_code?: string
  guest_name?: string
  listing_name?: string
  checkin?: string
  checkout?: string
  nights?: number
  price?: number
  cleaning_fee?: number
} {
  const cheerio = require('cheerio')
  const $ = cheerio.load(html || '')
  const bodyText = normalizeText(($('body').text() || ''))
  let confirmation_code: string | undefined
  let guest_name: string | undefined
  let listing_name: string | undefined
  let checkin: string | undefined
  let checkout: string | undefined
  let nights: number | undefined
  let price: number | undefined
  let cleaning_fee: number | undefined
  const m1 = /Confirmation code\s*([A-Z0-9]+)/.exec(bodyText)
  if (m1) confirmation_code = m1[1]
  const m2 = /New booking confirmed!\s*(.*?)\s+arrives/i.exec(bodyText)
  if (m2) guest_name = normalizeText(m2[1])
  let titleCand = ''
  $('h1,h2,h3').each(( _i: number, el: any) => { const txt = normalizeText($(el).text()); if (!titleCand || txt.length > titleCand.length) titleCand = txt })
  if (titleCand) listing_name = titleCand
  function pickDate(label: string): string | undefined {
    const re = new RegExp(label + '\\s*([A-Za-z]{3,9}),?\\s*(\\d{1,2})\\s+([A-Za-z]{3,9})', 'i')
    const m = re.exec(bodyText)
    if (!m) return undefined
    const day = Number(m[2])
    const mon = parseMonthStr(m[3] || '') || 0
    if (!mon || !day) return undefined
    return toDateOnly(headerYear, mon, day)
  }
  checkin = pickDate('Check-?in') || checkin
  checkout = pickDate('Check-?out') || checkout
  const mx = /([0-9]+)\s+nights\s+room\s+fee/i.exec(bodyText)
  if (mx) nights = Number(mx[1])
  function parseAmountAfter(label: string): number | undefined {
    const re = new RegExp(label + '\\s*\$?([0-9][0-9,.]*)', 'i')
    const m = re.exec(bodyText)
    if (!m) return undefined
    const v = Number(String(m[1]).replace(/[,]/g, ''))
    return isNaN(v) ? undefined : v
  }
  price = parseAmountAfter('You earn')
  cleaning_fee = parseAmountAfter('Cleaning fee') || 0
  return { confirmation_code, guest_name, listing_name, checkin, checkout, nights, price, cleaning_fee }
}

async function processMessage(acc: { user: string; pass: string; folder: string }, msg: any, propIndex: Record<string, string>, dryRun: boolean, sourceTag: string) {
  const mailparser = require('mailparser')
  const parsed = await mailparser.simpleParser(msg.source)
  const from = String(parsed.from?.text || '')
  const subject = String(parsed.subject || '')
  const html = String(parsed.html || '')
  const internal = msg.internalDate ? new Date(msg.internalDate) : new Date()
  const headerYear = internal.getFullYear()
  const fields = extractFieldsFromHtml(html, headerYear)
  const isAirbnb = /airbnb\.com/i.test(from)
  const isSubjectOk = /(Reservation confirmed|New booking confirmed)/i.test(subject)
  if (!isAirbnb && !isSubjectOk) return { matched: false, inserted: false, skipped_duplicate: false, failed: false, last_uid: Number(msg.uid || 0) }
  const cc = String(fields.confirmation_code || '').trim()
  if (!cc) {
    if (!dryRun && hasPg) {
      try { await pgInsert('order_import_staging', { id: uuid(), channel: 'airbnb_email', raw_row: { message_id: String(parsed.messageId || ''), subject, from, html_snippet: (html || '').slice(0, 2000) }, reason: 'missing_field:confirmation_code', status: 'unmatched' }) } catch {}
    }
    const sample = {
      confirmation_code: cc,
      guest_name: fields.guest_name,
      listing_name: fields.listing_name,
      checkin: fields.checkin,
      checkout: fields.checkout,
      nights: fields.nights,
      price: fields.price,
      cleaning_fee: fields.cleaning_fee,
      net_income: Number(((fields.price || 0) - (fields.cleaning_fee || 0)).toFixed?.(2) || ((fields.price || 0) - (fields.cleaning_fee || 0))),
      avg_nightly_price: (fields.nights && fields.nights > 0) ? Number((((fields.price || 0) - (fields.cleaning_fee || 0)) / fields.nights).toFixed(2)) : 0,
      property_match: false,
      property_id: undefined,
    }
    return { matched: true, inserted: false, skipped_duplicate: false, failed: true, sample, last_uid: Number(msg.uid || 0) }
  }
  const ln = String(fields.listing_name || '').trim().toLowerCase()
  const pid = ln ? propIndex[ln] : undefined
  if (!pid) {
    if (!dryRun && hasPg) {
      try { await pgInsert('order_import_staging', { id: uuid(), channel: 'airbnb_email', raw_row: { message_id: String(parsed.messageId || ''), subject, from, html_snippet: (html || '').slice(0, 2000), listing_name: fields.listing_name }, reason: 'unmatched_property', status: 'unmatched' }) } catch {}
    }
    const sample = {
      confirmation_code: cc,
      guest_name: fields.guest_name,
      listing_name: fields.listing_name,
      checkin: fields.checkin,
      checkout: fields.checkout,
      nights: fields.nights,
      price: fields.price,
      cleaning_fee: fields.cleaning_fee,
      net_income: Number(((fields.price || 0) - (fields.cleaning_fee || 0)).toFixed?.(2) || ((fields.price || 0) - (fields.cleaning_fee || 0))),
      avg_nightly_price: (fields.nights && fields.nights > 0) ? Number((((fields.price || 0) - (fields.cleaning_fee || 0)) / fields.nights).toFixed(2)) : 0,
      property_match: false,
      property_id: undefined,
    }
    return { matched: true, inserted: false, skipped_duplicate: false, failed: true, sample, last_uid: Number(msg.uid || 0) }
  }
  const ci = fields.checkin || ''
  const co = fields.checkout || ''
  let nights = fields.nights
  if ((!nights || nights <= 0) && ci && co) {
    try { const a = new Date(ci); const b = new Date(co); const ms = b.getTime() - a.getTime(); nights = ms > 0 ? Math.round(ms / (1000 * 60 * 60 * 24)) : 0 } catch { nights = 0 }
  }
  const price = round2(fields.price || 0) || 0
  const cleaning = round2(fields.cleaning_fee || 0) || 0
  const net = round2(price - cleaning) || 0
  const avg = nights && nights > 0 ? (round2(price / nights) || 0) : 0
  const idempotency_key = `airbnb_email:${cc}`
  if (dryRun) {
    const sample = { confirmation_code: cc, guest_name: fields.guest_name, listing_name: fields.listing_name, checkin: ci, checkout: co, nights, price, cleaning_fee: cleaning, net_income: net, avg_nightly_price: avg, property_match: !!pid, property_id: pid }
    return { matched: true, inserted: false, skipped_duplicate: false, failed: false, sample, last_uid: Number(msg.uid || 0) }
  }
  if (hasPg) {
    try {
      const dup: any[] = await pgSelect('orders', 'id', { source: sourceTag, confirmation_code: cc, property_id: pid }) as any[] || []
      if (Array.isArray(dup) && dup[0]) return { matched: true, inserted: false, skipped_duplicate: true, failed: false, last_uid: Number(msg.uid || 0) }
    } catch {}
    const payload: any = { id: uuid(), source: sourceTag, external_id: cc, property_id: pid, guest_name: fields.guest_name, checkin: ci, checkout: co, price, cleaning_fee: cleaning, net_income: net, avg_nightly_price: avg, nights, currency: 'AUD', status: 'confirmed', confirmation_code: cc, idempotency_key, payment_currency: 'AUD', payment_received: false }
    const row = await pgInsertOnConflictDoNothing('orders', payload, ['idempotency_key'])
    return { matched: true, inserted: !!row, skipped_duplicate: !row, failed: false, last_uid: Number(msg.uid || 0) }
  }
  return { matched: true, inserted: false, skipped_duplicate: false, failed: false, last_uid: Number(msg.uid || 0) }
}

async function fetchUids(client: any, q: { uidFrom?: number; since?: Date; before?: Date; limit: number }): Promise<number[]> {
  let uids: number[] = []
  if (q.uidFrom != null) {
    const from = Number(q.uidFrom)
    const rs = await client.search({ uid: `${from + 1}:*` }, { uid: true })
    uids = (rs || []).map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n))
  } else {
    const rs = await client.search({ since: q.since, before: q.before }, { uid: true })
    uids = (rs || []).map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n))
  }
  uids.sort((a, b) => a - b)
  const max = Number(q.limit || 200)
  return uids.slice(0, max)
}

export const router = Router()

const reqSchema = z.object({
  mode: z.enum(['incremental','backfill']).optional().default('incremental'),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
  dry_run: z.boolean().optional().default(false),
  batch_tag: z.string().optional(),
  max_messages: z.coerce.number().optional().default(200),
  commit_every: z.coerce.number().optional().default(50),
  preview_limit: z.coerce.number().optional().default(20),
  uids: z.array(z.coerce.number()).optional(),
})

router.post('/email-sync-airbnb', requirePerm('order.manage'), async (req, res) => {
  const parsed = reqSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { mode, from_date, to_date, dry_run, batch_tag, max_messages, commit_every } = parsed.data
  const debugUids: number[] | null = Array.isArray((req.body || {}).uids) ? ((req.body || {}).uids as any[]).map((n: any) => Number(n)).filter(n => Number.isFinite(n)) : null
  if (!hasPg) return res.status(400).json({ message: 'pg required' })
  const accounts = getAccounts()
  if (!accounts.length) return res.status(400).json({ message: 'missing imap accounts' })
  try {
    const lockKey = 918273645
    const result = await withAdvisoryLock(lockKey, async () => {
      const propIdx = await loadPropertyIndex()
      const stats = { scanned: 0, matched: 0, inserted: 0, skipped_duplicate: 0, failed: 0 }
      const samples: any[] = []
      const failedDetails: Array<{ uid: number; subject?: string; from?: string; reason?: string }> = []
      const parsedResults: any[] = []
      const { ImapFlow } = require('imapflow')
      for (const acc of accounts) {
        await ensureEmailState(acc.user)
        const sourceTag = mode === 'backfill' ? String(batch_tag || 'airbnb_email_import_v1') : 'airbnb_email'
        const client = new ImapFlow({ host: 'imap.exmail.qq.com', port: 993, secure: true, auth: { user: acc.user, pass: acc.pass } })
        try { await client.connect() } catch (e: any) { return res.status(500).json({ message: 'imap_connect_failed', detail: String(e?.message || '') }) }
        let mailbox: any
        try { mailbox = await client.mailboxOpen(acc.folder) } catch (e: any) { try { await client.logout() } catch {}; return res.status(500).json({ message: 'imap_mailbox_open_failed', detail: String(e?.message || '') }) }
        const state = await getEmailState(acc.user)
        let lastUid = Number(state.last_uid || 0)
        if (mode === 'incremental') {
          if (!lastUid || lastUid <= 0) {
            const initUid = Number(mailbox?.uidNext || 1) - 1
            lastUid = initUid > 0 ? initUid : 0
            await setEmailStateIncremental(acc.user, lastUid)
          }
        }
        const windowFrom = from_date ? new Date(`${from_date}T00:00:00`) : undefined
        const windowTo = to_date ? new Date(`${to_date}T23:59:59`) : undefined
        while (true) {
          const uids = (debugUids && debugUids.length) ? debugUids : await fetchUids(client, mode === 'incremental' ? { uidFrom: lastUid, limit: max_messages } : { since: windowFrom, before: windowTo, limit: max_messages })
          if (!uids.length) break
          for (let i = 0; i < uids.length; i++) {
            const uid = Number(uids[i])
            try {
              const m = await client.fetchOne(String(uid), { envelope: true, internalDate: true, source: true }, { uid: true })
              stats.scanned++
              const r = await processMessage(acc, m, propIdx, dry_run, sourceTag)
              if (r.matched) stats.matched++
              if (r.inserted) stats.inserted++
              if (r.skipped_duplicate) stats.skipped_duplicate++
              if (r.failed) stats.failed++
              if (r.failed) {
                const env: any = (m as any)?.envelope || {}
                failedDetails.push({ uid, subject: env?.subject, from: env?.from?.text, reason: (r as any).reason || 'parse_failed' })
                const preview = (async () => { try { const mailparser = require('mailparser'); const p = await mailparser.simpleParser(m.source); return String(p?.html || p?.text || '').slice(0,200) } catch { return '' } })
                try {
                  if (String(process.env.DEBUG_AIRBNB_EMAIL || '').toLowerCase() === 'true') {
                    const content_preview = await preview()
                    console.debug(JSON.stringify({ tag: 'airbnb_email_content_preview', uid, subject: env?.subject, content_preview }))
                  }
                } catch {}
                try {
                  const mailparser = require('mailparser')
                  const p2 = await mailparser.simpleParser(m.source)
                  const textBody = String((p2?.html || p2?.text || '')).replace(/\s+/g,' ')
                  const logObj = { tag: 'airbnb_email_parse_failed', uid, subject: env?.subject, from: env?.from?.text, missing: {
                    confirmation_code: !/Confirmation code\s*[A-Z0-9]+/i.test(textBody),
                    you_earn: !/You earn\s*\$?[0-9][0-9,.]*/i.test(textBody),
                    checkin: !/Check-?in\s*[A-Za-z]{3,9},?\s*\d{1,2}\s+[A-Za-z]{3,9}/i.test(textBody),
                    checkout: !/Check-?out\s*[A-Za-z]{3,9},?\s*\d{1,2}\s+[A-Za-z]{3,9}/i.test(textBody),
                    listing_name: !/Entire\s+home\/apt|apartment|studio|BR/i.test(textBody)
                  } }
                  console.info(JSON.stringify(logObj))
                } catch {}
              }
              if (dry_run && (r as any).sample && samples.length < Number(((req.body || {}).preview_limit || 20))) samples.push((r as any).sample)
              if (dry_run && (r as any).sample && parsedResults.length < Number(((req.body || {}).preview_limit || 20))) {
                const s = (r as any).sample
                parsedResults.push({ uid, confirmation_code: s?.confirmation_code, guest_name: s?.guest_name, listing_name: s?.listing_name, checkin: s?.checkin, checkout: s?.checkout, you_earn: s?.price, cleaning_fee: s?.cleaning_fee, nights: s?.nights })
              }
            } catch (e: any) {
              stats.failed++
              failedDetails.push({ uid, reason: 'fetch_failed' })
            } finally {
              if (mode === 'incremental') { if (uid > lastUid) lastUid = uid }
            }
            if ((i + 1) % commit_every === 0) {
              if (mode === 'incremental') await setEmailStateIncremental(acc.user, lastUid); else await setEmailStateBackfill(acc.user)
            }
          }
          if (mode === 'incremental') await setEmailStateIncremental(acc.user, lastUid); else await setEmailStateBackfill(acc.user)
          if (uids.length < max_messages) break
          if (debugUids && debugUids.length) break
        }
        try { await client.logout() } catch {}
      }
      return dry_run ? { ...stats, parsed_results: parsedResults, failed_details: failedDetails.slice(0,20) } : { ...stats, failed_details: failedDetails.slice(0,20) }
    })
    return res.json(result)
  } catch (e: any) {
    const status = Number(e?.status || 500)
    return res.status(status).json({ message: e?.message || 'sync failed' })
  }
})