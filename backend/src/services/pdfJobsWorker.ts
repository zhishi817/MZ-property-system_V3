import jwt from 'jsonwebtoken'
import { PDFDocument } from 'pdf-lib'
import { hasPg, pgPool } from '../dbAdapter'
import { hasR2, r2Upload } from '../r2'
import { ensurePdfJobsSchema } from './pdfJobsSchema'
import { getChromiumBrowser, resetChromiumBrowser } from '../lib/playwright'
import { waitForImages } from '../lib/waitForImages'
import { generateWorkRecordPdf, type WorkRecordPdfKind, type WorkRecordPdfPhotosMode } from '../lib/workRecordPdf'
import { generateStatementPhotoPackPdf, type StatementPhotoPackSection } from '../lib/monthlyStatementPhotoPack'
import { collectMonthlyInvoiceAttachments } from '../lib/monthlyStatementInvoiceAttachments'
import { reconcileMonthlyAutoExpenses } from '../lib/monthlyStatementExpenseReconcile'

export type PdfJobFile = {
  kind: string
  name: string
  path: string
  url: string
  size_bytes: number
  page_count: number
  part_no?: number
  source_count?: number
}

export type PdfJobsWorkerResult = { processed: number; ok: number; failed: number; reclaimed: number }

const SECRET = process.env.JWT_SECRET || 'dev-secret'

let schemaMissingLogged = false

type PdfJobHandler = (job: any, ctx: { workerId: string }) => Promise<void>

const handlers: Record<string, PdfJobHandler> = {
  merge_monthly_pack: async (job, ctx) => runMergeMonthlyPack(job, ctx.workerId),
  maintenance_record_pdf: async (job, ctx) => runWorkRecordPdfJob(job, ctx.workerId, 'maintenance'),
  deep_cleaning_record_pdf: async (job, ctx) => runWorkRecordPdfJob(job, ctx.workerId, 'deep_cleaning'),
  statement_photo_pack: async (job, ctx) => runStatementPhotoPack(job, ctx.workerId),
}

function msEnv(name: string, defMs: number): number {
  const raw = Number(process.env[name] || defMs)
  if (!Number.isFinite(raw)) return defMs
  return Math.max(0, Math.floor(raw))
}

