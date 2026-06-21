"use client"

import { App, Button, Card, Checkbox, DatePicker, Drawer, Form, Input, Modal, Select, Space, Table, Tabs, Tag, Tooltip, Typography, Upload } from 'antd'
import type { UploadProps } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { API_BASE, authHeaders, deleteJSON, getJSON, patchJSON, postJSON } from '../../../lib/api'
import { CalendarOutlined, CheckCircleOutlined, ClockCircleOutlined, CopyOutlined, EditOutlined, FileTextOutlined, InboxOutlined, LinkOutlined, NotificationOutlined, PrinterOutlined, UserOutlined } from '@ant-design/icons'
import TableRowActions from '../../../components/TableRowActions'

type PageType = 'announce' | 'doc' | 'warehouse'
type PageStatus = 'draft' | 'published'
type AudienceScope = 'all_staff' | 'cleaners' | 'warehouse_staff' | 'maintenance_staff' | 'managers'
type DocCategory = 'company_rule' | 'starter_guide' | 'role_guide' | 'work_guide' | 'customer_service_manual'
type DocCategoryFilter = 'all' | DocCategory
type CompanyGuideRole = 'cleaner' | 'cleaning_inspector'

type CompanyPageRow = {
  id: string
  slug?: string | null
  title?: string | null
  content?: string | null
  status?: PageStatus | null
  published_at?: string | null
  page_type?: string | null
  category?: string | null
  guide_role?: CompanyGuideRole | null
  pinned?: boolean | null
  urgent?: boolean | null
  audience_scope?: string | null
  expires_at?: string | null
  updated_at?: string | null
  updated_by?: string | null
  created_at?: string | null
}

type CompanyPagePublicLinkRow = {
  token_hash: string
  token?: string | null
  created_at?: string | null
  expires_at?: string | null
  revoked_at?: string | null
}

type StepItem = { type: 'text' | 'image' | 'video'; text?: string; url?: string; caption?: string }
type Block =
  | { type: 'heading'; text: string; level?: number }
  | { type: 'paragraph'; text: string }
  | { type: 'callout'; text: string }
  | { type: 'image'; url: string; caption?: string }
  | { type: 'video'; url: string; caption?: string }
  | { type: 'step'; title: string; contents: StepItem[] }
  | { type: 'list'; ordered?: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string; language?: string }
  | { type: 'legacy_html'; html: string }

const DOC_CATEGORY_META: Record<DocCategory, { label: string; shortLabel: string; description: string; color: string }> = {
  company_rule: { label: '公司制度', shortLabel: '制度', description: '制度、规范、要求', color: 'gold' },
  starter_guide: { label: '新手指南', shortLabel: '新手', description: '下载安装、登录、首次使用', color: 'green' },
  role_guide: { label: '角色使用说明', shortLabel: '角色', description: '按角色拆分的 App 使用说明', color: 'blue' },
  work_guide: { label: '现场工作指南', shortLabel: '现场', description: '现场 SOP、工作动作与注意事项', color: 'purple' },
  customer_service_manual: { label: '客服手册', shortLabel: '客服', description: '客服培训、SOP、规定与回复模板', color: 'cyan' },
}

const DOC_CATEGORY_OPTIONS = Object.entries(DOC_CATEGORY_META).map(([value, meta]) => ({
  value: value as DocCategory,
  label: meta.label,
}))

const AUDIENCE_OPTIONS: Array<{ value: AudienceScope; label: string }> = [
  { value: 'all_staff', label: '全员可见' },
  { value: 'cleaners', label: '保洁团队' },
  { value: 'warehouse_staff', label: '仓库团队' },
  { value: 'maintenance_staff', label: '维修团队' },
  { value: 'managers', label: '管理层' },
]

const AUDIENCE_SELECT_OPTIONS = AUDIENCE_OPTIONS.map((item) => ({
  ...item,
  title: item.label,
  label: (
    <div>
      <div style={{ fontWeight: 700 }}>{item.label}</div>
      <div style={{ color: '#64748b', fontSize: 12 }}>控制这篇内容在公司内容中心对哪个团队可见</div>
    </div>
  ),
}))

const AUDIENCE_LABEL: Record<AudienceScope, string> = {
  all_staff: '全员可见',
  cleaners: '保洁团队',
  warehouse_staff: '仓库团队',
  maintenance_staff: '维修团队',
  managers: '管理层',
}

const STATUS_OPTIONS = [
  { value: 'draft' as const, label: '草稿' },
  { value: 'published' as const, label: '已发布' },
]

const GUIDE_ROLE_OPTIONS = [
  { value: 'cleaner' as const, label: '清洁员' },
  { value: 'cleaning_inspector' as const, label: '检查员' },
]

const GUIDE_ROLE_LABEL: Record<CompanyGuideRole, string> = {
  cleaner: '清洁员',
  cleaning_inspector: '检查员',
}

function isGuideRoleCategory(category: string | null | undefined): category is DocCategory {
  return category === 'role_guide' || category === 'work_guide'
}

function docCategoryLabel(category: string | null | undefined) {
  const meta = category ? DOC_CATEGORY_META[category as DocCategory] : null
  return meta?.label || String(category || '-')
}

function headingLevelOf(block: Block) {
  return Math.max(1, Math.min(4, Number(block.type === 'heading' ? block.level || 2 : 2)))
}

function headingDomId(prefix: string, index: number) {
  return `${prefix}-heading-${index}`
}

function documentHeadings(blocks: Block[], prefix: string) {
  return blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.type === 'heading' && String(block.text || '').trim())
    .map(({ block, index }) => ({
      id: headingDomId(prefix, index),
      text: String((block as Extract<Block, { type: 'heading' }>).text || '').trim(),
      level: headingLevelOf(block),
    }))
}

function safeHttpUrl(url: string) {
  const s = String(url || '').trim()
  if (!s) return ''
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.toString()
  } catch {
    return ''
  }
}

function parseBlocks(content: string | null | undefined): { blocks: Block[]; raw: string } {
  const raw = String(content || '')
  const s = raw.trim()
  if (!s) return { blocks: [], raw }
  try {
    const j = JSON.parse(s)
    if (Array.isArray(j)) return { blocks: j as any, raw }
  } catch {}
  return { blocks: [{ type: 'legacy_html', html: raw }], raw }
}

function stripLegacyHtml(content: string) {
  return String(content || '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|section|article|li|ul|ol|blockquote)\s*>/gi, '\n')
    .replace(/<\s*h([1-4])[^>]*>(.*?)<\/\s*h\1\s*>/gis, (_m, level, text) => `\n${'#'.repeat(Math.max(1, Math.min(4, Number(level) || 2)))} ${String(text || '').trim()}\n`)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}

function isNumberedSectionLine(line: string) {
  const match = line.match(/^(\d{1,2})[.、]\s*(\S.{1,36})$/)
  if (!match) return false
  const text = String(match[2] || '').trim()
  if (/关于|重点|要求|注意|说明|反馈|沟通|更新|上传|填写|交接|标准/.test(text)) return true
  return !/[。；;:：，,]$/.test(text) && text.length <= 18
}

function flushMarkdownParagraph(lines: string[], blocks: Block[]) {
  const text = lines.join('\n').trim()
  lines.length = 0
  if (text) blocks.push({ type: 'paragraph', text })
}

function parseMarkdownImage(line: string) {
  const m = line.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*$/)
  if (!m) return null
  return { caption: (m[1] || m[3] || '').trim(), url: String(m[2] || '').trim() }
}

