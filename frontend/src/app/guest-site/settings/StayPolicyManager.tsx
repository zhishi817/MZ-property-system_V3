"use client"

import { Alert, App, Button, Card, Collapse, Empty, Select, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import GuestSitePolicyContentEditor from '../../../components/GuestSitePolicyContentEditor'
import GuestSitePolicyPreviewDrawer from '../../../components/GuestSitePolicyPreviewDrawer'
import { getJSON, postJSON, putJSON } from '../../../lib/api'
import { hasPerm, preloadRolePerms } from '../../../lib/auth'
import type { GuestSiteProperty } from '../../../lib/guestSite'
import {
  STAY_POLICY_META,
  STAY_POLICY_SECTIONS,
  editablePolicyContent,
  summarizePolicyContent,
  type CompanyPolicyImpact,
  type CompanyStayPolicyOverview,
  type StayPolicyContent,
  type StayPolicyPreview,
  type StayPolicySection,
} from '../../../lib/guestSiteStayPolicy'

function issueText(issue: string) {
  const labels: Record<string, string> = {
    house_rules_required: '至少填写一条房屋守则',
    cancellation_policy_required: '取消政策尚未填写',
    public_english_required: '公开内容必须为英文',
    valid_compact_times_required: '请选择有效紧凑时间',
    company_standard_times_required: '公司标准必须为 3PM / 10AM',
    all_stay_services_required: '三项入住服务必须完整',
  }
  return labels[issue] || issue.replace(/_/g, ' ')
}

export default function StayPolicyManager() {
  const { message, modal } = App.useApp()
  const [overview, setOverview] = useState<CompanyStayPolicyOverview | null>(null)
  const [properties, setProperties] = useState<GuestSiteProperty[]>([])
  const [contents, setContents] = useState<Partial<Record<StayPolicySection, StayPolicyContent>>>({})
  const [impacts, setImpacts] = useState<Partial<Record<StayPolicySection, CompanyPolicyImpact>>>({})
  const [previewPropertyIds, setPreviewPropertyIds] = useState<Partial<Record<StayPolicySection, string>>>({})
  const [preview, setPreview] = useState<StayPolicyPreview | null>(null)
  const [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const [permissions, setPermissions] = useState({ canEdit: false, canPublish: false })
  const canEdit = permissions.canEdit
  const canPublish = permissions.canPublish

  useEffect(() => {
    let active = true
    preloadRolePerms().catch(() => {}).finally(() => {
      if (active) setPermissions({ canEdit: hasPerm('guest_site_settings.write'), canPublish: hasPerm('guest_site_policies.publish') })
    })
    return () => { active = false }
  }, [])

  async function load() {
    setLoading(true)
    try {
      const [next, rows] = await Promise.all([
        getJSON<CompanyStayPolicyOverview>('/cms/guest-site/stay-policies'),
        getJSON<GuestSiteProperty[]>('/cms/guest-site/properties').catch(() => []),
      ])
      setOverview(next)
      setProperties(rows)
      setUnavailable(false)
      setContents(Object.fromEntries(next.sections.map((item) => [item.section, editablePolicyContent(item.section, item)])) as Partial<Record<StayPolicySection, StayPolicyContent>>)
    } catch (error: any) {
      setUnavailable(error?.status === 503 || /schema_not_ready|storage_unavailable/.test(String(error?.message || '')))
      if (error?.status !== 503) message.error(error?.message || '统一规则读取失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])
  const bySection = useMemo(() => new Map((overview?.sections || []).map((item) => [item.section, item])), [overview])

  async function saveDraft(section: StayPolicySection) {
    const current = bySection.get(section)
    const content = contents[section]
    if (!current || !content || !canEdit || busy) return
    setBusy(`save:${section}`)
    try {
      await putJSON(`/cms/guest-site/stay-policies/company/${section}/draft`, { expected_revision: current.draft?.revision || 0, content })
      setImpacts((value) => ({ ...value, [section]: undefined }))
      message.success(`${STAY_POLICY_META[section].title}草稿已保存，公开版本未改变`)
      await load()
    } catch (error: any) {
      message.error(error?.message === 'policy_revision_conflict' ? '草稿已被其他人修改，请刷新后重试' : error?.message || '草稿保存失败')
    } finally { setBusy('') }
  }

  async function calculateImpact(section: StayPolicySection) {
    const current = bySection.get(section)
    if (!current?.draft || busy) return
    setBusy(`impact:${section}`)
    try {
      const impact = await postJSON<CompanyPolicyImpact>(`/cms/guest-site/stay-policies/company/${section}/impact`, { expected_revision: current.draft.revision })
      setImpacts((value) => ({ ...value, [section]: impact }))
      message.success('影响清单已按当前草稿和房源模式生成')
    } catch (error: any) {
      message.error(error?.message === 'policy_revision_conflict' ? '草稿版本已变化，请刷新后重新检查影响' : error?.message || '影响清单生成失败')
    } finally { setBusy('') }
  }

  async function publish(section: StayPolicySection) {
    const current = bySection.get(section)
    const impact = impacts[section]
    if (!current?.draft || !impact || !canPublish || busy) return
    modal.confirm({
      title: `确认发布“${STAY_POLICY_META[section].title}”？`,
      content: <div><p>将发布草稿 revision {current.draft.revision}。当前有 <strong>{impact.changed_count}</strong> 套“跟随公司”的房源会改变公开内容。</p><p>Legacy 和单房覆盖不会被自动改写；发布后草稿才会成为公开版本。</p></div>,
      okText: '确认发布此分区',
      cancelText: '返回影响清单',
      onOk: async () => {
        setBusy(`publish:${section}`)
        try {
          await postJSON(`/cms/guest-site/stay-policies/company/${section}/publish`, { expected_revision: current.draft!.revision, impact_hash: impact.impact_hash })
          setImpacts((value) => ({ ...value, [section]: undefined }))
          message.success(`${STAY_POLICY_META[section].title}已发布`)
          await load()
        } catch (error: any) {
          message.error(error?.message === 'policy_impact_changed' ? '房源或模式已经变化，请重新生成并审阅影响清单' : error?.message || '发布失败')
          throw error
        } finally { setBusy('') }
      },
    })
  }

  async function openPreview(section: StayPolicySection) {
    const current = bySection.get(section)
    const propertyId = previewPropertyIds[section]
    if (!current?.draft || !propertyId || busy) return
    setBusy(`preview:${section}`)
    try {
      const result = await postJSON<StayPolicyPreview>(`/cms/guest-site/stay-policies/company/${section}/preview`, { expected_revision: current.draft.revision, property_id: propertyId })
      setPreview(result)
    } catch (error: any) { message.error(error?.message || '草稿预览失败') } finally { setBusy('') }
  }

  if (unavailable) return <Card title="统一规则与入住服务" style={{ marginTop: 16 }}><Alert type="warning" showIcon message="当前环境尚未启用统一规则存储" description="原有公开房源会继续使用各房源的旧规则与时间；本页面不会在请求期建表或把草稿当作公开内容。" /></Card>

  return <Card title="统一规则与入住服务" loading={loading} style={{ marginTop: 16 }} extra={<Button onClick={() => void load()} disabled={loading || !!busy}>刷新</Button>}>
    <Alert type="info" showIcon message="四个分区独立保存、检查和发布" description="保存只写草稿。发布前必须先查看当前影响清单并再次确认；取消政策缺失只会阻止取消政策本身。现有房源保持旧规则，除非管理员显式改为跟随或发布单房覆盖。" style={{ marginBottom: 16 }} />
    {!canPublish ? <Alert type="warning" showIcon message="当前账号没有规则发布权限" description="可以按现有编辑权限保存草稿和查看影响，但不能发布、切换房源模式或批量跟随。" style={{ marginBottom: 16 }} /> : null}
    {overview ? <Collapse defaultActiveKey={['house_rules']} items={STAY_POLICY_SECTIONS.map((section) => {
      const item = bySection.get(section)!
      const content = contents[section] || editablePolicyContent(section, item)
      const impact = impacts[section]
      return {
        key: section,
        label: <Space wrap><strong>{STAY_POLICY_META[section].title}</strong><Tag color={item.published ? 'green' : 'default'}>{item.published ? `已发布 r${item.published.revision}` : '未发布'}</Tag><Tag color={item.draft ? 'blue' : 'default'}>{item.draft ? `草稿 r${item.draft.revision}` : '无草稿'}</Tag><Tag color={item.readiness.ready ? 'green' : 'orange'}>{item.readiness.ready ? '可发布' : '待完善'}</Tag></Space>,
        children: <Space direction="vertical" size={14} style={{ width: '100%' }} data-policy-section={section}>
          <Typography.Paragraph type="secondary">{STAY_POLICY_META[section].summary}</Typography.Paragraph>
          <GuestSitePolicyContentEditor section={section} value={content} disabled={!canEdit} onChange={(next) => setContents((value) => ({ ...value, [section]: next }))} />
          {item.readiness.issues.length ? <Alert type="warning" showIcon message="当前草稿尚不能发布" description={item.readiness.issues.map(issueText).join('；')} /> : null}
          <Space wrap>
            <Button type="primary" data-save-policy-draft={section} disabled={!canEdit} loading={busy === `save:${section}`} onClick={() => void saveDraft(section)}>保存草稿</Button>
            <Button data-impact-policy={section} disabled={!item.draft} loading={busy === `impact:${section}`} onClick={() => void calculateImpact(section)}>生成发布影响清单</Button>
            <Select value={previewPropertyIds[section]} onChange={(propertyId) => setPreviewPropertyIds((value) => ({ ...value, [section]: propertyId }))} placeholder="选择房源预览" style={{ width: 260 }} options={properties.map((property) => ({ value: property.id, label: `${property.code || property.id} · ${property.hero_title || property.address || '未命名'}` }))} />
            <Button data-preview-policy={section} disabled={!item.draft || !previewPropertyIds[section]} loading={busy === `preview:${section}`} onClick={() => void openPreview(section)}>真实页面预览</Button>
          </Space>
          {impact ? <Card size="small" title={`发布影响清单 · ${impact.changed_count} 套会改变`} extra={<Button danger type="primary" data-publish-policy={section} disabled={!canPublish || !item.readiness.ready} loading={busy === `publish:${section}`} onClick={() => void publish(section)}>确认后发布此分区</Button>}>
            <Table size="small" rowKey="property_id" pagination={{ pageSize: 8 }} scroll={{ x: 760 }} dataSource={impact.properties} columns={[
              { title: '房源', render: (_: unknown, row) => `${row.property_code || row.property_id} · ${row.property_title}` },
              { title: '公开', dataIndex: 'is_published', width: 80, render: (value: boolean) => value ? '是' : '否' },
              { title: '模式', dataIndex: 'mode', width: 130 },
              { title: '是否变化', dataIndex: 'changed', width: 100, render: (value: boolean) => <Tag color={value ? 'orange' : 'default'}>{value ? '会变化' : '不变化'}</Tag> },
              { title: '当前', render: (_: unknown, row) => summarizePolicyContent(section, row.before) },
              { title: '发布后', render: (_: unknown, row) => summarizePolicyContent(section, row.after) },
            ]} />
          </Card> : null}
          <Collapse size="small" items={[{ key: 'history', label: `版本记录（${item.history.length}）`, children: item.history.length ? <Table size="small" pagination={false} rowKey="id" dataSource={item.history} columns={[
            { title: 'Revision', dataIndex: 'revision', width: 90 }, { title: '状态', dataIndex: 'status', width: 110 }, { title: '摘要', render: (_: unknown, row) => summarizePolicyContent(section, row.content) }, { title: '更新时间', dataIndex: 'updated_at', width: 190, render: (value: string) => value ? new Date(value).toLocaleString() : '—' },
          ]} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无版本" /> }]} />
        </Space>,
      }
    })} /> : null}
    <GuestSitePolicyPreviewDrawer open={!!preview} onClose={() => setPreview(null)} property={preview?.candidate_property || null} title={preview ? `${STAY_POLICY_META[preview.section].title} · 候选公开页面` : '候选公开页面'} />
  </Card>
}
