"use client"
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App, AutoComplete, Button, Card, DatePicker, Drawer, Form, Grid, Input, Modal, Select, Space, Table, Tag } from 'antd'
import dayjs from 'dayjs'
import { API_BASE, authHeaders } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'
import PropertyGuideEditor, { type GuideContent } from '../../../components/PropertyGuideEditor'
import { deriveBuildingKeyFromProperty, isValidPropertyCode, normalizeBaseVersion } from '../../../lib/propertyGuideCopy'

type PropertyRow = { id: string; code?: string; address?: string; building_name?: string }
type GuideRow = {
  id: string
  property_id: string | null
  language: string
  version: string
  base_version?: string | null
  building_key?: string | null
  copied_from_id?: string | null
  copied_at?: string | null
  copied_by?: string | null
  revision?: number
  status: 'draft' | 'published' | 'archived'
  content_json?: GuideContent
  created_at?: string
  updated_at?: string
  published_at?: string
}

type LinkRow = { token_hash: string; guide_id: string; created_at: string; expires_at: string; revoked_at?: string | null; token?: string | null }

async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers: { ...(init?.headers || {}), ...authHeaders() } })
  if (!res.ok) {
    const j = await res.json().catch(() => null)
    const msg = String(j?.message || `HTTP ${res.status}`)
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export default function Page() {
  const { message } = App.useApp()
  const { useBreakpoint } = Grid
  const bp = useBreakpoint()
  const isMobile = !bp.md
  const [properties, setProperties] = useState<PropertyRow[]>([])
  const [filterPropertyId, setFilterPropertyId] = useState<string | undefined>(undefined)
  const [filterLanguage, setFilterLanguage] = useState<string | undefined>(undefined)
  const [filterStatus, setFilterStatus] = useState<string | undefined>(undefined)
  const [keyword, setKeyword] = useState<string>('')
  const [rows, setRows] = useState<GuideRow[]>([])
  const [loading, setLoading] = useState(false)

  const [createOpen, setCreateOpen] = useState(false)
  const [createForm] = Form.useForm()

  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<GuideRow | null>(null)
  const [editMetaForm] = Form.useForm()
  const [editContent, setEditContent] = useState<GuideContent>({ sections: [] })
  const [roomMustFill, setRoomMustFill] = useState(false)
  const roomInputRef = useRef<any>(null)
  const [buildingUsedCodes, setBuildingUsedCodes] = useState<Set<string>>(new Set())

  const [linksOpen, setLinksOpen] = useState(false)
  const [linksGuide, setLinksGuide] = useState<GuideRow | null>(null)
  const [links, setLinks] = useState<LinkRow[]>([])
  const [linkExpiresAt, setLinkExpiresAt] = useState<any>(null)
  const [newToken, setNewToken] = useState<string>('')

  const [pwdInfo, setPwdInfo] = useState<{ configured: boolean; password_updated_at: string | null }>({ configured: false, password_updated_at: null })

  const propertyOptions = useMemo(
    () =>
      properties.map((p) => ({
        value: p.id,
        label: `${p.code ? `${p.code} - ` : ''}${p.address || p.id}`,
      })),
    [properties]
  )

  async function loadProperties() {
    try {
      const rows = await fetchJSON<PropertyRow[]>(`/properties?include_archived=true`)
      setProperties(Array.isArray(rows) ? rows : [])
    } catch {
      setProperties([])
    }
  }

  const loadGuides = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (filterPropertyId) params.set('property_id', filterPropertyId)
      if (filterLanguage) params.set('language', filterLanguage)
      if (filterStatus) params.set('status', filterStatus)
      const rows = await fetchJSON<GuideRow[]>(`/property-guides${params.toString() ? `?${params.toString()}` : ''}`)
      const arr = Array.isArray(rows) ? rows : []
      setRows(arr)
    } catch (e: any) {
      message.error(`加载失败：${e?.message || ''}`)
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [filterLanguage, filterPropertyId, filterStatus, message])

  async function loadPwdInfo() {
    if (!hasPerm('rbac.manage')) return
    try {
      const info = await fetchJSON<any>('/public/property-guide/password-info')
      setPwdInfo({ configured: !!info?.configured, password_updated_at: info?.password_updated_at || null })
    } catch {
      setPwdInfo({ configured: false, password_updated_at: null })
    }
  }

  useEffect(() => {
    loadProperties()
    loadPwdInfo()
  }, [])

  useEffect(() => {
    loadGuides()
  }, [loadGuides])

  const filteredRows = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return rows
    const propById = new Map(properties.map((p) => [p.id, p]))
    return rows.filter((r) => {
      const p = r.property_id ? propById.get(r.property_id) : undefined
      const hay = [r.version, r.language, r.status, p?.code, p?.address].map((x) => String(x || '').toLowerCase()).join(' ')
      return hay.includes(kw)
    })
  }, [keyword, properties, rows])

  function openEditor(row: GuideRow) {
    setEditing(row)
    setEditContent((row.content_json || { sections: [] }) as any)
    const p = row.property_id ? properties.find((x) => x.id === row.property_id) : undefined
    const code = p?.code || ''
    editMetaForm.setFieldsValue({ language: row.language, version: row.version, property_code: code })
    setEditorOpen(true)
  }

  useEffect(() => {
    if (!editorOpen || !editing) return
    const needs = !editing.property_id
    setRoomMustFill(needs)
    if (!needs) { setBuildingUsedCodes(new Set()); return }
    const buildingKey =
      String(editing.building_key || '').trim() ||
      (editing.copied_from_id ? '' : deriveBuildingKeyFromProperty(properties.find((p) => p.id === editing.property_id) as any))
    const baseVersion = String(editing.base_version || '').trim() || normalizeBaseVersion(editing.version)
    const lang = String(editing.language || '').trim()
    if (buildingKey && baseVersion && lang) {
      fetchJSON<any[]>(`/property-guides/building-usage?building_key=${encodeURIComponent(buildingKey)}&language=${encodeURIComponent(lang)}&base_version=${encodeURIComponent(baseVersion)}`)
        .then((rows) => {
          const set = new Set<string>()
          ;(Array.isArray(rows) ? rows : []).forEach((r: any) => {
            const c = String(r?.property_code || '').trim()
            if (c) set.add(c.toUpperCase())
          })
          setBuildingUsedCodes(set)
        })
        .catch(() => setBuildingUsedCodes(new Set()))
    }
    setTimeout(() => {
      try { roomInputRef.current?.focus?.() } catch {}
      editMetaForm.validateFields(['property_code']).catch(() => {})
    }, 60)
  }, [editorOpen, editMetaForm, editing, properties])

  async function submitCreate() {
    const v = await createForm.validateFields()
    const payload = { property_id: String(v.property_id || ''), language: String(v.language || ''), version: String(v.version || ''), content_json: { sections: [] } }
    try {
      const created = await fetchJSON<GuideRow>('/property-guides', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      message.success('已创建')
      setCreateOpen(false)
      createForm.resetFields()
      await loadGuides()
      openEditor(created)
    } catch (e: any) {
      message.error(`创建失败：${e?.message || ''}`)
    }
  }

  async function saveDraft() {
    if (!editing) return
    const meta = await editMetaForm.validateFields()
    const errors: string[] = []
    const sections = Array.isArray(editContent?.sections) ? editContent.sections : []
    for (const [si, s] of sections.entries()) {
      const sTitle = String((s as any)?.title || '').trim()
      const sLabel = sTitle ? `章节「${sTitle}」` : `章节 ${si + 1}`
      const blocks = Array.isArray((s as any)?.blocks) ? (s as any).blocks : []
      for (const [bi, b] of blocks.entries()) {
        if (String(b?.type) !== 'steps') continue
        const blockTitleRaw = String((b as any)?.title || '')
        const blockTitleTrimmed = blockTitleRaw.trim()
        if (blockTitleTrimmed) {
          const normalized = blockTitleTrimmed.replace(/\s+/g, ' ')
          if (normalized.length > 80) errors.push(`${sLabel}：Step 标题超过 80 字符`)
          if (/[\r\n]/.test(normalized)) errors.push(`${sLabel}：Step 标题包含换行`)
        }
        const steps = Array.isArray(b?.steps) ? b.steps : []
        for (const [i, st] of steps.entries()) {
          const raw = String(st?.title || '')
          const trimmed = raw.trim()
          if (!trimmed) continue
          const normalized = trimmed.replace(/\s+/g, ' ')
          if (normalized.length > 80) errors.push(`${sLabel}：步骤 ${i + 1} 标题超过 80 字符`)
          if (/[\r\n]/.test(normalized)) errors.push(`${sLabel}：步骤 ${i + 1} 标题包含换行`)
        }
      }
    }
    if (errors.length) {
      message.error(errors.length === 1 ? errors[0] : `${errors[0]}（共 ${errors.length} 处需要修正）`)
      return
    }
    try {
      const payload: any = { language: String(meta.language || ''), content_json: editContent }
      if (!editing.copied_from_id) payload.version = String(meta.version || '')
      if (!editing.property_id) payload.property_code = String(meta.property_code || '').trim()
      const updated = await fetchJSON<GuideRow>(`/property-guides/${editing.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      message.success('已保存')
      const wasUnassigned = !editing.property_id
      const nowAssigned = !!updated?.property_id
      if (wasUnassigned && nowAssigned) {
        setEditorOpen(false)
        setEditing(null)
        await loadGuides()
        return
      }
      setEditing(updated)
      await loadGuides()
    } catch (e: any) {
      message.error(`保存失败：${e?.message || ''}`)
    }
  }

  async function publishGuide(row: GuideRow) {
    try {
      await fetchJSON(`/property-guides/${row.id}/publish`, { method: 'POST' })
      message.success('已发布')
      await loadGuides()
    } catch (e: any) {
      message.error(`发布失败：${e?.message || ''}`)
    }
  }

  async function archiveGuide(row: GuideRow) {
    try {
      await fetchJSON(`/property-guides/${row.id}/archive`, { method: 'POST' })
      message.success('已归档')
      await loadGuides()
    } catch (e: any) {
      message.error(`归档失败：${e?.message || ''}`)
    }
  }

  async function deleteGuide(row: GuideRow) {
    Modal.confirm({
      title: '删除入住指南',
      content: '删除后不可恢复，确认删除该记录？',
      okText: '删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await fetchJSON(`/property-guides/${row.id}`, { method: 'DELETE' })
          message.success('已删除')
          if (editing?.id === row.id) { setEditorOpen(false); setEditing(null) }
          await loadGuides()
        } catch (e: any) {
          message.error(`删除失败：${e?.message || ''}`)
        }
      },
    })
  }

  async function duplicateGuide(row: GuideRow) {
    Modal.confirm({
      title: '复制',
      content: '将基于当前指南创建可编辑副本，房号需重新填写。',
      onOk: async () => {
        try {
          const created = await fetchJSON<GuideRow>(`/property-guides/${row.id}/copy`, { method: 'POST' })
          message.success('已复制')
          await loadGuides()
          openEditor(created)
        } catch (e: any) {
          message.error(`复制失败：${e?.message || ''}`)
        }
      },
    })
  }

  async function openLinks(row: GuideRow) {
    setLinksGuide(row)
    setLinksOpen(true)
    setNewToken('')
    setLinkExpiresAt(null)
    try {
      const rows = await fetchJSON<LinkRow[]>(`/property-guides/${row.id}/public-links`)
      setLinks(Array.isArray(rows) ? rows : [])
    } catch (e: any) {
      message.error(`加载外链失败：${e?.message || ''}`)
      setLinks([])
    }
  }

  async function createLink() {
    if (!linksGuide) return
    try {
      const expires_at = linkExpiresAt ? dayjs(linkExpiresAt).toISOString() : undefined
      const body = expires_at ? { expires_at } : {}
      const r = await fetchJSON<any>(`/property-guides/${linksGuide.id}/public-link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const token = String(r?.token || '')
      const exp = String(r?.expires_at || '')
      if (!token) throw new Error('missing token')
      setNewToken(token)
      message.success('外链已生成')
      const rows = await fetchJSON<LinkRow[]>(`/property-guides/${linksGuide.id}/public-links`)
      setLinks(Array.isArray(rows) ? rows : [])
      if (exp) setLinkExpiresAt(dayjs(exp))
    } catch (e: any) {
      message.error(`生成失败：${e?.message || ''}`)
    }
  }

  async function revokeLink(tokenHash: string) {
    try {
      await fetchJSON(`/property-guides/public-links/${encodeURIComponent(tokenHash)}/revoke`, { method: 'POST' })
      message.success('已失效')
      if (linksGuide) {
        const rows = await fetchJSON<LinkRow[]>(`/property-guides/${linksGuide.id}/public-links`)
        setLinks(Array.isArray(rows) ? rows : [])
      }
    } catch (e: any) {
      message.error(`失效失败：${e?.message || ''}`)
    }
  }

  async function resetPassword() {
    let pwd = ''
    Modal.confirm({
      title: '重置外链验证密码',
      content: (
        <div style={{ marginTop: 8 }}>
          <Input placeholder="输入 4–6 位数字" inputMode="numeric" onChange={(e) => (pwd = e.target.value)} />
        </div>
      ),
      onOk: async () => {
        try {
          await fetchJSON('/public/property-guide/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ new_password: pwd }) })
          message.success('已重置')
          loadPwdInfo()
        } catch (e: any) {
          message.error(`重置失败：${e?.message || ''}`)
        }
      },
    })
  }

  const cols: any[] = [
    {
      title: '房号',
      width: 160,
      render: (_: any, r: GuideRow) => {
        const p = r.property_id ? properties.find((x) => x.id === r.property_id) : null
        if (!p?.code) return <Tag color="red">待填写</Tag>
        return <span>{p.code}</span>
      }
    },
    { title: '语言', dataIndex: 'language', width: 110 },
    { title: '版本', dataIndex: 'version', width: 160 },
    { title: '修订', dataIndex: 'revision', width: 80, render: (v: any) => String(v ?? 1) },
    {
      title: '状态',
      dataIndex: 'status',
      width: 120,
      render: (v: any) => {
        const s = String(v || '')
        if (s === 'published') return <Tag color="green">published</Tag>
        if (s === 'archived') return <Tag color="default">archived</Tag>
        return <Tag color="blue">draft</Tag>
      },
    },
    { title: '更新时间', dataIndex: 'updated_at', width: 200 },
    { title: '发布时间', dataIndex: 'published_at', width: 200 },
    {
      title: '操作',
      width: 420,
      render: (_: any, r: GuideRow) => (
        <Space wrap>
          <Button onClick={() => openEditor(r)}>编辑</Button>
          <Button onClick={() => duplicateGuide(r)}>复制</Button>
          <Button disabled={r.status === 'published'} type="primary" onClick={() => publishGuide(r)}>发布</Button>
          <Button disabled={r.status === 'archived'} onClick={() => archiveGuide(r)}>归档</Button>
          <Button danger disabled={r.status === 'published'} onClick={() => deleteGuide(r)}>删除</Button>
          <Button disabled={r.status !== 'published'} onClick={() => openLinks(r)}>外链</Button>
        </Space>
      ),
    },
  ]

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card
        title={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <span>入住指南</span>
            <Button type="primary" onClick={() => { setCreateOpen(true); createForm.setFieldsValue({ language: 'zh-CN', version: `v${dayjs().format('YYYY.MM.DD')}` }) }} style={{ width: isMobile ? '100%' : undefined }}>
              新建版本
            </Button>
          </div>
        }
      >
        {hasPerm('rbac.manage') ? (
          <Card size="small" style={{ marginBottom: 12, borderRadius: 12 }}>
            <Space wrap>
              <span>外链验证密码：</span>
              <Tag color={pwdInfo.configured ? 'green' : 'default'}>{pwdInfo.configured ? '已配置' : '未配置'}</Tag>
              <span>最后更新：</span>
              <span>{pwdInfo.password_updated_at || '-'}</span>
              <Button onClick={resetPassword}>重置密码</Button>
            </Space>
          </Card>
        ) : null}

        <Space style={{ marginBottom: 12, width: '100%' }} wrap>
          <Select
            allowClear
            showSearch
            style={{ width: isMobile ? '100%' : 240 }}
            placeholder="房号搜索"
            options={propertyOptions}
            value={filterPropertyId}
            onChange={(v) => setFilterPropertyId(v ? String(v) : undefined)}
            filterOption={(input, option) => String(option?.label || '').toLowerCase().includes(String(input || '').toLowerCase())}
          />
          <Input
            allowClear
            style={{ width: isMobile ? '100%' : 200 }}
            placeholder="关键词搜索（版本/房号/地址）"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Select
            allowClear
            style={{ width: isMobile ? '100%' : 160 }}
            placeholder="按语言"
            value={filterLanguage}
            onChange={(v) => setFilterLanguage(v as any)}
            options={[{ value: 'zh-CN', label: 'zh-CN' }, { value: 'en', label: 'en' }]}
          />
          <Select
            allowClear
            style={{ width: isMobile ? '100%' : 160 }}
            placeholder="按状态"
            value={filterStatus}
            onChange={(v) => setFilterStatus(v as any)}
            options={[{ value: 'draft', label: 'draft' }, { value: 'published', label: 'published' }, { value: 'archived', label: 'archived' }]}
          />
          <Button onClick={() => { setFilterPropertyId(undefined); setFilterLanguage(undefined); setFilterStatus(undefined); setKeyword('') }}>重置</Button>
          <Button onClick={loadGuides}>刷新</Button>
        </Space>

        <Table rowKey={(r) => r.id} dataSource={filteredRows} columns={cols} loading={loading} pagination={{ pageSize: 10 }} />
      </Card>

      <Modal open={createOpen} onCancel={() => setCreateOpen(false)} onOk={submitCreate} title="新建入住指南版本" okText="创建">
        <Form form={createForm} layout="vertical">
          <Form.Item name="property_id" label="房源" rules={[{ required: true }]}>
            <Select
              showSearch
              options={propertyOptions}
              filterOption={(input, option) => String(option?.label || '').toLowerCase().includes(String(input || '').toLowerCase())}
            />
          </Form.Item>
          <Form.Item name="language" label="语言" rules={[{ required: true }]}>
            <Select options={[{ value: 'zh-CN', label: 'zh-CN' }, { value: 'en', label: 'en' }]} />
          </Form.Item>
          <Form.Item name="version" label="版本号" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        open={editorOpen}
        width={1100}
        onClose={() => { setEditorOpen(false); setEditing(null) }}
        title={editing ? `编辑：${editing.language} / ${editing.version} r${editing.revision ?? 1} (${editing.status})` : '编辑'}
        extra={<Space><Button onClick={() => { setEditorOpen(false); setEditing(null) }}>关闭</Button><Button type="primary" disabled={!editing} onClick={saveDraft}>保存</Button></Space>}
      >
        {editing ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <Card size="small">
              <Form
                form={editMetaForm}
                layout="inline"
                style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}
              >
                <Form.Item
                  name="property_code"
                  label="房号"
                  rules={roomMustFill ? [
                    { required: true, message: '房号必填' },
                    {
                      validator: async (_rule, value) => {
                        const raw = String(value || '').trim()
                        if (!raw) return Promise.resolve()
                        if (!isValidPropertyCode(raw)) return Promise.reject(new Error('房号格式不正确'))
                        const code = raw.toUpperCase()
                        const srcBuildingKey = String(editing.building_key || '').trim()
                        const inSameBuilding = properties.some((p) => String(p.code || '').toUpperCase() === code && deriveBuildingKeyFromProperty(p) === srcBuildingKey)
                        if (!inSameBuilding) return Promise.reject(new Error('房号不属于同一楼栋'))
                        if (buildingUsedCodes.has(code)) return Promise.reject(new Error('该房号已存在入住指南，请重新输入'))
                        return Promise.resolve()
                      },
                    },
                  ] : undefined}
                  style={{ marginBottom: 0 }}
                >
                  {roomMustFill ? (
                    <AutoComplete
                      options={properties
                        .filter((p) => deriveBuildingKeyFromProperty(p) === String(editing.building_key || '').trim())
                        .map((p) => ({ value: String(p.code || '').toUpperCase() }))
                        .filter((o) => !!o.value && !buildingUsedCodes.has(o.value))
                      }
                      filterOption={(inputValue, option) => String(option?.value || '').toUpperCase().includes(String(inputValue || '').toUpperCase())}
                      onChange={() => { editMetaForm.validateFields(['property_code']).catch(() => {}) }}
                    >
                      <Input ref={roomInputRef} placeholder="请输入或选择房号" style={{ width: 150 }} />
                    </AutoComplete>
                  ) : (
                    <Input style={{ width: 150 }} disabled />
                  )}
                </Form.Item>
                <Form.Item name="language" label="语言" rules={[{ required: true }]} style={{ marginBottom: 0 }}>
                  <Select style={{ width: 140 }} options={[{ value: 'zh-CN', label: 'zh-CN' }, { value: 'en', label: 'en' }]} />
                </Form.Item>
                <Form.Item name="version" label="版本号" rules={[{ required: true }]} style={{ marginBottom: 0 }}>
                  <Input style={{ width: 260 }} disabled={!!editing.copied_from_id} />
                </Form.Item>
                <Form.Item label="修订" style={{ marginBottom: 0 }}>
                  <Input value={String(editing.revision ?? 1)} style={{ width: 90 }} readOnly />
                </Form.Item>
                <Tag color={editing.status === 'published' ? 'green' : editing.status === 'archived' ? 'default' : 'blue'} style={{ marginInlineStart: 'auto' }}>
                  {editing.status}
                </Tag>
              </Form>
            </Card>
            <PropertyGuideEditor
              value={editContent}
              onChange={setEditContent}
              property={properties.find((p) => p.id === editing.property_id)}
              language={editing.language}
            />
          </div>
        ) : null}
      </Drawer>

      <Modal
        open={linksOpen}
        onCancel={() => { setLinksOpen(false); setLinksGuide(null); setLinks([]); setNewToken('') }}
        onOk={() => setLinksOpen(false)}
        okText="关闭"
        cancelButtonProps={{ style: { display: 'none' } }}
        width={isMobile ? '96vw' : '90vw'}
        style={{ maxWidth: 980, top: 24 }}
        styles={{ body: { maxHeight: '74vh', overflow: 'auto' } }}
        title="外部访问链接"
      >
        {linksGuide ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <Card size="small">
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: isMobile ? '1fr' : '1fr auto',
                  gap: 10,
                  alignItems: 'center',
                }}
              >
                <Space wrap style={{ minWidth: 0 }}>
                  <span>Guide：</span>
                  <Tag>{linksGuide.language}</Tag>
                  <Tag>{linksGuide.version}</Tag>
                  <span>过期时间：</span>
                  <DatePicker showTime value={linkExpiresAt} onChange={setLinkExpiresAt as any} style={{ width: 220, maxWidth: '100%' }} />
                </Space>
                <div style={{ display: 'flex', justifyContent: isMobile ? 'flex-start' : 'flex-end' }}>
                  <Button type="primary" onClick={createLink}>生成外链</Button>
                </div>
              </div>
              {newToken ? (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>新链接</div>
                  <Space wrap style={{ width: '100%' }}>
                    <Input value={`${window.location.origin}/public/guide/p/${newToken}`} readOnly style={{ width: 620, maxWidth: '100%', flex: '1 1 520px', minWidth: 280 }} />
                    <Button onClick={() => { navigator.clipboard?.writeText?.(`${window.location.origin}/public/guide/p/${newToken}`); message.success('已复制') }}>复制链接</Button>
                  </Space>
                </div>
              ) : null}
            </Card>

            <Table
              rowKey={(r) => r.token_hash}
              dataSource={links}
              pagination={false}
              size="small"
              tableLayout="fixed"
              scroll={{ x: 980 }}
              columns={[
                { title: 'token_hash', dataIndex: 'token_hash', width: 120, render: (v: any) => <span>{String(v || '').slice(0, 10)}…</span> },
                {
                  title: '链接',
                  width: 520,
                  render: (_: any, r: LinkRow) => {
                    const token = String(r.token || '')
                    if (!token) return <span style={{ color: '#999' }}>-（旧链接无法回显，重新生成即可）</span>
                    const url = `${window.location.origin}/public/guide/p/${token}`
                    return (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%', minWidth: 0 }}>
                        <Input value={url} readOnly style={{ flex: '1 1 auto', minWidth: 0 }} />
                        <Button
                          size="small"
                          onClick={() => {
                            navigator.clipboard?.writeText?.(url)
                            message.success('已复制')
                          }}
                        >
                          复制
                        </Button>
                      </div>
                    )
                  },
                },
                { title: 'expires_at', dataIndex: 'expires_at', width: 160 },
                { title: 'revoked_at', dataIndex: 'revoked_at', width: 140, render: (v: any) => v || '-' },
                {
                  title: '状态',
                  width: 90,
                  render: (_: any, r: LinkRow) => {
                    const revoked = !!r.revoked_at
                    const expired = r.expires_at ? dayjs(r.expires_at).isBefore(dayjs()) : true
                    if (revoked) return <Tag color="default">revoked</Tag>
                    if (expired) return <Tag color="red">expired</Tag>
                    return <Tag color="green">active</Tag>
                  },
                },
                {
                  title: '操作',
                  width: 110,
                  render: (_: any, r: LinkRow) => (
                    <Space>
                      <Button danger disabled={!!r.revoked_at} onClick={() => revokeLink(r.token_hash)}>一键失效</Button>
                    </Space>
                  ),
                },
              ]}
            />
          </div>
        ) : null}
      </Modal>
    </Space>
  )
}