function parseMarkdownToBlocks(markdown: string): Block[] {
  const normalized = String(markdown || '').replace(/\r\n?/g, '\n')
  const blocks: Block[] = []
  const paragraph: string[] = []
  const lines = normalized.split('\n')
  let i = 0

  while (i < lines.length) {
    const raw = lines[i] || ''
    const line = raw.trimEnd()
    const trimmed = line.trim()

    if (!trimmed) {
      flushMarkdownParagraph(paragraph, blocks)
      i += 1
      continue
    }

    const fence = trimmed.match(/^```([^`]*)$/)
    if (fence) {
      flushMarkdownParagraph(paragraph, blocks)
      const language = String(fence[1] || '').trim()
      const codeLines: string[] = []
      i += 1
      while (i < lines.length && !String(lines[i] || '').trim().startsWith('```')) {
        codeLines.push(lines[i] || '')
        i += 1
      }
      if (i < lines.length) i += 1
      blocks.push({ type: 'code', language, text: codeLines.join('\n') })
      continue
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/)
    if (heading) {
      flushMarkdownParagraph(paragraph, blocks)
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() })
      i += 1
      continue
    }

    if (isNumberedSectionLine(trimmed)) {
      flushMarkdownParagraph(paragraph, blocks)
      blocks.push({ type: 'heading', level: 2, text: trimmed.replace(/^\d{1,2}[.、]\s*/, '').trim() })
      i += 1
      continue
    }

    if (/^((请.+注意|特别注意|重要提醒)[:：]?|最后[，,、]?|说明[:：]?)$/.test(trimmed)) {
      flushMarkdownParagraph(paragraph, blocks)
      blocks.push({ type: 'callout', text: trimmed })
      i += 1
      continue
    }

    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushMarkdownParagraph(paragraph, blocks)
      i += 1
      continue
    }

    const image = parseMarkdownImage(trimmed)
    if (image?.url) {
      flushMarkdownParagraph(paragraph, blocks)
      blocks.push({ type: 'image', url: image.url, caption: image.caption })
      i += 1
      continue
    }

    if (trimmed.startsWith('>')) {
      flushMarkdownParagraph(paragraph, blocks)
      const quoteLines: string[] = []
      while (i < lines.length) {
        const q = String(lines[i] || '').trim()
        if (!q.startsWith('>')) break
        quoteLines.push(q.replace(/^>\s?/, '').trim())
        i += 1
      }
      blocks.push({ type: 'quote', text: quoteLines.join('\n').trim() })
      continue
    }

    const listMatch = trimmed.match(/^((?:[-*+•])|\d+[.)])\s*(.+)$/)
    if (listMatch) {
      flushMarkdownParagraph(paragraph, blocks)
      const ordered = /^\d+[.)]$/.test(listMatch[1])
      const items: string[] = []
      while (i < lines.length) {
        const itemLine = String(lines[i] || '').trim()
        const itemMatch = itemLine.match(/^((?:[-*+•])|\d+[.)])\s*(.+)$/)
        if (!itemMatch) break
        if (isNumberedSectionLine(itemLine)) break
        const nextOrdered = /^\d+[.)]$/.test(itemMatch[1])
        if (nextOrdered !== ordered) break
        items.push(itemMatch[2].trim())
        i += 1
      }
      if (items.length) blocks.push({ type: 'list', ordered, items })
      continue
    }

    paragraph.push(trimmed)
    i += 1
  }

  flushMarkdownParagraph(paragraph, blocks)
  return blocks
}

function parseBlocksForDisplay(content: string | null | undefined): Block[] {
  const parsed = parseBlocks(content)
  if (!(parsed.blocks.length === 1 && parsed.blocks[0].type === 'legacy_html')) return parsed.blocks
  const blocks = parseMarkdownToBlocks(stripLegacyHtml(parsed.raw))
  return blocks.length ? blocks : parsed.blocks
}

function blocksToPayload(blocks: Block[], rawFallback: string) {
  if (blocks.length === 1 && blocks[0].type === 'legacy_html') return rawFallback
  return JSON.stringify(blocks)
}

function isVideoFileUrl(url: string) {
  const s = String(url || '').trim().toLowerCase()
  return s.endsWith('.mp4') || s.endsWith('.webm') || s.endsWith('.ogg')
}

