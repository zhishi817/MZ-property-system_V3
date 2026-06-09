"use client"

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { type Dayjs } from 'dayjs'
import { API_BASE, authHeaders, deleteJSON, getJSON, patchJSON, postJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'
import TableRowActions from '../../../components/TableRowActions'

type SocialInsuranceMode = 'standard' | 'pending'
type ContractStatus = 'draft' | 'generated' | 'archived'

type ContractFields = {
  employer_name: string
  employer_credit_code: string
  legal_representative: string
  employer_address: string
  employee_name: string
  employee_id_no: string
  employee_phone: string
  employee_address: string
  contract_term_type: 'open_ended' | 'fixed_term'
  effective_date: string
  end_date: string
  probation_months: number
  job_title_cn: string
  job_title_en: string
  job_duties_cn: string
  job_duties_en: string
  work_location_cn: string
  work_location_en: string
  work_timezone: string
  core_hours_start: string
  core_hours_end: string
  flexible_hours_start: string
  flexible_hours_end: string
  rest_days_cn: string
  rest_days_en: string
  monthly_salary: number
  payday: number
  payment_method_cn: string
  payment_method_en: string
  social_insurance_mode: SocialInsuranceMode
  social_insurance_city: string
  contribution_base_note: string
  termination_notice_days: number
  employer_authorized_representative: string
  employer_sign_date: string
  employee_sign_date: string
}

type EmploymentContract = {
  id: string
  contract_no: string
  status: ContractStatus
  fields: ContractFields
  notes?: string | null
  last_generated_at?: string | null
  created_at?: string
  updated_at?: string
}

type ContractFormValues = Omit<ContractFields, 'effective_date' | 'end_date' | 'employer_sign_date' | 'employee_sign_date'> & {
  effective_date?: Dayjs
  end_date?: Dayjs
  employer_sign_date?: Dayjs
  employee_sign_date?: Dayjs
  notes?: string
}

const DEFAULT_DUTIES_CN = [
  '客户服务：日常沟通，解答咨询，处理预订、入住、退房；协助解决客户问题及投诉；收集反馈。',
  '房源管理：登记房源订单，更新日历和价格，新房源上线建立 listing，更新信息表，回复大楼邮件。',
  '入住管理：制作或更新入住指南和手册，发送入住信息给相关大楼。',
  '维修维护：客人损坏物品索赔跟进，通过 Airtasker 等平台寻找维修人员，与物业预定钥匙和 fob。',
].join('\n')

const DEFAULT_DUTIES_EN = [
  'Customer Service: Daily customer communication, answering inquiries, handling reservations, check-ins and check-outs, resolving issues and collecting feedback.',
  'Property Management: Registering property orders, updating calendars and prices, creating new listings, updating information sheets and responding to building emails.',
  'Check-in Management: Creating and updating check-in guides and manuals, and sending check-in information to relevant buildings.',
  'Maintenance & Repairs: Following up guest damage claims, finding repairers through Airtasker or similar platforms, and booking keys or fobs with property management.',
].join('\n')

const DEFAULT_FIELDS: ContractFields = {
  employer_name: '南京知日科技有限公司',
  employer_credit_code: '',
  legal_representative: '',
  employer_address: '',
  employee_name: '',
  employee_id_no: '',
  employee_phone: '',
  employee_address: '',
  contract_term_type: 'open_ended',
  effective_date: dayjs().format('YYYY-MM-DD'),
  end_date: '',
  probation_months: 1,
  job_title_cn: '客服',
  job_title_en: 'Customer Service',
  job_duties_cn: DEFAULT_DUTIES_CN,
  job_duties_en: DEFAULT_DUTIES_EN,
  work_location_cn: '远程办公（居家办公）',
  work_location_en: 'Remote work (work from home)',
  work_timezone: '墨尔本时间',
  core_hours_start: '09:00',
  core_hours_end: '16:00',
  flexible_hours_start: '16:00',
  flexible_hours_end: '21:00',
  rest_days_cn: '周日、周一',
  rest_days_en: 'Sunday and Monday',
  monthly_salary: 7500,
  payday: 7,
  payment_method_cn: '银行卡转账',
  payment_method_en: 'Bank transfer',
  social_insurance_mode: 'standard',
  social_insurance_city: '南京市',
  contribution_base_note: '',
  termination_notice_days: 60,
  employer_authorized_representative: '',
  employer_sign_date: '',
  employee_sign_date: '',
}

const STATUS_META: Record<ContractStatus, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'default' },
  generated: { label: '已生成', color: 'green' },
  archived: { label: '已归档', color: 'orange' },
}

