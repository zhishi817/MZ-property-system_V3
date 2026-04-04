import { API_BASE, authHeaders } from './api'

type PhotoPackJobStatus = {
  id: string
  status?: string
  progress?: number
  stage?: string
  detail?: string
  result_files?: any[]
  last_error_message?: string | null
}

function withTimeout(signalMs: number) {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(new DOMException('timeout', 'AbortError')), signalMs)
  return {
    signal: controller.signal,
    clear: () => window.clearTimeout(timer),
  }
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const ctl = withTimeout(timeoutMs)
  try {
    const resp = await fetch(url, { ...init, signal: ctl.signal })
    const json = await resp.json().catch(() => ({}))
    return { resp, json }
  } finally {
    ctl.clear()
  }
}

async function fetchBlobWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const ctl = withTimeout(timeoutMs)
  try {
    const resp = await fetch(url, { ...init, signal: ctl.signal })
    const blob = await resp.blob()
    return { resp, blob }
  } finally {
    ctl.clear()
  }
}

export async function runStatementPhotoPackJob(opts: {
  month: string
  propertyId: string
  sections: 'maintenance' | 'deep_cleaning' | 'all'
  showChinese?: boolean
  qualityMode?: 'compressed' | 'thumbnail'
  onUpdate?: (patch: { open?: boolean; stage?: string; detail?: string; progress?: number; timeout?: boolean }) => void
}) {
  const onUpdate = opts.onUpdate || (() => {})
  onUpdate({ open: true, stage: '创建任务', detail: '正在创建照片下载任务...', progress: 5, timeout: false })
  const create = await fetchJsonWithTimeout(`${API_BASE}/finance/statement-photo-pack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      month: opts.month,
      property_id: opts.propertyId,
      sections: opts.sections,
      showChinese: !!opts.showChinese,
      quality_mode: opts.qualityMode || 'compressed',
      forceNew: false,
    }),
  }, 30000)
  if (!create.resp.ok) throw new Error(String((create.json as any)?.message || `HTTP ${create.resp.status}`))
  const jobId = String((create.json as any)?.job_id || (create.json as any)?.id || '').trim()
  if (!jobId) throw new Error('创建任务失败（missing job_id）')
  onUpdate({ stage: '创建任务', detail: '任务已创建，正在生成 PDF...', progress: 10, timeout: false })
  const startedAt = Date.now()
  let pollCount = 0
  while (Date.now() - startedAt < 8 * 60 * 1000) {
    await new Promise((resolve) => window.setTimeout(resolve, Math.min(8000, 1500 + pollCount * 400)))
    pollCount += 1
    try {
      const st = await fetchJsonWithTimeout(`${API_BASE}/finance/statement-photo-pack/${encodeURIComponent(jobId)}`, { headers: authHeaders() }, 20000)
      if (!st.resp.ok) continue
      const s = (st.json || {}) as PhotoPackJobStatus
      const stage = String(s.stage || '')
      const detail = String(s.detail || '')
      onUpdate({
        stage: stage || '生成中',
        detail: detail || '正在处理...',
        progress: Number.isFinite(Number(s.progress || 0)) ? Number(s.progress || 0) : 0,
        timeout: false,
      })
      if (String(s.status || '') === 'failed' || stage === 'failed') {
        throw new Error(String(s.last_error_message || s.detail || '照片 PDF 生成失败'))
      }
      if (String(s.status || '') === 'success' && stage === 'done') {
        onUpdate({ stage: '准备下载', detail: 'PDF 已生成，正在下载...', progress: 96, timeout: false })
        const dl = await fetchBlobWithTimeout(`${API_BASE}/finance/statement-photo-pack/${encodeURIComponent(jobId)}/download`, { headers: authHeaders() }, 30000)
        if (!dl.resp.ok) {
          let msg = `HTTP ${dl.resp.status}`
          try {
            const txt = await dl.blob.text()
            const j = JSON.parse(txt)
            msg = String(j?.message || msg)
          } catch {}
          throw new Error(msg)
        }
        onUpdate({ stage: '完成', detail: '下载完成', progress: 100, timeout: false })
        return { blob: dl.blob, jobId, status: s }
      }
    } catch (e: any) {
      const timeout = String(e?.name || '') === 'AbortError'
      if (timeout) {
        onUpdate({ stage: '网络较慢', detail: '单次轮询超时，任务仍可能继续执行，正在重试...', timeout: true })
        continue
      }
      throw e
    }
  }
  onUpdate({ timeout: true, stage: '生成时间较长', detail: '照片 PDF 仍在后台处理中，请稍后重试。' })
  throw new Error('照片 PDF 生成时间较长，请稍后重试')
}
