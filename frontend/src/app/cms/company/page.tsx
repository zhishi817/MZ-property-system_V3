"use client"

import { App, Button, Card, Checkbox, DatePicker, Drawer, Form, Input, Modal, Select, Space, Table, Tabs, Tag, Typography, Upload } from 'antd'
import type { UploadProps } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { API_BASE, authHeaders, deleteJSON, getJSON, patchJSON, postJSON } from '../../../lib/api'
import { CalendarOutlined, CheckCircleOutlined, ClockCircleOutlined, CloseOutlined, CopyOutlined, EditOutlined, FileTextOutlined, InboxOutlined, LinkOutlined, NotificationOutlined, PrinterOutlined, UserOutlined } from '@ant-design/icons'

type PageType = 'announce' | 'doc' | 'warehouse'
type PageStatus = 'draft' | 'published'
type AudienceScope = 'all_staff' | 'cleaners' | 'warehouse_staff' | 'maintenance_staff' | 'managers'
type DocCategory = 'company_rule' | 'work_guide'

type CompanyPageRow = {
  id: string
  slug?: string | null
  title?: string | null
  content?: string | null
  status?: PageStatus | null
  published_at?: string | null
  page_type?: string | null
  category?: string | null
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
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'callout'; text: string }
  | { type: 'image'; url: string; caption?: string }
  | { type: 'video'; url: string; caption?: string }
  | { type: 'step'; title: string; contents: StepItem[] }
  | { type: 'legacy_html'; html: string }

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

function blocksToPayload(blocks: Block[], rawFallback: string) {
  if (blocks.length === 1 && blocks[0].type === 'legacy_html') return rawFallback
  return JSON.stringify(blocks)
}

function isVideoFileUrl(url: string) {
  const s = String(url || '').trim().toLowerCase()
  return s.endsWith('.mp4') || s.endsWith('.webm') || s.endsWith('.ogg')
}

