"use client"

import { useCallback, useEffect, useState } from 'react'
import { Alert, App, Button, Card, DatePicker, Descriptions, Divider, Drawer, Empty, Form, Input, Select, Space, Switch, Table, Tabs, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { type Dayjs } from 'dayjs'
import TableRowActions from '../../../components/TableRowActions'
import { getJSON, patchJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'
import { resolveSettlementLoadIssue, type SettlementLoadIssue } from './settlementPageState'
import FeeRuleDrawer from './FeeRuleDrawer'
import WeeklySettlementsPanel from './WeeklySettlementsPanel'
import WorkloadClaimsPanel from './WorkloadClaimsPanel'
import {
  isValidAustralianAbn,
  normalizeAustralianAbn,
  personnelProfileSaveErrorMessage,
} from './personnelProfileUi'
import {
  FEE_COMPONENT_LABELS,
  PRICE_BASIS_LABELS,
  centsToDollars,
  cleaningRuleItemLabel,
  type FeeComponentType,
  type FeePriceBasis,
} from './feeRuleUi'

type GstStatus = 'unconfirmed' | 'registered' | 'not_registered'
type PersonnelType = 'cleaner' | 'inspector' | 'warehouse' | 'trial' | 'external' | 'mixed'

type PersonnelProfile = {
  user_id: string
  username: string | null
  display_name: string | null
  role: string | null
  legal_name: string | null
  supplier_business_name: string | null
  personal_abn: string | null
  gst_status: GstStatus
  gst_effective_from: string | null
  effective_from: string | null
  settlement_enabled: boolean
  person_type: PersonnelType
  photo_id_uploaded: boolean
  bank_details_complete: boolean
  bank_account_name: string | null
  bank_bsb: string | null
  bank_account_number: string | null
  bank_bsb_masked: string | null
  bank_account_masked: string | null
  fee_rule_name: string | null
  fee_rule_price_basis: 'exclusive_gst' | 'inclusive_gst' | null
  fee_rule_effective_from: string | null
  updated_at: string | null
}

type PersonnelFeeRuleItem = {
  id: string
  component_type: FeeComponentType
  conditions?: { property_type?: string | null } | null
  rate_cents: number
}

type PersonnelFeeRuleVersion = {
  id: string
  name: string
  effective_from: string
  effective_to: string | null
  price_basis: FeePriceBasis
  notes: string | null
  is_current: boolean
  items: PersonnelFeeRuleItem[]
}

type EditValues = {
  legal_name: string
  supplier_business_name?: string
  personal_abn: string
  gst_status: GstStatus
  person_type: PersonnelType
  settlement_enabled: boolean
  effective_date: Dayjs
  reason: string
  bank_account_name?: string
  bank_bsb?: string
  bank_account_number?: string
}

const GST_LABELS: Record<GstStatus, string> = {
  unconfirmed: '未确认',
  registered: '已注册 GST',
  not_registered: '未注册 GST',
}

const TYPE_LABELS: Record<PersonnelType, string> = {
  cleaner: '清洁人员',
  inspector: '检查人员',
  warehouse: '仓管人员',
  trial: '试工人员',
  external: '编外人员',
  mixed: '混合岗位',
}

function displayName(row: PersonnelProfile) {
  return row.display_name || row.username || row.legal_name || row.user_id
}

function formatDateTime(value: string | null) {
  if (!value) return '-'
  const parsed = dayjs(value)
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm') : value
}

function feeRuleItemLabel(item: PersonnelFeeRuleItem) {
  return item.component_type === 'cleaning_task'
    ? cleaningRuleItemLabel(item.conditions?.property_type)
    : FEE_COMPONENT_LABELS[item.component_type] || item.component_type
}

export default function PersonnelSettlementsPage() {
  const { message } = App.useApp()
  const [form] = Form.useForm<EditValues>()
  const [mounted, setMounted] = useState(false)
  const [rows, setRows] = useState<PersonnelProfile[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState('weekly')
  const [loadIssue, setLoadIssue] = useState<SettlementLoadIssue | null>(null)
  const [drawerMode, setDrawerMode] = useState<'detail' | 'edit' | null>(null)
  const [selected, setSelected] = useState<PersonnelProfile | null>(null)
  const [detailCurrentRule, setDetailCurrentRule] = useState<PersonnelFeeRuleVersion | null>(null)
  const [detailCurrentRuleError, setDetailCurrentRuleError] = useState('')
  const [ruleTarget, setRuleTarget] = useState<PersonnelProfile | null>(null)
  const canView = hasPerm('personnel_settlements.profiles.view')
  const canEdit = hasPerm('personnel_settlements.profiles.manage')
  const canManageBank = hasPerm('personnel_settlements.bank.manage')
  const canManageRules = hasPerm('personnel_settlements.rules.manage')

  const loadRows = useCallback(async (keyword: string) => {
    if (!mounted || !canView) return
    setLoading(true)
    setLoadIssue(null)
    try {
      const query = keyword.trim() ? `?search=${encodeURIComponent(keyword.trim())}` : ''
      setRows(await getJSON<PersonnelProfile[]>(`/finance/settlements/profiles${query}`, { authSensitive: true }))
    } catch (error: any) {
      setRows([])
      setLoadIssue(resolveSettlementLoadIssue(error))
    } finally {
      setLoading(false)
    }
  }, [canView, mounted])

  useEffect(() => { setMounted(true) }, [])
  useEffect(() => { void loadRows('') }, [loadRows])

  async function loadDetail(row: PersonnelProfile) {
    return getJSON<PersonnelProfile>(`/finance/settlements/profiles/${encodeURIComponent(row.user_id)}`, { authSensitive: true })
  }

  async function openDrawer(row: PersonnelProfile, mode: 'detail' | 'edit') {
    try {
      const detail = await loadDetail(row)
      let currentRule: PersonnelFeeRuleVersion | null = null
      let currentRuleError = ''
      if (mode === 'detail' && canManageRules) {
        try {
          const rules = await getJSON<PersonnelFeeRuleVersion[]>(`/finance/settlements/profiles/${encodeURIComponent(row.user_id)}/rules`, { authSensitive: true })
          currentRule = rules.find((rule) => rule.is_current) || null
        } catch {
          currentRuleError = '暂时无法读取当前费用规则，请稍后关闭并重新打开详情。'
        }
      }
      setSelected(detail)
      setDetailCurrentRule(currentRule)
      setDetailCurrentRuleError(currentRuleError)
      setDrawerMode(mode)
      if (mode === 'edit') {
        form.setFieldsValue({
          legal_name: detail.legal_name || '',
          supplier_business_name: detail.supplier_business_name || '',
          personal_abn: detail.personal_abn || '',
          gst_status: detail.gst_status || 'unconfirmed',
          person_type: detail.person_type,
          settlement_enabled: detail.settlement_enabled,
          effective_date: dayjs(),
          reason: '',
          ...(canManageBank ? {
            bank_account_name: detail.bank_account_name || '',
            bank_bsb: detail.bank_bsb || '',
            bank_account_number: detail.bank_account_number || '',
          } : {}),
        })
      }
    } catch (error: any) {
      message.error(String(error?.message || '人员结算资料加载失败'))
    }
  }

  async function save() {
    if (!selected) return
    const values = await form.validateFields()
    setSaving(true)
    try {
      const payload: Record<string, unknown> = {
        legal_name: values.legal_name.trim(),
        supplier_business_name: values.supplier_business_name?.trim() || null,
        personal_abn: normalizeAustralianAbn(values.personal_abn),
        gst_status: values.gst_status,
        person_type: values.person_type,
        settlement_enabled: values.settlement_enabled,
        effective_date: values.effective_date.format('YYYY-MM-DD'),
        reason: values.reason.trim(),
      }
      if (canManageBank) {
        payload.bank_account_name = values.bank_account_name?.trim() || null
        payload.bank_bsb = values.bank_bsb?.trim() || null
        payload.bank_account_number = values.bank_account_number?.trim() || null
      }
      await patchJSON(`/finance/settlements/profiles/${encodeURIComponent(selected.user_id)}`, payload, { authSensitive: true })
      message.success('人员结算资料已保存')
      setDrawerMode(null)
      setSelected(null)
      form.resetFields()
      await loadRows(search)
    } catch (error: any) {
      if (error?.errorFields) return
      message.error(personnelProfileSaveErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const columns: ColumnsType<PersonnelProfile> = [
    {
      title: '人员',
      key: 'person',
      fixed: 'left',
      width: 170,
      render: (_, row) => <Space direction="vertical" size={0}><strong>{displayName(row)}</strong><Typography.Text type="secondary">{row.role || '-'}</Typography.Text></Space>,
    },
    { title: '类型', dataIndex: 'person_type', width: 110, render: (value: PersonnelType) => TYPE_LABELS[value] || value },
    { title: 'ABN', dataIndex: 'personal_abn', width: 130, render: (value) => value || <Tag color="warning">未填写</Tag> },
    { title: '商业名称', dataIndex: 'supplier_business_name', width: 160, render: (value) => value || '-' },
    {
      title: 'GST',
      dataIndex: 'gst_status',
      width: 140,
      render: (value: GstStatus, row) => <Space direction="vertical" size={0}><Tag color={value === 'registered' ? 'green' : value === 'not_registered' ? 'blue' : 'orange'}>{GST_LABELS[value]}</Tag><Typography.Text type="secondary">{row.gst_effective_from || '-'}</Typography.Text></Space>,
    },
    { title: '银行资料', dataIndex: 'bank_details_complete', width: 110, render: (value: boolean) => <Tag color={value ? 'green' : 'warning'}>{value ? '完整' : '待补充'}</Tag> },
    {
      title: '费用规则',
      key: 'rule',
      width: 180,
      render: (_, row) => row.fee_rule_name ? <Space direction="vertical" size={0}><span>{row.fee_rule_name}</span><Typography.Text type="secondary">{row.fee_rule_price_basis === 'inclusive_gst' ? '含 GST' : '未税价'}</Typography.Text></Space> : <Tag color="warning">未配置</Tag>,
    },
    { title: '结算', dataIndex: 'settlement_enabled', width: 90, render: (value: boolean) => <Tag color={value ? 'green' : 'default'}>{value ? '启用' : '停用'}</Tag> },
    { title: '最后修改', dataIndex: 'updated_at', width: 155, render: formatDateTime },
    {
      title: '操作',
      key: 'actions',
      fixed: 'right',
      width: canEdit || canManageRules ? 270 : 90,
      render: (_, row) => <TableRowActions actions={[
        { key: 'detail', label: '详情', onClick: () => { void openDrawer(row, 'detail') } },
        { key: 'edit', label: '编辑', hidden: !canEdit, onClick: () => { void openDrawer(row, 'edit') } },
        { key: 'rules', label: '费用规则', hidden: !canManageRules, onClick: () => { setRuleTarget(row) } },
      ]} />,
    },
  ]

  if (!mounted) return null
  if (!canView) return <Alert type="error" showIcon message="无权限查看费用结算人员资料" />

  return (
    <Card
      title="费用结算"
      extra={activeTab === 'profiles' ? (
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="搜索姓名、账号或 ABN"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onSearch={(value) => { setSearch(value); void loadRows(value) }}
            style={{ width: 300 }}
          />
          <Button onClick={() => void loadRows(search)} loading={loading}>刷新</Button>
        </Space>
      ) : null}
    >
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        destroyOnHidden
        items={[
          { key: 'weekly', label: '周结算', children: <WeeklySettlementsPanel /> },
          { key: 'claims', label: '工作量反馈', children: <WorkloadClaimsPanel /> },
          {
            key: 'profiles',
            label: '人员与费用规则',
            children: <>
              <Alert
                showIcon
                type="info"
                message="姓名、ABN、银行和 Photo ID 复用移动端个人资料；GST 与结算设置按生效日期保留历史版本。"
                style={{ marginBottom: 12 }}
              />
              {loadIssue ? (
                <Alert
                  showIcon
                  type={loadIssue.kind === 'schema_not_ready' ? 'warning' : 'error'}
                  message={loadIssue.message}
                  description={loadIssue.description}
                  action={<Button size="small" onClick={() => void loadRows(search)} loading={loading}>重新加载</Button>}
                />
              ) : (
                <Table<PersonnelProfile>
                  rowKey="user_id"
                  loading={loading}
                  dataSource={rows}
                  columns={columns}
                  scroll={{ x: 1450 }}
                  pagination={{ pageSize: 50, showSizeChanger: true }}
                />
              )}
            </>,
          },
        ]}
      />

      <Drawer
        width={680}
        open={drawerMode === 'detail'}
        title="人员结算资料详情"
        onClose={() => { setDrawerMode(null); setSelected(null); setDetailCurrentRule(null); setDetailCurrentRuleError('') }}
        footer={<div style={{ textAlign: 'right' }}><Button onClick={() => { setDrawerMode(null); setSelected(null); setDetailCurrentRule(null); setDetailCurrentRuleError('') }}>关闭</Button></div>}
      >
        {selected ? <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Descriptions bordered column={1} size="small">
            <Descriptions.Item label="人员">{displayName(selected)}</Descriptions.Item>
            <Descriptions.Item label="人员类型">{TYPE_LABELS[selected.person_type]}</Descriptions.Item>
            <Descriptions.Item label="法定姓名">{selected.legal_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="商业名称">{selected.supplier_business_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="ABN">{selected.personal_abn || '-'}</Descriptions.Item>
            <Descriptions.Item label="GST 状态">{GST_LABELS[selected.gst_status]}（生效：{selected.gst_effective_from || '-'}）</Descriptions.Item>
            <Descriptions.Item label="银行账户名">{selected.bank_account_name || (selected.bank_details_complete ? '已登记（无完整银行资料权限）' : '-')}</Descriptions.Item>
            <Descriptions.Item label="BSB">{selected.bank_bsb || selected.bank_bsb_masked || '-'}</Descriptions.Item>
            <Descriptions.Item label="银行账号">{selected.bank_account_number || selected.bank_account_masked || '-'}</Descriptions.Item>
            <Descriptions.Item label="Photo ID">{selected.photo_id_uploaded ? '已上传' : '未上传'}</Descriptions.Item>
            <Descriptions.Item label="费用规则">{selected.fee_rule_name || '未配置'}</Descriptions.Item>
            <Descriptions.Item label="结算状态">{selected.settlement_enabled ? '启用' : '停用'}</Descriptions.Item>
          </Descriptions>
          {canManageRules ? <>
            <Divider orientation="left" style={{ margin: 0 }}>当前费用规则</Divider>
            {detailCurrentRuleError ? (
              <Alert showIcon type="error" message="当前费用规则加载失败" description={detailCurrentRuleError} />
            ) : detailCurrentRule ? (
              <Card
                size="small"
                title={<Space><span>{detailCurrentRule.name}</span><Tag color="green">当前生效</Tag></Space>}
              >
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Typography.Text>生效期间：{detailCurrentRule.effective_from} 至 {detailCurrentRule.effective_to || '持续有效'}</Typography.Text>
                  <Typography.Text>单价口径：{PRICE_BASIS_LABELS[detailCurrentRule.price_basis]}</Typography.Text>
                  {detailCurrentRule.items.map((item) => (
                    <Typography.Text key={item.id}>• {feeRuleItemLabel(item)}：${centsToDollars(item.rate_cents).toFixed(2)}</Typography.Text>
                  ))}
                  {detailCurrentRule.notes ? <Typography.Text type="secondary">备注：{detailCurrentRule.notes}</Typography.Text> : null}
                </Space>
              </Card>
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有生效的费用规则" />}
          </> : null}
        </Space> : null}
      </Drawer>

      <Drawer
        width={680}
        forceRender
        open={drawerMode === 'edit'}
        title="编辑人员结算资料"
        onClose={() => { if (!saving) { setDrawerMode(null); setSelected(null); form.resetFields() } }}
        footer={<div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><Button disabled={saving} onClick={() => { setDrawerMode(null); setSelected(null); form.resetFields() }}>取消</Button><Button type="primary" loading={saving} onClick={() => void save()}>保存</Button></div>}
      >
        <Form form={form} layout="vertical">
          <Form.Item label="法定姓名" name="legal_name" rules={[{ required: true, message: '请输入法定姓名' }]}><Input maxLength={120} /></Form.Item>
          <Form.Item label="商业/Trading Name（可选）" name="supplier_business_name"><Input maxLength={160} /></Form.Item>
          <Form.Item
            label="ABN"
            name="personal_abn"
            extra="系统只检查 11 位数字，不做数学或 ABR 验证；可输入空格或连字符。GST 状态请按实际登记情况选择。"
            rules={[
              { required: true, message: '请输入 ABN' },
              {
                validator: async (_, value) => {
                  if (!String(value || '').trim()) return
                  if (!isValidAustralianAbn(value)) throw new Error('ABN 必须为 11 位数字')
                },
              },
            ]}
          ><Input maxLength={32} /></Form.Item>
          <Form.Item label="GST 状态" name="gst_status" rules={[{ required: true }]}><Select options={Object.entries(GST_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item label="人员类型" name="person_type" rules={[{ required: true }]}><Select options={Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item label="启用费用结算" name="settlement_enabled" valuePropName="checked"><Switch /></Form.Item>
          {canManageBank ? <>
            <Form.Item label="银行账户名" name="bank_account_name"><Input maxLength={120} /></Form.Item>
            <Form.Item label="BSB" name="bank_bsb" rules={[{ pattern: /^\s*\d{3}[\s-]?\d{3}\s*$/, message: 'BSB 必须为 6 位数字' }]}><Input maxLength={32} /></Form.Item>
            <Form.Item label="银行账号" name="bank_account_number" rules={[{ pattern: /^\s*\d[\d\s-]{2,20}\s*$/, message: '银行账号格式不正确' }]}><Input maxLength={32} /></Form.Item>
          </> : <Alert style={{ marginBottom: 16 }} showIcon type="warning" message="当前权限只能修改身份、GST 和结算设置；完整银行资料仅财务或获授权人员可修改。" />}
          <Form.Item
            label="结算资料生效日期"
            name="effective_date"
            extra="控制本页姓名、ABN、GST、人员类型、结算开关及银行资料从哪一天开始生效。"
            rules={[{ required: true, message: '请选择结算资料生效日期' }]}
          ><DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" disabledDate={(date) => date.isAfter(dayjs(), 'day')} /></Form.Item>
          <Form.Item label="资料修改原因" name="reason" rules={[{ required: true, whitespace: true, message: '请填写资料修改原因' }]}><Input.TextArea maxLength={500} showCount rows={3} /></Form.Item>
        </Form>
      </Drawer>

      <FeeRuleDrawer
        open={!!ruleTarget}
        userId={ruleTarget?.user_id || null}
        personName={ruleTarget ? displayName(ruleTarget) : ''}
        personType={ruleTarget?.person_type || 'external'}
        onClose={() => setRuleTarget(null)}
        onSaved={() => loadRows(search)}
      />
    </Card>
  )
}