function socialInsuranceLabel(mode?: SocialInsuranceMode) {
  return mode === 'pending' ? '暂未由公司办理' : '正常缴纳'
}

function formatDateTime(value?: string | null) {
  return value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-'
}

function toFormValues(contract?: EmploymentContract): ContractFormValues {
  const fields = contract?.fields || DEFAULT_FIELDS
  const parseDate = (value?: string) => value ? dayjs(value) : undefined
  return {
    ...DEFAULT_FIELDS,
    ...fields,
    effective_date: parseDate(fields.effective_date),
    end_date: parseDate(fields.end_date),
    employer_sign_date: parseDate(fields.employer_sign_date),
    employee_sign_date: parseDate(fields.employee_sign_date),
    notes: contract?.notes || '',
  }
}

function toPayload(values: ContractFormValues) {
  const dateText = (value?: Dayjs) => value ? value.format('YYYY-MM-DD') : ''
  const { notes, ...rest } = values
  return {
    fields: {
      ...rest,
      effective_date: dateText(values.effective_date),
      end_date: dateText(values.end_date),
      employer_sign_date: dateText(values.employer_sign_date),
      employee_sign_date: dateText(values.employee_sign_date),
    },
    notes: notes?.trim() || null,
  }
}

function ContractDetail({ contract }: { contract: EmploymentContract }) {
  const fields = contract.fields || ({} as ContractFields)
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Descriptions bordered size="small" column={2} title="合同信息">
        <Descriptions.Item label="合同编号">{contract.contract_no}</Descriptions.Item>
        <Descriptions.Item label="状态">
          <Tag color={STATUS_META[contract.status]?.color}>{STATUS_META[contract.status]?.label || contract.status}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="员工姓名">{fields.employee_name || '-'}</Descriptions.Item>
        <Descriptions.Item label="岗位">{fields.job_title_cn || '-'}</Descriptions.Item>
        <Descriptions.Item label="生效日期">{fields.effective_date || '-'}</Descriptions.Item>
        <Descriptions.Item label="合同期限">{fields.contract_term_type === 'fixed_term' ? `固定期限，至 ${fields.end_date || '-'}` : '无固定期限'}</Descriptions.Item>
        <Descriptions.Item label="税前月薪">人民币 {Number(fields.monthly_salary || 0).toLocaleString('zh-CN')} 元</Descriptions.Item>
        <Descriptions.Item label="五险一金">{socialInsuranceLabel(fields.social_insurance_mode)}</Descriptions.Item>
        <Descriptions.Item label="核心工作时间">{fields.core_hours_start || '09:00'} - {fields.core_hours_end || '16:00'}</Descriptions.Item>
        <Descriptions.Item label="弹性工作时间">{fields.flexible_hours_start || '16:00'} - {fields.flexible_hours_end || '21:00'}</Descriptions.Item>
        <Descriptions.Item label="每周休息日" span={2}>{fields.rest_days_cn || '周日、周一'}</Descriptions.Item>
        <Descriptions.Item label="最后生成">{formatDateTime(contract.last_generated_at)}</Descriptions.Item>
        <Descriptions.Item label="更新时间">{formatDateTime(contract.updated_at)}</Descriptions.Item>
      </Descriptions>
      <Descriptions bordered size="small" column={1} title="甲乙双方">
        <Descriptions.Item label="甲方">{fields.employer_name || '-'}</Descriptions.Item>
        <Descriptions.Item label="统一社会信用代码">{fields.employer_credit_code || '-'}</Descriptions.Item>
        <Descriptions.Item label="法定代表人">{fields.legal_representative || '-'}</Descriptions.Item>
        <Descriptions.Item label="甲方地址">{fields.employer_address || '-'}</Descriptions.Item>
        <Descriptions.Item label="乙方身份证号">{fields.employee_id_no || '-'}</Descriptions.Item>
        <Descriptions.Item label="乙方联系电话">{fields.employee_phone || '-'}</Descriptions.Item>
        <Descriptions.Item label="乙方地址">{fields.employee_address || '-'}</Descriptions.Item>
      </Descriptions>
      <Descriptions bordered size="small" column={1} title="补充说明">
        <Descriptions.Item label="五险一金说明">{fields.contribution_base_note || '-'}</Descriptions.Item>
        <Descriptions.Item label="内部备注">{contract.notes || '-'}</Descriptions.Item>
      </Descriptions>
    </Space>
  )
}

