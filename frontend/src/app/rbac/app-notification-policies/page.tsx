"use client"

import { Alert, Button, Card, Empty, Input, List, Radio, Select, Space, Spin, Tag, Typography, message } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { getJSON, postJSON, putJSON } from '../../../lib/api'
import {
  AppNotificationGroupOption,
  AppNotificationPolicy,
  AppNotificationPolicyForm,
  AppNotificationTemplateOption,
  AppNotificationUser,
  buildPolicyForm,
  buildPolicySummary,
  formatPolicyUpdatedAt,
  isPolicyDirty,
  policyStateMeta,
} from './policyUi'

type LoadResponse = {
  policies: AppNotificationPolicy[]
  groups: AppNotificationGroupOption[]
  templates: AppNotificationTemplateOption[]
  users: AppNotificationUser[]
}

const EMPTY_FORM: AppNotificationPolicyForm = {
  enabled: true,
  template_key: 'participants_plus_ops_manager',
  extra_group_keys: [],
  extra_user_ids: [],
  note: '',
}

export default function AppNotificationPoliciesPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [policies, setPolicies] = useState<AppNotificationPolicy[]>([])
  const [groups, setGroups] = useState<AppNotificationGroupOption[]>([])
  const [templates, setTemplates] = useState<AppNotificationTemplateOption[]>([])
  const [users, setUsers] = useState<AppNotificationUser[]>([])
  const [currentPolicyKey, setCurrentPolicyKey] = useState('')
  const [form, setForm] = useState<AppNotificationPolicyForm>(EMPTY_FORM)

  async function load() {
    setLoading(true)
    try {
      const res = await getJSON<LoadResponse>('/rbac/app-notification-policies')
      const nextPolicies = Array.isArray(res.policies) ? res.policies : []
      setPolicies(nextPolicies)
      setGroups(Array.isArray(res.groups) ? res.groups : [])
      setTemplates(Array.isArray(res.templates) ? res.templates : [])
      setUsers(Array.isArray(res.users) ? res.users : [])
      const firstPolicyKey = nextPolicies[0]?.policy_key || ''
      setCurrentPolicyKey((prev) => (prev && nextPolicies.some((item) => item.policy_key === prev) ? prev : firstPolicyKey))
    } catch (e: any) {
      message.error(String(e?.message || '加载失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const current = useMemo(() => policies.find((item) => item.policy_key === currentPolicyKey) || null, [policies, currentPolicyKey])
  const currentState = current ? policyStateMeta(current) : null
  const currentAllowedGroups = useMemo(() => {
    if (!current) return []
    return groups.filter((item) => current.catalog_meta.allowed_group_keys.includes(item.key))
  }, [current, groups])

  useEffect(() => {
    if (!current) return
    setForm(buildPolicyForm(current))
  }, [current])

  const dirty = current ? isPolicyDirty(current, form) : false
  const summary = useMemo(
    () => buildPolicySummary({
      policyKey: current?.policy_key || '',
      templateKey: form.template_key,
      extraGroupKeys: form.extra_group_keys,
      extraUserIds: form.extra_user_ids,
      groups,
      templates,
      users,
    }),
    [current?.policy_key, form.template_key, form.extra_group_keys, form.extra_user_ids, groups, templates, users],
  )

  async function saveCurrent() {
    if (!current) return
    setSaving(true)
    try {
      const saved = await putJSON<AppNotificationPolicy>(`/rbac/app-notification-policies/${current.policy_key}`, {
        enabled: form.enabled,
        template_key: form.template_key,
        extra_group_keys: form.extra_group_keys,
        extra_user_ids: form.extra_user_ids,
        note: form.note.trim() || null,
      })
      setPolicies((prev) => prev.map((item) => (item.policy_key === saved.policy_key ? saved : item)))
      setForm(buildPolicyForm(saved))
      message.success('App 通知策略已保存')
    } catch (e: any) {
      message.error(String(e?.message || '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  async function resetCurrent() {
    if (!current) return
    setSaving(true)
    try {
      const saved = await postJSON<AppNotificationPolicy>(`/rbac/app-notification-policies/${current.policy_key}/reset`, {})
      setPolicies((prev) => prev.map((item) => (item.policy_key === saved.policy_key ? saved : item)))
      setForm(buildPolicyForm(saved))
      message.success('已恢复默认模板')
    } catch (e: any) {
      message.error(String(e?.message || '恢复失败'))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div style={{ padding: 24, display: 'grid', placeItems: 'center' }}><Spin /></div>

  return (
    <div style={{ padding: 24, display: 'grid', gap: 16 }}>
      <Card title="App 通知规则" extra={<Button onClick={() => load()}>刷新</Button>}>
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          这里配置 App 新策略，只面向业务事件和模板，不暴露旧的 `role / audience / user` selector。
        </Typography.Paragraph>
        <Typography.Paragraph style={{ marginBottom: 0 }} type="secondary">
          旧 `/rbac/notification-rules` 继续保留给 legacy / 非 App 通知；这里的“运营经理组”固定等于 `admin + 线下经理`，客服始终单独配置。
        </Typography.Paragraph>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '320px minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <Card title="业务事件" bodyStyle={{ padding: 0 }}>
          <List
            dataSource={policies}
            renderItem={(item) => {
              const meta = policyStateMeta(item)
              return (
                <List.Item
                  onClick={() => setCurrentPolicyKey(item.policy_key)}
                  style={{
                    padding: '12px 16px',
                    cursor: 'pointer',
                    background: currentPolicyKey === item.policy_key ? '#f0f5ff' : undefined,
                  }}
                >
                  <div style={{ width: '100%', display: 'grid', gap: 6 }}>
                    <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                      <Typography.Text strong>{item.catalog_meta.label}</Typography.Text>
                      <Tag color={meta.color}>{meta.text}</Tag>
                    </Space>
                    <Typography.Text type="secondary">{item.catalog_meta.description}</Typography.Text>
                  </div>
                </List.Item>
              )
            }}
          />
        </Card>

        {!current ? (
          <Card><Empty description="请选择一个业务事件" /></Card>
        ) : (
          <Card
            title={current.catalog_meta.label}
            extra={
              <Space>
                <Button onClick={resetCurrent} disabled={saving}>恢复默认模板</Button>
                <Button type="primary" onClick={saveCurrent} loading={saving} disabled={!dirty}>保存</Button>
              </Space>
            }
          >
            <div style={{ display: 'grid', gap: 16 }}>
              <Alert
                type={form.enabled ? (Number(current.version || 0) > 0 ? 'success' : 'warning') : 'error'}
                message={`${current.catalog_meta.label} / ${currentState?.text || ''}`}
                description={currentState?.desc || ''}
                showIcon
              />

              <Card size="small" title="规则信息">
                <Space wrap size={[16, 8]}>
                  <Tag color="blue">版本 {current.version || 0}</Tag>
                  <Tag>最后修改时间：{formatPolicyUpdatedAt(current.updated_at)}</Tag>
                  <Tag>最后修改人：{current.updated_by_name || current.updated_by || '-'}</Tag>
                </Space>
              </Card>

              <Card size="small" title="业务说明">
                <Typography.Paragraph style={{ marginBottom: 0 }}>
                  {current.catalog_meta.description}
                </Typography.Paragraph>
              </Card>

              <Card size="small" title="规则状态">
                <Radio.Group
                  value={form.enabled ? 'enabled' : 'disabled'}
                  onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.target.value === 'enabled' }))}
                  optionType="button"
                  buttonStyle="solid"
                >
                  <Radio.Button value="enabled">启用</Radio.Button>
                  <Radio.Button value="disabled">禁用</Radio.Button>
                </Radio.Group>
              </Card>

              <Card size="small" title="主模板">
                <Select
                  value={form.template_key}
                  style={{ width: '100%' }}
                  onChange={(value) => setForm((prev) => ({ ...prev, template_key: value }))}
                  options={templates.map((item) => ({
                    value: item.key,
                    label: `${item.label} · ${item.description}`,
                  }))}
                />
              </Card>

              <Card size="small" title="附加接收组">
                <Select
                  mode="multiple"
                  value={form.extra_group_keys}
                  style={{ width: '100%' }}
                  placeholder="选择额外追加的业务组"
                  onChange={(value) => setForm((prev) => ({ ...prev, extra_group_keys: value }))}
                  options={currentAllowedGroups.map((item) => ({
                    value: item.key,
                    label: `${item.label} · ${item.description}`,
                  }))}
                />
              </Card>

              <Card size="small" title="指定个人">
                <Select
                  mode="multiple"
                  showSearch
                  optionFilterProp="label"
                  value={form.extra_user_ids}
                  style={{ width: '100%' }}
                  placeholder="追加指定个人"
                  onChange={(value) => setForm((prev) => ({ ...prev, extra_user_ids: value }))}
                  options={users.map((item) => ({
                    value: item.id,
                    label: `${item.username} · ${item.role}`,
                  }))}
                />
              </Card>

              <Card size="small" title="备注">
                <Input.TextArea
                  value={form.note}
                  rows={4}
                  maxLength={500}
                  placeholder="记录这个业务事件的接收约定"
                  onChange={(e) => setForm((prev) => ({ ...prev, note: e.target.value }))}
                />
              </Card>

              <Card size="small" title="最终摘要">
                <Alert
                  type="info"
                  showIcon
                  message={summary}
                  description="模板只负责默认收件范围；附加接收组和指定个人始终按“追加接收人”处理，不支持在页面里减人。"
                />
              </Card>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}
