"use client"

import { Alert, App, Button, Card, Drawer, Empty, Form, Input, Select, Space, Tabs, Tag, Typography } from 'antd'
import { BookOutlined, CheckCircleOutlined, ClockCircleOutlined, EditOutlined, FileTextOutlined, SearchOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getJSON, patchJSON, postJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'

type PageStatus = 'draft' | 'published'
type AudienceScope = 'all_staff' | 'cleaners' | 'warehouse_staff' | 'maintenance_staff' | 'managers'

type ManualRow = {
  id: string
  slug?: string | null
  title?: string | null
  content?: string | null
  status?: PageStatus | null
  audience_scope?: AudienceScope | null
  published_at?: string | null
  updated_at?: string | null
  updated_by?: string | null
  created_at?: string | null
  virtual?: boolean
}

type ContentStepItem = { type: 'text' | 'image' | 'video'; text?: string; url?: string; caption?: string }
type ContentBlock =
  | { type: 'heading'; text?: string; level?: number }
  | { type: 'paragraph'; text?: string }
  | { type: 'callout'; text?: string }
  | { type: 'image'; url?: string; caption?: string }
  | { type: 'video'; url?: string; caption?: string }
  | { type: 'step'; title?: string; contents?: ContentStepItem[] }
  | { type: 'legacy_html'; html?: string }

type ManualSection = {
  id: string
  title: string
  level: number
  blocks: ContentBlock[]
  text: string
  index: number
}

const CATEGORY = 'customer_service_manual'
const MANUAL_SLUG = 'cs-manual'
const DEFAULT_TITLE = '客服培训与实操手册'

const STATUS_OPTIONS = [
  { value: 'published', label: '已发布' },
  { value: 'draft', label: '草稿' },
]

const AUDIENCE_OPTIONS: Array<{ value: AudienceScope; label: string }> = [
  { value: 'managers', label: '管理层全部' },
  { value: 'all_staff', label: '全员可见' },
  { value: 'cleaners', label: '保洁团队' },
  { value: 'warehouse_staff', label: '仓库团队' },
  { value: 'maintenance_staff', label: '维修团队' },
]

const AUDIENCE_LABEL: Record<AudienceScope, string> = {
  all_staff: '全员可见',
  cleaners: '保洁团队',
  warehouse_staff: '仓库团队',
  maintenance_staff: '维修团队',
  managers: '管理层全部',
}

const SEARCH_SYNONYMS: Array<{ triggers: string[]; terms: string[] }> = [
  {
    triggers: ['没电', '无电', '停电', '断电', '跳闸', '电源', '插座', '灯不亮', '充不了电', '不能充电'],
    terms: ['停电', '无电', '断电', '部分插座无电', '插座无电', '电源', '电闸', '跳闸', '灯不亮'],
  },
  {
    triggers: ['wifi', 'wi-fi', '无线网', '网络', '上不了网', '连不上网', '网不好'],
    terms: ['wifi', 'wi-fi', '无线网', '网络', '路由器', '无法连接'],
  },
  {
    triggers: ['退款', '退钱', '补偿', '赔偿', '取消', '改期'],
    terms: ['取消', '退款', '改期', '补偿', '赔偿', '不能自行批准补偿'],
  },
  {
    triggers: ['钥匙未归还', '钥匙没还', '没还钥匙', '钥匙丢了', '遗失钥匙', 'fob', '门禁卡', '遥控器'],
    terms: ['钥匙未按要求归还', '钥匙未归还', '遗失钥匙', 'fob', '车库遥控器', '备用钥匙'],
  },
  {
    triggers: ['进不去', '打不开门', '开不了门', '密码打不开', '密码无效', '锁没电', '锁坏了'],
    terms: ['无法入住', '门锁密码无效', '智能锁没电', '密码盒打不开', '线下协助'],
  },
  {
    triggers: ['空调坏了', '没有暖气', '没热水', '没有热水', '热水坏了', '冷气', '暖气'],
    terms: ['空调', '暖气', '热水', '无法使用', '维修问题'],
  },
  {
    triggers: ['不干净', '脏', '头发', '床品', '污渍', '灰尘', '虫子', '蟑螂'],
    terms: ['卫生问题', '头发', '灰尘', '污渍', '床品问题', '虫害', '补清洁'],
  },
  {
    triggers: ['噪音', '太吵', '聚会', '邻居投诉', '物业投诉'],
    terms: ['噪音投诉', '聚会', '邻居', '物业投诉', '停止噪音'],
  },
]

function parseBlocks(content: string | null | undefined): ContentBlock[] {
  const raw = String(content || '').trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as ContentBlock[]
  } catch {}
  return [{ type: 'legacy_html', html: raw }]
}

