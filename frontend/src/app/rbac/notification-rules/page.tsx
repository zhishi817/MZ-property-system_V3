"use client"

import { Alert, Button, Card, Checkbox, Empty, Input, List, Radio, Select, Space, Spin, Tag, Typography, message } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { getJSON, postJSON, putJSON } from '../../../lib/api'

type NotificationRuleRecipientType = 'role' | 'audience' | 'user'
type NotificationRuleConfigState = 'no_config' | 'configured' | 'empty_config' | 'disabled'
type Selector = { recipient_type: NotificationRuleRecipientType; recipient_value: string }
type Rule = {
  event_type: string
  enabled: boolean
  config_state: NotificationRuleConfigState
  version: number
  updated_at: string | null
  updated_by: string | null
  updated_by_name: string | null
  note: string | null
  selectors: Selector[]
  default_template: { enabled: boolean; note?: string | null; selectors: Selector[] }
}
type Role = { id: string; name: string; description?: string | null }
type User = { id: string; username: string; role: string; roles?: string[] }
type AudienceOption = { value: string; label: string; description: string }

const EVENT_DESCRIPTIONS: Record<string, string> = {
  ORDER_UPDATED: '订单信息更新',
  CLEANING_TASK_UPDATED: '清洁任务字段更新、退房类任务更新',
  CLEANING_COMPLETED: '清洁完成',
  INSPECTION_COMPLETED: '检查完成',
  KEY_PHOTO_UPLOADED: '上传钥匙照片',
  ISSUE_REPORTED: '问题上报',
  WORK_TASK_UPDATED: '真实 work task 更新',
  WORK_TASK_COMPLETED: '房源 / 公司 / 其他任务完成',
  DAY_END_HANDOVER_REMINDER: '日终交接提醒',
  DAY_END_HANDOVER_MANAGER_REMINDER: '日终交接 manager 提醒',
  KEY_UPLOAD_REMINDER: '普通提醒：提醒执行人上传钥匙照片',
  KEY_UPLOAD_SLA_REMINDER: 'SLA 提醒：到达时限节点仍未上传，继续提醒执行人',
  KEY_UPLOAD_SLA_ESCALATION: 'SLA 升级：超过时限仍未上传，升级通知经理组',
}

function fmtDateTime(raw: string | null) {
  if (!raw) return '-'
  const d = new Date(raw)
  if (!Number.isFinite(d.getTime())) return raw
  return d.toLocaleString()
}

function stateMeta(state: NotificationRuleConfigState) {
  if (state === 'no_config') return { color: 'gold', text: '未配置', desc: '当前使用系统默认模板' }
  if (state === 'empty_config') return { color: 'orange', text: '空配置', desc: '当前已配置为空，将不会通知任何人' }
  if (state === 'disabled') return { color: 'red', text: '已禁用', desc: '当前事件已整体停发' }
  return { color: 'green', text: '已配置', desc: '当前使用自定义规则' }
}