function BlocksRenderer({ blocks }: { blocks: Block[] }) {
  let stepNo = 0
  return (
    <div style={{ lineHeight: 1.7 }}>
      {blocks.map((b, idx) => {
        if (b.type === 'legacy_html') return <div key={idx} dangerouslySetInnerHTML={{ __html: b.html || '' }} />
        if (b.type === 'heading') return <h2 key={idx} style={{ margin: '16px 0 8px' }}>{b.text}</h2>
        if (b.type === 'callout') return <div key={idx} style={{ background: '#fff7e6', border: '1px solid #ffd591', padding: 10, borderRadius: 8, margin: '10px 0' }}>{b.text}</div>
        if (b.type === 'paragraph') return <p key={idx} style={{ margin: '8px 0' }}>{b.text}</p>
        if (b.type === 'image') {
          const url = safeHttpUrl(b.url)
          return (
            <figure key={idx} style={{ margin: '0 0 12px' }}>
              {url ? <img src={url} style={{ maxWidth: '100%', borderRadius: 8 }} /> : null}
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
                            {url ? <img src={url} style={{ maxWidth: '100%', borderRadius: 8 }} /> : null}
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
  const { message } = App.useApp()

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

  const uploadProps: UploadProps = useMemo(() => ({
    multiple: false,
    showUploadList: false,
    beforeUpload: (file) => { uploadImage(file as any); return false },
  }), [blocks])

  const quickActions = (
    <Space wrap size={8}>
      <Button onClick={addHeading}>添加标题</Button>
      <Button onClick={addStep}>添加步骤</Button>
      <Button onClick={addParagraph}>添加文字</Button>
      <Button onClick={addCallout}>添加提示块</Button>
      <Upload {...uploadProps}><Button>上传图片</Button></Upload>
      <Button onClick={addVideo}>添加视频链接</Button>
    </Space>
  )

  return (
    <div>
      <div style={{ position: 'sticky', top: 0, zIndex: 5, marginBottom: 12, padding: 12, border: '1px solid #eef2f7', borderRadius: 14, background: 'rgba(255,255,255,0.96)', backdropFilter: 'blur(6px)' }}>
        <div style={{ fontWeight: 700, marginBottom: 8, color: '#334155' }}>内容工具条</div>
        {quickActions}
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 320 }}>
          {blocks.map((b, i) => (
            <Card
              key={i}
              size="small"
              style={{ marginBottom: 8 }}
              title={b.type === 'paragraph' ? '文字' : (b.type === 'image' ? '图片' : (b.type === 'heading' ? '标题' : (b.type === 'callout' ? '提示' : (b.type === 'video' ? '视频' : (b.type === 'legacy_html' ? '旧内容' : '步骤')))))}
              extra={<Button danger size="small" onClick={() => remove(i)}>删除</Button>}
            >
              {b.type === 'legacy_html' ? (
                <Input.TextArea value={b.html || ''} disabled autoSize={{ minRows: 6 }} />
              ) : null}
              {b.type === 'heading' ? (
                <Input value={b.text} onChange={(e) => update(i, { text: e.target.value })} />
              ) : null}
              {b.type === 'paragraph' ? (
                <Input.TextArea value={b.text} onChange={(e) => update(i, { text: e.target.value })} autoSize={{ minRows: 3 }} />
              ) : null}
              {b.type === 'callout' ? (
                <Input.TextArea value={b.text} onChange={(e) => update(i, { text: e.target.value })} autoSize={{ minRows: 2 }} />
              ) : null}
              {b.type === 'image' ? (
                <div>
                  {b.url ? <img src={safeHttpUrl(b.url)} style={{ maxWidth: '100%', borderRadius: 8 }} /> : null}
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
                          {c.url ? <img src={safeHttpUrl(String(c.url || ''))} style={{ maxWidth: '100%', borderRadius: 8 }} /> : null}
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
        <div style={{ width: 375, border: '1px solid #eee', borderRadius: 24, padding: 12, boxShadow: '0 6px 20px rgba(0,0,0,0.08)' }}>
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

  const columns = useMemo(() => {
    const base: any[] = [
      { title: '标题', dataIndex: 'title', width: 260 },
      { title: '状态', dataIndex: 'status', width: 120, render: (v: any) => <Tag color={String(v) === 'published' ? 'green' : 'default'}>{String(v || '')}</Tag> },
    ]
    if (type === 'announce') {
      base.push({ title: '置顶', dataIndex: 'pinned', width: 80, render: (v: any) => v ? <Tag color="blue">置顶</Tag> : null })
      base.push({ title: '紧急', dataIndex: 'urgent', width: 80, render: (v: any) => v ? <Tag color="red">紧急</Tag> : null })
      base.push({ title: '发布日期', dataIndex: 'published_at', width: 130 })
      base.push({ title: '过期', dataIndex: 'expires_at', width: 130 })
      base.push({ title: '受众', dataIndex: 'audience_scope', width: 150 })
    }
    if (type === 'doc') {
      base.push({ title: '分类', dataIndex: 'category', width: 140 })
      base.push({ title: '受众', dataIndex: 'audience_scope', width: 150 })
    }
    if (type === 'warehouse') {
      base.push({ title: '受众', dataIndex: 'audience_scope', width: 150 })
    }
    base.push({ title: '更新时间', dataIndex: 'updated_at', width: 190 })
    base.push({
      title: '操作',
      width: 180,
      render: (_: any, r: CompanyPageRow) => (
        <Space>
          <Button onClick={() => openView(r)}>查看</Button>
          {type === 'warehouse' ? <Button icon={<LinkOutlined />} onClick={() => openPublicLinks(r)}>外链</Button> : null}
          <Button onClick={() => openEdit(r)}>编辑</Button>
          <Button danger onClick={() => remove(r)}>删除</Button>
        </Space>
      ),
    })
    return base
  }, [type])

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

  function resetEditorContent(content: string | null | undefined) {
    const p = parseBlocks(content)
    setBlocks(p.blocks)
    setRawContent(p.raw)
  }

  function openCreate() {
    setEditing(null)
    form.resetFields()
    resetEditorContent('')
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
      audience_scope: r.audience_scope || undefined,
    })
    resetEditorContent(r.content || '')
    setOpen(true)
  }

  function openView(r: CompanyPageRow) {
    setViewing(r)
    const p = parseBlocks(r.content || '')
    setViewBlocks(p.blocks)
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
    if (type === 'doc') payload.category = v.category
    if (!payload.slug) delete payload.slug
    if (!payload.published_at) delete payload.published_at
    if (!payload.expires_at) delete payload.expires_at
    if (!payload.audience_scope) delete payload.audience_scope

    try {
      if (editing?.id) {
        await patchJSON(`/cms/company/pages/${encodeURIComponent(String(editing.id))}`, payload)
        message.success('已更新')
      } else {
        await postJSON(`/cms/company/pages`, { ...payload, type })
        message.success('已创建')
      }
      setOpen(false)
      setEditing(null)
      form.resetFields()
      resetEditorContent('')
      await load()
    } catch (e: any) {
      message.error(String(e?.message || '保存失败'))
    }
  }

  const audienceOptions = [
    { value: 'all_staff', label: 'all_staff' },
    { value: 'cleaners', label: 'cleaners' },
    { value: 'warehouse_staff', label: 'warehouse_staff' },
    { value: 'maintenance_staff', label: 'maintenance_staff' },
    { value: 'managers', label: 'managers' },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button type="primary" onClick={openCreate}>新建</Button>
        <Button onClick={load} loading={loading}>刷新</Button>
      </Space>
      <Table
        rowKey={(r) => String(r.id)}
        dataSource={rows}
        columns={columns as any}
        loading={loading}
        pagination={{ pageSize: 10, showSizeChanger: true }}
        tableLayout="auto"
        scroll={{ x: 'max-content' }}
      />
      <Modal
        open={viewOpen}
        onCancel={closeView}
        footer={null}
        width={1080}
        closable={false}
      >
        <div style={{ margin: -24 }}>
          <div style={{ padding: '18px 22px', borderBottom: '1px solid #eef2f7', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ width: 56, height: 56, borderRadius: 18, background: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2563eb', fontSize: 22, fontWeight: 800 }}>
                {type === 'announce' ? <NotificationOutlined /> : (type === 'warehouse' ? <InboxOutlined /> : <FileTextOutlined />)}
              </div>
              <div>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#0f172a' }}>
                  {type === 'announce' ? '查看公告内容' : (type === 'warehouse' ? '查看仓库指南' : '查看文档内容')}
                </div>
                <div style={{ marginTop: 2, color: '#94a3b8', fontSize: 14 }}>
                  {type === 'announce' ? 'Notice Details Preview' : (type === 'warehouse' ? 'Warehouse Guide Preview' : 'Document Details Preview')}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Button type="text" icon={<PrinterOutlined />} onClick={() => { try { window.print() } catch {} }} />
              <Button type="text" icon={<CloseOutlined />} onClick={closeView} />
            </div>
          </div>

          <div style={{ padding: '18px 22px 0' }}>
            <Space wrap style={{ marginBottom: 18 }}>
              {viewing?.status ? pill({ icon: <CheckCircleOutlined />, text: String(viewing.status || '').toUpperCase(), tone: String(viewing.status) === 'published' ? 'success' : 'default' }) : null}
              {viewing?.audience_scope ? pill({ icon: <UserOutlined />, text: `受众: ${String(viewing.audience_scope)}` }) : null}
              {type === 'doc' && viewing?.category ? pill({ icon: <UserOutlined />, text: `分类: ${String(viewing.category)}` }) : null}
              {type === 'announce' && viewing?.published_at ? pill({ icon: <CalendarOutlined />, text: `发布: ${String(viewing.published_at)}` }) : null}
              {type === 'announce' && viewing?.expires_at ? pill({ icon: <CalendarOutlined />, text: `过期: ${String(viewing.expires_at)}` }) : null}
              {type === 'announce' && viewing?.pinned ? pill({ text: '置顶', tone: 'default' }) : null}
              {type === 'announce' && viewing?.urgent ? pill({ text: '紧急', tone: 'danger' }) : null}
            </Space>

            <div style={{ fontSize: 34, fontWeight: 900, color: '#0f172a', marginBottom: 14 }}>
              {String(viewing?.title || '')}
            </div>

            <div style={{ background: '#f8fafc', border: '1px solid #eef2f7', borderRadius: 18, padding: 18 }}>
              <BlocksRenderer blocks={viewBlocks} />
            </div>

            <div style={{ marginTop: 14, display: 'inline-flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 14, border: '1px solid #e5e7eb', background: '#f8fafc', color: '#64748b', fontWeight: 600 }}>
              <ClockCircleOutlined />
              <span>最后更新于: {String(viewing?.updated_at || '')}</span>
            </div>
          </div>

          <div style={{ marginTop: 18, padding: '14px 22px', borderTop: '1px solid #eef2f7', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              {type === 'announce' ? (
                <Button type="text" icon={<CopyOutlined />} onClick={copyViewLink}>复制公告链接</Button>
              ) : null}
            </div>
            <Space>
              <Button onClick={closeView} style={{ minWidth: 120 }}>我知道了</Button>
              <Button type="primary" icon={<EditOutlined />} onClick={openEditFromView} style={{ minWidth: 140 }}>进入编辑</Button>
            </Space>
          </div>
        </div>
      </Modal>
      {type === 'warehouse' ? (
        <Drawer
          open={open}
          onClose={() => { setOpen(false); setEditing(null) }}
          title={editing ? '编辑仓库指南' : '新建仓库指南'}
          width={1080}
          destroyOnHidden={false}
          extra={<Space><Button onClick={() => { setOpen(false); setEditing(null) }}>取消</Button><Button type="primary" onClick={submit}>保存</Button></Space>}
        >
          <Form form={form} layout="vertical" initialValues={{ status: 'draft', pinned: false, urgent: false }}>
            <Form.Item name="slug" label="Slug（可选）"><Input placeholder="例如 warehouse:docklands" /></Form.Item>
            <Form.Item name="title" label="标题" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="status" label="状态" rules={[{ required: true }]}>
              <Select options={[{ value: 'draft', label: 'draft' }, { value: 'published', label: 'published' }]} />
            </Form.Item>
            <Form.Item name="audience_scope" label="受众范围（可选）">
              <Select allowClear options={audienceOptions} />
            </Form.Item>
            <Form.Item label="内容">
              <BlocksEditor blocks={blocks} setBlocks={setBlocks} />
            </Form.Item>
          </Form>
        </Drawer>
      ) : (
        <Modal
          open={open}
          onCancel={() => { setOpen(false); setEditing(null) }}
          onOk={submit}
          width={980}
          title={editing ? '编辑' : '新建'}
        >
          <Form form={form} layout="vertical" initialValues={{ status: 'draft', pinned: false, urgent: false }}>
            <Form.Item name="slug" label="Slug（可选）"><Input placeholder="例如 announce:xxxx" /></Form.Item>
            <Form.Item name="title" label="标题" rules={[{ required: true }]}><Input /></Form.Item>
            {type === 'doc' ? (
              <Form.Item name="category" label="分类" rules={[{ required: true }]}>
                <Select options={[{ value: 'company_rule', label: 'company_rule' }, { value: 'work_guide', label: 'work_guide' }]} />
              </Form.Item>
            ) : null}
            <Form.Item name="status" label="状态" rules={[{ required: true }]}>
              <Select options={[{ value: 'draft', label: 'draft' }, { value: 'published', label: 'published' }]} />
            </Form.Item>
            <Form.Item name="audience_scope" label="受众范围（可选）">
              <Select allowClear options={audienceOptions} />
            </Form.Item>
            {type === 'announce' ? (
              <>
                <Form.Item name="published_at" label="发布日期（可选）"><DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" /></Form.Item>
                <Form.Item name="expires_at" label="过期时间（可选）"><DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" /></Form.Item>
                <Space style={{ marginBottom: 8 }} wrap>
                  <Form.Item name="pinned" valuePropName="checked" style={{ marginBottom: 0 }}><Checkbox>置顶</Checkbox></Form.Item>
                  <Form.Item name="urgent" valuePropName="checked" style={{ marginBottom: 0 }}><Checkbox>紧急</Checkbox></Form.Item>
                </Space>
              </>
            ) : null}
            <Form.Item label="内容">
              <BlocksEditor blocks={blocks} setBlocks={setBlocks} />
            </Form.Item>
          </Form>
        </Modal>
      )}

      <Modal
        open={linkOpen}
        onCancel={() => { setLinkOpen(false); setLinkTarget(null); setLinkRows([]) }}
        footer={null}
        width={860}
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
            columns={[
              {
                title: '外链',
                dataIndex: 'token',
                render: (_: any, r: CompanyPagePublicLinkRow) => {
                  const url = buildPublicWarehouseUrl(r.token)
                  return url ? (
                    <Space wrap>
                      <Input value={url} readOnly style={{ width: 420, maxWidth: '100%' }} />
                      <Button onClick={() => { navigator.clipboard?.writeText?.(url); message.success('已复制') }}>复制</Button>
                      <Button onClick={() => window.open(url, '_blank')}>打开</Button>
                    </Space>
                  ) : <Typography.Text type="secondary">无法恢复原始 token</Typography.Text>
                },
              },
              { title: '创建时间', dataIndex: 'created_at', width: 180 },
              { title: '过期时间', dataIndex: 'expires_at', width: 180 },
              { title: '状态', dataIndex: 'revoked_at', width: 120, render: (v: any) => v ? <Tag color="red">已撤销</Tag> : <Tag color="green">有效</Tag> },
              {
                title: '操作',
                width: 100,
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
    { key: 'doc', label: '公司规定', children: <CompanyPagesTab type="doc" /> },
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