function blockText(block: ContentBlock) {
  if (!block) return ''
  if (block.type === 'heading') return String(block.text || '').trim()
  if (block.type === 'paragraph') return String(block.text || '').trim()
  if (block.type === 'callout') return String(block.text || '').trim()
  if (block.type === 'legacy_html') return String(block.html || '').trim()
  if (block.type === 'image' || block.type === 'video') return [block.caption, block.url].map((x) => String(x || '').trim()).filter(Boolean).join(' ')
  if (block.type === 'step') {
    const items = (block.contents || []).map((item) => String(item?.text || item?.caption || item?.url || '').trim()).filter(Boolean)
    return [block.title, ...items].map((x) => String(x || '').trim()).filter(Boolean).join('\n')
  }
  return ''
}

function blocksToText(content: string | null | undefined) {
  const blocks = parseBlocks(content)
  const lines: string[] = []
  for (const block of blocks) {
    if (!block) continue
    if (block.type === 'heading') {
      const level = Math.max(1, Math.min(6, Number(block.level || 2)))
      lines.push(`${'#'.repeat(level)} ${String(block.text || '').trim()}`)
    } else if (block.type === 'callout') {
      lines.push(`> ${String(block.text || '').trim()}`)
    } else {
      const text = blockText(block)
      if (text) lines.push(text)
    }
    if (lines[lines.length - 1] !== '') lines.push('')
  }
  return lines.join('\n').trim()
}

function textToBlocks(text: string): ContentBlock[] {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  const blocks: ContentBlock[] = []
  let paragraph: string[] = []
  let callout: string[] = []

  const flushParagraph = () => {
    const value = paragraph.join('\n').trim()
    if (value) blocks.push({ type: 'paragraph', text: value })
    paragraph = []
  }
  const flushCallout = () => {
    const value = callout.join('\n').trim()
    if (value) blocks.push({ type: 'callout', text: value })
    callout = []
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
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
      blocks.push({ type: 'heading', text: String(heading[2] || '').trim(), level: heading[1].length })
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
  return blocks
}

function normalizeSearchText(value: string | null | undefined) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/wi[\s-]?fi/g, 'wifi')
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, '')
}

function searchFragments(query: string) {
  const normalized = normalizeSearchText(query)
  const fragments = new Set<string>()
  const rawParts = String(query || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/wi[\s-]?fi/g, 'wifi')
    .split(/[^a-z0-9\u3400-\u9fff]+/g)
    .map(normalizeSearchText)
    .filter((part) => part.length >= 2)
  rawParts.forEach((part) => fragments.add(part))
  if (normalized.length >= 2) fragments.add(normalized)
  if (normalized.length >= 4) {
    for (let size = 2; size <= 4; size += 1) {
      for (let i = 0; i <= normalized.length - size; i += 1) fragments.add(normalized.slice(i, i + size))
    }
  }
  return Array.from(fragments)
}

function searchAliasTerms(query: string) {
  const normalized = normalizeSearchText(query)
  const terms = new Set<string>()
  for (const group of SEARCH_SYNONYMS) {
    const matched = group.triggers.some((trigger) => {
      const value = normalizeSearchText(trigger)
      return value.length >= 2 && normalized.includes(value)
    })
    if (matched) group.terms.map(normalizeSearchText).filter((term) => term.length >= 2).forEach((term) => terms.add(term))
  }
  return Array.from(terms)
}

