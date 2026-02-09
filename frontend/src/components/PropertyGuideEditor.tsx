"use client"
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Card, Input, Space, Typography, Upload } from 'antd'
import type { UploadProps } from 'antd'
import { ClockCircleOutlined, CopyOutlined } from '@ant-design/icons'
import { API_BASE, authHeaders } from '../lib/api'
import { moveBlockToIndex as moveBlockToIndexAcrossSections, moveSectionToIndex as moveSectionToIndexAcross, arrayInsertMove as arrayInsertMovePure } from '../lib/guideDrag'

export type GuideStep = { title?: string; text?: string; url?: string; caption?: string }
export type GuideBlock =
  | { id?: string; type: 'heading'; text?: string }
  | { id?: string; type: 'text'; text?: string }
  | { id?: string; type: 'image'; url?: string; caption?: string }
  | { id?: string; type: 'steps'; title?: string; steps?: GuideStep[] }
  | { id?: string; type: 'wifi'; ssid?: string; password?: string; router_location?: string }
  | { id?: string; type: 'notice'; title?: string; items?: string[]; text?: string }

export type GuideSection = { id?: string; title?: string; blocks?: GuideBlock[] }
export type GuideMeta = {
  badge?: string
  title?: string
  address?: string
  cover_image_url?: string
  wifi_ssid?: string
  wifi_password?: string
  checkin_time?: string
  checkout_time?: string
}
export type GuideContent = { meta?: GuideMeta; sections?: GuideSection[] }