function BlocksRenderer({ blocks, headingIdPrefix }: { blocks: Block[]; headingIdPrefix?: string }) {
  let stepNo = 0
  return (
    <div style={{ lineHeight: 1.7, wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
      {blocks.map((b, idx) => {
        if (b.type === 'legacy_html') return <div key={idx} style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }} dangerouslySetInnerHTML={{ __html: b.html || '' }} />
        if (b.type === 'heading') {
          const level = headingLevelOf(b)
          const Tag = (`h${Math.min(level + 1, 4)}` as keyof JSX.IntrinsicElements)
          const fontSize = level === 1 ? 28 : (level === 2 ? 22 : 18)
          return <Tag id={headingIdPrefix ? headingDomId(headingIdPrefix, idx) : undefined} key={idx} style={{ scrollMarginTop: 24, margin: level === 1 ? '22px 0 12px' : '18px 0 8px', fontSize, fontWeight: 800, color: '#0f172a' }}>{b.text}</Tag>
        }
        if (b.type === 'callout') return <div key={idx} style={{ background: '#fff7e6', border: '1px solid #ffd591', padding: 10, borderRadius: 8, margin: '10px 0' }}>{b.text}</div>
        if (b.type === 'paragraph') return <p key={idx} style={{ margin: '8px 0' }}>{b.text}</p>
        if (b.type === 'quote') return <blockquote key={idx} style={{ margin: '12px 0', padding: '8px 12px', borderLeft: '4px solid #cbd5e1', background: '#f8fafc', color: '#475569', whiteSpace: 'pre-wrap' }}>{b.text}</blockquote>
        if (b.type === 'code') return <pre key={idx} style={{ margin: '12px 0', padding: 12, borderRadius: 10, background: '#0f172a', color: '#e2e8f0', overflowX: 'auto' }}><code>{b.text}</code></pre>
        if (b.type === 'list') {
          const items = Array.isArray(b.items) ? b.items : []
          const ListTag = b.ordered ? 'ol' : 'ul'
          return <ListTag key={idx} style={{ margin: '8px 0 12px', paddingLeft: 24 }}>{items.map((item, i) => <li key={i}>{item}</li>)}</ListTag>
        }
        if (b.type === 'image') {
          const url = safeHttpUrl(b.url)
          return (
            <figure key={idx} style={{ margin: '0 0 12px' }}>
              {url ? <img src={url} alt={b.caption || '内容图片'} style={{ maxWidth: '100%', borderRadius: 8 }} /> : null}
              {b.caption ? <figcaption style={{ color: '#666', fontSize: 12, marginTop: 4 }}>{b.caption}</figcaption> : null}
            </figure>
          )
        }
        if (b.type === 'video') {
          const url = safeHttpUrl(b.url)
          if (!url) return null
          return (
            <div key={idx} style={{ margin: '0 0 12px' }}>
              {isVideoFileUrl(url) ? (
                <video controls src={url} style={{ width: '100%', borderRadius: 8 }} />
              ) : (
                <a href={url} target="_blank" rel="noreferrer">{url}</a>
              )}
              {b.caption ? <div style={{ color: '#666', fontSize: 12, marginTop: 4 }}>{b.caption}</div> : null}
            </div>
          )
        }
        if (b.type === 'step') {
          stepNo += 1
          const items = Array.isArray(b.contents) ? b.contents : []
          return (
            <div key={idx} style={{ margin: '14px 0 18px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <div style={{ minWidth: 28, color: '#111827', fontWeight: 700 }}>{`${stepNo}.`}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{b.title}</div>
                {items.length ? (
                  <div style={{ marginTop: 6 }}>
                    {items.map((it, i) => {
                      if (it.type === 'text') return <div key={i} style={{ margin: '4px 0' }}>{it.text}</div>
                      const url = safeHttpUrl(String(it.url || ''))
                      if (it.type === 'image') {
                        return (
                          <figure key={i} style={{ margin: '6px 0 12px' }}>
                            {url ? <img src={url} alt={it.caption || '步骤图片'} style={{ maxWidth: '100%', borderRadius: 8 }} /> : null}
                            {it.caption ? <figcaption style={{ color: '#666', fontSize: 12, marginTop: 4 }}>{it.caption}</figcaption> : null}
                          </figure>
                        )
                      }
                      if (it.type === 'video') {
                        if (!url) return null
                        return (
                          <div key={i} style={{ margin: '6px 0 12px' }}>
                            {isVideoFileUrl(url) ? (
                              <video controls src={url} style={{ width: '100%', borderRadius: 8 }} />
                            ) : (
                              <a href={url} target="_blank" rel="noreferrer">{url}</a>
                            )}
                            {it.caption ? <div style={{ color: '#666', fontSize: 12, marginTop: 4 }}>{it.caption}</div> : null}
                          </div>
                        )
                      }
                      return null
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          )
        }
        return null
      })}
    </div>
  )
}

function BlocksEditor({ blocks, setBlocks }: { blocks: Block[]; setBlocks: (b: Block[]) => void }) {
  const { message, modal } = App.useApp()

  function addHeading() { setBlocks([...blocks, { type: 'heading', text: '' }]) }
  function addParagraph() { setBlocks([...blocks, { type: 'paragraph', text: '' }]) }
  function addCallout() { setBlocks([...blocks, { type: 'callout', text: '' }]) }
  function addStep() { setBlocks([...blocks, { type: 'step', title: '', contents: [] }]) }
  function addVideo() { setBlocks([...blocks, { type: 'video', url: '', caption: '' }]) }

  function update(i: number, patch: any) { const nb = blocks.slice(); nb[i] = { ...(nb[i] as any), ...patch } as any; setBlocks(nb) }
  function remove(i: number) { const nb = blocks.slice(); nb.splice(i, 1); setBlocks(nb) }
  function addStepText(i: number) {
    const nb = blocks.slice()
    const b = nb[i]
    if (b.type !== 'step') return
    b.contents = Array.isArray(b.contents) ? [...b.contents, { type: 'text', text: '' }] : [{ type: 'text', text: '' }]
    setBlocks(nb)
  }
  function addStepVideo(i: number) {
    const nb = blocks.slice()
    const b = nb[i]
    if (b.type !== 'step') return
    b.contents = Array.isArray(b.contents) ? [...b.contents, { type: 'video', url: '', caption: '' }] : [{ type: 'video', url: '', caption: '' }]
    setBlocks(nb)
  }
  function removeStepItem(i: number, idx: number) {
    const nb = blocks.slice()
    const b = nb[i]
    if (b.type !== 'step') return
    b.contents = Array.isArray(b.contents) ? b.contents.filter((_, k) => k !== idx) : []
    setBlocks(nb)
  }
  function updateStepItem(i: number, idx: number, patch: any) {
    const nb = blocks.slice()
    const b = nb[i]
    if (b.type !== 'step') return
    const c = Array.isArray(b.contents) ? b.contents.slice() : []
    const it = c[idx]
    if (!it) return
    c[idx] = { ...it, ...patch }
    b.contents = c
    setBlocks(nb)
  }

  function blockTitle(block: Block) {
    if (block.type === 'paragraph') return '文字'
    if (block.type === 'image') return '图片'
    if (block.type === 'heading') return '标题'
    if (block.type === 'callout') return '提示'
    if (block.type === 'video') return '视频'
    if (block.type === 'legacy_html') return '旧内容'
    if (block.type === 'list') return '列表'
    if (block.type === 'quote') return '引用'
    if (block.type === 'code') return '代码块'
    return '步骤'
  }

  async function uploadImage(file: File, stepIndex?: number) {
    const fd = new FormData()
    fd.append('file', file)
    try {
      const res = await fetch(`${API_BASE}/maintenance/upload`, { method: 'POST', headers: { ...authHeaders() }, body: fd })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      const url = safeHttpUrl(String(j?.url || ''))
      if (!url) throw new Error('missing url')
      if (typeof stepIndex === 'number') {
        const nb = blocks.slice()
        const b = nb[stepIndex]
        if (b.type === 'step') {
          b.contents = Array.isArray(b.contents) ? [...b.contents, { type: 'image', url, caption: '' }] : [{ type: 'image', url, caption: '' }]
          setBlocks(nb)
        }
      } else {
        setBlocks([...blocks, { type: 'image', url, caption: '' }])
      }
      message.success('图片已上传')
    } catch (e: any) {
      message.error(`上传失败：${String(e?.message || '')}`)
    }
  }

  async function importMarkdown(file: File) {
    const name = String(file?.name || '').trim()
    const lower = name.toLowerCase()
    if (!(lower.endsWith('.md') || lower.endsWith('.markdown') || String(file?.type || '').includes('markdown') || String(file?.type || '').startsWith('text/'))) {
      message.error('请选择 .md 或 .markdown 文件')
      return
    }
    try {
      const text = await file.text()
      const nextBlocks = parseMarkdownToBlocks(text)
      if (!nextBlocks.length) {
        message.warning('Markdown 文件没有可导入的内容')
        return
      }
      const apply = () => {
        setBlocks(nextBlocks)
        message.success(`已导入 Markdown：${name || '未命名文件'}`)
      }
      if (blocks.length) {
        modal.confirm({
          title: '导入 Markdown？',
          content: '导入后会替换当前编辑区内容。已保存的线上内容不会变化，只有点击保存后才会生效。',
          okText: '导入并替换',
          cancelText: '取消',
          onOk: apply,
        })
      } else {
        apply()
      }
    } catch (e: any) {
      message.error(`导入失败：${String(e?.message || '')}`)
    }
  }

  const uploadProps: UploadProps = {
    multiple: false,
    showUploadList: false,
    beforeUpload: (file) => { uploadImage(file as any); return false },
  }

  const quickActions = (
    <Space wrap size={8}>
      <Button onClick={addHeading}>添加标题</Button>
      <Button onClick={addStep}>添加步骤</Button>
      <Button onClick={addParagraph}>添加文字</Button>
      <Button onClick={addCallout}>添加提示块</Button>
      <Upload {...uploadProps}><Button>上传图片</Button></Upload>
      <Upload
        accept=".md,.markdown,text/markdown,text/plain"
        multiple={false}
        showUploadList={false}
        beforeUpload={(file) => { importMarkdown(file as any); return false }}
      >
        <Button>导入 Markdown</Button>
      </Upload>
      <Button onClick={addVideo}>添加视频链接</Button>
    </Space>
  )

  return (
    <div>
      <div style={{ position: 'sticky', top: 0, zIndex: 5, marginBottom: 16, padding: 14, border: '1px solid #cbd5e1', borderRadius: 14, background: 'linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)', boxShadow: '0 8px 24px rgba(15,23,42,0.08)', backdropFilter: 'blur(6px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
          <div style={{ fontWeight: 800, color: '#0f172a' }}>内容工具条</div>
          <div style={{ color: '#64748b', fontSize: 12 }}>添加内容块或导入 Markdown 后，右侧会实时预览</div>
        </div>
        {quickActions}
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 320 }}>
          {blocks.map((b, i) => (
            <Card
              key={i}
              size="small"
              style={{ marginBottom: 8 }}
              title={blockTitle(b)}
              extra={<Button danger size="small" onClick={() => remove(i)}>删除</Button>}
            >
              {b.type === 'legacy_html' ? (
                <Input.TextArea value={b.html || ''} disabled autoSize={{ minRows: 6 }} />
              ) : null}
              {b.type === 'heading' ? (
                <Space.Compact style={{ width: '100%' }}>
                  <Select
                    style={{ width: 110 }}
                    value={Math.max(1, Math.min(4, Number(b.level || 2)))}
                    onChange={(level) => update(i, { level })}
                    options={[
                      { value: 1, label: '一级标题' },
                      { value: 2, label: '二级标题' },
                      { value: 3, label: '三级标题' },
                      { value: 4, label: '四级标题' },
                    ]}
                  />
                  <Input value={b.text} onChange={(e) => update(i, { text: e.target.value })} />
                </Space.Compact>
              ) : null}
              {b.type === 'paragraph' ? (
                <Input.TextArea value={b.text} onChange={(e) => update(i, { text: e.target.value })} autoSize={{ minRows: 3 }} />
              ) : null}
              {b.type === 'callout' ? (
                <Input.TextArea value={b.text} onChange={(e) => update(i, { text: e.target.value })} autoSize={{ minRows: 2 }} />
              ) : null}
              {b.type === 'quote' ? (
                <Input.TextArea value={b.text} onChange={(e) => update(i, { text: e.target.value })} autoSize={{ minRows: 2 }} />
              ) : null}
              {b.type === 'code' ? (
                <div>
                  <Input placeholder="语言（可选，例如 ts / sql）" value={b.language} onChange={(e) => update(i, { language: e.target.value })} style={{ marginBottom: 8 }} />
                  <Input.TextArea value={b.text} onChange={(e) => update(i, { text: e.target.value })} autoSize={{ minRows: 4 }} />
                </div>
              ) : null}
              {b.type === 'list' ? (
                <div>
                  <Checkbox checked={!!b.ordered} onChange={(e) => update(i, { ordered: e.target.checked })} style={{ marginBottom: 8 }}>有序列表</Checkbox>
                  <Input.TextArea
                    value={(Array.isArray(b.items) ? b.items : []).join('\n')}
                    onChange={(e) => update(i, { items: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })}
                    autoSize={{ minRows: 3 }}
                    placeholder="每行一个列表项"
                  />
                </div>
              ) : null}
              {b.type === 'image' ? (
                <div>
                  {b.url ? <img src={safeHttpUrl(b.url)} alt={b.caption || '内容图片'} style={{ maxWidth: '100%', borderRadius: 8 }} /> : null}
                  <Input placeholder="图片说明（可选）" value={b.caption} onChange={(e) => update(i, { caption: e.target.value })} style={{ marginTop: 8 }} />
                </div>
              ) : null}
              {b.type === 'video' ? (
                <div>
                  <Input placeholder="视频链接（https）" value={b.url} onChange={(e) => update(i, { url: e.target.value })} />
                  <Input placeholder="说明（可选）" value={b.caption} onChange={(e) => update(i, { caption: e.target.value })} style={{ marginTop: 8 }} />
                </div>
              ) : null}
              {b.type === 'step' ? (
                <div>
                  <Input placeholder="步骤标题" value={b.title} onChange={(e) => update(i, { title: e.target.value })} style={{ marginBottom: 8 }} />
                  <Space style={{ marginBottom: 8 }} wrap>
                    <Button onClick={() => addStepText(i)}>添加文字子项</Button>
                    <Upload multiple={false} showUploadList={false} beforeUpload={(file) => { uploadImage(file as any, i); return false }}><Button>上传图片到步骤</Button></Upload>
                    <Button onClick={() => addStepVideo(i)}>添加视频到步骤</Button>
                  </Space>
                  {(Array.isArray(b.contents) ? b.contents : []).map((c, idx) => (
                    <Card key={idx} size="small" style={{ marginBottom: 8 }} title={c.type === 'text' ? '子项文字' : (c.type === 'image' ? '子项图片' : '子项视频')} extra={<Button danger size="small" onClick={() => removeStepItem(i, idx)}>删除</Button>}>
                      {c.type === 'text' ? (
                        <Input.TextArea value={c.text} onChange={(e) => updateStepItem(i, idx, { text: e.target.value })} autoSize={{ minRows: 2 }} />
                      ) : null}
                      {c.type === 'image' ? (
                        <div>
                          {c.url ? <img src={safeHttpUrl(String(c.url || ''))} alt={c.caption || '步骤图片'} style={{ maxWidth: '100%', borderRadius: 8 }} /> : null}
                          <Input placeholder="图片说明（可选）" value={c.caption} onChange={(e) => updateStepItem(i, idx, { caption: e.target.value })} style={{ marginTop: 8 }} />
                        </div>
                      ) : null}
                      {c.type === 'video' ? (
                        <div>
                          <Input placeholder="视频链接（https）" value={c.url} onChange={(e) => updateStepItem(i, idx, { url: e.target.value })} />
                          <Input placeholder="说明（可选）" value={c.caption} onChange={(e) => updateStepItem(i, idx, { caption: e.target.value })} style={{ marginTop: 8 }} />
                        </div>
                      ) : null}
                    </Card>
                  ))}
                </div>
              ) : null}
            </Card>
          ))}
        </div>
        <div style={{ width: 375, maxWidth: '100%', position: 'sticky', top: 72, border: '1px solid #eee', borderRadius: 24, padding: 12, boxShadow: '0 6px 20px rgba(0,0,0,0.08)', maxHeight: 'calc(100vh - 180px)', overflowY: 'auto', background: '#fff' }}>
          <Typography.Text type="secondary">预览</Typography.Text>
          <div style={{ marginTop: 8 }}>
            <BlocksRenderer blocks={blocks} />
          </div>
        </div>
      </div>
    </div>
  )
}

function CompanyPagesTab({ type }: { type: PageType }) {
  const { message } = App.useApp()
  const [rows, setRows] = useState<CompanyPageRow[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<CompanyPageRow | null>(null)
  const [viewOpen, setViewOpen] = useState(false)
  const [viewing, setViewing] = useState<CompanyPageRow | null>(null)
  const [viewBlocks, setViewBlocks] = useState<Block[]>([])
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkTarget, setLinkTarget] = useState<CompanyPageRow | null>(null)
  const [linkRows, setLinkRows] = useState<CompanyPagePublicLinkRow[]>([])
  const [linkLoading, setLinkLoading] = useState(false)
  const [form] = Form.useForm()
  const [blocks, setBlocks] = useState<Block[]>([])
  const [rawContent, setRawContent] = useState('')
  const [docCategoryFilter, setDocCategoryFilter] = useState<DocCategoryFilter>('all')
  const watchedCategory = Form.useWatch('category', form) as DocCategory | undefined
  const viewHeadingPrefix = 'company-content-view'
  const viewHeadings = useMemo(() => documentHeadings(viewBlocks, viewHeadingPrefix), [viewBlocks])

  const columns = (() => {
    const base: any[] = [
      { title: '标题', dataIndex: 'title', width: 260 },
      { title: '状态', dataIndex: 'status', width: 120, render: (v: any) => <Tag color={String(v) === 'published' ? 'green' : 'default'}>{String(v) === 'published' ? '已发布' : '草稿'}</Tag> },
    ]
    if (type === 'announce') {
      base.push({ title: '置顶', dataIndex: 'pinned', width: 80, render: (v: any) => v ? <Tag color="blue">置顶</Tag> : null })
      base.push({ title: '紧急', dataIndex: 'urgent', width: 80, render: (v: any) => v ? <Tag color="red">紧急</Tag> : null })
      base.push({ title: '发布日期', dataIndex: 'published_at', width: 130 })
      base.push({ title: '过期', dataIndex: 'expires_at', width: 130 })
      base.push({ title: '可见团队', dataIndex: 'audience_scope', width: 150, render: (v: AudienceScope | null | undefined) => v ? AUDIENCE_LABEL[v] || String(v) : <Tag>-</Tag> })
    }
    if (type === 'doc') {
      base.push({
        title: '分类',
        dataIndex: 'category',
        width: 160,
        render: (v: string | null | undefined) => {
          const meta = v ? DOC_CATEGORY_META[v as DocCategory] : null
          return <Tag color={meta?.color || 'default'}>{meta?.label || String(v || '-')}</Tag>
        },
      })
      base.push({
        title: (
          <Tooltip title="只用于移动端 App 的清洁员/检查员角色匹配；不是公司组织团队权限。">
            <span>App 角色</span>
          </Tooltip>
        ),
        dataIndex: 'guide_role',
        width: 140,
        render: (v: CompanyGuideRole | null | undefined) => {
          const label = v ? GUIDE_ROLE_LABEL[v] : ''
          return label ? <Tag color="blue">{label}</Tag> : <Tag>-</Tag>
        },
      })
      base.push({
        title: (
          <Tooltip title="控制公司内容中心里哪个团队可见，例如全员、保洁、仓库、维修或管理层。">
            <span>可见团队</span>
          </Tooltip>
        ),
        dataIndex: 'audience_scope',
        width: 150,
        render: (v: AudienceScope | null | undefined) => v ? AUDIENCE_LABEL[v] || String(v) : <Tag>-</Tag>,
      })
    }
    if (type === 'warehouse') {
      base.push({ title: '可见团队', dataIndex: 'audience_scope', width: 150, render: (v: AudienceScope | null | undefined) => v ? AUDIENCE_LABEL[v] || String(v) : <Tag>-</Tag> })
    }
    base.push({ title: '更新时间', dataIndex: 'updated_at', width: 190 })
    base.push({
      title: '操作',
      width: type === 'warehouse' ? 300 : 220,
      render: (_: any, r: CompanyPageRow) => (
        <TableRowActions
          actions={[
            { key: 'detail', label: '查看', onClick: () => openView(r) },
            { key: 'edit', label: '编辑', onClick: () => openEdit(r) },
            { key: 'link', label: '外链', onClick: () => openPublicLinks(r), hidden: type !== 'warehouse' },
            { key: 'delete', label: '删除', onClick: () => remove(r), danger: true },
          ]}
        />
      ),
    })
    return base
  })()

  const filteredRows = useMemo(() => {
    if (type !== 'doc' || docCategoryFilter === 'all') return rows
    return rows.filter((row) => String(row.category || '').trim() === docCategoryFilter)
  }, [docCategoryFilter, rows, type])

  const docCategoryCards = useMemo(() => {
    if (type !== 'doc') return []
    const total = rows.length
    const cards: Array<{ key: DocCategoryFilter; label: string; description: string; count: number }> = [
      { key: 'all', label: '全部文档', description: '按全部公司文档查看', count: total },
    ]
    for (const key of Object.keys(DOC_CATEGORY_META) as DocCategory[]) {
      cards.push({
        key,
        label: DOC_CATEGORY_META[key].label,
        description: DOC_CATEGORY_META[key].description,
        count: rows.filter((row) => String(row.category || '').trim() === key).length,
      })
    }
    return cards
  }, [rows, type])

  async function load() {
    setLoading(true)
    try {
      const data = await getJSON<CompanyPageRow[]>(`/cms/company/pages?type=${encodeURIComponent(type)}`)
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      message.error(String(e?.message || '加载失败'))
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [type])

  useEffect(() => {
    if (type !== 'doc') return
    if (isGuideRoleCategory(String(watchedCategory || '').trim())) return
    form.setFieldValue('guide_role', undefined)
  }, [form, type, watchedCategory])

  useEffect(() => {
    if (type !== 'doc') setDocCategoryFilter('all')
  }, [type])

  function resetEditorContent(content: string | null | undefined) {
    const p = parseBlocks(content)
    setBlocks(p.blocks)
    setRawContent(p.raw)
  }

  function resetEditor() {
    setEditing(null)
    form.resetFields()
    resetEditorContent('')
  }

  function closeEditor() {
    if (saving) return
    setOpen(false)
    resetEditor()
  }

  function openCreate(preset?: { category?: DocCategory; guide_role?: CompanyGuideRole; audience_scope?: AudienceScope; title?: string }) {
    setEditing(null)
    form.resetFields()
    resetEditorContent('')
    const presetCategory = type === 'doc'
      ? (preset?.category || (docCategoryFilter !== 'all' ? docCategoryFilter : undefined))
      : undefined
    form.setFieldsValue({
      slug: '',
      title: preset?.title || '',
      status: 'draft',
      published_at: null,
      expires_at: null,
      pinned: false,
      urgent: false,
      category: presetCategory,
      guide_role: preset?.guide_role,
      audience_scope: preset?.audience_scope || (presetCategory === 'starter_guide' ? 'all_staff' : undefined),
    })
    setOpen(true)
  }

  function openEdit(r: CompanyPageRow) {
    setEditing(r)
    form.resetFields()
    form.setFieldsValue({
      slug: r.slug || '',
      title: r.title || '',
      status: r.status || 'draft',
      published_at: r.published_at ? dayjs(r.published_at) : null,
      expires_at: r.expires_at ? dayjs(r.expires_at) : null,
      pinned: !!r.pinned,
      urgent: !!r.urgent,
      category: r.category || undefined,
      guide_role: r.guide_role || undefined,
      audience_scope: r.audience_scope || undefined,
    })
    resetEditorContent(r.content || '')
    setOpen(true)
  }

  function openView(r: CompanyPageRow) {
    setViewing(r)
    setViewBlocks(parseBlocksForDisplay(r.content || ''))
    setViewOpen(true)
  }

  async function openPublicLinks(r: CompanyPageRow) {
    setLinkTarget(r)
    setLinkOpen(true)
    await loadPublicLinks(r)
  }

  async function loadPublicLinks(r?: CompanyPageRow | null) {
    const row = r || linkTarget
    const id = String(row?.id || '').trim()
    if (!id) {
      setLinkRows([])
      return
    }
    setLinkLoading(true)
    try {
      const data = await getJSON<CompanyPagePublicLinkRow[]>(`/cms/company/pages/${encodeURIComponent(id)}/public-links`)
      setLinkRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      message.error(String(e?.message || '加载外链失败'))
      setLinkRows([])
    } finally {
      setLinkLoading(false)
    }
  }

  function buildPublicWarehouseUrl(token?: string | null) {
    const tk = String(token || '').trim()
    if (!tk) return ''
    if (typeof window === 'undefined') return `/public/company-warehouse/${tk}`
    return `${window.location.origin}/public/company-warehouse/${tk}`
  }

  async function createPublicLink() {
    const id = String(linkTarget?.id || '').trim()
    if (!id) return
    try {
      const j = await postJSON<{ token: string; expires_at?: string | null }>(`/cms/company/pages/${encodeURIComponent(id)}/public-link`, {})
      const url = buildPublicWarehouseUrl(j?.token)
      if (url) {
        try { await navigator.clipboard?.writeText?.(url) } catch {}
        message.success('已创建并复制外链')
      } else {
        message.success('已创建外链')
      }
      await loadPublicLinks(linkTarget)
    } catch (e: any) {
      message.error(String(e?.message || '创建外链失败'))
    }
  }

  async function revokePublicLink(tokenHash: string) {
    try {
      await postJSON(`/cms/company/pages/public-links/${encodeURIComponent(tokenHash)}/revoke`, {})
      message.success('已撤销')
      await loadPublicLinks(linkTarget)
    } catch (e: any) {
      message.error(String(e?.message || '撤销失败'))
    }
  }

  function closeView() {
    setViewOpen(false)
    setViewing(null)
    setViewBlocks([])
  }

  function scrollToViewHeading(id: string) {
    try {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } catch {}
  }

  function pill(opts: { icon?: any; text: string; tone?: 'default' | 'success' | 'danger' }) {
    const tone = opts.tone || 'default'
    const styleBy: Record<string, any> = {
      default: { background: '#f8fafc', borderColor: '#e5e7eb', color: '#334155' },
      success: { background: '#ecfdf5', borderColor: '#bbf7d0', color: '#047857' },
      danger: { background: '#fef2f2', borderColor: '#fecaca', color: '#b91c1c' },
    }
    const s = styleBy[tone] || styleBy.default
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 14, border: `1px solid ${s.borderColor}`, background: s.background, color: s.color, fontWeight: 600 }}>
        {opts.icon ? <span style={{ fontSize: 16, lineHeight: 1 }}>{opts.icon}</span> : null}
        <span>{opts.text}</span>
      </div>
    )
  }

  function copyViewLink() {
    const id = String(viewing?.id || '').trim()
    if (!id) return
    const base = typeof window !== 'undefined' ? window.location.origin : ''
    const link = base ? `${base}/cms/company#${encodeURIComponent(id)}` : id
    try {
      if (navigator?.clipboard?.writeText) {
        navigator.clipboard.writeText(link).then(() => message.success('已复制')).catch(() => message.success('已复制'))
      } else {
        message.success('已复制')
      }
    } catch {
      message.success('已复制')
    }
  }

  function openEditFromView() {
    const v = viewing
    if (!v) return
    closeView()
    openEdit(v)
  }

  async function remove(r: CompanyPageRow) {
    Modal.confirm({
      title: '确认删除？',
      onOk: async () => {
        try {
          await deleteJSON(`/cms/company/pages/${encodeURIComponent(String(r.id))}`)
          message.success('已删除')
          await load()
        } catch (e: any) {
          message.error(String(e?.message || '删除失败'))
        }
      },
    })
  }

  async function submit() {
    if (saving) return
    const v = await form.validateFields()
    const payload: any = {
      slug: v.slug ? String(v.slug).trim() : undefined,
      title: String(v.title || '').trim(),
      content: blocksToPayload(blocks, rawContent),
      status: v.status as PageStatus,
      published_at: v.published_at ? dayjs(v.published_at).format('YYYY-MM-DD') : undefined,
      expires_at: v.expires_at ? dayjs(v.expires_at).format('YYYY-MM-DD') : undefined,
      audience_scope: v.audience_scope || undefined,
    }
    if (type === 'announce') {
      payload.pinned = !!v.pinned
      payload.urgent = !!v.urgent
    }
    if (type === 'doc') {
      payload.category = v.category
      if (isGuideRoleCategory(String(v.category || '').trim())) payload.guide_role = v.guide_role || undefined
    }
    if (!payload.slug) delete payload.slug
    if (!payload.published_at) delete payload.published_at
    if (!payload.expires_at) delete payload.expires_at
    if (!payload.audience_scope) delete payload.audience_scope
    if (!payload.guide_role) delete payload.guide_role

    setSaving(true)
    try {
      if (editing?.id) {
        await patchJSON(`/cms/company/pages/${encodeURIComponent(String(editing.id))}`, payload)
        message.success('已更新')
      } else {
        await postJSON(`/cms/company/pages`, { ...payload, type })
        message.success('已创建')
      }
      setOpen(false)
      resetEditor()
      await load()
    } catch (e: any) {
      message.error(String(e?.message || '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Button type="primary" onClick={() => openCreate()}>新建</Button>
      </div>
      {type === 'doc' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
          {docCategoryCards.map((item) => {
            const active = docCategoryFilter === item.key
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setDocCategoryFilter(item.key)}
                style={{
                  textAlign: 'left',
                  border: active ? '1px solid #2563eb' : '1px solid #e5e7eb',
                  background: active ? '#eff6ff' : '#ffffff',
                  borderRadius: 16,
                  padding: 14,
                  cursor: 'pointer',
                  boxShadow: active ? '0 8px 24px rgba(37,99,235,0.12)' : 'none',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>{item.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: active ? '#2563eb' : '#0f172a' }}>{item.count}</div>
                </div>
                <div style={{ marginTop: 6, color: '#64748b', fontSize: 13 }}>{item.description}</div>
              </button>
            )
          })}
        </div>
      ) : null}
      <Table
        rowKey={(r) => String(r.id)}
        dataSource={filteredRows}
        columns={columns as any}
        loading={loading}
        pagination={{ pageSize: 10, showSizeChanger: true }}
        tableLayout="auto"
        scroll={{ x: 'max-content' }}
      />
      <Drawer
        open={viewOpen}
        onClose={closeView}
        width={1180}
        destroyOnHidden
        title={
          <Space>
            {type === 'announce' ? <NotificationOutlined /> : (type === 'warehouse' ? <InboxOutlined /> : <FileTextOutlined />)}
            <span>{type === 'announce' ? '查看公告内容' : (type === 'warehouse' ? '查看仓库指南' : '查看文档内容')}</span>
          </Space>
        }
        extra={
          <Space>
            <Button icon={<PrinterOutlined />} onClick={() => { try { window.print() } catch {} }}>打印</Button>
            <Button type="primary" icon={<EditOutlined />} onClick={openEditFromView}>进入编辑</Button>
          </Space>
        }
      >
        <div style={{ display: 'grid', gridTemplateColumns: viewHeadings.length ? '220px minmax(0, 1fr)' : 'minmax(0, 1fr)', gap: 24, alignItems: 'start' }}>
          {viewHeadings.length ? (
            <aside style={{ position: 'sticky', top: 0, maxHeight: 'calc(100vh - 140px)', overflowY: 'auto', borderRight: '1px solid #e5e7eb', paddingRight: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: '#0f172a', marginBottom: 10 }}>文档导航</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {viewHeadings.map((heading) => (
                  <button
                    key={heading.id}
                    type="button"
                    onClick={() => scrollToViewHeading(heading.id)}
                    style={{
                      border: 0,
                      background: 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                      padding: '6px 8px',
                      paddingLeft: 8 + Math.max(0, heading.level - 1) * 12,
                      borderRadius: 8,
                      color: '#475569',
                      fontSize: heading.level === 1 ? 14 : 13,
                      fontWeight: heading.level === 1 ? 800 : 600,
                      lineHeight: 1.45,
                    }}
                  >
                    {heading.text}
                  </button>
                ))}
              </div>
            </aside>
          ) : null}

          <main style={{ minWidth: 0 }}>
            <Space wrap style={{ marginBottom: 18 }}>
              {viewing?.status ? pill({ icon: <CheckCircleOutlined />, text: String(viewing.status) === 'published' ? '已发布' : '草稿', tone: String(viewing.status) === 'published' ? 'success' : 'default' }) : null}
              {viewing?.audience_scope ? pill({ icon: <UserOutlined />, text: `可见团队: ${AUDIENCE_LABEL[viewing.audience_scope as AudienceScope] || String(viewing.audience_scope)}` }) : null}
              {type === 'doc' && viewing?.category ? pill({ icon: <FileTextOutlined />, text: `分类: ${docCategoryLabel(viewing.category)}` }) : null}
              {type === 'doc' && viewing?.guide_role ? pill({ icon: <UserOutlined />, text: `App 角色: ${GUIDE_ROLE_LABEL[viewing.guide_role] || String(viewing.guide_role)}` }) : null}
              {type === 'announce' && viewing?.published_at ? pill({ icon: <CalendarOutlined />, text: `发布: ${String(viewing.published_at)}` }) : null}
              {type === 'announce' && viewing?.expires_at ? pill({ icon: <CalendarOutlined />, text: `过期: ${String(viewing.expires_at)}` }) : null}
              {type === 'announce' && viewing?.pinned ? pill({ text: '置顶', tone: 'default' }) : null}
              {type === 'announce' && viewing?.urgent ? pill({ text: '紧急', tone: 'danger' }) : null}
            </Space>

            <div style={{ maxWidth: 820 }}>
              <div style={{ fontSize: 34, fontWeight: 900, color: '#0f172a', marginBottom: 14, lineHeight: 1.22 }}>
                {String(viewing?.title || '')}
              </div>

              <div style={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 18, padding: '18px 22px', boxShadow: '0 10px 28px rgba(15,23,42,0.06)' }}>
                <BlocksRenderer blocks={viewBlocks} headingIdPrefix={viewHeadingPrefix} />
              </div>

              <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 14, border: '1px solid #e5e7eb', background: '#f8fafc', color: '#64748b', fontWeight: 600 }}>
                  <ClockCircleOutlined />
                  <span>最后更新于: {String(viewing?.updated_at || '')}</span>
                </div>
                {type === 'announce' ? (
                  <Button icon={<CopyOutlined />} onClick={copyViewLink}>复制公告链接</Button>
                ) : null}
              </div>
            </div>
          </main>
        </div>
      </Drawer>
      <Drawer
        open={open}
        onClose={closeEditor}
        title={
          editing
            ? (type === 'announce' ? '编辑公告' : (type === 'doc' ? '编辑公司文档' : '编辑仓库指南'))
            : (type === 'announce' ? '新建公告' : (type === 'doc' ? '新建公司文档' : '新建仓库指南'))
        }
        width={1320}
        destroyOnHidden={false}
        extra={
          <Space>
            <Button onClick={closeEditor} disabled={saving}>取消</Button>
            <Button type="primary" loading={saving} onClick={() => { submit().catch(() => {}) }}>
              {editing ? '保存修改' : '立即创建'}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" initialValues={{ status: 'draft', pinned: false, urgent: false }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <Card
              title="基础信息"
              style={{ width: 360, maxWidth: '100%', position: 'sticky', top: 0, borderRadius: 16 }}
              bodyStyle={{ paddingBottom: 8 }}
            >
              {type === 'doc' ? (
                <div style={{ marginBottom: 12, padding: 12, borderRadius: 12, background: '#f8fafc', color: '#475569', lineHeight: 1.6 }}>
                  新手指南建议放下载安装、登录和首次进入 App；
                  <br />
                  角色使用说明建议按岗位拆开写，避免一篇文档塞太多角色内容。
                </div>
              ) : null}
              <Form.Item name="slug" label="Slug（可选）">
                <Input placeholder={type === 'announce' ? '例如 announce:staff-policy' : (type === 'doc' ? '例如 doc:app-download-guide' : '例如 warehouse:docklands')} />
              </Form.Item>
              <Form.Item name="title" label="标题" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              {type === 'doc' ? (
                <>
                  <Form.Item name="category" label="分类" rules={[{ required: true }]}>
                    <Select options={DOC_CATEGORY_OPTIONS} />
                  </Form.Item>
                  {isGuideRoleCategory(String(watchedCategory || '').trim()) ? (
                    <Form.Item
                      name="guide_role"
                      label="App 角色匹配（可选）"
                      tooltip="只用于移动端 App 的清洁员/检查员文档匹配；不是公司团队权限。"
                      extra="留空表示该分类下所有 App 角色都可看到。"
                    >
                      <Select allowClear options={GUIDE_ROLE_OPTIONS} placeholder="选择清洁员或检查员" />
                    </Form.Item>
                  ) : null}
                </>
              ) : null}
              <Form.Item name="status" label="状态" rules={[{ required: true }]}>
                <Select options={STATUS_OPTIONS} />
              </Form.Item>
              <Form.Item
                name="audience_scope"
                label="可见团队（可选）"
                tooltip="按公司组织团队控制内容可见范围。"
                extra="留空通常表示不额外限制；全员可见会显示给所有员工。"
              >
                <Select allowClear optionLabelProp="title" options={AUDIENCE_SELECT_OPTIONS} placeholder="选择这篇内容给哪个团队看" />
              </Form.Item>
              {type === 'announce' ? (
                <>
                  <Form.Item name="published_at" label="发布日期（可选）">
                    <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" />
                  </Form.Item>
                  <Form.Item name="expires_at" label="过期时间（可选）">
                    <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" />
                  </Form.Item>
                  <Space style={{ marginBottom: 8 }} wrap>
                    <Form.Item name="pinned" valuePropName="checked" style={{ marginBottom: 0 }}>
                      <Checkbox>置顶</Checkbox>
                    </Form.Item>
                    <Form.Item name="urgent" valuePropName="checked" style={{ marginBottom: 0 }}>
                      <Checkbox>紧急</Checkbox>
                    </Form.Item>
                  </Space>
                </>
              ) : null}
            </Card>
            <Card title="内容编辑" style={{ flex: 1, minWidth: 320, borderRadius: 16 }} bodyStyle={{ paddingBottom: 8 }}>
              <Form.Item label="内容" style={{ marginBottom: 0 }}>
                <BlocksEditor blocks={blocks} setBlocks={setBlocks} />
              </Form.Item>
            </Card>
          </div>
        </Form>
      </Drawer>

      <Modal
        open={linkOpen}
        onCancel={() => { setLinkOpen(false); setLinkTarget(null); setLinkRows([]) }}
        footer={null}
        width={980}
        title="仓库指南外部访问链接"
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontWeight: 700, color: '#111827' }}>{String(linkTarget?.title || '') || '仓库指南'}</div>
              <div style={{ color: '#64748b', marginTop: 4 }}>仅已发布的仓库指南可生成外部访问链接。</div>
            </div>
            <Button type="primary" icon={<LinkOutlined />} disabled={String(linkTarget?.status || '') !== 'published'} onClick={createPublicLink}>
              生成新外链
            </Button>
          </div>
          {String(linkTarget?.status || '') !== 'published' ? (
            <Typography.Text type="warning">当前记录不是 `published` 状态，暂时不能生成外链。</Typography.Text>
          ) : null}
          <Table
            rowKey={(r) => String(r.token_hash)}
            loading={linkLoading}
            pagination={false}
            dataSource={linkRows}
            tableLayout="fixed"
            scroll={{ x: 900 }}
            columns={[
              {
                title: '外链',
                dataIndex: 'token',
                width: 420,
                render: (_: any, r: CompanyPagePublicLinkRow) => {
                  const url = buildPublicWarehouseUrl(r.token)
                  return url ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', minWidth: 0 }}>
                      <Input value={url} readOnly style={{ width: '100%' }} />
                      <Space wrap>
                        <Button onClick={() => { navigator.clipboard?.writeText?.(url); message.success('已复制') }}>复制</Button>
                        <Button onClick={() => window.open(url, '_blank')}>打开</Button>
                      </Space>
                    </div>
                  ) : <Typography.Text type="secondary">无法恢复原始 token</Typography.Text>
                },
              },
              {
                title: '创建时间',
                dataIndex: 'created_at',
                width: 160,
                render: (v: any) => <div style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{String(v || '-')}</div>,
              },
              {
                title: '过期时间',
                dataIndex: 'expires_at',
                width: 160,
                render: (v: any) => <div style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{String(v || '-')}</div>,
              },
              { title: '状态', dataIndex: 'revoked_at', width: 90, render: (v: any) => v ? <Tag color="red">已撤销</Tag> : <Tag color="green">有效</Tag> },
              {
                title: '操作',
                width: 90,
                render: (_: any, r: CompanyPagePublicLinkRow) => !r.revoked_at ? <Button danger size="small" onClick={() => revokePublicLink(r.token_hash)}>撤销</Button> : null,
              },
            ] as any}
          />
        </Space>
      </Modal>
    </div>
  )
}

function PasswordConfigTab() {
  const { message } = App.useApp()
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [secretRows, setSecretRows] = useState<any[]>([])
  const [secretLoading, setSecretLoading] = useState(false)
  const [secretOpen, setSecretOpen] = useState(false)
  const [secretEditing, setSecretEditing] = useState<any | null>(null)
  const [secretForm] = Form.useForm()

  const items = useMemo(() => ([
    { key: 'cleaning-guide', name: '清洁公开指南', info: '/public/cleaning-guide/password-info', current: '/public/cleaning-guide/current-password', reset: '/public/cleaning-guide/reset-password', clear: '/public/cleaning-guide/clear-password' },
    { key: 'maintenance-share', name: '维修分享外链', info: '/public/maintenance-share/password-info', current: '/public/maintenance-share/current-password', reset: '/public/maintenance-share/reset-password', clear: '/public/maintenance-share/clear-password' },
    { key: 'maintenance-progress', name: '维修进度公开页', info: '/public/maintenance-progress/password-info', current: '/public/maintenance-progress/current-password', reset: '/public/maintenance-progress/reset-password', clear: '/public/maintenance-progress/clear-password' },
    { key: 'deep-cleaning-share', name: '深清分享外链', info: '/public/deep-cleaning-share/password-info', current: '/public/deep-cleaning-share/current-password', reset: '/public/deep-cleaning-share/reset-password', clear: '/public/deep-cleaning-share/clear-password' },
    { key: 'deep-cleaning-upload', name: '深清上传外链', info: '/public/deep-cleaning-upload/password-info', current: '/public/deep-cleaning-upload/current-password', reset: '/public/deep-cleaning-upload/reset-password', clear: '/public/deep-cleaning-upload/clear-password' },
    { key: 'company-expense', name: '公司支出外部登记', info: '/public/company-expense/password-info', current: '/public/company-expense/current-password', reset: '/public/company-expense/reset-password', clear: '/public/company-expense/clear-password' },
    { key: 'property-expense', name: '房源支出外部登记', info: '/public/property-expense/password-info', current: '/public/property-expense/current-password', reset: '/public/property-expense/reset-password', clear: '/public/property-expense/clear-password' },
    { key: 'property-guide', name: '入住指南外链', info: '/public/property-guide/password-info', current: '/public/property-guide/current-password', reset: '/public/property-guide/reset-password', clear: '/public/property-guide/clear-password' },
  ]), [])

  async function load() {
    setLoading(true)
    try {
      const out: any[] = []
      for (const it of items) {
        try {
          const j = await getJSON<any>(it.info)
          let currentPwd: string | null = null
          try {
            const c = await getJSON<any>(it.current)
            currentPwd = c?.password ? String(c.password) : null
          } catch {}
          out.push({ ...it, configured: !!j?.configured, password_updated_at: j?.password_updated_at || null, password: currentPwd })
        } catch (e: any) {
          out.push({ ...it, configured: false, password_updated_at: null, password: null, error: String(e?.message || 'failed') })
        }
      }
      setRows(out)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function loadSecrets() {
    setSecretLoading(true)
    try {
      const data = await getJSON<any[]>(`/cms/company/secrets?include_secret=1`)
      setSecretRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      message.error(String(e?.message || '加载失败'))
      setSecretRows([])
    } finally {
      setSecretLoading(false)
    }
  }

  useEffect(() => { loadSecrets() }, [])

  const columns = [
    { title: '项目', dataIndex: 'name', width: 220 },
    { title: '配置状态', dataIndex: 'configured', width: 120, render: (v: any) => v ? <Tag color="green">已配置</Tag> : <Tag>未配置</Tag> },
    { title: '密码', dataIndex: 'password', width: 220, render: (v: any) => v ? <Tag color="blue">{String(v)}</Tag> : <Tag>-</Tag> },
    { title: '更新时间', dataIndex: 'password_updated_at', width: 220 },
    { title: '错误', dataIndex: 'error', width: 220, render: (v: any) => v ? <Tag color="red">{String(v)}</Tag> : null },
    {
      title: '操作',
      width: 220,
      render: (_: any, r: any) => (
        <Space>
          <Button onClick={() => resetPassword(r)}>重置密码</Button>
          <Button danger onClick={() => clearPassword(r)}>清除</Button>
        </Space>
      ),
    },
  ]

  async function resetPassword(r: any) {
    const holder: any = { form: null as any }
    const FormInner = () => {
      const [f] = Form.useForm()
      holder.form = f
      return (
        <Form form={f} layout="vertical">
          <Form.Item name="new_password" label="新密码" rules={[{ required: true }]}><Input.Password /></Form.Item>
        </Form>
      )
    }
    Modal.confirm({
      title: `重置密码：${String(r.name || '')}`,
      content: <FormInner />,
      onOk: async () => {
        const v = await holder.form.validateFields()
        const res = await postJSON<any>(r.reset, { new_password: v.new_password })
        if (res?.ok) {
          const stored = res?.stored === false ? '（未加密存储，缺少密钥）' : ''
          message.success(`已重置，新密码：${String(res?.password || v.new_password)}${stored}`)
          await load()
          return
        }
        message.success('已重置')
        await load()
      },
    })
  }

  async function clearPassword(r: any) {
    Modal.confirm({
      title: `清除配置：${String(r.name || '')}`,
      content: '将删除该入口的 public_access 记录，外部访问将失效（直到重新设置）。',
      okType: 'danger',
      onOk: async () => {
        try {
          const res = await postJSON<any>(String(r.clear || ''), {})
          if (res?.ok) message.success('已清除')
          else message.success('已清除')
          await load()
        } catch (e: any) {
          message.error(String(e?.message || '清除失败'))
        }
      },
    })
  }

  async function openCreateSecret() {
    setSecretEditing(null)
    secretForm.resetFields()
    setSecretOpen(true)
  }

  async function openEditSecret(r: any) {
    setSecretEditing(r)
    secretForm.resetFields()
    secretForm.setFieldsValue({ title: r.title || '', note: r.note || '' })
    setSecretOpen(true)
  }

  async function submitSecret() {
    const v = await secretForm.validateFields()
    try {
      if (secretEditing?.id) {
        const payload: any = { title: String(v.title || '').trim(), note: v.note ? String(v.note) : '' }
        if (v.secret) payload.secret = String(v.secret)
        await patchJSON(`/cms/company/secrets/${encodeURIComponent(String(secretEditing.id))}`, payload)
        message.success('已更新')
      } else {
        await postJSON(`/cms/company/secrets`, { title: String(v.title || '').trim(), note: v.note ? String(v.note) : undefined, secret: String(v.secret || '') })
        message.success('已创建')
      }
      setSecretOpen(false)
      setSecretEditing(null)
      secretForm.resetFields()
      await loadSecrets()
    } catch (e: any) {
      message.error(String(e?.message || '保存失败'))
    }
  }

  async function removeSecret(r: any) {
    Modal.confirm({
      title: `确认删除：${String(r.title || '')}？`,
      okType: 'danger',
      onOk: async () => {
        try {
          await deleteJSON(`/cms/company/secrets/${encodeURIComponent(String(r.id))}`)
          message.success('已删除')
          await loadSecrets()
        } catch (e: any) {
          message.error(String(e?.message || '删除失败'))
        }
      },
    })
  }

  async function copySecretText(r: any) {
    const id = String(r?.id || '').trim()
    const s = String(r?.secret || '')
    if (!id || !s) return
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(s)
      }
    } catch {}
    try { await postJSON(`/cms/company/secrets/${encodeURIComponent(id)}/log-copy`, {}) } catch {}
    message.success('已复制')
  }

  const secretColumns = [
    { title: '标题', dataIndex: 'title', width: 260 },
    { title: '密码', dataIndex: 'secret', width: 220, render: (v: any, r: any) => (
      <Space>
        {v ? <Tag color="blue">{String(v)}</Tag> : <Tag>-</Tag>}
        <Button size="small" disabled={!v} onClick={() => copySecretText(r)}>复制</Button>
      </Space>
    ) },
    { title: '备注', dataIndex: 'note', width: 260 },
    { title: '更新时间', dataIndex: 'updated_at', width: 200 },
    {
      title: '操作',
      width: 220,
      render: (_: any, r: any) => (
        <Space>
          <Button onClick={() => openEditSecret(r)}>编辑</Button>
          <Button danger onClick={() => removeSecret(r)}>删除</Button>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 0 }}>访问密码管理（对外入口）</Typography.Title>
        <Space wrap>
          <Button onClick={load} loading={loading}>刷新</Button>
        </Space>
      </div>
      <div style={{ height: 12 }} />
      <Table
        rowKey={(r) => String(r.key)}
        dataSource={rows}
        columns={columns as any}
        loading={loading}
        pagination={false}
        tableLayout="auto"
        scroll={{ x: 'max-content' }}
      />

      <div style={{ height: 18 }} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 0 }}>内部机密项（可存储/修改）</Typography.Title>
        <Space wrap>
          <Button type="primary" onClick={openCreateSecret}>新增</Button>
          <Button onClick={loadSecrets} loading={secretLoading}>刷新</Button>
        </Space>
      </div>
      <div style={{ height: 12 }} />
      <Table
        rowKey={(r) => String(r.id)}
        dataSource={secretRows}
        columns={secretColumns as any}
        loading={secretLoading}
        pagination={{ pageSize: 10, showSizeChanger: true }}
        tableLayout="auto"
        scroll={{ x: 'max-content' }}
      />

      <Modal
        open={secretOpen}
        onCancel={() => { setSecretOpen(false); setSecretEditing(null) }}
        onOk={submitSecret}
        title={secretEditing ? '编辑内部机密项' : '新增内部机密项'}
      >
        <Form form={secretForm} layout="vertical">
          <Form.Item name="title" label="标题" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="note" label="备注（可选）"><Input.TextArea rows={3} /></Form.Item>
          <Form.Item name="secret" label={secretEditing ? '密码（留空则不修改）' : '密码'} rules={secretEditing ? [] : [{ required: true }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default function Page() {
  const tabs = [
    { key: 'announce', label: '发布公告', children: <CompanyPagesTab type="announce" /> },
    { key: 'doc', label: '公司文档', children: <CompanyPagesTab type="doc" /> },
    { key: 'warehouse', label: '仓库指南', children: <CompanyPagesTab type="warehouse" /> },
    { key: 'passwords', label: '密码配置', children: <PasswordConfigTab /> },
  ]
  return (
    <Card>
      <Typography.Title level={3} style={{ marginTop: 0 }}>公司内容中心</Typography.Title>
      <Tabs items={tabs as any} />
    </Card>
  )
}