function containsInOrder(haystack: string, needle: string) {
  if (needle.length < 3) return false
  let cursor = 0
  for (const ch of needle) {
    cursor = haystack.indexOf(ch, cursor)
    if (cursor < 0) return false
    cursor += 1
  }
  return true
}

function fuzzyScore(text: string, query: string) {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) return 1
  const hay = normalizeSearchText(text)
  if (!hay) return 0
  if (hay.includes(normalizedQuery)) return 1000 + normalizedQuery.length
  let score = 0
  for (const term of searchAliasTerms(query)) {
    if (hay.includes(term)) score += 120 + term.length * 10
    else if (containsInOrder(hay, term)) score += 65 + term.length * 4
  }
  for (const term of searchFragments(query)) {
    if (term === normalizedQuery) continue
    if (hay.includes(term)) score += 28 + term.length * 8
    else if (containsInOrder(hay, term)) score += 12 + term.length * 4
  }
  return score >= 100 ? score : 0
}

function formatTime(v: any) {
  const s = String(v || '').trim()
  if (!s) return '-'
  const d = new Date(s)
  if (!Number.isFinite(d.getTime())) return s
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function sectionId(title: string, index: number) {
  const slug = normalizeSearchText(title).slice(0, 32)
  return `section-${index}-${slug || 'manual'}`
}

function buildSections(blocks: ContentBlock[]) {
  const sections: ManualSection[] = []
  let current: ManualSection | null = null

  const pushCurrent = () => {
    if (!current) return
    current.text = current.blocks.map(blockText).join('\n')
    sections.push(current)
  }

  blocks.forEach((block) => {
    if (block.type === 'heading') {
      pushCurrent()
      const title = String(block.text || '').trim() || `章节 ${sections.length + 1}`
      current = {
        id: sectionId(title, sections.length + 1),
        title,
        level: Math.max(1, Math.min(6, Number(block.level || 2))),
        blocks: [block],
        text: '',
        index: sections.length + 1,
      }
      return
    }
    if (!current) {
      current = {
        id: sectionId('手册说明', 1),
        title: '手册说明',
        level: 2,
        blocks: [],
        text: '',
        index: 1,
      }
    }
    current.blocks.push(block)
  })
  pushCurrent()
  return sections
}

function ContentView({ blocks }: { blocks: ContentBlock[] }) {
  if (!blocks.length) return <Typography.Text type="secondary">暂无内容</Typography.Text>
  return (
    <div style={{ lineHeight: 1.85, wordBreak: 'break-word', overflowWrap: 'anywhere', color: '#1f2937' }}>
      {blocks.map((block, idx) => {
        if (block.type === 'heading') {
          const level = Number(block.level || 2)
          const titleLevel = level <= 2 ? 3 : 4
          return (
            <Typography.Title key={idx} level={titleLevel as any} style={{ margin: idx === 0 ? '4px 0 12px' : '26px 0 10px', color: '#0f172a' }}>
              {block.text}
            </Typography.Title>
          )
        }
        if (block.type === 'callout') {
          return (
            <div key={idx} style={{ background: '#fff7e6', border: '1px solid #ffd591', padding: '12px 14px', borderRadius: 12, margin: '12px 0', whiteSpace: 'pre-wrap' }}>
              {block.text}
            </div>
          )
        }
        if (block.type === 'step') {
          return (
            <div key={idx} style={{ margin: '16px 0', padding: '12px 14px', border: '1px solid #e5e7eb', borderRadius: 12, background: '#ffffff' }}>
              {block.title ? <Typography.Text strong style={{ color: '#111827' }}>{block.title}</Typography.Text> : null}
              {(block.contents || []).map((item, itemIdx) => {
                const text = String(item?.text || item?.caption || item?.url || '').trim()
                return text ? <Typography.Paragraph key={itemIdx} style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>{text}</Typography.Paragraph> : null
              })}
            </div>
          )
        }
        const text = blockText(block)
        return text ? <Typography.Paragraph key={idx} style={{ whiteSpace: 'pre-wrap', margin: '10px 0', fontSize: 15 }}>{text}</Typography.Paragraph> : null
      })}
    </div>
  )
}

function StatusPills({ row }: { row: ManualRow }) {
  return (
    <Space wrap size={[8, 8]}>
      <Tag color={row.status === 'published' ? 'green' : 'default'} icon={row.status === 'published' ? <CheckCircleOutlined /> : undefined}>
        {row.status === 'published' ? '已发布' : '草稿'}
      </Tag>
      <Tag>{row.audience_scope ? AUDIENCE_LABEL[row.audience_scope] || row.audience_scope : '-'}</Tag>
      <Typography.Text type="secondary"><ClockCircleOutlined /> {formatTime(row.updated_at)}</Typography.Text>
    </Space>
  )
}

function splitSortValue(row: ManualRow) {
  const slug = String(row.slug || '').trim().toLowerCase()
  if (slug === 'cs-manual:overview') return 0
  if (slug === 'cs-manual:quick-nav') return 1
  const numbered = slug.match(/^cs-manual:(\d+)(?:-(\d+))?/)
  if (numbered) return Number(numbered[1]) * 100 + Number(numbered[2] || 0)
  const reply = slug.match(/^cs-manual:t(\d+)/)
  if (reply) return 12000 + Number(reply[1])
  const review = slug.match(/^cs-manual:r(\d+)/)
  if (review) return 13000 + Number(review[1])
  return 99000
}

function splitHeadingLevel(row: ManualRow) {
  const title = String(row.title || '').trim()
  const slug = String(row.slug || '').trim().toLowerCase()
  if (/^cs-manual:(11|12|13|14)-/.test(slug)) return 3
  if (/^cs-manual:[tr]\d{2}/.test(slug)) return 3
  if (/^\d+\./.test(title) || /^[TR]\d{2}\b/i.test(title)) return 3
  return 2
}

function combineSplitRows(rows: ManualRow[]): ManualRow | null {
  if (!rows.length) return null
  const sorted = [...rows]
    .filter((row) => String(row.slug || '').trim() !== MANUAL_SLUG)
    .sort((a, b) => {
      const diff = splitSortValue(a) - splitSortValue(b)
      if (diff) return diff
      return String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN')
    })
  if (!sorted.length) return null
  const blocks: ContentBlock[] = []
  sorted.forEach((row) => {
    const title = String(row.title || '').trim()
    if (title) blocks.push({ type: 'heading', text: title, level: splitHeadingLevel(row) })
    blocks.push(...parseBlocks(row.content))
  })
  const updatedAt = sorted
    .map((row) => String(row.updated_at || '').trim())
    .filter(Boolean)
    .sort()
    .pop()
  return {
    id: '',
    slug: MANUAL_SLUG,
    title: sorted.find((row) => String(row.title || '').includes('客服培训与实操手册'))?.title || DEFAULT_TITLE,
    content: JSON.stringify(blocks),
    status: 'published',
    audience_scope: 'managers',
    updated_at: updatedAt || sorted[0]?.updated_at || null,
    virtual: true,
  }
}

export default function CustomerServiceManualPage() {
  const { message } = App.useApp()
  const [rows, setRows] = useState<ManualRow[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  const canWrite = hasPerm('cms_pages.write')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getJSON<ManualRow[]>(`/cms/company/pages?type=doc&category=${CATEGORY}`)
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      message.error(String(e?.message || '加载失败'))
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => { load() }, [load])

  const persistedManual = useMemo(() => rows.find((row) => String(row.slug || '').trim() === MANUAL_SLUG) || null, [rows])
  const manual = useMemo(() => persistedManual || combineSplitRows(rows), [persistedManual, rows])
  const blocks = useMemo(() => parseBlocks(manual?.content), [manual?.content])
  const sections = useMemo(() => buildSections(blocks), [blocks])
  const visibleSections = useMemo(() => {
    const q = keyword.trim()
    const matched = sections
      .map((section) => ({ section, score: fuzzyScore(`${section.title}\n${section.text}`, q) }))
      .filter(({ score }) => score > 0)
    if (!q) return matched.map(({ section }) => section)
    return matched.sort((a, b) => b.score - a.score || a.section.index - b.section.index).map(({ section }) => section)
  }, [keyword, sections])

  useEffect(() => {
    if (!visibleSections.length) {
      if (activeSectionId) setActiveSectionId(null)
      return
    }
    if (!activeSectionId || !visibleSections.some((section) => section.id === activeSectionId)) {
      setActiveSectionId(visibleSections[0].id)
    }
  }, [activeSectionId, visibleSections])

  const activeSection = useMemo(() => {
    return visibleSections.find((section) => section.id === activeSectionId) || visibleSections[0] || null
  }, [activeSectionId, visibleSections])
  const activeSectionIndex = activeSection ? visibleSections.findIndex((section) => section.id === activeSection.id) : -1

  function openEditor() {
    form.resetFields()
    form.setFieldsValue({
      title: manual?.title || DEFAULT_TITLE,
      slug: MANUAL_SLUG,
      status: manual?.status || 'published',
      audience_scope: manual?.audience_scope || 'managers',
      content_text: manual ? blocksToText(manual.content) : '',
    })
    setEditOpen(true)
  }

  async function submit() {
    if (saving) return
    const v = await form.validateFields()
    const payload: any = {
      slug: MANUAL_SLUG,
      title: String(v.title || DEFAULT_TITLE).trim(),
      status: v.status || 'published',
      audience_scope: v.audience_scope || 'managers',
      category: CATEGORY,
      content: JSON.stringify(textToBlocks(String(v.content_text || ''))),
    }
    setSaving(true)
    try {
      if (persistedManual?.id) {
        await patchJSON(`/cms/company/pages/${encodeURIComponent(String(persistedManual.id))}`, payload)
        message.success('客服手册已保存')
      } else {
        await postJSON('/cms/company/pages', { ...payload, type: 'doc' })
        message.success('客服手册已合并保存')
      }
      setEditOpen(false)
      await load()
    } catch (e: any) {
      message.error(String(e?.message || '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const readingTab = (
    <div>
      {rows.length > 1 && !persistedManual ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="正在临时合并旧版拆分内容"
          description="当前数据库里还是旧版多条客服手册记录。页面已先把这些内容合成一本完整手册显示；点击编辑并保存后，会生成真正的一本 cs-manual 手册。"
        />
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <Space wrap>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索房间没电、退款、Wi-Fi、T09、钥匙未归还"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            style={{ width: 390, maxWidth: '100%' }}
          />
          <Button onClick={load} loading={loading}>刷新</Button>
        </Space>
        {canWrite ? <Button type="primary" icon={<EditOutlined />} onClick={openEditor}>{persistedManual ? '编辑手册' : (manual ? '合并保存手册' : '创建手册')}</Button> : null}
      </div>

      {manual ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
            <Card size="small" style={{ borderRadius: 16 }}>
              <Typography.Text type="secondary">手册状态</Typography.Text>
              <div style={{ marginTop: 8 }}><StatusPills row={manual} /></div>
            </Card>
            <Card size="small" style={{ borderRadius: 16 }}>
              <Typography.Text type="secondary">章节数量</Typography.Text>
              <div style={{ marginTop: 6, fontSize: 24, fontWeight: 800, color: '#0f172a' }}>{sections.length}</div>
            </Card>
            <Card size="small" style={{ borderRadius: 16 }}>
              <Typography.Text type="secondary">搜索结果</Typography.Text>
              <div style={{ marginTop: 6, fontSize: 24, fontWeight: 800, color: '#2563eb' }}>{visibleSections.length}</div>
            </Card>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 360px) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
            <div style={{ border: '1px solid #e5e7eb', borderRadius: 16, background: '#ffffff', overflow: 'hidden', maxHeight: 'calc(100vh - 310px)', minHeight: 560, position: 'sticky', top: 12 }}>
              <div style={{ padding: '14px 16px', borderBottom: '1px solid #eef2f7', background: '#f8fafc' }}>
                <div style={{ fontWeight: 800, color: '#0f172a' }}>手册目录</div>
                <div style={{ marginTop: 4, color: '#64748b', fontSize: 13 }}>共 {visibleSections.length} 个匹配章节</div>
              </div>
              <div style={{ overflowY: 'auto', maxHeight: 'calc(100vh - 390px)' }}>
                {visibleSections.length ? visibleSections.map((section) => {
                  const active = activeSection?.id === section.id
                  return (
                    <button
                      key={section.id}
                      type="button"
                      onClick={() => setActiveSectionId(section.id)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        border: 0,
                        borderBottom: '1px solid #f1f5f9',
                        background: active ? '#eff6ff' : '#ffffff',
                        padding: section.level >= 3 ? '11px 16px 11px 34px' : '13px 16px',
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                        <div style={{ color: active ? '#2563eb' : '#94a3b8', fontWeight: 800, minWidth: 30 }}>{String(section.index).padStart(2, '0')}</div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ color: active ? '#1d4ed8' : '#111827', fontWeight: section.level >= 3 ? 600 : 800, whiteSpace: 'normal', lineHeight: 1.45 }}>
                            {section.title}
                          </div>
                          <div style={{ marginTop: 5, color: '#64748b', fontSize: 12, lineHeight: 1.45 }}>
                            {section.text.replace(/\s+/g, ' ').slice(0, 58) || '点击查看章节内容'}
                          </div>
                        </div>
                      </div>
                    </button>
                  )
                }) : (
                  <div style={{ padding: 18 }}>
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的章节" />
                  </div>
                )}
              </div>
            </div>

            <div style={{ border: '1px solid #e5e7eb', borderRadius: 16, background: '#ffffff', minHeight: 560, overflow: 'hidden' }}>
              {activeSection ? (
                <>
                  <div style={{ padding: '22px 24px', borderBottom: '1px solid #eef2f7', background: '#f8fafc' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', minWidth: 0 }}>
                        <div style={{ width: 52, height: 52, borderRadius: 16, background: '#eff6ff', color: '#2563eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 }}>
                          <BookOutlined />
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <Typography.Title level={3} style={{ margin: 0, color: '#0f172a' }}>{activeSection.title}</Typography.Title>
                          <div style={{ marginTop: 10 }}><StatusPills row={manual} /></div>
                        </div>
                      </div>
                      {canWrite ? <Button icon={<EditOutlined />} onClick={openEditor}>{persistedManual ? '编辑手册' : '合并保存手册'}</Button> : null}
                    </div>
                  </div>
                  <div style={{ padding: '26px 30px', maxWidth: 940, margin: '0 auto' }}>
                    <ContentView blocks={activeSection.blocks} />
                  </div>
                  <div style={{ padding: '14px 24px', borderTop: '1px solid #eef2f7', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <Button disabled={activeSectionIndex <= 0} onClick={() => setActiveSectionId(visibleSections[activeSectionIndex - 1]?.id || null)}>上一章</Button>
                    <Typography.Text type="secondary">{activeSectionIndex >= 0 ? `${activeSectionIndex + 1} / ${visibleSections.length}` : '-'}</Typography.Text>
                    <Button disabled={activeSectionIndex < 0 || activeSectionIndex >= visibleSections.length - 1} onClick={() => setActiveSectionId(visibleSections[activeSectionIndex + 1]?.id || null)}>下一章</Button>
                  </div>
                </>
              ) : (
                <div style={{ padding: 48 }}>
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的章节" />
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <Card style={{ borderRadius: 16 }}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有客服手册"
          >
            {canWrite ? <Button type="primary" onClick={openEditor}>创建客服手册</Button> : null}
          </Empty>
        </Card>
      )}
    </div>
  )

  const settingsTab = (
    <div>
      <Card style={{ borderRadius: 16 }}>
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <div>
            <Typography.Title level={5} style={{ marginTop: 0 }}>手册信息</Typography.Title>
            <Typography.Text type="secondary">客服手册现在作为一条 CMS 文档维护，正文内部按章节显示和搜索。</Typography.Text>
          </div>
          {manual ? (
            <Space direction="vertical" size={8}>
              <div><Typography.Text type="secondary">标题：</Typography.Text>{manual.title || '-'}</div>
              <div><Typography.Text type="secondary">Slug：</Typography.Text><Tag>{manual.slug || '-'}</Tag></div>
              <div><Typography.Text type="secondary">状态：</Typography.Text><StatusPills row={manual} /></div>
              <div><Typography.Text type="secondary">更新时间：</Typography.Text>{formatTime(manual.updated_at)}</div>
            </Space>
          ) : <Typography.Text type="secondary">暂无手册记录。</Typography.Text>}
          {canWrite ? <Button type="primary" icon={<EditOutlined />} onClick={openEditor}>{persistedManual ? '编辑手册' : (manual ? '合并保存手册' : '创建手册')}</Button> : null}
        </Space>
      </Card>
    </div>
  )

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <Typography.Title level={3} style={{ marginTop: 0, marginBottom: 2 }}>客服手册</Typography.Title>
          <Typography.Text type="secondary">一本客服培训手册，进入后按章节学习、搜索和编辑</Typography.Text>
        </div>
        <Tag color="cyan" icon={<FileTextOutlined />}>公司内容中心 / 客服手册</Tag>
      </div>
      <Tabs
        items={[
          { key: 'read', label: '手册阅读', children: readingTab },
          { key: 'settings', label: '手册设置', children: settingsTab },
        ]}
      />

      <Drawer
        open={editOpen}
        onClose={() => { if (!saving) setEditOpen(false) }}
        title={persistedManual ? '编辑客服手册' : (manual ? '合并保存客服手册' : '创建客服手册')}
        width={1180}
        destroyOnHidden={false}
        extra={
          <Space>
            <Button disabled={saving} onClick={() => setEditOpen(false)}>取消</Button>
            <Button type="primary" loading={saving} onClick={() => { submit().catch(() => {}) }}>{persistedManual ? '保存修改' : (manual ? '合并保存' : '立即创建')}</Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <Card
              title="基础信息"
              style={{ width: 360, maxWidth: '100%', position: 'sticky', top: 0, borderRadius: 16 }}
              bodyStyle={{ paddingBottom: 8 }}
            >
              <div style={{ marginBottom: 12, padding: 12, borderRadius: 12, background: '#f8fafc', color: '#475569', lineHeight: 1.6 }}>
                客服手册固定为一本 CMS 文档。正文里用 Markdown 标题分章节，例如 ## 大章节、### 小章节。
              </div>
              <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
                <Input />
              </Form.Item>
              <Form.Item name="slug" label="Slug（固定）">
                <Input disabled />
              </Form.Item>
              <Form.Item name="status" label="状态" rules={[{ required: true }]}>
                <Select options={STATUS_OPTIONS} />
              </Form.Item>
              <Form.Item name="audience_scope" label="受众范围" rules={[{ required: true }]}>
                <Select options={AUDIENCE_OPTIONS} />
              </Form.Item>
            </Card>
            <Card title="正文编辑" style={{ flex: 1, minWidth: 360, borderRadius: 16 }} bodyStyle={{ paddingBottom: 8 }}>
              <Form.Item name="content_text" label="内容" rules={[{ required: true, message: '请输入内容' }]}>
                <Input.TextArea autoSize={{ minRows: 28, maxRows: 46 }} placeholder="用 ## 和 ### 分章节，例如：&#10;&#10;## 一、岗位目标&#10;正文...&#10;&#10;### 11.20 停电或部分插座无电&#10;正文..." />
              </Form.Item>
            </Card>
          </div>
        </Form>
      </Drawer>
    </Card>
  )
}