export default function EmploymentContractsPage() {
  const [form] = Form.useForm<ContractFormValues>()
  const [rows, setRows] = useState<EmploymentContract[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [generatingId, setGeneratingId] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [editing, setEditing] = useState<EmploymentContract | null>(null)
  const [detail, setDetail] = useState<EmploymentContract | null>(null)
  const [keyword, setKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState<ContractStatus | undefined>()
  const [insuranceFilter, setInsuranceFilter] = useState<SocialInsuranceMode | undefined>()

  const canView = hasPerm('employment_contracts.view') || hasPerm('employment_contracts.create') || hasPerm('employment_contracts.write')
  const canWrite = hasPerm('employment_contracts.create') || hasPerm('employment_contracts.write')
  const canDelete = hasPerm('employment_contracts.delete')
  const contractTermType = Form.useWatch('contract_term_type', form)
  const socialInsuranceMode = Form.useWatch('social_insurance_mode', form)

  const loadRows = useCallback(async () => {
    if (!canView) return
    setLoading(true)
    try {
      const data = await getJSON<EmploymentContract[]>('/employment-contracts?include_archived=true')
      setRows(Array.isArray(data) ? data : [])
    } catch (error: any) {
      message.error(error?.message || '劳动合同加载失败')
    } finally {
      setLoading(false)
    }
  }, [canView])

  useEffect(() => {
    void loadRows()
  }, [loadRows])

  const filteredRows = useMemo(() => {
    const query = keyword.trim().toLowerCase()
    return rows.filter((row) => {
      if (statusFilter && row.status !== statusFilter) return false
      if (insuranceFilter && row.fields?.social_insurance_mode !== insuranceFilter) return false
      if (!query) return true
      const haystack = [row.contract_no, row.fields?.employee_name, row.fields?.employer_name, row.fields?.job_title_cn]
        .map((value) => String(value || '').toLowerCase())
        .join(' ')
      return haystack.includes(query)
    })
  }, [insuranceFilter, keyword, rows, statusFilter])

  function openCreate() {
    setEditing(null)
    form.setFieldsValue(toFormValues())
    setEditorOpen(true)
  }

  function openEdit(row: EmploymentContract) {
    setEditing(row)
    form.setFieldsValue(toFormValues(row))
    setEditorOpen(true)
  }

  function openDetail(row: EmploymentContract) {
    setDetail(row)
    setDetailOpen(true)
  }

  async function downloadPdf(row: EmploymentContract) {
    setGeneratingId(row.id)
    try {
      const response = await fetch(`${API_BASE}/employment-contracts/${encodeURIComponent(row.id)}/generate-pdf`, {
        method: 'POST',
        headers: authHeaders(),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.message || `HTTP ${response.status}`)
      }
      const blob = await response.blob()
      const disposition = response.headers.get('content-disposition') || ''
      const encodedMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i)
      const plainMatch = disposition.match(/filename="([^"]+)"/i)
      const filename = encodedMatch?.[1]
        ? decodeURIComponent(encodedMatch[1])
        : plainMatch?.[1] || `employment-contract-${row.contract_no}.pdf`
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      message.success('劳动合同 PDF 已生成')
      await loadRows()
      return true
    } catch (error: any) {
      message.error(error?.message || 'PDF 生成失败')
      return false
    } finally {
      setGeneratingId(null)
    }
  }

  async function submitContract() {
    if (saving) return
    try {
      const values = await form.validateFields()
      setSaving(true)
      const payload = toPayload(values)
      const saved = editing
        ? await patchJSON<EmploymentContract>(`/employment-contracts/${editing.id}`, payload)
        : await postJSON<EmploymentContract>('/employment-contracts', payload)
      const generated = await downloadPdf(saved)
      if (!generated) return
      setEditorOpen(false)
      setEditing(null)
      form.resetFields()
    } catch (error: any) {
      if (error?.errorFields) return
      if (error?.message) message.error(error.message)
    } finally {
      setSaving(false)
    }
  }

  function confirmDelete(row: EmploymentContract) {
    Modal.confirm({
      title: '删除劳动合同',
      content: `确认删除 ${row.contract_no}（${row.fields?.employee_name || '未命名员工'}）？删除后无法恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await deleteJSON(`/employment-contracts/${row.id}`)
        message.success('劳动合同已删除')
        await loadRows()
      },
    })
  }

  const columns: ColumnsType<EmploymentContract> = [
    {
      title: '合同编号',
      dataIndex: 'contract_no',
      width: 180,
      render: (value: string) => <Typography.Text copyable>{value}</Typography.Text>,
    },
    {
      title: '员工',
      width: 130,
      render: (_, row) => row.fields?.employee_name || '-',
    },
    {
      title: '岗位',
      width: 120,
      render: (_, row) => row.fields?.job_title_cn || '-',
    },
    {
      title: '生效日期',
      width: 120,
      render: (_, row) => row.fields?.effective_date || '-',
    },
    {
      title: '税前月薪',
      width: 130,
      align: 'right',
      render: (_, row) => `¥${Number(row.fields?.monthly_salary || 0).toLocaleString('zh-CN')}`,
    },
    {
      title: '五险一金',
      width: 150,
      render: (_, row) => (
        <Tag color={row.fields?.social_insurance_mode === 'pending' ? 'orange' : 'blue'}>
          {socialInsuranceLabel(row.fields?.social_insurance_mode)}
        </Tag>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (status: ContractStatus) => <Tag color={STATUS_META[status]?.color}>{STATUS_META[status]?.label || status}</Tag>,
    },
    {
      title: '最后生成',
      width: 150,
      render: (_, row) => formatDateTime(row.last_generated_at),
    },
    {
      title: '操作',
      fixed: 'right',
      width: 300,
      render: (_, row) => (
        <TableRowActions
          actions={[
            { key: 'detail', label: '详情', onClick: () => openDetail(row) },
            { key: 'edit', label: '编辑', onClick: () => openEdit(row), hidden: !canWrite },
            {
              key: 'download',
              label: '下载',
              onClick: () => void downloadPdf(row),
              loading: generatingId === row.id,
              hidden: !canWrite,
            },
            { key: 'delete', label: '删除', onClick: () => confirmDelete(row), danger: true, hidden: !canDelete },
          ]}
        />
      ),
    },
  ]

  if (!canView) {
    return <Alert type="warning" showIcon message="无劳动合同查看权限" description="请由管理员在人事管理菜单中授予相应权限。" />
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>劳动合同</Typography.Title>
          <Typography.Text type="secondary">生成劳动合同、保密协议和培训协议的中英双语 PDF。</Typography.Text>
        </div>
        {canWrite ? <Button type="primary" onClick={openCreate}>新建劳动合同</Button> : null}
      </div>

      <Alert
        type="warning"
        showIcon
        message="签署前请进行法务审核"
        description="“暂未由公司办理”不代表双方可以免除法定社会保险或住房公积金义务，系统生成的条款会保留依法处理的兜底说明。"
      />

      <Card size="small">
        <Space wrap>
          <Input
            allowClear
            placeholder="搜索合同编号、员工或岗位"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            style={{ width: 260 }}
          />
          <Select
            allowClear
            placeholder="合同状态"
            value={statusFilter}
            onChange={setStatusFilter}
            style={{ width: 140 }}
            options={[
              { value: 'draft', label: '草稿' },
              { value: 'generated', label: '已生成' },
              { value: 'archived', label: '已归档' },
            ]}
          />
          <Select
            allowClear
            placeholder="五险一金"
            value={insuranceFilter}
            onChange={setInsuranceFilter}
            style={{ width: 180 }}
            options={[
              { value: 'standard', label: '正常缴纳' },
              { value: 'pending', label: '暂未由公司办理' },
            ]}
          />
          <Button onClick={() => void loadRows()}>刷新</Button>
        </Space>
      </Card>

      <Card bodyStyle={{ padding: 0 }}>
        <Table<EmploymentContract>
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={filteredRows}
          scroll={{ x: 1450 }}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => `共 ${total} 份合同` }}
        />
      </Card>

      <Drawer
        title={editing ? `编辑劳动合同：${editing.contract_no}` : '新建劳动合同'}
        open={editorOpen}
        width={820}
        destroyOnClose
        onClose={() => {
          if (saving) return
          setEditorOpen(false)
          setEditing(null)
          form.resetFields()
        }}
        extra={
          <Space>
            <Button disabled={saving} onClick={() => setEditorOpen(false)}>取消</Button>
            <Button type="primary" loading={saving} onClick={() => void submitContract()}>保存并生成 PDF</Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" requiredMark="optional">
          <Card size="small" title="甲方（用人单位）" style={{ marginBottom: 16 }}>
            <Row gutter={16}>
              <Col span={12}><Form.Item name="employer_name" label="公司名称" rules={[{ required: true }]}><Input /></Form.Item></Col>
              <Col span={12}><Form.Item name="employer_credit_code" label="统一社会信用代码"><Input /></Form.Item></Col>
              <Col span={12}><Form.Item name="legal_representative" label="法定代表人"><Input /></Form.Item></Col>
              <Col span={12}><Form.Item name="employer_authorized_representative" label="授权签字代表"><Input /></Form.Item></Col>
              <Col span={24}><Form.Item name="employer_address" label="公司地址"><Input /></Form.Item></Col>
            </Row>
          </Card>

          <Card size="small" title="乙方（员工）" style={{ marginBottom: 16 }}>
            <Row gutter={16}>
              <Col span={12}><Form.Item name="employee_name" label="员工姓名" rules={[{ required: true }]}><Input /></Form.Item></Col>
              <Col span={12}><Form.Item name="employee_id_no" label="身份证号"><Input /></Form.Item></Col>
              <Col span={12}><Form.Item name="employee_phone" label="联系电话"><Input /></Form.Item></Col>
              <Col span={12}><Form.Item name="employee_address" label="员工地址"><Input /></Form.Item></Col>
            </Row>
          </Card>

          <Card size="small" title="合同期限与岗位" style={{ marginBottom: 16 }}>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="contract_term_type" label="合同期限类型" rules={[{ required: true }]}>
                  <Radio.Group options={[{ value: 'open_ended', label: '无固定期限' }, { value: 'fixed_term', label: '固定期限' }]} />
                </Form.Item>
              </Col>
              <Col span={6}><Form.Item name="effective_date" label="生效日期" rules={[{ required: true }]}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={6}>
                <Form.Item
                  name="end_date"
                  label="结束日期"
                  rules={[{ required: contractTermType === 'fixed_term', message: '请选择结束日期' }]}
                >
                  <DatePicker disabled={contractTermType !== 'fixed_term'} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={8}><Form.Item name="probation_months" label="试用期（月）" rules={[{ required: true }]}><InputNumber min={0} max={6} style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={8}><Form.Item name="job_title_cn" label="岗位（中文）" rules={[{ required: true }]}><Input /></Form.Item></Col>
              <Col span={8}><Form.Item name="job_title_en" label="岗位（英文）" rules={[{ required: true }]}><Input /></Form.Item></Col>
              <Col span={12}><Form.Item name="job_duties_cn" label="工作职责（中文，每行一项）" rules={[{ required: true }]}><Input.TextArea rows={8} /></Form.Item></Col>
              <Col span={12}><Form.Item name="job_duties_en" label="Job Duties（英文，每行一项）" rules={[{ required: true }]}><Input.TextArea rows={8} /></Form.Item></Col>
            </Row>
          </Card>

          <Card size="small" title="工作安排与报酬" style={{ marginBottom: 16 }}>
            <Row gutter={16}>
              <Col span={12}><Form.Item name="work_location_cn" label="工作地点（中文）" rules={[{ required: true }]}><Input /></Form.Item></Col>
              <Col span={12}><Form.Item name="work_location_en" label="工作地点（英文）" rules={[{ required: true }]}><Input /></Form.Item></Col>
              <Col span={8}><Form.Item name="work_timezone" label="工作时间时区" rules={[{ required: true }]}><Input /></Form.Item></Col>
              <Col span={8}><Form.Item name="core_hours_start" label="核心开始时间" rules={[{ required: true, pattern: /^\d{2}:\d{2}$/ }]}><Input placeholder="09:00" /></Form.Item></Col>
              <Col span={8}><Form.Item name="core_hours_end" label="核心结束时间" rules={[{ required: true, pattern: /^\d{2}:\d{2}$/ }]}><Input placeholder="16:00" /></Form.Item></Col>
              <Col span={12}><Form.Item name="flexible_hours_start" label="弹性开始时间" rules={[{ required: true, pattern: /^\d{2}:\d{2}$/ }]}><Input placeholder="16:00" /></Form.Item></Col>
              <Col span={12}><Form.Item name="flexible_hours_end" label="弹性结束时间" rules={[{ required: true, pattern: /^\d{2}:\d{2}$/ }]}><Input placeholder="21:00" /></Form.Item></Col>
              <Col span={12}><Form.Item name="rest_days_cn" label="每周休息日（中文）" rules={[{ required: true }]}><Input /></Form.Item></Col>
              <Col span={12}><Form.Item name="rest_days_en" label="每周休息日（英文）" rules={[{ required: true }]}><Input /></Form.Item></Col>
              <Col span={8}><Form.Item name="monthly_salary" label="税前月薪（人民币）" rules={[{ required: true }]}><InputNumber min={0.01} precision={2} style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={8}><Form.Item name="payday" label="每月发薪日" rules={[{ required: true }]}><InputNumber min={1} max={31} style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={8}><Form.Item name="termination_notice_days" label="解除通知期（天）" rules={[{ required: true }]}><InputNumber min={0} max={180} style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={12}><Form.Item name="payment_method_cn" label="支付方式（中文）" rules={[{ required: true }]}><Input /></Form.Item></Col>
              <Col span={12}><Form.Item name="payment_method_en" label="支付方式（英文）" rules={[{ required: true }]}><Input /></Form.Item></Col>
            </Row>
          </Card>

          <Card size="small" title="五险一金" style={{ marginBottom: 16 }}>
            <Form.Item name="social_insurance_mode" label="办理方式" rules={[{ required: true }]}>
              <Radio.Group>
                <Space direction="vertical">
                  <Radio value="standard">正常缴纳五险一金</Radio>
                  <Radio value="pending">暂未由公司办理（需法务确认）</Radio>
                </Space>
              </Radio.Group>
            </Form.Item>
            {socialInsuranceMode === 'pending' ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 16 }}
                message="该选项不会生成“永久放弃五险一金”的条款"
                description="PDF 将写明当前暂未办理，并保留依法补办或按主管部门要求处理的责任。"
              />
            ) : null}
            <Row gutter={16}>
              <Col span={8}><Form.Item name="social_insurance_city" label="缴纳城市" rules={[{ required: true }]}><Input /></Form.Item></Col>
              <Col span={16}><Form.Item name="contribution_base_note" label="缴纳基数或暂未办理说明"><Input /></Form.Item></Col>
            </Row>
          </Card>

          <Card size="small" title="签署与内部备注">
            <Row gutter={16}>
              <Col span={12}><Form.Item name="employer_sign_date" label="甲方签署日期"><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={12}><Form.Item name="employee_sign_date" label="乙方签署日期"><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={24}><Form.Item name="notes" label="内部备注（不进入合同正文）"><Input.TextArea rows={3} /></Form.Item></Col>
            </Row>
          </Card>
        </Form>
      </Drawer>

      <Drawer
        title={detail ? `劳动合同详情：${detail.contract_no}` : '劳动合同详情'}
        open={detailOpen}
        width={720}
        onClose={() => setDetailOpen(false)}
        extra={detail && canWrite ? (
          <Space>
            <Button onClick={() => {
              setDetailOpen(false)
              openEdit(detail)
            }}>编辑</Button>
            <Button type="primary" loading={generatingId === detail.id} onClick={() => void downloadPdf(detail)}>下载 PDF</Button>
          </Space>
        ) : null}
      >
        {detail ? <ContractDetail contract={detail} /> : null}
      </Drawer>
    </Space>
  )
}