function makeId() {
  const c: any = (globalThis as any)?.crypto
  if (c?.randomUUID) return `gid-${c.randomUUID()}`
  return `gid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function normalizeContent(v: any): GuideContent {
  let seq = 0
  const nextId = () => `gid-${++seq}`
  const meta = (v && typeof v === 'object' && v.meta && typeof v.meta === 'object') ? v.meta : {}
  const sections = Array.isArray(v?.sections) ? v.sections : []
  const usedSectionIds = new Set<string>()
  const usedBlockIds = new Set<string>()
  return {
    meta: {
      badge: String((meta as any)?.badge || ''),
      title: String((meta as any)?.title || ''),
      address: String((meta as any)?.address || ''),
      cover_image_url: String((meta as any)?.cover_image_url || ''),
      wifi_ssid: String((meta as any)?.wifi_ssid || ''),
      wifi_password: String((meta as any)?.wifi_password || ''),
      checkin_time: String((meta as any)?.checkin_time || ''),
      checkout_time: String((meta as any)?.checkout_time || ''),
    },
    sections: sections.map((s: any) => {
      let sid = String(s?.id || '')
      if (!sid || usedSectionIds.has(sid)) sid = nextId()
      usedSectionIds.add(sid)
      const blocks = (Array.isArray(s?.blocks) ? s.blocks : []).map((b: any) => {
        let bid = String(b?.id || '')
        if (!bid || usedBlockIds.has(bid)) bid = nextId()
        usedBlockIds.add(bid)
        return { ...b, id: bid }
      })
      return { id: sid, title: s?.title || '', blocks }
    }),
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {}
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    ta.style.top = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export default function PropertyGuideEditor({
  value,
  onChange,
  property,
  language,
}: {
  value: GuideContent
  onChange: (v: GuideContent) => void
  property?: { code?: string; address?: string }
  language?: string
}) {
  const { message } = App.useApp()
  const isEn = String(language || '').trim().toLowerCase().startsWith('en')
  const [content, setContent] = useState<GuideContent>(() => normalizeContent(value))
  const [dragging, setDragging] = useState<{ kind: 'section'; sectionId: string } | { kind: 'block'; sectionId: string; blockId: string } | null>(null)
  const [dragOver, setDragOver] = useState<{ kind: 'section'; index: number } | { kind: 'block'; sectionId: string; index: number } | null>(null)
  const [selected, setSelected] = useState<{ kind: 'section'; id: string } | { kind: 'block'; id: string } | null>(null)
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null)
  const [bottomAddHover, setBottomAddHover] = useState(false)
  const contentRef = useRef<GuideContent>(content)
  const dragSnapshotRef = useRef<GuideContent | null>(null)
  const pendingDragRef = useRef<GuideContent | null>(null)
  const sectionsWrapRef = useRef<HTMLDivElement | null>(null)
  const dragCleanupRef = useRef<null | (() => void)>(null)
  const ghostRafRef = useRef<number | null>(null)
  const ghostNextRef = useRef<{ x: number; y: number; label: string } | null>(null)

  useEffect(() => {
    setContent(normalizeContent(value))
  }, [value])

  useEffect(() => {
    contentRef.current = content
  }, [content])

  useEffect(() => {
    return () => {
      try { dragCleanupRef.current?.() } catch {}
      dragCleanupRef.current = null
    }
  }, [])

  const sections = useMemo(() => (Array.isArray(content.sections) ? content.sections : []), [content])
  const meta = useMemo(() => ((content && typeof content === 'object' && content.meta && typeof content.meta === 'object') ? (content.meta as GuideMeta) : {}), [content])

  function commit(next: GuideContent) {
    const merged: GuideContent = { ...next, meta: (next as any)?.meta !== undefined ? (next as any).meta : (content as any)?.meta }
    const normalized = normalizeContent(merged)
    setContent(normalized)
    onChange(normalized)
  }

  function updateMeta(patch: Partial<GuideMeta>) {
    commit({ ...content, meta: { ...(meta || {}), ...patch } })
  }

  useEffect(() => {
    const code = String(property?.code || '').trim()
    const addr = String(property?.address || '').trim()
    const needTitle = !String(meta?.title || '').trim()
    const needAddr = !String(meta?.address || '').trim()
    if (!needTitle && !needAddr) return
    const patch: any = {}
    const lang = String(language || '').trim().toLowerCase()
    const suffix = lang === 'en' ? 'Check IN&OUT Instructions' : '入住指南'
    if (needTitle && code) patch.title = `${code} ${suffix}`
    if (needAddr && addr) patch.address = addr
    if (Object.keys(patch).length) updateMeta(patch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [property?.code, property?.address, language])

  function addSection() {
    const next = { meta, sections: [...sections, { id: makeId(), title: '新章节', blocks: [] }] }
    commit(next)
  }

  function updateSectionTitle(sectionIndex: number, title: string) {
    const next = { meta, sections: sections.map((s, i) => (i === sectionIndex ? { ...s, title } : s)) }
    commit(next)
  }

  function removeSection(sectionIndex: number) {
    const next = { meta, sections: sections.filter((_, i) => i !== sectionIndex) }
    commit(next)
  }

  function moveSectionToIndex(fromId: string, toIndex: number) {
    const from = sections.findIndex((s) => String(s.id) === fromId)
    if (from < 0) return
    const nextSections = arrayInsertMovePure(sections, from, Math.max(0, Math.min(toIndex, sections.length)))
    const next = { meta, sections: nextSections }
    commit(next)
  }

  function sectionBlocks(sectionIndex: number): GuideBlock[] {
    const s = sections[sectionIndex]
    return Array.isArray(s?.blocks) ? s!.blocks! : []
  }

  function updateBlock(sectionIndex: number, blockIndex: number, patch: Partial<GuideBlock>) {
    const blocks = sectionBlocks(sectionIndex)
    const nextBlocks = blocks.map((b, i) => (i === blockIndex ? ({ ...b, ...patch } as any) : b))
    const next = { meta, sections: sections.map((s, i) => (i === sectionIndex ? { ...s, blocks: nextBlocks } : s)) }
    commit(next)
  }

  function removeBlock(sectionIndex: number, blockIndex: number) {
    const blocks = sectionBlocks(sectionIndex)
    const nextBlocks = blocks.filter((_, i) => i !== blockIndex)
    const next = { meta, sections: sections.map((s, i) => (i === sectionIndex ? { ...s, blocks: nextBlocks } : s)) }
    commit(next)
  }

  function addBlock(sectionIndex: number, block: GuideBlock) {
    const blocks = sectionBlocks(sectionIndex)
    const nextBlocks = [...blocks, { ...(block as any), id: makeId() }]
    const next = { meta, sections: sections.map((s, i) => (i === sectionIndex ? { ...s, blocks: nextBlocks } : s)) }
    commit(next)
  }

  function moveBlockToIndex(sectionId: string, fromBlockId: string, toIndex: number) {
    if (!sectionId) return
    const sectionIndex = sections.findIndex((s) => String(s.id) === sectionId)
    if (sectionIndex < 0) return
    const blocks = sectionBlocks(sectionIndex)
    const from = blocks.findIndex((b: any) => String(b?.id) === fromBlockId)
    if (from < 0) return
    const nextBlocks = arrayInsertMovePure(blocks, from, Math.max(0, Math.min(toIndex, blocks.length)))
    const next = { meta, sections: sections.map((s, i) => (i === sectionIndex ? { ...s, blocks: nextBlocks } : s)) }
    commit(next)
  }

  function shouldBlockDragStartFromTarget(target: EventTarget | null) {
    const el = target as HTMLElement | null
    if (!el) return false
    const tag = String(el.tagName || '').toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'button') return true
    if (el.closest('input, textarea, button, [contenteditable="true"]')) return true
    return false
  }

  function isWithinBlockItem(target: EventTarget | null) {
    const el = target as HTMLElement | null
    if (!el) return false
    return Boolean(el.closest('[data-block-item="1"], [data-drop-kind="block"]'))
  }

  type DragInfo = { kind: 'section'; sectionId: string } | { kind: 'block'; sectionId: string; blockId: string }

  function startDragSession(e: React.PointerEvent, info: DragInfo) {
    if (shouldBlockDragStartFromTarget(e.target)) return
    if ((e as any).button !== 0) return
    try { dragCleanupRef.current?.() } catch {}
    dragCleanupRef.current = null

    e.preventDefault()
    if (info.kind === 'section') setSelected({ kind: 'section', id: info.sectionId })
    if (info.kind === 'block') setSelected({ kind: 'block', id: info.blockId })
    dragSnapshotRef.current = null
    pendingDragRef.current = null
    setDragging(null)
    setDragOver(null)
    setGhost(null)
    try { (e.currentTarget as any)?.setPointerCapture?.((e as any).pointerId) } catch {}

    const prevUserSelect = document.body.style.userSelect
    const wrap = sectionsWrapRef.current
    let lastOverKey = ''
    const startX = (e as any).clientX as number
    const startY = (e as any).clientY as number
    let started = false
    let lastTarget: { kind: 'section'; index: number } | { kind: 'block'; sectionId: string; index: number } | null = null
    let scrollRaf: number | null = null

    const label = (() => {
      const cur = contentRef.current
      const secs = Array.isArray(cur.sections) ? cur.sections : []
      if (info.kind === 'section') {
        const s = secs.find((x: any) => String(x?.id) === String(info.sectionId))
        const t = String(s?.title || '').trim()
        return t ? `章节：${t}` : '章节'
      }
      for (const s of secs as any[]) {
        const bs = Array.isArray(s?.blocks) ? s.blocks : []
        const b = bs.find((x: any) => String(x?.id) === String(info.blockId))
        if (b) return `模块：${String(b?.type || '').trim() || 'block'}`
      }
      return '模块'
    })()

    function flipAnimate(container: HTMLElement, selector: string, update: () => void) {
      const prev = new Map<string, DOMRect>()
      const prevEls = Array.from(container.querySelectorAll(selector)) as HTMLElement[]
      for (const el of prevEls) {
        const id = String(el.dataset.itemId || '')
        if (!id) continue
        prev.set(id, el.getBoundingClientRect())
      }
      update()
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const nextEls = Array.from(container.querySelectorAll(selector)) as HTMLElement[]
          for (const el of nextEls) {
            const id = String(el.dataset.itemId || '')
            if (!id) continue
            const p = prev.get(id)
            if (!p) continue
            const n = el.getBoundingClientRect()
            const dx = p.left - n.left
            const dy = p.top - n.top
            if (!dx && !dy) continue
            el.style.transition = 'transform 0s'
            el.style.transform = `translate(${dx}px, ${dy}px)`
            requestAnimationFrame(() => {
              el.style.transition = 'transform 180ms ease'
              el.style.transform = ''
              window.setTimeout(() => {
                el.style.transition = ''
              }, 220)
            })
          }
        })
      })
    }

    function readSectionInsertionIndex(ev: PointerEvent) {
      if (!wrap) return null
      const start = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
      const bar = start?.closest?.('[data-drop-kind="section"]') as HTMLElement | null
      if (bar) {
        const idx = Number(bar.dataset.dropIndex)
        if (Number.isFinite(idx)) return idx
      }
      const item = start?.closest?.('[data-section-item="1"]') as HTMLElement | null
      const secs = Array.isArray(contentRef.current.sections) ? contentRef.current.sections : []
      if (item) {
        const idx = Number(item.dataset.sectionIndex)
        if (!Number.isFinite(idx)) return null
        const r = item.getBoundingClientRect()
        const insertion = ev.clientY > (r.top + r.height / 2) ? idx + 1 : idx
        return Math.max(0, Math.min(insertion, secs.length))
      }
      const wr = wrap.getBoundingClientRect()
      if (ev.clientY < wr.top) return 0
      if (ev.clientY > wr.bottom) return secs.length
      return null
    }

    function readBlockInsertionIndex(ev: PointerEvent) {
      if (!wrap) return null
      const start = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
      const bar = start?.closest?.('[data-drop-kind="block"]') as HTMLElement | null
      if (bar) {
        const idx = Number(bar.dataset.dropIndex)
        const sid = String(bar.dataset.sectionId || '')
        if (sid && Number.isFinite(idx)) return { sectionId: sid, index: idx }
      }
      const item = start?.closest?.('[data-block-item="1"]') as HTMLElement | null
      const secs = Array.isArray(contentRef.current.sections) ? contentRef.current.sections : []
      const sid = String(item?.dataset?.sectionId || '')
      const si = secs.findIndex((s: any) => String(s?.id) === sid)
      if (si < 0) return null
      const blocks = Array.isArray(secs[si]?.blocks) ? (secs[si]!.blocks as any[]) : []
      if (item) {
        const idx = Number(item.dataset.blockIndex)
        if (!Number.isFinite(idx)) return null
        const r = item.getBoundingClientRect()
        const insertion = ev.clientY > (r.top + r.height / 2) ? idx + 1 : idx
        return { sectionId: sid, index: Math.max(0, Math.min(insertion, blocks.length)) }
      }
      return null
    }

    function onMove(ev: PointerEvent) {
      const gx = ev.clientX + 14
      const gy = ev.clientY + 14
      ghostNextRef.current = { x: gx, y: gy, label }
      if (ghostRafRef.current == null) {
        ghostRafRef.current = window.requestAnimationFrame(() => {
          ghostRafRef.current = null
          setGhost(ghostNextRef.current)
        })
      }

      if (scrollRaf == null) {
        scrollRaf = window.requestAnimationFrame(() => {
          scrollRaf = null
          const topZone = 90
          const bottomZone = window.innerHeight - 90
          if (ev.clientY < topZone) window.scrollBy(0, -18)
          else if (ev.clientY > bottomZone) window.scrollBy(0, 18)
        })
      }

      if (!started) {
        const dx = Math.abs(ev.clientX - startX)
        const dy = Math.abs(ev.clientY - startY)
        if (Math.max(dx, dy) < 6) return
        started = true
        dragSnapshotRef.current = contentRef.current
        pendingDragRef.current = null
        setDragging(info as any)
        document.body.style.userSelect = 'none'
      }
      if (info.kind === 'section') {
        const idx = readSectionInsertionIndex(ev)
        const key = idx === null ? '' : `section|${idx}`
        if (key !== lastOverKey) {
          lastOverKey = key
          lastTarget = idx === null ? null : ({ kind: 'section', index: idx } as any)
          setDragOver(lastTarget as any)
        }
        return
      }
      if (info.kind === 'block') {
        const hit = readBlockInsertionIndex(ev)
        const key = hit === null ? '' : `block|${hit.sectionId}|${hit.index}`
        if (key !== lastOverKey) {
          lastOverKey = key
          lastTarget = hit === null ? null : ({ kind: 'block', sectionId: hit.sectionId, index: hit.index } as any)
          setDragOver(lastTarget as any)
        }
      }
    }

    function finish() {
      try {
        if (started) {
          const base = dragSnapshotRef.current || contentRef.current
          const baseSections = Array.isArray(base.sections) ? base.sections : []
          if (info.kind === 'section' && lastTarget?.kind === 'section') {
            const nextSections = moveSectionToIndexAcross(baseSections as any, info.sectionId, lastTarget.index) as any
            if (wrap && nextSections && nextSections !== baseSections) {
              const normalized = normalizeContent({ meta: base.meta, sections: nextSections })
              flipAnimate(wrap, '[data-section-item="1"]', () => setContent(normalized))
              onChange(normalized)
            }
          }
          if (info.kind === 'block' && lastTarget?.kind === 'block') {
            const nextSections = moveBlockToIndexAcrossSections(baseSections as any, info.sectionId, info.blockId, lastTarget.sectionId, lastTarget.index) as any
            if (wrap && nextSections && nextSections !== baseSections) {
              const normalized = normalizeContent({ meta: base.meta, sections: nextSections })
              flipAnimate(wrap, '[data-block-item="1"]', () => setContent(normalized))
              onChange(normalized)
            }
          }
        }
      } catch {
        const snap = dragSnapshotRef.current
        if (snap) {
          const normalized = normalizeContent(snap)
          setContent(normalized)
          onChange(normalized)
        }
      }
      setDragging(null)
      setDragOver(null)
      setGhost(null)
      dragSnapshotRef.current = null
      pendingDragRef.current = null
      try { dragCleanupRef.current?.() } catch {}
      dragCleanupRef.current = null
      document.body.style.userSelect = prevUserSelect
    }

    const onUp = () => finish()
    const onCancel = () => finish()

    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onCancel, true)

    dragCleanupRef.current = () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onCancel, true)
    }
  }

  async function uploadImage(file: File): Promise<string> {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`${API_BASE}/property-guides/upload-image`, { method: 'POST', headers: { ...authHeaders() }, body: fd })
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      throw new Error(String(j?.message || `HTTP ${res.status}`))
    }
    const j = await res.json().catch(() => null)
    const url = String(j?.url || '')
    if (!url) throw new Error('missing url')
    return url
  }

  function uploadProps(onUploaded: (url: string) => void): UploadProps {
    return {
      multiple: false,
      showUploadList: false,
      beforeUpload: async (file) => {
        try {
          const url = await uploadImage(file as any)
          onUploaded(url)
          message.success('图片已上传')
        } catch (e: any) {
          message.error(`上传失败：${e?.message || ''}`)
        }
        return false
      },
    }
  }

  function renderPreviewBlock(b: GuideBlock, key: string) {
    switch (b.type) {
      case 'heading':
        return <Typography.Title key={key} level={4} style={{ margin: '12px 0 8px' }}>{b.text || ''}</Typography.Title>
      case 'text':
        return <Typography.Paragraph key={key} style={{ margin: '8px 0', whiteSpace: 'pre-wrap' }}>{b.text || ''}</Typography.Paragraph>
      case 'image':
        return (
          <div key={key} style={{ margin: '10px 0' }}>
            {b.url ? <img src={b.url} draggable={false} style={{ maxWidth: '100%', borderRadius: 10 }} /> : null}
            {b.caption ? <div style={{ color: '#666', fontSize: 12, marginTop: 4 }}>{b.caption}</div> : null}
          </div>
        )
      case 'notice':
        return (
          <Card key={key} size="small" style={{ margin: '10px 0', borderRadius: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>{b.title || '注意事项'}</div>
            {Array.isArray(b.items) && b.items.length ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {b.items.map((it, i) => <li key={i}>{it}</li>)}
              </ul>
            ) : null}
            {b.text ? <div style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{b.text}</div> : null}
          </Card>
        )
      case 'steps':
        return (
          <div key={key} style={{ margin: '10px 0' }}>
            {b.title ? <div style={{ fontWeight: 700, marginBottom: 6 }}>{b.title}</div> : null}
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              {(b.steps || []).map((s, i) => (
                <li key={i} style={{ marginBottom: 10 }}>
                  {s.title ? <div style={{ fontWeight: 600 }}>{s.title}</div> : null}
                  {s.text ? <div style={{ whiteSpace: 'pre-wrap' }}>{s.text}</div> : null}
                  {s.url ? <div style={{ marginTop: 6 }}><img src={s.url} style={{ maxWidth: '100%', borderRadius: 10 }} /></div> : null}
                  {s.caption ? <div style={{ color: '#666', fontSize: 12, marginTop: 4 }}>{s.caption}</div> : null}
                </li>
              ))}
            </ol>
          </div>
        )
      default:
        return null
    }
  }

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 340 }}>
        <Card style={{ marginBottom: 12 }} title="页面头部信息（外链展示）">
          <div style={{ display: 'grid', gap: 10 }}>
            <Space wrap>
              <Upload {...uploadProps((url) => updateMeta({ cover_image_url: url }))}>
                <Button>上传封面图</Button>
              </Upload>
              <Input value={meta.cover_image_url} onChange={(e) => updateMeta({ cover_image_url: e.target.value })} placeholder="封面图 URL（可选）" style={{ width: 520 }} />
            </Space>
            {meta.cover_image_url ? <img src={meta.cover_image_url} alt="" style={{ width: '100%', maxWidth: 760, borderRadius: 14, border: '1px solid #eee' }} /> : null}
            <Space wrap>
              <Input value={meta.badge} onChange={(e) => updateMeta({ badge: e.target.value })} placeholder="徽标（如 PREMIUM STAY）" style={{ width: 260 }} />
              <Input value={meta.title} onChange={(e) => updateMeta({ title: e.target.value })} placeholder="标题（建议：房源名/概览）" style={{ width: 420 }} />
            </Space>
            <Input value={meta.address} onChange={(e) => updateMeta({ address: e.target.value })} placeholder="地址（可选，留空则尝试使用房源地址）" />
            <Space wrap>
              <Input value={meta.wifi_ssid} onChange={(e) => updateMeta({ wifi_ssid: e.target.value })} placeholder="Wi‑Fi SSID（可选）" style={{ width: 260 }} />
              <Input value={meta.wifi_password} onChange={(e) => updateMeta({ wifi_password: e.target.value })} placeholder="Wi‑Fi Password（可选）" style={{ width: 260 }} />
              <Input value={meta.checkin_time} onChange={(e) => updateMeta({ checkin_time: e.target.value })} placeholder="入住时间（如 3:00 PM）" style={{ width: 220 }} />
              <Input value={meta.checkout_time} onChange={(e) => updateMeta({ checkout_time: e.target.value })} placeholder="退房时间（如 10:00 AM）" style={{ width: 220 }} />
            </Space>
          </div>
        </Card>
        {ghost ? (
          <div
            style={{
              position: 'fixed',
              left: ghost.x,
              top: ghost.y,
              zIndex: 9999,
              pointerEvents: 'none',
              background: 'rgba(16, 24, 40, 0.92)',
              color: '#fff',
              padding: '6px 10px',
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 900,
              boxShadow: '0 14px 30px rgba(0,0,0,0.22)',
              maxWidth: 260,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {ghost.label}
          </div>
        ) : null}

        <div ref={sectionsWrapRef}>
          <div
            data-drop-kind="section"
            data-drop-index={0}
            style={{
              height: (dragOver?.kind === 'section' && dragOver.index === 0) ? 16 : 10,
              borderRadius: 8,
              background: (dragOver?.kind === 'section' && dragOver.index === 0) ? 'rgba(22, 119, 255, 0.32)' : (dragging?.kind === 'section' ? 'rgba(22, 119, 255, 0.10)' : 'transparent'),
              boxShadow: (dragOver?.kind === 'section' && dragOver.index === 0) ? '0 8px 18px rgba(22, 119, 255, 0.18)' : undefined,
              border: (dragOver?.kind === 'section' && dragOver.index === 0) ? '1px dashed rgba(22, 119, 255, 0.55)' : '1px dashed transparent',
              marginBottom: 8,
            }}
          />

          {sections.map((sec, si) => {
            const blocks = sectionBlocks(si)
            return (
              <div key={sec.id || si}>
                <div
                  data-drop-kind="section"
                  data-drop-index={si}
                  style={{
                    height: (dragOver?.kind === 'section' && dragOver.index === si) ? 16 : 10,
                    borderRadius: 8,
                    background: (dragOver?.kind === 'section' && dragOver.index === si) ? 'rgba(22, 119, 255, 0.32)' : (dragging?.kind === 'section' ? 'rgba(22, 119, 255, 0.10)' : 'transparent'),
                    boxShadow: (dragOver?.kind === 'section' && dragOver.index === si) ? '0 8px 18px rgba(22, 119, 255, 0.18)' : undefined,
                    border: (dragOver?.kind === 'section' && dragOver.index === si) ? '1px dashed rgba(22, 119, 255, 0.55)' : '1px dashed transparent',
                    marginBottom: 8,
                  }}
                />

                <Card
                  data-section-item="1"
                  data-item-id={String(sec.id)}
                  data-section-index={si}
                  onPointerDown={(e) => {
                    if (isWithinBlockItem(e.target)) return
                    startDragSession(e, { kind: 'section', sectionId: String(sec.id) })
                  }}
                  title={
                    <Space>
                      <span style={{ fontWeight: 900, fontSize: 16 }}>章节</span>
                      <Input value={sec.title} onChange={(e) => updateSectionTitle(si, e.target.value)} style={{ width: 360, fontSize: 18, fontWeight: 900 }} placeholder="章节标题" />
                    </Space>
                  }
                  extra={<Button danger onClick={() => removeSection(si)}>删除章节</Button>}
                  style={{
                    marginBottom: 12,
                    touchAction: 'none',
                    cursor: dragging?.kind === 'section' ? 'grabbing' : 'grab',
                    opacity: (dragging?.kind === 'section' && dragging.sectionId === String(sec.id)) ? 0.72 : 1,
                    outline:
                      (dragging?.kind === 'section' && dragging.sectionId === String(sec.id))
                        ? '2px solid rgba(22, 119, 255, 0.25)'
                        : (selected?.kind === 'section' && selected.id === String(sec.id))
                          ? '2px solid rgba(22, 119, 255, 0.55)'
                          : 'none',
                    boxShadow: (dragging?.kind === 'section' && dragging.sectionId === String(sec.id)) ? '0 18px 40px rgba(16, 24, 40, 0.14)' : undefined,
                  }}
                >
              <Space style={{ marginBottom: 10, flexWrap: 'wrap' }}>
                <Button onClick={() => addBlock(si, { type: 'heading', text: '' })}>标题</Button>
                <Button onClick={() => addBlock(si, { type: 'text', text: '' })}>文字</Button>
                <Button onClick={() => addBlock(si, { type: 'image', url: '', caption: '' })}>图片</Button>
                <Button onClick={() => addBlock(si, { type: 'steps', title: '', steps: [] })}>步骤</Button>
                <Button onClick={() => addBlock(si, { type: 'notice', title: '注意事项', items: [''], text: '' })}>注意事项</Button>
              </Space>

              <div
                data-drop-kind="block"
                data-section-id={String(sec.id)}
                data-drop-index={0}
                style={{
                  height: (dragOver?.kind === 'block' && dragOver.sectionId === String(sec.id) && dragOver.index === 0) ? 16 : 10,
                  borderRadius: 8,
                  background:
                    (dragOver?.kind === 'block' && dragOver.sectionId === String(sec.id) && dragOver.index === 0)
                      ? 'rgba(22, 119, 255, 0.32)'
                      : (dragging?.kind === 'block' && dragging.sectionId === String(sec.id))
                        ? 'rgba(22, 119, 255, 0.10)'
                        : 'transparent',
                  boxShadow: (dragOver?.kind === 'block' && dragOver.sectionId === String(sec.id) && dragOver.index === 0) ? '0 8px 18px rgba(22, 119, 255, 0.18)' : undefined,
                  border: (dragOver?.kind === 'block' && dragOver.sectionId === String(sec.id) && dragOver.index === 0) ? '1px dashed rgba(22, 119, 255, 0.55)' : '1px dashed transparent',
                  marginBottom: 8,
                }}
              />

              {blocks.map((b, bi) => (
                <div key={(b as any).id || bi}>
                  <div
                    data-drop-kind="block"
                    data-section-id={String(sec.id)}
                    data-drop-index={bi}
                    style={{
                      height: (dragOver?.kind === 'block' && dragOver.sectionId === String(sec.id) && dragOver.index === bi) ? 16 : 10,
                      borderRadius: 8,
                      background:
                        (dragOver?.kind === 'block' && dragOver.sectionId === String(sec.id) && dragOver.index === bi)
                          ? 'rgba(22, 119, 255, 0.32)'
                          : (dragging?.kind === 'block' && dragging.sectionId === String(sec.id))
                            ? 'rgba(22, 119, 255, 0.10)'
                            : 'transparent',
                      boxShadow: (dragOver?.kind === 'block' && dragOver.sectionId === String(sec.id) && dragOver.index === bi) ? '0 8px 18px rgba(22, 119, 255, 0.18)' : undefined,
                      border: (dragOver?.kind === 'block' && dragOver.sectionId === String(sec.id) && dragOver.index === bi) ? '1px dashed rgba(22, 119, 255, 0.55)' : '1px dashed transparent',
                      marginBottom: 8,
                    }}
                  />

                  <Card
                    size="small"
                    data-block-item="1"
                    data-section-id={String(sec.id)}
                    data-item-id={String((b as any).id)}
                    data-block-index={bi}
                    title={
                      <Space>
                        <span>{b.type}</span>
                      </Space>
                    }
                    extra={<Button danger size="small" onClick={() => removeBlock(si, bi)}>删除</Button>}
                    style={{
                      marginBottom: 10,
                      touchAction: 'none',
                      cursor: dragging?.kind === 'block' ? 'grabbing' : 'grab',
                      opacity: (dragging?.kind === 'block' && dragging.sectionId === String(sec.id) && dragging.blockId === String((b as any).id)) ? 0.72 : 1,
                      outline:
                        (dragging?.kind === 'block' && dragging.sectionId === String(sec.id) && dragging.blockId === String((b as any).id))
                          ? '2px solid rgba(22, 119, 255, 0.25)'
                          : (selected?.kind === 'block' && selected.id === String((b as any).id))
                            ? '2px solid rgba(22, 119, 255, 0.55)'
                            : 'none',
                    }}
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      startDragSession(e, { kind: 'block', sectionId: String(sec.id), blockId: String((b as any).id) })
                    }}
                  >
                  {b.type === 'heading' ? (
                    <Input value={b.text} onChange={(e) => updateBlock(si, bi, { text: e.target.value } as any)} placeholder="标题" />
                  ) : null}

                  {b.type === 'text' ? (
                    <Input.TextArea value={b.text} onChange={(e) => updateBlock(si, bi, { text: e.target.value } as any)} autoSize={{ minRows: 3 }} placeholder="文本内容" />
                  ) : null}

                  {b.type === 'image' ? (
                    <div>
                      <Space style={{ marginBottom: 8 }}>
                        <Upload {...uploadProps((url) => updateBlock(si, bi, { url } as any))}>
                          <Button>上传图片</Button>
                        </Upload>
                        <Input value={b.url} onChange={(e) => updateBlock(si, bi, { url: e.target.value } as any)} placeholder="图片 URL" style={{ width: 360 }} />
                      </Space>
                      {b.url ? <img src={b.url} draggable={false} style={{ maxWidth: '100%', borderRadius: 10, marginBottom: 8 }} /> : null}
                      <Input value={b.caption} onChange={(e) => updateBlock(si, bi, { caption: e.target.value } as any)} placeholder="图片说明（可选）" />
                    </div>
                  ) : null}

                  {b.type === 'notice' ? (
                    <div style={{ display: 'grid', gap: 8 }}>
                      <Input value={b.title} onChange={(e) => updateBlock(si, bi, { title: e.target.value } as any)} placeholder="标题（可选）" />
                      <Input.TextArea value={b.text} onChange={(e) => updateBlock(si, bi, { text: e.target.value } as any)} autoSize={{ minRows: 2 }} placeholder="补充说明（可选）" />
                      <div>
                        <div style={{ fontWeight: 600, marginBottom: 6 }}>条目</div>
                        {(b.items || []).map((it, i) => (
                          <Space key={i} style={{ marginBottom: 6 }}>
                            <Input
                              value={it}
                              onChange={(e) => {
                                const items = [...(b.items || [])]
                                items[i] = e.target.value
                                updateBlock(si, bi, { items } as any)
                              }}
                              style={{ width: 420 }}
                              placeholder={`条目 ${i + 1}`}
                            />
                            <Button
                              danger
                              onClick={() => {
                                const items = [...(b.items || [])]
                                items.splice(i, 1)
                                updateBlock(si, bi, { items } as any)
                              }}
                            >
                              删除
                            </Button>
                          </Space>
                        ))}
                        <Button onClick={() => updateBlock(si, bi, { items: [...(b.items || []), ''] } as any)}>新增条目</Button>
                      </div>
                    </div>
                  ) : null}

                  {b.type === 'steps' ? (
                    <div style={{ display: 'grid', gap: 8 }}>
                      <Input value={b.title} onChange={(e) => updateBlock(si, bi, { title: e.target.value } as any)} placeholder="步骤模块标题（可选）" />
                      <Space>
                        <Button onClick={() => updateBlock(si, bi, { steps: [...(b.steps || []), { title: '', text: '', url: '', caption: '' }] } as any)}>新增步骤</Button>
                      </Space>
                      {(b.steps || []).map((st, i) => (
                        <Card
                          key={i}
                          size="small"
                          title={`步骤 ${i + 1}`}
                          extra={
                            <Button
                              danger
                              size="small"
                              onClick={() => {
                                const steps = [...(b.steps || [])]
                                steps.splice(i, 1)
                                updateBlock(si, bi, { steps } as any)
                              }}
                            >
                              删除
                            </Button>
                          }
                        >
                          <div style={{ display: 'grid', gap: 8 }}>
                            <Input value={st.title} onChange={(e) => {
                              const steps = [...(b.steps || [])]
                              steps[i] = { ...steps[i], title: e.target.value }
                              updateBlock(si, bi, { steps } as any)
                            }} placeholder="步骤标题（可选）" />
                            <Input.TextArea value={st.text} onChange={(e) => {
                              const steps = [...(b.steps || [])]
                              steps[i] = { ...steps[i], text: e.target.value }
                              updateBlock(si, bi, { steps } as any)
                            }} autoSize={{ minRows: 2 }} placeholder="步骤说明（可选）" />
                            <Space>
                              <Upload {...uploadProps((url) => {
                                const steps = [...(b.steps || [])]
                                steps[i] = { ...steps[i], url }
                                updateBlock(si, bi, { steps } as any)
                              })}>
                                <Button>上传图片</Button>
                              </Upload>
                              <Input value={st.url} onChange={(e) => {
                                const steps = [...(b.steps || [])]
                                steps[i] = { ...steps[i], url: e.target.value }
                                updateBlock(si, bi, { steps } as any)
                              }} placeholder="图片 URL（可选）" style={{ width: 360 }} />
                            </Space>
                            {st.url ? <img src={st.url} draggable={false} style={{ maxWidth: '100%', borderRadius: 10 }} /> : null}
                            <Input value={st.caption} onChange={(e) => {
                              const steps = [...(b.steps || [])]
                              steps[i] = { ...steps[i], caption: e.target.value }
                              updateBlock(si, bi, { steps } as any)
                            }} placeholder="图片说明（可选）" />
                          </div>
                        </Card>
                      ))}
                    </div>
                  ) : null}
                  </Card>
                </div>
              ))}

              <div
                data-drop-kind="block"
                data-section-id={String(sec.id)}
                data-drop-index={blocks.length}
                style={{
                  height: (dragOver?.kind === 'block' && dragOver.sectionId === String(sec.id) && dragOver.index === blocks.length) ? 16 : 10,
                  borderRadius: 8,
                  background:
                    (dragOver?.kind === 'block' && dragOver.sectionId === String(sec.id) && dragOver.index === blocks.length)
                      ? 'rgba(22, 119, 255, 0.32)'
                      : (dragging?.kind === 'block' && dragging.sectionId === String(sec.id))
                        ? 'rgba(22, 119, 255, 0.10)'
                        : 'transparent',
                  boxShadow: (dragOver?.kind === 'block' && dragOver.sectionId === String(sec.id) && dragOver.index === blocks.length) ? '0 8px 18px rgba(22, 119, 255, 0.18)' : undefined,
                  border: (dragOver?.kind === 'block' && dragOver.sectionId === String(sec.id) && dragOver.index === blocks.length) ? '1px dashed rgba(22, 119, 255, 0.55)' : '1px dashed transparent',
                  marginBottom: 8,
                }}
              />
            </Card>
            </div>
          )
        })}

          <div
            data-drop-kind="section"
            data-drop-index={sections.length}
            style={{
              height: (dragOver?.kind === 'section' && dragOver.index === sections.length) ? 16 : 10,
              borderRadius: 8,
              background: (dragOver?.kind === 'section' && dragOver.index === sections.length) ? 'rgba(22, 119, 255, 0.32)' : (dragging?.kind === 'section' ? 'rgba(22, 119, 255, 0.10)' : 'transparent'),
              boxShadow: (dragOver?.kind === 'section' && dragOver.index === sections.length) ? '0 8px 18px rgba(22, 119, 255, 0.18)' : undefined,
              border: (dragOver?.kind === 'section' && dragOver.index === sections.length) ? '1px dashed rgba(22, 119, 255, 0.55)' : '1px dashed transparent',
              marginBottom: 8,
            }}
          />
        </div>

        <div style={{ marginTop: 24, width: '100%', display: 'flex', justifyContent: 'center' }}>
          <div
            role="button"
            tabIndex={0}
            onClick={addSection}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') addSection()
            }}
            onPointerEnter={() => setBottomAddHover(true)}
            onPointerLeave={() => setBottomAddHover(false)}
            onMouseEnter={() => setBottomAddHover(true)}
            onMouseLeave={() => setBottomAddHover(false)}
            style={{
              width: '100%',
              borderRadius: 12,
              border: `1px solid ${bottomAddHover ? 'rgba(22, 119, 255, 0.55)' : '#d9d9d9'}`,
              background: bottomAddHover ? 'rgba(22, 119, 255, 0.06)' : '#fafafa',
              boxShadow: bottomAddHover ? '0 10px 26px rgba(22, 119, 255, 0.18)' : 'none',
              color: 'rgba(0, 0, 0, 0.88)',
              fontWeight: 900,
              fontSize: 16,
              letterSpacing: 0.2,
              padding: '12px 14px',
              textAlign: 'center',
              cursor: 'pointer',
              userSelect: 'none',
              transition: 'background 140ms ease, box-shadow 140ms ease, border-color 140ms ease',
            }}
          >
            新增章节
          </div>
        </div>
      </div>

      <div style={{ width: 390, border: '1px solid #eee', borderRadius: 24, padding: 12, boxShadow: '0 6px 20px rgba(0,0,0,0.08)' }}>
        <Typography.Text type="secondary">外链手机预览</Typography.Text>
        <div style={{ marginTop: 10 }}>
          <div style={{ borderRadius: 18, overflow: 'hidden', border: '1px solid #f0f0f0', background: '#fff', marginBottom: 12 }}>
            <div style={{ height: 150, position: 'relative', background: '#2b2b2b' }}>
              {meta.cover_image_url ? <img src={meta.cover_image_url} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
              <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.72) 82%, rgba(0,0,0,0.86) 100%)' }} />
              <div style={{ position: 'absolute', left: 12, right: 12, bottom: 10, color: '#fff' }}>
                <div style={{ display: 'inline-flex', padding: '5px 10px', borderRadius: 999, background: '#ff4d6d', fontWeight: 900, fontSize: 11, letterSpacing: 0.5, marginBottom: 8 }}>{meta.badge || 'PREMIUM STAY'}</div>
                <div style={{ fontWeight: 900, fontSize: 16, lineHeight: 1.2 }}>{meta.title || '入住指南'}</div>
                {meta.address ? (
                  <div style={{ opacity: 0.86, marginTop: 4, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        const addr = String(meta.address || '')
                        if (!addr) return
                        copyText(addr).then((ok) => (ok ? message.success('已复制') : message.error('复制失败')))
                      }}
                    >
                      {meta.address}
                    </span>
                    <span
                      style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
                      onClick={() => {
                        const addr = String(meta.address || '')
                        if (!addr) return
                        copyText(addr).then((ok) => (ok ? message.success('已复制') : message.error('复制失败')))
                      }}
                    >
                      <CopyOutlined />
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
            {(meta.wifi_ssid || meta.wifi_password || meta.checkin_time || meta.checkout_time) ? (
              <div style={{ padding: 10, background: '#f5f7fb' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gridTemplateRows: '1fr 1fr', gap: 10 }}>
                  <div style={{ gridRow: '1 / span 2', borderRadius: 14, background: '#fff', padding: 10, border: '1px solid #eef2f8' }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                      <div style={{ width: 34, height: 34, borderRadius: 999, background: 'rgba(0, 122, 255, 0.12)', color: '#1677ff', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}>
                        <span style={{ fontWeight: 900, fontSize: 14, lineHeight: 1 }}>Wi</span>
                      </div>
                      <div style={{ width: '100%', display: 'grid', alignContent: 'space-between' }}>
                        <div style={{ fontSize: 11, color: '#98a2b3', fontWeight: 900, letterSpacing: 0.4 }}>WI‑FI</div>
                        <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
                          <div style={{ display: 'grid', gap: 4 }}>
                            <div style={{ fontSize: 11, color: '#98a2b3', fontWeight: 900, letterSpacing: 0.35 }}>USERNAME</div>
                            <div style={{ fontSize: 13, fontWeight: 900 }}>{meta.wifi_ssid || '-'}</div>
                          </div>
                          <div style={{ display: 'grid', gap: 4 }}>
                            <div style={{ fontSize: 11, color: '#98a2b3', fontWeight: 900, letterSpacing: 0.35 }}>PASSWORD</div>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                              <div
                                style={{ fontSize: 13, fontWeight: 900, cursor: meta.wifi_password ? 'pointer' : 'default' }}
                                onClick={() => {
                                  const pwd = String(meta.wifi_password || '')
                                  if (!pwd) return
                                  copyText(pwd).then((ok) => (ok ? message.success('已复制') : message.error('复制失败')))
                                }}
                              >
                                {meta.wifi_password || '-'}
                              </div>
                              <Button
                                size="small"
                                icon={<CopyOutlined />}
                                disabled={!meta.wifi_password}
                                onClick={() => {
                                  const pwd = String(meta.wifi_password || '')
                                  if (!pwd) return
                                  copyText(pwd).then((ok) => (ok ? message.success('已复制') : message.error('复制失败')))
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div style={{ borderRadius: 14, background: '#fff', padding: 10, border: '1px solid #eef2f8' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ color: '#fa8c16' }}><ClockCircleOutlined /></span>
                      <div style={{ fontSize: 11, color: '#98a2b3', fontWeight: 900, letterSpacing: 0.4 }}>CHECK‑IN TIME</div>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 900, marginTop: 2 }}>{meta.checkin_time || '-'}</div>
                  </div>

                  <div style={{ borderRadius: 14, background: '#fff', padding: 10, border: '1px solid #eef2f8' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ color: '#fa8c16' }}><ClockCircleOutlined /></span>
                      <div style={{ fontSize: 11, color: '#98a2b3', fontWeight: 900, letterSpacing: 0.4 }}>CHECK‑OUT TIME</div>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 900, marginTop: 2 }}>{meta.checkout_time || '-'}</div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
          {sections.length ? (
            <div style={{ borderRadius: 18, overflow: 'hidden', border: '1px solid #f0f0f0', background: '#fff', marginBottom: 12 }}>
              <div style={{ padding: 12 }}>
                <div style={{ fontWeight: 900, fontSize: 14, marginBottom: 10 }}>{isEn ? 'Contents' : '目录'}</div>
                <div style={{ display: 'grid', gap: 10 }}>
                  {sections.map((sec, si) => {
                    const title = String(sec.title || '').trim() || (isEn ? `Chapter ${si + 1}` : `章节 ${si + 1}`)
                    const key = String((sec as any)?.id || si)
                    return (
                      <div
                        key={key}
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          requestAnimationFrame(() => {
                            const el = document.getElementById(`preview-sec-${key}`)
                            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
                          })
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            requestAnimationFrame(() => {
                              const el = document.getElementById(`preview-sec-${key}`)
                              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
                            })
                          }
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '10px 12px',
                          borderRadius: 14,
                          border: '1px solid rgba(16, 24, 40, 0.08)',
                          background: '#fff',
                          boxShadow: '0 8px 18px rgba(16, 24, 40, 0.06)',
                          cursor: 'pointer',
                          userSelect: 'none',
                        }}
                      >
                        <div style={{ width: 28, height: 28, borderRadius: 999, background: 'rgba(255, 77, 109, 0.14)', color: '#ff4d6d', fontWeight: 900, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}>
                          {si + 1}
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 900, color: '#101828', lineHeight: 1.2, flex: '1 1 auto' }}>{title}</div>
                        <div style={{ color: 'rgba(16, 24, 40, 0.45)', fontWeight: 900, fontSize: 18, lineHeight: 1, flex: '0 0 auto' }}>›</div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          ) : null}
          {sections.map((sec, si) => (
            <div key={si} id={`preview-sec-${String((sec as any)?.id || si)}`} style={{ marginBottom: 16, scrollMarginTop: 14 }}>
              {sec.title ? <div style={{ fontWeight: 800, marginBottom: 8 }}>{sec.title}</div> : null}
              {(sec.blocks || []).map((b, bi) => renderPreviewBlock(b, `${si}-${bi}`))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