async function applyTxTimeouts(client: any) {
  const lockTimeoutMs = msEnv('PDF_JOBS_LOCK_TIMEOUT_MS', 2000)
  const statementTimeoutMs = msEnv('PDF_JOBS_STATEMENT_TIMEOUT_MS', 60000)
  const idleTimeoutMs = msEnv('PDF_JOBS_IDLE_IN_TX_TIMEOUT_MS', 60000)
  if (lockTimeoutMs) await client.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`)
  if (statementTimeoutMs) await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`)
  if (idleTimeoutMs) await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${idleTimeoutMs}`)
}

function backoffMinutes(attempts: number) {
  const n = Math.max(1, Number(attempts || 0))
  if (n <= 1) return 1
  if (n === 2) return 5
  return 30
}

function classifyError(e: any): { retriable: boolean; code: string; message: string } {
  const code = String(e?.code || '')
  const message = String(e?.message || '')
  const retriableCodes = new Set(['40001', '40P01', '55P03', '57014', '53300', '57P01', '57P02', '57P03'])
  const nonRetriableCodes = new Set([
    '23503',
    '23505',
    '42501',
    '42P01',
    '42703',
    'NO_PHOTOS_TO_RENDER',
    'PHOTO_ASSETS_UNREACHABLE',
    'PHOTO_PACK_RENDER_EMPTY',
    'PHOTO_PREFLIGHT_FAILED',
    'PHOTO_LOAD_INCOMPLETE',
    'MERGE_ATTACHMENT_PREFLIGHT_FAILED',
  ])
  if (code === 'PDF_JOBS_SCHEMA_MISSING' || code === 'JOB_INVALID') return { retriable: false, code, message }
  if (nonRetriableCodes.has(code)) return { retriable: false, code, message }
  if (retriableCodes.has(code)) return { retriable: true, code, message }
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE') return { retriable: true, code, message }
  if (/timeout/i.test(message)) return { retriable: true, code, message }
  return { retriable: true, code, message }
}

async function reclaimExpiredLeases(): Promise<number> {
  if (!hasPg || !pgPool) return 0
  const r = await pgPool.query(
    `UPDATE pdf_jobs
     SET status='queued',
         progress=0,
         stage='queued',
         lease_expires_at=NULL,
         locked_by=NULL,
         running_started_at=NULL,
         last_error_code='lease_reclaimed',
         last_error_message='lease_expired_reclaimed',
         updated_at=now()
     WHERE status='running'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at < now()`
  )
  return Number(r?.rowCount || 0)
}

async function claimJobs(limit: number, workerId: string): Promise<any[]> {
  if (!hasPg || !pgPool) return []
  const n = Math.max(1, Math.min(10, Number(limit || 3)))
  const client = await pgPool.connect()
  try {
    await client.query('BEGIN')
    await applyTxTimeouts(client)
    const leaseSec = Math.max(30, Math.min(30 * 60, Number(process.env.PDF_JOBS_LEASE_SECONDS || 8 * 60)))
    const r = await client.query(
      `WITH picked AS (
         SELECT id
         FROM pdf_jobs
         WHERE status='queued' AND next_retry_at <= now()
         ORDER BY next_retry_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE pdf_jobs j
       SET status='running',
           attempts=j.attempts+1,
           progress=1,
           stage='running',
           running_started_at=COALESCE(j.running_started_at, now()),
           locked_by=$2,
           lease_expires_at=now() + ($3 || ' seconds')::interval,
           updated_at=now()
       FROM picked
       WHERE j.id = picked.id
       RETURNING j.*`,
      [n, workerId, String(leaseSec)]
    )
    await client.query('COMMIT')
    return r?.rows || []
  } catch (e: any) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    try { client.release() } catch {}
  }
}

async function updateJob(id: string, patch: Partial<{ status: string; progress: number; stage: string; detail: string; result_files: PdfJobFile[]; last_error_code: string | null; last_error_message: string | null; locked_by: string | null; lease_expires_at: any | null }>) {
  if (!pgPool) return
  const sets: string[] = []
  const vals: any[] = [id]
  let i = 2
  const add = (col: string, v: any, cast?: string) => {
    sets.push(`${col}=$${i}${cast ? `::${cast}` : ''}`)
    vals.push(v)
    i++
  }
  if (patch.status !== undefined) add('status', patch.status)
  if (patch.progress !== undefined) add('progress', patch.progress)
  if (patch.stage !== undefined) add('stage', patch.stage)
  if (patch.detail !== undefined) add('detail', patch.detail)
  if (patch.result_files !== undefined) add('result_files', JSON.stringify(patch.result_files || []), 'jsonb')
  if (patch.last_error_code !== undefined) add('last_error_code', patch.last_error_code)
  if (patch.last_error_message !== undefined) add('last_error_message', patch.last_error_message)
  if (patch.locked_by !== undefined) add('locked_by', patch.locked_by)
  if (patch.lease_expires_at !== undefined) add('lease_expires_at', patch.lease_expires_at)
  sets.push('updated_at=now()')
  await pgPool.query(`UPDATE pdf_jobs SET ${sets.join(', ')} WHERE id=$1`, vals)
}

function internalAuthToken() {
  const payload: any = { sub: 'u-pdf-job', role: 'admin', username: 'pdf_job' }
  return jwt.sign(payload, SECRET, { expiresIn: `${Math.max(1, Number(process.env.PDF_JOB_TOKEN_HOURS || 2))}h` })
}

function frontBaseUrl(): string {
  const front = String(process.env.FRONTEND_BASE_URL || '').trim()
  if (!front) throw new Error('missing FRONTEND_BASE_URL')
  try {
    let local = false
    try {
      const u = new URL(front)
      const h = String(u.hostname || '').toLowerCase()
      local = h === 'localhost' || h === '127.0.0.1'
    } catch {}
    console.log(`[pdf-jobs][worker] FRONTEND_BASE_URL=${front} is_local=${local ? '1' : '0'}`)
  } catch {}
  return front
}

function apiBaseForAssets(): string {
  const apiBase = String(
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_DEV ||
    process.env.NEXT_PUBLIC_API_BASE ||
    process.env.API_BASE ||
    process.env.FRONTEND_BASE_URL ||
    ''
  ).trim()
  try { console.log(`[pdf-jobs][worker] API_BASE_RESOLVED=${apiBase || '(empty)'}`) } catch {}
  return apiBase
}

function cookieBase(baseUrl: string, token: string) {
  const isHttps = /^https:\/\//i.test(baseUrl)
  return {
    name: 'auth',
    value: token,
    url: baseUrl,
    sameSite: isHttps ? 'None' : 'Lax',
    secure: isHttps,
  }
}

function vercelBypassSecret(): string {
  return String(
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET ||
    process.env.VERCEL_PROTECTION_BYPASS_SECRET ||
    process.env.VERCEL_PROTECTION_BYPASS ||
    ''
  ).trim()
}

async function pdfPageCount(buf: Buffer): Promise<number> {
  try {
    const doc = await PDFDocument.load(new Uint8Array(buf))
    return doc.getPageCount()
  } catch {
    return 0
  }
}

async function generateStatementBasePdf(opts: { jobId: string; month: string; property_id: string; showChinese: boolean; excludeOrphanFixedSnapshots: boolean; carryStartMonth?: string }): Promise<{ pdf: Buffer; diagnostics: any }> {
  const front = frontBaseUrl()
  const token = internalAuthToken()
  const bypass = vercelBypassSecret()
  const url = (() => {
    const u = new URL('/public/monthly-statement-print', front)
    u.searchParams.set('pid', opts.property_id)
    u.searchParams.set('month', opts.month)
    u.searchParams.set('pdf', '1')
    u.searchParams.set('showChinese', opts.showChinese ? '1' : '0')
    u.searchParams.set('photos', 'off')
    u.searchParams.set('sections', 'base')
    u.searchParams.set('exclude_orphan_fixed', opts.excludeOrphanFixedSnapshots ? '1' : '0')
    u.searchParams.set('carry_start_month', /^\d{4}-\d{2}$/.test(String(opts.carryStartMonth || '').trim()) ? String(opts.carryStartMonth).trim() : '2026-01')
    if (bypass) u.searchParams.set('x-vercel-protection-bypass', bypass)
    return u.toString()
  })()
  try { console.log(`[pdf-jobs][worker] goto_url=${url}`) } catch {}
  const apiBase = apiBaseForAssets()
  const isTargetClosed = (e: any) => /(Target page, context or browser has been closed|browser has been closed|browser disconnected|Target closed)/i.test(String(e?.message || ''))
  for (let attempt = 0; attempt < 2; attempt++) {
    const browser = await getChromiumBrowser()
    let context: any = null
    const diag: any = { url, console: [] as string[], pageErrors: [] as string[], requestFails: [] as string[], badResponses: [] as string[], apiCalls: [] as string[], stats: null as any }
    try {
      const extraHTTPHeaders = bypass ? { 'x-vercel-protection-bypass': bypass, 'x-vercel-set-bypass-cookie': 'true' } : undefined
      try { context = await browser.newContext(extraHTTPHeaders ? { extraHTTPHeaders } : undefined) } catch (e: any) {
        if (!isTargetClosed(e)) throw e
        await resetChromiumBrowser()
        const b2 = await getChromiumBrowser()
        context = await b2.newContext(extraHTTPHeaders ? { extraHTTPHeaders } : undefined)
      }
      const cookieTargets = Array.from(new Set([front, apiBase].map(s => String(s || '').trim()).filter(Boolean)))
      if (cookieTargets.length) {
        await context.addCookies(cookieTargets.map((base) => cookieBase(base, token)) as any)
      }
      const page = await context.newPage()
      const pushCap = (arr: string[], s: string, cap = 30) => {
        const v = String(s || '').slice(0, 500)
        if (!v) return
        arr.push(v)
        if (arr.length > cap) arr.splice(0, arr.length - cap)
      }
      try {
        page.on('console', (msg: any) => {
          const t = String(msg?.type?.() || '')
          if (t === 'error' || t === 'warning') pushCap(diag.console, `${t}: ${String(msg?.text?.() || '')}`)
        })
        page.on('pageerror', (err: any) => pushCap(diag.pageErrors, String(err?.message || err || 'pageerror')))
        page.on('response', (resp: any) => {
          try {
            const st = Number(resp?.status?.() || 0)
            const u = String(resp?.url?.() || '')
            if (st >= 400) pushCap(diag.badResponses, `${u} (${st})`)
            if (/\/(orders|finance|properties|landlords)(\?|\/|$)/i.test(u)) pushCap(diag.apiCalls, `${u} (${st})`, 12)
          } catch {}
        })
        page.on('requestfailed', (req: any) => {
          const u = String(req?.url?.() || '')
          const ft = String(req?.failure?.()?.errorText || '')
          pushCap(diag.requestFails, ft ? `${u} (${ft})` : u)
        })
      } catch {}
      const navTimeoutMs = Math.max(5000, Math.min(120000, Number(process.env.PDF_NAV_TIMEOUT_MS || 45000)))
      const waitTimeoutMs = Math.max(5000, Math.min(120000, Number(process.env.PDF_WAIT_TIMEOUT_MS || 45000)))
      page.setDefaultTimeout(waitTimeoutMs)
      page.setDefaultNavigationTimeout(navTimeoutMs)
      try {
        let resp: any = null
        try {
          resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs })
        } catch (e: any) {
          const msg = String(e?.message || e || '')
          const navAborted = /net::ERR_ABORTED/i.test(msg)
          if (!navAborted) throw e
          try { console.log(`[pdf-jobs][worker] goto_aborted attempt=${attempt + 1} url=${url}`) } catch {}
          // Some production navigations are reported as aborted by Chromium even though
          // the print page keeps loading. Give the page a short grace period and continue
          // if the statement root shows up.
          await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
          await page.waitForSelector('[data-monthly-statement-root="1"]', { timeout: Math.min(waitTimeoutMs, 8000) }).catch(() => {})
        }
        const status = Number(resp?.status?.() || 0)
        if (status >= 400) {
          const title = await page.title().catch(() => '')
          const hint = status === 429
            ? '当前返回 429 Too Many Requests，通常表示 FRONTEND_BASE_URL 指向了错误的服务（后端/限流页），或目标站点被限流'
            : '当前返回非 200 页面，请确认 FRONTEND_BASE_URL 指向 Next 前端站点且存在 /public/monthly-statement-print'
          const e2: any = new Error(`print page http ${status}${title ? ` title=${title}` : ''} (${hint})`)
          e2.code = `HTTP_${status}`
          throw e2
        }
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
        await page.evaluate(() => (document as any).fonts?.ready).catch(() => {})
        await page.waitForSelector('[data-monthly-statement-root="1"]', { timeout: waitTimeoutMs })
        const u0 = String(page.url?.() || '')
        if (u0.includes('/login')) throw new Error('print page redirected to /login')
        await page.waitForFunction(() => {
          const el = document.querySelector('[data-monthly-statement-root="1"]') as any
          if (!el) return false
          const ready = String(el.getAttribute('data-monthly-statement-ready') || '') === '1'
          return ready
        }, { timeout: waitTimeoutMs } as any)
        try {
          diag.stats = await page.evaluate(() => {
            const root = document.querySelector('[data-monthly-statement-root="1"]') as HTMLElement | null
            const rows = document.querySelectorAll('[data-monthly-statement-root="1"] [data-statement-row="1"]').length
            const tables = document.querySelectorAll('[data-monthly-statement-root="1"] table').length
            const cookieHasAuth = typeof document !== 'undefined' ? (document.cookie || '').includes('auth=') : false
            return { hasRoot: !!root, statementRows: rows, tables, cookieHasAuth, href: String(location?.href || '') }
          })
        } catch {}
        const authFailed = Array.isArray(diag.badResponses) && diag.badResponses.some((s: string) => /\((401|403)\)\s*$/.test(String(s || '')))
        if (authFailed) throw Object.assign(new Error('print page has unauthorized api responses (401/403)'), { code: 'PRINT_AUTH' })
        if (diag?.stats?.cookieHasAuth === false) throw Object.assign(new Error('print page missing auth cookie'), { code: 'PRINT_AUTH' })
        const rows = Number(diag?.stats?.statementRows || 0) || 0
        const rf = Array.isArray(diag?.requestFails) ? diag.requestFails.length : 0
        const br = Array.isArray(diag?.badResponses) ? diag.badResponses.length : 0
        if (!rows && (rf || br)) throw Object.assign(new Error(`print page got empty statement rows=0 with request_fail=${rf} http>=400=${br}`), { code: 'PRINT_EMPTY' })
      } catch (e: any) {
        try {
          const pu = String(page.url?.() || '')
          const html = await page.content().catch(() => '')
          console.log(`[pdf-jobs][worker] page_debug attempt=${attempt + 1} page_url=${pu}`)
          if (html) console.log(String(html).slice(0, 2000))
        } catch {}
        const msg = String(e?.message || e || '')
        if (/ERR_CONNECTION_REFUSED/i.test(msg) && /localhost|127\.0\.0\.1/i.test(url)) {
          const e2: any = new Error(`${msg} (worker 无法访问 ${url}；请把后端环境变量 FRONTEND_BASE_URL 设置为线上前端域名，而不是 localhost)`)
          if (e?.code) e2.code = e.code
          throw e2
        }
        throw e
      }
      await waitForImages(page, { timeoutMs: 20000, scroll: true, maxFailedUrls: 8 }).catch(() => ({ total: 0, notLoaded: 0, failedUrls: [] as string[] }))
      await page.waitForTimeout(200)
      await page.emulateMedia({ media: 'print' } as any)
      const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true })
      return { pdf: Buffer.from(pdf), diagnostics: diag }
    } catch (e: any) {
      if (attempt === 0 && isTargetClosed(e)) {
        try { console.log(`[pdf-jobs][worker] target_closed_retry message=${String(e?.message || '')}`) } catch {}
        await resetChromiumBrowser().catch(() => {})
      } else {
        throw e
      }
    } finally {
      try { await context?.close?.() } catch {}
    }
  }
  throw new Error('generateStatementBasePdf failed')
}

async function preflightUrls(urls: string[], kind: 'image' | 'attachment'): Promise<{ ok: string[]; failed: string[]; skipped: string[] }> {
  const unique = Array.from(new Set(urls.map((u) => String(u || '').trim()).filter(Boolean)))
  if (!unique.length) return { ok: [], failed: [], skipped: [] }
  const timeoutMs = Math.max(2000, Math.min(20000, Number(process.env.PDF_PREFLIGHT_TIMEOUT_MS || 7000)))
  const concurrency = Math.max(2, Math.min(12, Number(process.env.PDF_PREFLIGHT_CONCURRENCY || 6)))
  const maxChecks = kind === 'attachment'
    ? Math.max(0, Math.min(40, Number(process.env.MERGE_ATTACHMENT_PREFLIGHT_MAX || 12)))
    : unique.length
  const inspect = kind === 'attachment' ? unique.slice(0, maxChecks) : unique
  const skipped = kind === 'attachment' ? unique.slice(maxChecks) : []
  const ok: string[] = []
  const failed: string[] = []
  let idx = 0
  const workers = Array.from({ length: Math.min(concurrency, inspect.length) }, async () => {
    while (true) {
      const cur = idx++
      if (cur >= inspect.length) break
      const u = inspect[cur]
      const ac = new AbortController()
      const t = setTimeout(() => { try { ac.abort() } catch {} }, timeoutMs)
      try {
        let r: any
        try {
          r = await fetch(u, { method: kind === 'attachment' ? 'HEAD' : 'GET', signal: ac.signal } as any)
          if (kind === 'attachment' && (r?.status === 405 || r?.status === 403)) throw new Error(`head_unsupported:${String(r?.status || '')}`)
        } catch (e: any) {
          if (kind === 'attachment' && /^head_unsupported:/i.test(String(e?.message || ''))) {
            r = await fetch(u, { method: 'GET', signal: ac.signal } as any)
          } else {
            throw e
          }
        }
        const ct = String(r?.headers?.get?.('content-type') || '').toLowerCase()
        try { await r?.body?.cancel?.() } catch {}
        if (!r?.ok) throw new Error(`http_${String(r?.status || '')}`)
        if (kind === 'image' && ct && !ct.startsWith('image/')) throw new Error(`invalid_content_type:${ct}`)
        ok.push(u)
      } catch {
        failed.push(u)
      } finally {
        clearTimeout(t)
      }
    }
  })
  await Promise.all(workers)
  return { ok, failed, skipped }
}

function workRecordPhotosMode(job: any): WorkRecordPdfPhotosMode {
  const raw = String(job?.params?.quality_mode || '').trim().toLowerCase()
  if (raw === 'full' || raw === 'compressed' || raw === 'thumbnail') return raw as WorkRecordPdfPhotosMode
  return 'compressed'
}

async function runWorkRecordPdfJob(job: any, workerId: string, kind: WorkRecordPdfKind) {
  if (!hasPg || !pgPool) throw new Error('no database configured')
  if (!hasR2) throw new Error('R2 not configured')
  const id = String(job?.id || '').trim()
  const recordId = String(job?.params?.record_id || '').trim()
  const showChinese = !!job?.params?.showChinese
  if (!id || !recordId) {
    const e: any = new Error('invalid work record pdf job params')
    e.code = 'JOB_INVALID'
    throw e
  }
  await updateJob(id, { progress: 8, stage: 'collect_images', detail: '正在收集图片...', locked_by: workerId })
  const initialMode = workRecordPhotosMode(job)
  let mode = initialMode
  let built = await generateWorkRecordPdf({
    recordId,
    kind,
    showChinese,
    apiBase: String(process.env.API_BASE || process.env.NEXT_PUBLIC_API_BASE_URL || '').trim(),
    photosMode: mode,
  })
  if (built.imageCount > 6 && mode !== 'thumbnail') {
    mode = 'thumbnail'
    await updateJob(id, { progress: 18, stage: 'compress_images', detail: '图片较多，正在切换为缩略图模式...', locked_by: workerId })
    built = await generateWorkRecordPdf({
      recordId,
      kind,
      showChinese,
      apiBase: String(process.env.API_BASE || process.env.NEXT_PUBLIC_API_BASE_URL || '').trim(),
      photosMode: mode,
    })
  }
  await updateJob(id, { progress: 72, stage: 'uploading', detail: 'PDF 已生成，正在上传文件...', locked_by: workerId })
  const key = `pdf-jobs/work-records/${kind}/${id}.pdf`
  const url = await r2Upload(key, 'application/pdf', built.pdf)
  const file: PdfJobFile = {
    kind: 'work_record_pdf',
    name: built.filename,
    path: key,
    url,
    size_bytes: built.pdf.byteLength,
    page_count: 0,
    source_count: built.imageCount,
  }
  const warning = built.notLoaded > 0 ? `；图片加载警告 ${built.notLoaded} 张` : ''
  await updateJob(id, {
    status: 'success',
    progress: 100,
    stage: 'done',
    detail: `已生成 PDF（模式：${mode}，图片 ${built.imageCount} 张${warning}）`,
    result_files: [file],
    locked_by: null,
    lease_expires_at: null,
    last_error_code: null,
    last_error_message: null,
  })
}

function statementPhotoPackSection(job: any): StatementPhotoPackSection {
  const raw = String(job?.params?.sections || 'all').trim().toLowerCase()
  if (raw === 'maintenance' || raw === 'deep_cleaning') return raw as StatementPhotoPackSection
  return 'all'
}

function statementPhotoPackQualityMode(job: any): 'compressed' | 'thumbnail' {
  const raw = String(job?.params?.quality_mode || '').trim().toLowerCase()
  if (raw === 'thumbnail') return 'thumbnail'
  return 'compressed'
}

async function runStatementPhotoPack(job: any, workerId: string) {
  if (!hasPg || !pgPool) throw Object.assign(new Error('no_pg'), { code: 'JOB_INVALID' })
  if (!hasR2) throw Object.assign(new Error('R2 not configured'), { code: 'JOB_INVALID' })
  const id = String(job?.id || '').trim()
  const params = (job?.params || {}) as any
  const monthKey = String(params?.month || params?.month_key || '').trim()
  const pid = String(params?.property_id || params?.pid || '').trim()
  const sections = statementPhotoPackSection(job)
  if (!id || !/^\d{4}-\d{2}$/.test(monthKey) || !pid) throw Object.assign(new Error('invalid_job_params'), { code: 'JOB_INVALID' })
  const showChinese = params?.showChinese !== false
  await updateJob(id, { progress: 5, stage: 'load_rows', detail: '正在读取照片记录...', locked_by: workerId })
  const preferredMode = statementPhotoPackQualityMode(job)
  const jobStartedAt = Date.now()
  let built = await generateStatementPhotoPackPdf({
    month: monthKey,
    propertyId: pid,
    sections,
    showChinese,
    apiBase: apiBaseForAssets(),
    photosMode: preferredMode,
    onStage: async (stage, detail, meta) => {
      const progressByStage: Record<string, number> = {
        load_rows: 8,
        normalize_urls: 14,
        prefetch_validate: 26,
        wait_images: 48,
        render_pdf: 68,
      }
      await updateJob(id, { progress: progressByStage[stage] || 8, stage, detail, locked_by: workerId })
      try {
        if (meta) console.log(`[statement-photo-pack][worker] stage job_id=${id} stage=${stage} detail=${detail} meta=${JSON.stringify(meta)}`)
      } catch {}
    },
  })
  if (built.imageCount > 6 && built.effectivePhotosMode !== 'thumbnail') {
    await updateJob(id, { progress: 22, stage: 'compress_images', detail: '照片较多，正在切换为缩略图模式...', locked_by: workerId })
    built = await generateStatementPhotoPackPdf({
      month: monthKey,
      propertyId: pid,
      sections,
      showChinese,
      apiBase: apiBaseForAssets(),
      photosMode: 'thumbnail',
    })
  }
  try {
    const samples = (Array.isArray(built.failedUrls) ? built.failedUrls : []).slice(0, 3).join(' | ')
    console.log(
      `[statement-photo-pack][worker] job_id=${id} property_id=${pid} month=${monthKey} sections=${sections} mode=${built.effectivePhotosMode} rawUrls=${built.rawUrls} cleanedUrls=${built.cleanedUrls} imageCount=${built.imageCount} notLoaded=${built.notLoaded} failedCount=${Array.isArray(built.failedUrls) ? built.failedUrls.length : 0}${samples ? ` sampleFailedUrls=${samples}` : ''} metrics=${JSON.stringify(built.metrics || {})}`
    )
  } catch {}
  await updateJob(id, { progress: 76, stage: 'uploading', detail: 'PDF 已生成，正在上传文件...', locked_by: workerId })
  const suffix = sections === 'maintenance' ? 'maintenance' : sections === 'deep_cleaning' ? 'deep-cleaning' : 'all'
  const key = `pdf-jobs/statement-photo-pack/${monthKey}/${pid}/${suffix}/${id}.pdf`
  const uploadStartedAt = Date.now()
  const url = await r2Upload(key, 'application/pdf', built.pdf)
  const uploadMs = Date.now() - uploadStartedAt
  const pageCount = await pdfPageCount(built.pdf)
  const file: PdfJobFile = {
    kind: 'statement_photo_pack_pdf',
    name: built.filename,
    path: key,
    url,
    size_bytes: built.pdf.byteLength,
    page_count: pageCount,
    source_count: built.imageCount,
  }
  await updateJob(id, {
    status: 'success',
    progress: 100,
    stage: 'done',
    detail: `已生成照片 PDF（模式：${built.effectivePhotosMode}，${built.detail}，页数 ${pageCount}，上传 ${uploadMs}ms，总耗时 ${Date.now() - jobStartedAt}ms）`,
    result_files: [file],
    locked_by: null,
    lease_expires_at: null,
    last_error_code: null,
    last_error_message: null,
  })
}

function allowedHostsSet(): Set<string> {
  const hosts = new Set<string>()
  const addHost = (h: string) => { if (h) hosts.add(h.toLowerCase()) }
  const envs = [process.env.API_BASE, process.env.NEXT_PUBLIC_API_BASE_URL, process.env.NEXT_PUBLIC_API_BASE_DEV, process.env.NEXT_PUBLIC_API_BASE, process.env.R2_PUBLIC_BASE_URL, process.env.R2_PUBLIC_BASE, process.env.R2_ENDPOINT]
  for (const e of envs) {
    try { if (e) addHost(new URL(String(e)).host) } catch {}
  }
  return hosts
}

async function fetchBytes(u: string, allowedHosts: Set<string>): Promise<Uint8Array> {
  const raw = String(u || '').trim()
  if (!raw) throw new Error('invalid url')
  const url = raw.startsWith('/') ? (() => {
    const base = apiBaseForAssets()
    if (!base) throw new Error('missing api base for relative url')
    return `${base}${raw}`
  })() : raw
  const uu = new URL(url)
  const proto = uu.protocol.toLowerCase()
  if (proto !== 'http:' && proto !== 'https:') throw new Error('invalid protocol')
  if (allowedHosts.size && !allowedHosts.has(uu.host.toLowerCase())) throw new Error('disallowed host')
  const timeoutMs = Math.max(1000, Math.min(180000, Number(process.env.MERGE_FETCH_TIMEOUT_MS || 20000)))
  const ac = new AbortController()
  const t = setTimeout(() => { try { ac.abort() } catch {} }, timeoutMs)
  let r: any
  try {
    r = await fetch(url, { signal: ac.signal } as any)
  } finally {
    clearTimeout(t)
  }
  if (!r.ok) throw new Error(`fetch failed: ${r.status}`)
  const ab = await r.arrayBuffer()
  return new Uint8Array(ab)
}

async function mergeStatementWithInvoices(statementPdf: Buffer, invoiceUrls: string[], maxPerPart: number, maxSourceBytes: number): Promise<{ files: { buf: Buffer; kind: string; part_no: number; source_count: number }[]; failed: string[] }> {
  const srcStatement = await PDFDocument.load(new Uint8Array(statementPdf))
  const statementPageIndices = srcStatement.getPageIndices()
  const allowedHosts = allowedHostsSet()
  const files: { buf: Buffer; kind: string; part_no: number; source_count: number }[] = []
  const failed: string[] = []
  const maxN = Math.max(1, Math.min(80, Number(maxPerPart || 25)))
  const maxB = Math.max(2 * 1024 * 1024, Math.min(80 * 1024 * 1024, Number(maxSourceBytes || 20 * 1024 * 1024)))
  let batch: string[] = []
  let batchBytes = 0
  let partNo = 1
  const flush = async (includeStatement: boolean) => {
    if (!batch.length) return
    const merged = await PDFDocument.create()
    if (includeStatement) {
      const copied = await merged.copyPages(srcStatement, statementPageIndices)
      copied.forEach(p => merged.addPage(p))
    }
    for (const u of batch) {
      try {
        if (/\.pdf($|\?)/i.test(u || '')) {
          const bytes = await fetchBytes(u, allowedHosts)
          const src = await PDFDocument.load(bytes)
          const copied = await merged.copyPages(src, src.getPageIndices())
          copied.forEach(p => merged.addPage(p))
        } else if (/\.(png|jpg|jpeg)($|\?)/i.test(u || '')) {
          const bytes = await fetchBytes(u, allowedHosts)
          const img = /\.png($|\?)/i.test(u || '') ? await merged.embedPng(bytes) : await merged.embedJpg(bytes)
          const page = merged.addPage([595, 842])
          const maxW = 595 - 60
          const maxH = 842 - 60
          const scale = Math.min(maxW / img.width, maxH / img.height)
          const w = img.width * scale
          const h = img.height * scale
          const x = (595 - w) / 2
          const y = (842 - h) / 2
          page.drawImage(img, { x, y, width: w, height: h })
        }
      } catch {
        failed.push(u)
      }
    }
    const out = await merged.save({ useObjectStreams: false })
    files.push({ buf: Buffer.from(out), kind: includeStatement ? 'statement_merged_invoices' : 'invoices_part', part_no: partNo, source_count: batch.length })
    partNo++
    batch = []
    batchBytes = 0
  }
  let first = true
  for (const u of invoiceUrls) {
    const approx = 512 * 1024
    if (batch.length && (batch.length >= maxN || batchBytes + approx > maxB)) {
      await flush(first)
      first = false
    }
    batch.push(u)
    batchBytes += approx
  }
  await flush(first)
  return { files, failed }
}

async function runMergeMonthlyPack(job: any, workerId: string) {
  if (!hasPg || !pgPool) throw Object.assign(new Error('no_pg'), { code: 'JOB_INVALID' })
  if (!hasR2) throw Object.assign(new Error('R2 not configured'), { code: 'JOB_INVALID' })
  const id = String(job?.id || '').trim()
  const params = (job?.params || {}) as any
  const monthKey = String(params?.month || params?.month_key || '').trim()
  const pid = String(params?.property_id || params?.pid || '').trim()
  if (!id || !/^\d{4}-\d{2}$/.test(monthKey) || !pid) throw Object.assign(new Error('invalid_job_params'), { code: 'JOB_INVALID' })
  const showChinese = params?.showChinese !== false
  const excludeOrphans = !!params?.excludeOrphanFixedSnapshots
  const carryStartMonth = /^\d{4}-\d{2}$/.test(String(params?.carryStartMonth || '').trim()) ? String(params.carryStartMonth).trim() : '2026-01'
  const mergeInvoices = params?.mergeInvoices !== false
  const jobStartedAt = Date.now()
  await updateJob(id, { progress: 2, stage: 'reconcile_expenses', detail: '正在同步维修/深清支出...', locked_by: workerId })
  await reconcileMonthlyAutoExpenses({ monthKey, propertyId: pid })
  await updateJob(id, { progress: 3, stage: 'render_statement', detail: '正在生成主报表（无照片版）...', locked_by: workerId })
  const renderStartedAt = Date.now()
  const gen = await generateStatementBasePdf({ jobId: id, month: monthKey, property_id: pid, showChinese, excludeOrphanFixedSnapshots: excludeOrphans, carryStartMonth })
  const renderMs = Date.now() - renderStartedAt
  const statementPdf = gen.pdf
  const statementPages = await pdfPageCount(statementPdf)
  const diag = (gen as any)?.diagnostics || null
  const diagSummary = (() => {
    try {
      if (!diag) return ''
      const parts: string[] = []
      const rf = Array.isArray(diag?.requestFails) ? diag.requestFails.length : 0
      const br = Array.isArray(diag?.badResponses) ? diag.badResponses.length : 0
      const ce = Array.isArray(diag?.console) ? diag.console.length : 0
      const pe = Array.isArray(diag?.pageErrors) ? diag.pageErrors.length : 0
      const rows = Number(diag?.stats?.statementRows || 0) || 0
      const cookie = diag?.stats?.cookieHasAuth === false ? 'cookie_auth=0' : ''
      const hosts = (() => {
        try {
          const arr: string[] = []
          const pushHost = (u: string) => { try { arr.push(new URL(u).host) } catch {} }
          for (const s of ([] as string[]).concat(diag?.apiCalls || [], diag?.badResponses || [], diag?.requestFails || [])) {
            const u = String(s || '').split(' (')[0]
            if (/^https?:\/\//i.test(u)) pushHost(u)
          }
          return Array.from(new Set(arr.map(h => h.toLowerCase()).filter(Boolean)))
        } catch { return [] as string[] }
      })()
      parts.push(`rows=${rows}`)
      if (rf) parts.push(`request_fail=${rf}`)
      if (br) parts.push(`http>=400=${br}`)
      if (ce) parts.push(`console=${ce}`)
      if (pe) parts.push(`pageerror=${pe}`)
      if (cookie) parts.push(cookie)
      if (hosts.length) parts.push(`api_hosts=${hosts.slice(0, 3).join('|')}${hosts.length > 3 ? `(+${hosts.length - 3})` : ''}`)
      return parts.length ? `；渲染诊断：${parts.join(',')}` : ''
    } catch {
      return ''
    }
  })()
  if (!statementPdf?.length) throw Object.assign(new Error('statement pdf is empty'), { code: 'PRINT_EMPTY' })
  if (statementPages <= 0) throw Object.assign(new Error('statement pdf page_count=0'), { code: 'PRINT_EMPTY' })
  const baseKey = `monthly-pack/${monthKey}/${pid}/${id}/statement_base.pdf`
  const baseUploadStartedAt = Date.now()
  const baseUrl = await r2Upload(baseKey, 'application/pdf', statementPdf)
  const baseUploadMs = Date.now() - baseUploadStartedAt
  const files: PdfJobFile[] = [{
    kind: 'statement_base',
    name: 'statement_base.pdf',
    path: baseKey,
    url: baseUrl,
    size_bytes: statementPdf.length,
    page_count: statementPages,
    part_no: 1,
    source_count: 1,
  }]
  await updateJob(id, { progress: 20, stage: 'statement_uploaded', detail: `主报表已生成（${statementPages}页，渲染 ${renderMs}ms，上传 ${baseUploadMs}ms）${diagSummary}`, result_files: files, locked_by: workerId })
  if (!mergeInvoices) {
    await updateJob(id, { status: 'success', progress: 100, stage: 'done', detail: `已生成主报表（未合并附件）${diagSummary}`, result_files: files, locked_by: null, lease_expires_at: null, last_error_code: null, last_error_message: null })
    return
  }
  await updateJob(id, { progress: 25, stage: 'collect_invoices', detail: `正在收集发票附件...${diagSummary}`, result_files: files, locked_by: workerId })
  const collectStartedAt = Date.now()
  const attachments = await collectMonthlyInvoiceAttachments({ propertyId: pid, monthKey, apiBase: apiBaseForAssets() })
  const invoiceUrls = attachments.map((x) => String(x.url || '').trim()).filter(Boolean)
  const collectMs = Date.now() - collectStartedAt
  if (!invoiceUrls.length) {
    await updateJob(id, { status: 'success', progress: 100, stage: 'done', detail: `未找到可合并的附件，已生成主报表（总耗时 ${Date.now() - jobStartedAt}ms）${diagSummary}`, result_files: files, locked_by: null, lease_expires_at: null, last_error_code: null, last_error_message: null })
    return
  }
  await updateJob(id, { progress: 32, stage: 'validate_invoices', detail: `正在校验发票附件（${invoiceUrls.length}）...${diagSummary}`, result_files: files, locked_by: workerId })
  const validateStartedAt = Date.now()
  const preflight = await preflightUrls(invoiceUrls, 'attachment')
  const validateMs = Date.now() - validateStartedAt
  const validInvoiceUrls = Array.from(new Set([...preflight.ok, ...preflight.skipped]))
  const invalidInvoiceUrls = preflight.failed
  const sampledCount = preflight.ok.length + preflight.failed.length
  const invalidRate = sampledCount > 0 ? invalidInvoiceUrls.length / sampledCount : 0
  const degraded = invalidInvoiceUrls.length > 0 && invalidRate >= Math.max(0.2, Math.min(1, Number(process.env.MERGE_ATTACHMENT_PREFLIGHT_FAIL_RATIO || 0.5)))
  await updateJob(id, {
    progress: 40,
    stage: 'merge_invoices',
    detail: `正在合并附件（有效 ${validInvoiceUrls.length} / 总计 ${invoiceUrls.length}，收集 ${collectMs}ms，校验 ${validateMs}ms${invalidInvoiceUrls.length ? `，预检失败 ${invalidInvoiceUrls.length}` : ''}${degraded ? '，部分附件失效将跳过' : ''}）...${diagSummary}`,
    result_files: files,
    locked_by: workerId,
  })
  if (!validInvoiceUrls.length) {
    await updateJob(id, { status: 'success', progress: 100, stage: 'done', detail: `附件全部失效，已生成主报表并跳过附件（收集 ${collectMs}ms，校验 ${validateMs}ms）${diagSummary}`, result_files: files, locked_by: null, lease_expires_at: null, last_error_code: null, last_error_message: null })
    return
  }
  const maxPerPart = Math.max(5, Math.min(60, Number(process.env.MERGE_INVOICE_MAX_PER_PART || 25)))
  const maxSourceBytes = Math.max(5 * 1024 * 1024, Math.min(80 * 1024 * 1024, Number(process.env.MERGE_INVOICE_MAX_SOURCE_BYTES || 20 * 1024 * 1024)))
  const mergeStartedAt = Date.now()
  const merged = await mergeStatementWithInvoices(statementPdf, validInvoiceUrls, maxPerPart, maxSourceBytes)
  const mergeMs = Date.now() - mergeStartedAt
  for (const f of merged.files) {
    const key = f.kind === 'statement_merged_invoices'
      ? `monthly-pack/${monthKey}/${pid}/${id}/statement_merged_invoices.pdf`
      : `monthly-pack/${monthKey}/${pid}/${id}/invoices_part_${String(f.part_no).padStart(2, '0')}.pdf`
    const uploadStartedAt = Date.now()
    const url = await r2Upload(key, 'application/pdf', f.buf)
    const uploadMs = Date.now() - uploadStartedAt
    const pages = await pdfPageCount(f.buf)
    files.push({
      kind: f.kind,
      name: f.kind === 'statement_merged_invoices' ? 'statement_merged_invoices.pdf' : `invoices_part_${String(f.part_no).padStart(2, '0')}.pdf`,
      path: key,
      url,
      size_bytes: f.buf.length,
      page_count: pages,
      part_no: f.part_no,
      source_count: f.source_count,
    })
    const p = Math.min(95, 35 + Math.round((files.length / (merged.files.length + 1)) * 55))
    await updateJob(id, { progress: p, stage: 'uploading', detail: `正在上传合并文件（${files.length - 1}/${merged.files.length}，上传 ${uploadMs}ms）...`, result_files: files, locked_by: workerId })
  }
  const failN = merged.failed.length + invalidInvoiceUrls.length
  const failSample = [...invalidInvoiceUrls, ...merged.failed].slice(0, 3).join(' | ')
  const detail = failN ? `合并完成（附件失败：${failN}，样例：${failSample}，合并 ${mergeMs}ms，总耗时 ${Date.now() - jobStartedAt}ms）${diagSummary}` : `合并完成（合并 ${mergeMs}ms，总耗时 ${Date.now() - jobStartedAt}ms）${diagSummary}`
  await updateJob(id, { status: 'success', progress: 100, stage: 'done', detail, result_files: files, locked_by: null, lease_expires_at: null, last_error_code: null, last_error_message: null })
}

async function markFailedOrRetry(job: any, info: { retriable: boolean; code: string; message: string }) {
  const id = String(job?.id || '')
  const attempts = Number(job?.attempts || 0)
  const maxAttempts = Number(job?.max_attempts || 3)
  const willRetry = info.retriable && attempts < maxAttempts
  if (willRetry) {
    const nextMin = backoffMinutes(attempts)
    await pgPool!.query(
      `UPDATE pdf_jobs
       SET status='queued',
           progress=0,
           stage='queued',
           next_retry_at=now() + ($2 || ':minutes')::interval,
           locked_by=NULL,
           lease_expires_at=NULL,
           last_error_code=$3,
           last_error_message=$4,
           updated_at=now()
       WHERE id=$1`,
      [id, String(nextMin), info.code || null, info.message || null]
    )
    return
  }
  await pgPool!.query(
    `UPDATE pdf_jobs
     SET status='failed',
         progress=100,
         stage='failed',
         locked_by=NULL,
         lease_expires_at=NULL,
         last_error_code=$2,
         last_error_message=$3,
         updated_at=now()
     WHERE id=$1`,
    [id, info.code || null, info.message || null]
  )
}

export async function processPdfJobsOnce(opts: { limit?: number } = {}): Promise<PdfJobsWorkerResult> {
  if (!hasPg || !pgPool) return { processed: 0, ok: 0, failed: 0, reclaimed: 0 }
  try {
    await ensurePdfJobsSchema()
  } catch (e: any) {
    if (String(e?.code || '') === 'PDF_JOBS_SCHEMA_MISSING') {
      if (!schemaMissingLogged) {
        schemaMissingLogged = true
        try { console.error('[pdf-jobs][worker] schema_missing table=pdf_jobs') } catch {}
      }
      return { processed: 0, ok: 0, failed: 0, reclaimed: 0 }
    }
    throw e
  }
  const reclaimed = await reclaimExpiredLeases().catch(() => 0)
  const workerId = String(process.env.PDF_JOBS_WORKER_ID || '') || `pdf_worker_${process.pid}`
  const jobs = await claimJobs(Number(opts.limit || 2), workerId)
  if (!jobs.length) {
    try {
      const r = await pgPool.query(
        `SELECT
           now() AS db_now,
           (SELECT count(1) FROM pdf_jobs WHERE status='queued') AS queued_total,
           (SELECT count(1) FROM pdf_jobs WHERE status='queued' AND next_retry_at <= now()) AS queued_due,
           (SELECT min(next_retry_at) FROM pdf_jobs WHERE status='queued') AS queued_min_next,
           (SELECT min(next_retry_at) FROM pdf_jobs WHERE status='queued' AND kind='merge_monthly_pack') AS mm_min_next,
           (SELECT count(1) FROM pdf_jobs WHERE status='queued' AND kind='merge_monthly_pack') AS mm_total,
           (SELECT count(1) FROM pdf_jobs WHERE status='queued' AND kind='merge_monthly_pack' AND next_retry_at <= now()) AS mm_due`
      )
      const row = r.rows?.[0] || null
      console.log(`[pdf-jobs][worker] claim none workerId=${workerId} queued_total=${Number(row?.queued_total || 0)} queued_due=${Number(row?.queued_due || 0)} mm_total=${Number(row?.mm_total || 0)} mm_due=${Number(row?.mm_due || 0)} queued_min_next=${row?.queued_min_next || ''} mm_min_next=${row?.mm_min_next || ''}`)
    } catch (e: any) {
      try { console.log(`[pdf-jobs][worker] claim none diag_failed workerId=${workerId} message=${String(e?.message || '')}`) } catch {}
    }
  }
  let ok = 0, failed = 0
  for (const job of jobs) {
    const jobId = String(job?.id || '')
    const kind = String(job?.kind || '')
    try {
      console.log(`[pdf-jobs][worker] run start jobId=${jobId} kind=${kind} attempts=${Number(job?.attempts || 0)}`)
      const handler = handlers[kind]
      if (!handler) throw Object.assign(new Error('unsupported_job_kind'), { code: 'JOB_INVALID' })
      await handler(job, { workerId })
      console.log(`[pdf-jobs][worker] run done jobId=${jobId} kind=${kind}`)
      ok++
    } catch (e: any) {
      const info = classifyError(e)
      console.log(`[pdf-jobs][worker] run failed jobId=${jobId} kind=${kind} code=${info.code} retriable=${info.retriable} message=${info.message}`)
      try { await markFailedOrRetry(job, info) } catch {}
      failed++
    }
  }
  return { processed: jobs.length, ok, failed, reclaimed }
}
