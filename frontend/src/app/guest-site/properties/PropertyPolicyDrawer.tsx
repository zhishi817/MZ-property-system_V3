"use client"

import { Alert, App, Button, Card, Collapse, Drawer, Empty, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import GuestSitePolicyContentEditor from '../../../components/GuestSitePolicyContentEditor'
import GuestSitePolicyPreviewDrawer from '../../../components/GuestSitePolicyPreviewDrawer'
import { getJSON, postJSON, putJSON } from '../../../lib/api'
import { hasPerm, preloadRolePerms } from '../../../lib/auth'
import {
  STAY_POLICY_META,
  STAY_POLICY_SECTIONS,
  editablePolicyContent,
  summarizePolicyContent,
  type PropertyStayPolicyOverview,
  type StayPolicyContent,
  type StayPolicyMode,
  type StayPolicyPreview,
  type StayPolicySection,
} from '../../../lib/guestSiteStayPolicy'

const modeLabel: Record<StayPolicyMode, string> = { legacy: '保留旧规则', follow_company: '跟随公司', override: '单房覆盖' }

export default function PropertyPolicyDrawer({ open, property, onClose, onChanged }: { open: boolean; property: { id: string; code?: string; address?: string } | null; onClose: () => void; onChanged?: () => void }) {
  const { message, modal } = App.useApp()
  const [overview, setOverview] = useState<PropertyStayPolicyOverview | null>(null)
  const [contents, setContents] = useState<Partial<Record<StayPolicySection, StayPolicyContent>>>({})
  const [preview, setPreview] = useState<StayPolicyPreview | null>(null)
  const [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [permissions, setPermissions] = useState({ canEdit: false, canPublish: false })
  const canEdit = permissions.canEdit
  const canPublish = permissions.canPublish

  useEffect(() => {
    let active = true
    if (!open) return () => { active = false }
    preloadRolePerms().catch(() => {}).finally(() => {
      if (active) setPermissions({ canEdit: hasPerm('guest_site_properties.write'), canPublish: hasPerm('guest_site_policies.publish') })
    })
    return () => { active = false }
  }, [open])

  async function load() {
    if (!property?.id) return
    setLoading(true)
    try {
      const next = await getJSON<PropertyStayPolicyOverview>(`/cms/guest-site/stay-policies/properties/${encodeURIComponent(property.id)}`)
      setOverview(next)
      setContents(Object.fromEntries(next.sections.map((item) => [item.section, editablePolicyContent(item.section, item)])) as Partial<Record<StayPolicySection, StayPolicyContent>>)
      setUnavailable(false)
    } catch (error: any) {
      setUnavailable(error?.status === 503 || /schema_not_ready|storage_unavailable/.test(String(error?.message || '')))
      if (error?.status !== 503) message.error(error?.message || '房源规则读取失败')
    } finally { setLoading(false) }
  }

  useEffect(() => { if (open) void load(); else { setOverview(null); setPreview(null); setUnavailable(false) } }, [open, property?.id])
  const bySection = useMemo(() => new Map((overview?.sections || []).map((item) => [item.section, item])), [overview])

  async function saveDraft(section: StayPolicySection) {
    const item = bySection.get(section)
    if (!property || !item || !contents[section] || !canEdit || busy) return
    setBusy(`save:${section}`)
    try {
      await putJSON(`/cms/guest-site/stay-policies/properties/${encodeURIComponent(property.id)}/${section}/draft`, { expected_revision: item.draft?.revision || 0, content: contents[section] })
      message.success(`${STAY_POLICY_META[section].title}单房草稿已保存，公开内容未改变`)
      await load()
    } catch (error: any) { message.error(error?.message === 'policy_revision_conflict' ? '草稿已被其他人修改，请刷新后重试' : error?.message || '草稿保存失败') } finally { setBusy('') }
  }

  function changeMode(section: StayPolicySection, mode: 'legacy' | 'follow_company') {
    const item = bySection.get(section)
    if (!property || !item || !canPublish || busy) return
    modal.confirm({
      title: `将“${STAY_POLICY_META[section].title}”改为${modeLabel[mode]}？`,
      content: mode === 'legacy' ? '公开页会立即恢复使用当前房源旧字段；不会删除公司版本或单房覆盖历史。' : '公开页会立即使用当前已发布的公司分区；以后公司再次发布该分区时，这套房会同步变化。',
      okText: '确认切换公开模式', cancelText: '取消',
      onOk: async () => {
        setBusy(`mode:${section}`)
        try {
          await putJSON(`/cms/guest-site/stay-policies/properties/${encodeURIComponent(property.id)}/${section}/mode`, { mode, expected_revision: item.mode?.revision || 0 })
          message.success(`已切换为${modeLabel[mode]}`)
          await load(); onChanged?.()
        } catch (error: any) { message.error(error?.message === 'policy_mode_revision_conflict' ? '模式已被其他人修改，请刷新后重试' : error?.message || '模式切换失败'); throw error } finally { setBusy('') }
      },
    })
  }

  function publishOverride(section: StayPolicySection) {
    const item = bySection.get(section)
    if (!property || !item?.draft || !canPublish || busy) return
    modal.confirm({
      title: `发布“${STAY_POLICY_META[section].title}”单房覆盖？`,
      content: <div><p>将发布 revision {item.draft.revision}，并原子切换这套房的该分区为“单房覆盖”。</p><p>只影响当前房源；公司规则及其他房源不会改变。</p></div>,
      okText: '确认发布单房覆盖', cancelText: '取消',
      onOk: async () => {
        setBusy(`publish:${section}`)
        try {
          await postJSON(`/cms/guest-site/stay-policies/properties/${encodeURIComponent(property.id)}/${section}/publish`, { expected_revision: item.draft!.revision, expected_mode_revision: item.mode?.revision || 0 })
          message.success('单房覆盖已发布并生效')
          await load(); onChanged?.()
        } catch (error: any) { message.error(error?.message || '单房覆盖发布失败'); throw error } finally { setBusy('') }
      },
    })
  }

  async function openPreview(section: StayPolicySection) {
    const item = bySection.get(section)
    if (!property || !item?.draft || busy) return
    setBusy(`preview:${section}`)
    try {
      setPreview(await postJSON<StayPolicyPreview>(`/cms/guest-site/stay-policies/properties/${encodeURIComponent(property.id)}/${section}/preview`, { expected_revision: item.draft.revision }))
    } catch (error: any) { message.error(error?.message || '单房草稿预览失败') } finally { setBusy('') }
  }

  return <>
    <Drawer open={open} onClose={onClose} destroyOnClose width="min(1040px, 100vw)" title={`规则与入住服务：${property?.code || property?.address || property?.id || ''}`} extra={<Button onClick={() => void load()} disabled={loading || !!busy}>刷新</Button>}>
      {unavailable ? <Alert type="warning" showIcon message="当前环境尚未启用统一规则存储" description="这套房继续使用旧规则与时间；不会在页面请求时建表。" /> : null}
      {!unavailable ? <>
        <Alert type="info" showIcon message="每个分区独立选择来源" description="保留旧规则不会被公司发布自动改写；跟随公司只使用已发布公司版本；单房覆盖必须先保存草稿，再明确发布。" style={{ marginBottom: 16 }} />
        {!canPublish ? <Alert type="warning" showIcon message="当前账号不能改变公开规则" description="可以按编辑权限保存单房草稿，但模式切换和覆盖发布按钮不可用。" style={{ marginBottom: 16 }} /> : null}
        <Card loading={loading} bordered={false} bodyStyle={{ padding: 0 }}>
          {overview ? <Collapse defaultActiveKey={['house_rules']} items={STAY_POLICY_SECTIONS.map((section) => {
            const item = bySection.get(section)!
            const mode = item.mode?.mode || 'legacy'
            const content = contents[section] || editablePolicyContent(section, item)
            return { key: section, label: <Space wrap><strong>{STAY_POLICY_META[section].title}</strong><Tag color={mode === 'legacy' ? 'default' : mode === 'follow_company' ? 'blue' : 'purple'}>{modeLabel[mode]}</Tag>{item.published ? <Tag color="green">覆盖已发布 r{item.published.revision}</Tag> : null}{item.draft ? <Tag color="blue">草稿 r{item.draft.revision}</Tag> : null}</Space>, children: <Space direction="vertical" size={14} style={{ width: '100%' }} data-property-policy-section={section}>
              <Typography.Paragraph type="secondary">{STAY_POLICY_META[section].summary}</Typography.Paragraph>
              {mode === 'follow_company' && !item.company_published ? <Alert type="error" showIcon message="公司该分区尚未发布" description="当前不可切换为跟随；请先在统一设置发布该分区。" /> : null}
              <GuestSitePolicyContentEditor section={section} value={content} disabled={!canEdit} onChange={(next) => setContents((value) => ({ ...value, [section]: next }))} />
              <Space wrap>
                <Button type="primary" data-save-property-policy={section} disabled={!canEdit} loading={busy === `save:${section}`} onClick={() => void saveDraft(section)}>保存单房草稿</Button>
                <Button data-preview-property-policy={section} disabled={!item.draft} loading={busy === `preview:${section}`} onClick={() => void openPreview(section)}>真实页面预览</Button>
                <Button data-mode-legacy={section} disabled={!canPublish || mode === 'legacy'} loading={busy === `mode:${section}`} onClick={() => changeMode(section, 'legacy')}>使用旧规则</Button>
                <Button data-mode-follow={section} disabled={!canPublish || mode === 'follow_company' || !item.company_published} loading={busy === `mode:${section}`} onClick={() => changeMode(section, 'follow_company')}>跟随公司</Button>
                <Button danger data-publish-property-policy={section} disabled={!canPublish || !item.draft || !item.readiness.ready} loading={busy === `publish:${section}`} onClick={() => publishOverride(section)}>发布为单房覆盖</Button>
              </Space>
              {item.draft && !item.readiness.ready ? <Alert type="warning" showIcon message="当前草稿尚不能发布" description={item.readiness.issues.join('；')} /> : null}
              <Collapse size="small" items={[{ key: 'history', label: `版本记录（${item.history.length}）`, children: item.history.length ? <Table size="small" pagination={false} rowKey="id" dataSource={item.history} columns={[{ title: 'Revision', dataIndex: 'revision', width: 90 }, { title: '状态', dataIndex: 'status', width: 110 }, { title: '摘要', render: (_: unknown, row) => summarizePolicyContent(section, row.content) }]} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无版本" /> }]} />
            </Space> }
          })} /> : null}
        </Card>
      </> : null}
    </Drawer>
    <GuestSitePolicyPreviewDrawer open={!!preview} onClose={() => setPreview(null)} property={preview?.candidate_property || null} title={preview ? `${STAY_POLICY_META[preview.section].title} · 单房候选页面` : '单房候选页面'} />
  </>
}