export default function NotificationRulesPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [rules, setRules] = useState<Rule[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [audiences, setAudiences] = useState<AudienceOption[]>([])
  const [currentEventType, setCurrentEventType] = useState<string>('')
  const [mode, setMode] = useState<'enabled' | 'disabled'>('enabled')
  const [roleValues, setRoleValues] = useState<string[]>([])
  const [audienceValues, setAudienceValues] = useState<string[]>([])
  const [userValues, setUserValues] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [dirty, setDirty] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const res = await getJSON<{ rules: Rule[]; roles: Role[]; users: User[]; audience_options: AudienceOption[] }>('/rbac/notification-rules')
      const nextRules = Array.isArray(res.rules) ? res.rules : []
      setRules(nextRules)
      setRoles(Array.isArray(res.roles) ? res.roles : [])
      setUsers(Array.isArray(res.users) ? res.users : [])
      setAudiences(Array.isArray(res.audience_options) ? res.audience_options : [])
      const firstEvent = nextRules[0]?.event_type || ''
      setCurrentEventType((prev) => (prev && nextRules.some((x) => x.event_type === prev) ? prev : firstEvent))
    } catch (e: any) {
      message.error(String(e?.message || '加载失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const current = useMemo(() => rules.find((x) => x.event_type === currentEventType) || null, [rules, currentEventType])

  useEffect(() => {
    if (!current) return
    const baseSelectors = current.config_state === 'no_config' ? (current.default_template?.selectors || []) : current.selectors
    const selectors = Array.isArray(baseSelectors) ? baseSelectors : []
    const effectiveEnabled = current.config_state === 'no_config' ? current.default_template?.enabled !== false : current.enabled !== false
    setMode(effectiveEnabled ? 'enabled' : 'disabled')
    setRoleValues(selectors.filter((x) => x.recipient_type === 'role').map((x) => x.recipient_value))
    setAudienceValues(selectors.filter((x) => x.recipient_type === 'audience').map((x) => x.recipient_value))
    setUserValues(selectors.filter((x) => x.recipient_type === 'user').map((x) => x.recipient_value))
    setNote(String(current.note || current.default_template?.note || ''))
    setDirty(false)
  }, [current])

  const previewRoles = roleValues.map((name) => `角色:${name}`)
  const previewAudiences = audienceValues.map((name) => `系统人群:${name}`)
  const previewUsers = userValues
    .map((id) => users.find((x) => x.id === id))
    .filter(Boolean)
    .map((u) => `例外用户:${u!.username}`)
  const state = current ? stateMeta(current.config_state) : null

  async function saveCurrent() {
    if (!current) return
    setSaving(true)
    try {
      const selectors: Selector[] = [
        ...roleValues.map((x) => ({ recipient_type: 'role' as const, recipient_value: x })),
        ...audienceValues.map((x) => ({ recipient_type: 'audience' as const, recipient_value: x })),
        ...userValues.map((x) => ({ recipient_type: 'user' as const, recipient_value: x })),
      ]
      const saved = await putJSON<Rule>(`/rbac/notification-rules/${current.event_type}`, {
        enabled: mode !== 'disabled',
        note: note.trim() || null,
        selectors,
      })
      setRules((prev) => prev.map((x) => (x.event_type === saved.event_type ? saved : x)))
      setDirty(false)
      message.success('通知规则已保存')
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
      const saved = await postJSON<Rule>(`/rbac/notification-rules/${current.event_type}/reset`, {})
      setRules((prev) => prev.map((x) => (x.event_type === saved.event_type ? saved : x)))
      setDirty(false)
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
      <Card title="通知规则" extra={<Button onClick={() => load()}>刷新</Button>}>
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          在这里按事件配置通知角色、系统人群和例外人群。`emitNotificationEvent` 会以这里保存的规则为准解析 recipients。
        </Typography.Paragraph>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '320px minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <Card title="事件列表" bodyStyle={{ padding: 0 }}>
          <List
            dataSource={rules}
            renderItem={(item) => {
              const meta = stateMeta(item.config_state)
              return (
                <List.Item
                  onClick={() => setCurrentEventType(item.event_type)}
                  style={{
                    padding: '12px 16px',
                    cursor: 'pointer',
                    background: currentEventType === item.event_type ? '#f0f5ff' : undefined,
                  }}
                >
                  <div style={{ width: '100%', display: 'grid', gap: 6 }}>
                    <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                      <Typography.Text strong>{item.event_type}</Typography.Text>
                      <Tag color={meta.color}>{meta.text}</Tag>
                    </Space>
                    <Typography.Text type="secondary">{EVENT_DESCRIPTIONS[item.event_type] || item.event_type}</Typography.Text>
                  </div>
                </List.Item>
              )
            }}
          />
        </Card>

        {!current ? (
          <Card><Empty description="请选择一个事件" /></Card>
        ) : (
          <Card
            title={current.event_type}
            extra={
              <Space>
                <Button onClick={resetCurrent} disabled={saving}>恢复默认模板</Button>
                <Button type="primary" onClick={saveCurrent} loading={saving} disabled={!dirty}>保存</Button>
              </Space>
            }
          >
            <div style={{ display: 'grid', gap: 16 }}>
              <Alert
                type={current.config_state === 'disabled' ? 'error' : current.config_state === 'configured' ? 'success' : 'warning'}
                message={`${EVENT_DESCRIPTIONS[current.event_type] || current.event_type} / ${state?.text || ''}`}
                description={state?.desc || ''}
                showIcon
              />

              <Card size="small" title="规则信息">
                <Space wrap size={[16, 8]}>
                  <Tag color="blue">版本 {current.version || 0}</Tag>
                  <Tag>最后修改时间：{fmtDateTime(current.updated_at)}</Tag>
                  <Tag>最后修改人：{current.updated_by_name || current.updated_by || '-'}</Tag>
                </Space>
              </Card>

              <Card size="small" title="规则状态">
                <Radio.Group
                  value={mode}
                  onChange={(e) => { setMode(e.target.value); setDirty(true) }}
                  optionType="button"
                  buttonStyle="solid"
                >
                  <Radio.Button value="enabled">启用</Radio.Button>
                  <Radio.Button value="disabled">禁用</Radio.Button>
                </Radio.Group>
              </Card>

              <Card size="small" title="角色勾选">
                <Alert
                  style={{ marginBottom: 12 }}
                  type="warning"
                  showIcon
                  message="角色勾选 = 固定岗位广播"
                  description="勾选角色后，会通知系统里所有拥有该角色的用户，不会自动限制为当前任务参与人。比如勾选 cleaner，会通知所有 cleaner，而不只是当前任务的清洁人员。"
                />
                <Checkbox.Group
                  style={{ display: 'grid', gap: 8 }}
                  value={roleValues}
                  onChange={(vals) => { setRoleValues((vals || []).map((x) => String(x))); setDirty(true) }}
                >
                  {roles.map((role) => (
                    <Checkbox key={role.id} value={role.name}>
                      <Space>
                        <span>{role.name}</span>
                        {role.description ? <Typography.Text type="secondary">{role.description}</Typography.Text> : null}
                        {(role.name === 'cleaner' || role.name === 'cleaning_inspector') ? (
                          <Typography.Text type="warning">勾选后会通知所有该角色用户</Typography.Text>
                        ) : null}
                      </Space>
                    </Checkbox>
                  ))}
                </Checkbox.Group>
              </Card>

              <Card size="small" title="系统人群">
                <Alert
                  style={{ marginBottom: 12 }}
                  type="info"
                  showIcon
                  message="系统人群 = 按当前业务动态匹配"
                  description="如果你想只通知当前任务/订单相关的人，优先使用系统人群。比如“清洁任务参与人”只会匹配当前 cleaning task 的 cleaner / inspector / assignee。"
                />
                <Checkbox.Group
                  style={{ display: 'grid', gap: 8 }}
                  value={audienceValues}
                  onChange={(vals) => { setAudienceValues((vals || []).map((x) => String(x))); setDirty(true) }}
                >
                  {audiences.map((item) => (
                    <Checkbox key={item.value} value={item.value}>
                      <Space direction="vertical" size={0}>
                        <span>{item.label}</span>
                        <Typography.Text type="secondary">{item.description}</Typography.Text>
                      </Space>
                    </Checkbox>
                  ))}
                </Checkbox.Group>
              </Card>

              <Card size="small" title="例外人群">
                <Select
                  mode="multiple"
                  allowClear
                  showSearch
                  style={{ width: '100%' }}
                  placeholder="按用户名搜索额外接收人"
                  value={userValues}
                  onChange={(vals) => { setUserValues((vals || []).map((x) => String(x))); setDirty(true) }}
                  optionFilterProp="label"
                  options={users.map((user) => ({
                    value: user.id,
                    label: `${user.username} (${Array.from(new Set([user.role, ...(user.roles || [])].filter(Boolean))).join(', ')})`,
                  }))}
                />
              </Card>

              <Card size="small" title="备注">
                <Input.TextArea
                  value={note}
                  rows={3}
                  placeholder="补充说明这个事件为什么这样配置"
                  onChange={(e) => { setNote(e.target.value); setDirty(true) }}
                />
              </Card>

              <Card size="small" title="当前解析预览">
                <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
                  以下三类是并集关系：角色、系统人群、例外人群可以单独选择，也可以组合选择。若三类都为空且规则仍启用，则该事件最终不会通知任何人。
                </Typography.Paragraph>
                <Space wrap>
                  {previewRoles.map((x) => <Tag key={x}>{x}</Tag>)}
                  {previewAudiences.map((x) => <Tag key={x} color="blue">{x}</Tag>)}
                  {previewUsers.map((x) => <Tag key={x} color="purple">{x}</Tag>)}
                  {!previewRoles.length && !previewAudiences.length && !previewUsers.length ? <Typography.Text type="secondary">当前没有任何 selector。启用状态下会形成空配置，最终不会通知任何人。</Typography.Text> : null}
                </Space>
              </Card>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}
