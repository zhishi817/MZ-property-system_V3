'use client'

import { Alert, Button, Card, Descriptions, Divider, Drawer, Empty, Form, Input, Popconfirm, Popover, Select, Space, Spin, Table, Tag } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { deleteJSON, getJSON, postJSON } from '../../../lib/api'
import { PROPERTY_PAYABLE_SETTLEMENT_DUE_LABEL, propertyPayableFrequencyLabel, propertyPayablePaymentTypeLabel } from '../../../lib/propertyPayables'
import { sortPropertiesByRegionThenCode } from '../../../lib/properties'

export const BILL_COLUMNS = [
  ['water', '水费'], ['electricity', '电费'], ['gas_hot_water', '煤气'], ['internet', '网络'],
  ['council_rate', '市政费'], ['owners_corp', '物业费'], ['other', '其他账单'],
] as const

type Category = typeof BILL_COLUMNS[number][0]
const statusLabels = { owner: '房东自付', company: '公司代付', pending: '待确认', not_applicable: '不适用' } as const
const statusOptions = Object.entries(statusLabels).map(([value, label]) => ({ value, label }))
type BillConfig = { status: keyof typeof statusLabels }
type OtherBillListItem = { source: 'configured' | 'template'; status: keyof typeof statusLabels; name?: string | null; template_status?: string | null }
type Bill = BillConfig & { source: 'configured' | 'template'; template_count?: number; active_template_count?: number;
  other_items?: OtherBillListItem[]; registration_status?: keyof typeof statusLabels }
export type PropertyBillTemplate = { template_id: string; template_status: string; property_id: string; category: Category;
  vendor?: string | null; category_detail?: string | null; other_bill_name?: string | null; amount?: number | null; account_number?: string | null;
  cycle_months?: number | null; due_day_of_month?: number | null; bill_expected_day_of_month?: number | null;
  bill_period_start_day_of_month?: number | null; bill_period_start_month_offset?: number | null;
  bill_period_end_day_of_month?: number | null; bill_period_end_month_offset?: number | null; remind_days_before?: number | null;
  payment_type?: string | null;
  pay_account_name?: string | null; pay_bsb?: string | null; pay_account_number?: string | null; pay_ref?: string | null;
  bpay_code?: string | null; pay_mobile_number?: string | null; start_month_key?: string | null; note?: string | null }
type PropertyRow = { id: string; code?: string; address?: string; region?: string | null; bills: Partial<Record<Category, Bill>> }
type Directory = { can_edit: boolean; display_name_storage_ready?: boolean; rows: PropertyRow[] }
type HistoryRow = { id?: string; date?: string | null; status?: string | null; amount?: number | null }
export type PropertyBillTemplateContext = { property_id: string; property_code: string; category: Category; can_edit: boolean }
type Props = {
  refreshToken?: number
  onViewTemplate?: (template: PropertyBillTemplate, context: PropertyBillTemplateContext) => void
  onEditTemplate?: (template: PropertyBillTemplate, context: PropertyBillTemplateContext) => void
  onCreateTemplate?: (context: PropertyBillTemplateContext) => void
  onDisplayNameStorageReady?: (ready: boolean) => void
}
const endpoint = '/recurring/property-payables/property-bills'
const categoryPath = (id: string, category: Category) => `${endpoint}/${encodeURIComponent(id)}/${category}`
const propertyLabel = (row: PropertyRow) => row.code || '房号未设置'
const billTagColor = { owner: 'blue', company: 'green', pending: 'gold', not_applicable: 'default' } as const

function firstCategory() {
  return BILL_COLUMNS[0][0]
}

function otherBillName(item: OtherBillListItem) {
  return String(item.name || '').trim() || '未命名'
}

function otherBillStatus(item: OtherBillListItem) {
  if (item.source === 'template' && item.template_status === 'paused') return '公司代付（已暂停）'
  return statusLabels[item.status] || statusLabels.pending
}

export default function PropertyBills({ refreshToken = 0, onViewTemplate, onEditTemplate, onCreateTemplate, onDisplayNameStorageReady }: Props) {
  const [directory, setDirectory] = useState<Directory | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [reload, setReload] = useState(0)
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [selected, setSelected] = useState<{ row: PropertyRow; category: Category } | null>(null)
  const [selectedBill, setSelectedBill] = useState<Bill | null>(null)
  const [selectedTemplates, setSelectedTemplates] = useState<PropertyBillTemplate[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [saveNotice, setSaveNotice] = useState(false)
  const [templateAction, setTemplateAction] = useState('')
  const [templateActionError, setTemplateActionError] = useState('')
  const [history, setHistory] = useState<{ rows?: HistoryRow[]; error?: boolean } | null>(null)
  const [readingHistory, setReadingHistory] = useState(false)
  const detailRequest = useRef(0)
  const historyRequest = useRef(0)
  const [form] = Form.useForm<BillConfig>()
  const status = Form.useWatch('status', form)

  useEffect(() => {
    let current = true
    setLoadError(false)
    setDirectory(null)
    const request = submittedQuery
      ? postJSON<Directory>(`${endpoint}/search`, {query: submittedQuery})
      : getJSON<Directory>(endpoint)
    void request.then((result) => {
      if (current) {
        setDirectory(result)
        onDisplayNameStorageReady?.(Boolean(result.display_name_storage_ready))
      }
    }, () => {
      if (current) { setDirectory(null); setLoadError(true) }
    })
    return () => { current = false }
  }, [refreshToken, reload, submittedQuery, onDisplayNameStorageReady])

  function open(row: PropertyRow, category: Category) {
    const requestId = ++detailRequest.current
    historyRequest.current += 1
    form.resetFields()
    setSelectedBill(null)
    setSelectedTemplates([])
    setDetailLoading(true)
    setDetailError(false)
    setHistory(null)
    setReadingHistory(false)
    setSaveError(false)
    setSaveNotice(false)
    setTemplateActionError('')
    setSelected({ row, category })
    void getJSON<{bill: Bill | null; templates: PropertyBillTemplate[]; display_name_storage_ready?: boolean}>(categoryPath(row.id, category)).then((result) => {
      if (detailRequest.current !== requestId) return
      setSelectedBill(result.bill)
      setSelectedTemplates(Array.isArray(result.templates) ? result.templates : [])
      onDisplayNameStorageReady?.(Boolean(result.display_name_storage_ready))
      form.setFieldsValue({ status: result.bill?.status })
    }, () => {
      if (detailRequest.current === requestId) setDetailError(true)
    }).finally(() => {
      if (detailRequest.current === requestId) setDetailLoading(false)
    })
  }

  useEffect(() => {
    if (!refreshToken || !selected) return
    open(selected.row, selected.category)
    // refreshToken is controlled by the parent template form. Keep the current
    // property/category selected while re-reading the original template data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken])

  function search(value: string) {
    const next = value.trim()
    setQuery(value)
    setDirectory(null)
    if (next === submittedQuery) setReload((count) => count + 1)
    else setSubmittedQuery(next)
  }

  async function save(values: BillConfig) {
    if (!selected || !directory?.can_edit || saving) return
    setSaving(true)
    setSaveError(false)
    try {
      await postJSON(categoryPath(selected.row.id, selected.category), { status: values.status })
      setDirectory(null)
      setSelected(null)
      setSaveNotice(true)
      setReload((n) => n + 1)
    } catch {
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }

  async function readHistory() {
    if (!selected || readingHistory) return
    const requestId = ++historyRequest.current
    const historyPath = `${categoryPath(selected.row.id, selected.category)}/history`
    setReadingHistory(true)
    try {
      const result = await getJSON<{ rows: HistoryRow[] }>(historyPath)
      if (historyRequest.current === requestId) setHistory(result)
    } catch {
      if (historyRequest.current === requestId) setHistory({ error: true })
    } finally {
      if (historyRequest.current === requestId) setReadingHistory(false)
    }
  }

  async function runTemplateAction(template: PropertyBillTemplate, action: 'stop' | 'resume' | 'delete') {
    if (!selected || !directory?.can_edit || templateAction) return
    const key = `${action}:${template.template_id}`
    const path = `${categoryPath(selected.row.id, selected.category)}/templates/${encodeURIComponent(template.template_id)}`
    setTemplateAction(key)
    setTemplateActionError('')
    try {
      if (action === 'stop' || action === 'resume') await postJSON(`${path}/${action}`, {})
      else await deleteJSON(path)
      setReload((count) => count + 1)
      open(selected.row, selected.category)
    } catch (error: any) {
      const code = String(error?.code || '')
      setTemplateActionError(code === 'template_has_linked_records'
        ? '该模板已有账单、历史或其他关联记录，不能删除；可以改用停用。'
        : code === 'template_link_history_unverifiable'
          ? '现有数据无法证明该模板从未关联过账单，系统已拒绝删除；可以改用停用。'
        : code === 'template_dependency_check_failed'
          ? '无法完整核实模板关联，系统已拒绝删除；可以改用停用。'
          : code === 'template_resume_schedule_unavailable'
            ? '模板缺少可靠的原周期，系统已拒绝恢复；没有补建任何账单。'
            : action === 'stop' ? '模板未能停用，本次没有删除或修改账单。'
              : action === 'resume' ? '模板未能恢复启用，本次没有补建或修改账单。' : '模板未能删除。')
    } finally {
      setTemplateAction('')
    }
  }

  function closeDetail() {
    if (saving || readingHistory || detailLoading) return
    detailRequest.current += 1
    historyRequest.current += 1
    setSelected(null)
  }

  const rows = sortPropertiesByRegionThenCode(directory?.rows || [])
  const bill = selectedBill
  const disabled = saving || readingHistory || detailLoading
  const selectedCategoryTitle = selected ? BILL_COLUMNS.find(([key]) => key === selected.category)?.[1] : null
  const selectedStatus = bill || (selected ? selected.row.bills[selected.category] : null)
  const activeTemplates = selectedTemplates.filter((template) => template.template_status === 'active')
  const templateContext = selected
    ? {property_id: selected.row.id, property_code: propertyLabel(selected.row), category: selected.category, can_edit: Boolean(directory?.can_edit)}
    : null

  function renderOtherBills(row: PropertyRow) {
    const bill = row.bills.other
    const items = bill?.other_items || []
    if (!items.length) {
      return <Button type="text" size="small" onClick={() => open(row, 'other')}
        aria-label={`${propertyLabel(row)} 其他账单 无额外账单`}
        style={{ width: '100%', paddingInline: 2, color: '#8c8c8c' }}>—</Button>
    }
    const first = items[0]
    const remaining = items.slice(1)
    const firstLabel = `${otherBillName(first)} · ${otherBillStatus(first)}`
    const registrationNote = bill?.registration_status && items.some((item) => item.source === 'template')
      ? `类别登记：${statusLabels[bill.registration_status]}（未套用到各模板）`
      : ''
    return <div style={{ height: 32, display: 'flex', alignItems: 'center', gap: 2, minWidth: 0, whiteSpace: 'nowrap' }}>
      <Button type="text" size="small" title={firstLabel} onClick={() => open(row, 'other')}
        aria-label={`${propertyLabel(row)} 其他账单 ${firstLabel}`}
        style={{ minWidth: 0, flex: 1, paddingInline: 2, overflow: 'hidden' }}>
        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{firstLabel}</span>
      </Button>
      {registrationNote ? <Popover trigger="click" placement="bottomRight" content={registrationNote}>
        <Button type="link" size="small" aria-label={`${propertyLabel(row)} 类别登记说明`}
          style={{ flex: 'none', paddingInline: 2 }}>登记</Button>
      </Popover> : null}
      {remaining.length ? <Popover trigger="click" placement="bottomRight" title="其余其他账单"
        content={<div role="list" aria-label={`${propertyLabel(row)} 其余其他账单`} style={{ width: 280, maxWidth: '70vw' }}>
          {remaining.map((item, index) => {
            const label = `${otherBillName(item)} · ${otherBillStatus(item)}`
            return <div role="listitem" key={`${item.source}-${otherBillName(item)}-${index}`}>
              <Button type="text" size="small" block title={label} onClick={() => open(row, 'other')}
                aria-label={`${label} 查看详情`}
                style={{ height: 'auto', minHeight: 32, paddingInline: 4, textAlign: 'left', whiteSpace: 'normal' }}>
                <span>{label}</span>
                <Tag style={{ marginInlineStart: 6, marginInlineEnd: 0 }}>{item.source === 'template' ? '原代付模板' : '类别登记'}</Tag>
              </Button>
            </div>
          })}
        </div>}>
        <Button type="link" size="small" aria-label={`${propertyLabel(row)} 查看其余 ${remaining.length} 项其他账单`}
          style={{ flex: 'none', paddingInline: 2 }}>+{remaining.length}</Button>
      </Popover> : null}
    </div>
  }

  return <section className="property-payables-table-panel" aria-label="房源账单">
    <Space direction="vertical" style={{ width: '100%' }}>
      <Alert type="info" showIcon message="顶部月份、房源与代付状态筛选用于其他代付标签；房源账单始终查询全部有效房源。" />
      <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
        <Input.Search allowClear enterButton="搜索" placeholder="搜索房号或 Account Number" aria-label="搜索房源账单"
          style={{ width: 300, maxWidth: '100%' }} value={query}
          onChange={(event) => { setQuery(event.target.value); if (!event.target.value) search('') }} onSearch={search} />
      </div>
      {loadError && <Alert type="error" showIcon message="房源账单暂时无法加载。" action={<Button onClick={() => setReload((n) => n + 1)}>重试</Button>} />}
      {saveNotice && <Alert type="success" showIcon message="付款方设置已保存，不影响代付模板、支付或历史记录。" />}
      <Table<PropertyRow> rowKey="id" loading={!directory && !loadError} dataSource={rows} scroll={{ x: 1160 }} tableLayout="fixed" pagination={{ pageSize: 20 }}
        onRow={() => ({ style: { height: 56 } })}
        locale={{emptyText: '没有匹配的房源账单'}}
        columns={[
          { title: '房号', key: 'property', width: 120, fixed: 'left', render: (_, row) =>
            <strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{propertyLabel(row)}</strong>
          },
          { title: '登记状态', key: 'registration', width: 130, fixed: 'left', align: 'center', render: (_: unknown, row: PropertyRow) => {
            const registered = Object.keys(row.bills).length
            return <Tag color={registered ? 'blue' : undefined} style={{ marginInlineEnd: 0 }}>{registered ? `已登记 ${registered}/7` : '待登记'}</Tag>
          } },
          ...BILL_COLUMNS.map(([category, title]) => ({ title, key: category, width: category === 'other' ? 186 : 106, align: 'center' as const,
            render: (_: unknown, row: PropertyRow) => {
              if (category === 'other') return renderOtherBills(row)
              const rowBill = row.bills[category]
              return <Button type="text" size="small" onClick={() => open(row, category)}
                style={{ width: '100%', paddingInline: 2 }}
                aria-label={`${propertyLabel(row)} ${title} ${rowBill ? statusLabels[rowBill.status] : '未登记'}`}>
                {rowBill
                  ? <Tag color={billTagColor[rowBill.status]} style={{ marginInlineEnd: 0 }}>{statusLabels[rowBill.status]}</Tag>
                  : <span style={{ color: '#8c8c8c', fontSize: 12 }}>未登记</span>}
              </Button>
            },
          })),
          { title: '操作', key: 'actions', width: 88, align: 'center', render: (_: unknown, row: PropertyRow) =>
            <Button onClick={() => open(row, firstCategory())}>管理</Button>
          },
        ]} />
    </Space>
    <Drawer title="房源账单详情" width={720} open={Boolean(selected)} forceRender
      onClose={closeDetail} closable={!disabled} keyboard={!disabled} maskClosable={!disabled}
      footer={<div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <Button disabled={saving || detailLoading || detailError} loading={readingHistory} onClick={() => void readHistory()}>查看历史记录</Button>
        <Space>
          <Button disabled={disabled} onClick={closeDetail}>取消</Button>
          {directory?.can_edit
            ? <Button type="primary" disabled={disabled || detailError} loading={saving} onClick={() => form.submit()}>保存配置</Button>
            : <Tag style={{ alignSelf: 'center', marginInlineEnd: 0 }}>只读</Tag>}
        </Space>
      </div>}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {selected && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <strong style={{ display: 'block', fontSize: 16 }}>{propertyLabel(selected.row)}</strong>
          </div>
          <Tag color={selectedStatus ? billTagColor[selectedStatus.status] : undefined} style={{ marginInlineEnd: 0 }}>
            {selectedCategoryTitle} · {selectedStatus ? statusLabels[selectedStatus.status] : '未登记'}
          </Tag>
        </div>}
        <div>
          <Divider orientation="left" style={{ marginTop: 0 }}>费用分类</Divider>
          {selected && <div role="tablist" aria-label="费用分类" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(76px, 1fr))', gap: 8 }}>
            {BILL_COLUMNS.map(([category, title]) => <Button key={category} role="tab" aria-selected={selected.category === category} disabled={disabled}
              type={selected.category === category ? 'primary' : 'default'} onClick={() => open(selected.row, category)}>{title}</Button>)}
          </div>}
        </div>
        {saveError && <Alert showIcon type="error" message="配置未保存，请核对权限或稍后重试。本次输入已保留。" />}
        {detailError && <Alert showIcon type="error" message="账单详情暂时无法加载。" />}
        <Spin spinning={detailLoading}>
          <Form<BillConfig> form={form} layout="vertical" onFinish={save} disabled={!directory?.can_edit || disabled || detailError}>
            <Divider orientation="left" style={{ marginTop: 0 }}>账单设置</Divider>
            <Form.Item name="status" label="付款方" rules={[{ required: true, message: '请选择付款方' }]}><Select options={statusOptions} placeholder="请选择" /></Form.Item>
          </Form>
          {status === 'owner' && activeTemplates.length > 0 && <Alert showIcon type="warning"
            message={`仍有 ${activeTemplates.length} 份启用中的代付模板`}
            description="保存“房东自付”只登记付款方，不会暂停、删除或修改这些模板，也不会改变既有账单生成、待付、日历或已付记录。" />}
          {status === 'company' && activeTemplates.length === 0 && <Alert showIcon type="warning"
            message="尚未关联启用中的代付模板"
            description="可以保存“公司代付”付款方，但系统不会自动创建模板。请使用下方原新增模板表单核对。" />}
          {templateActionError && <Alert showIcon type="error" message={templateActionError} />}
          <Divider orientation="left">代付模板</Divider>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {selectedTemplates.length ? selectedTemplates.map((template, index) => <Card key={template.template_id} size="small"
              title={<Space wrap><span>{template.vendor || `代付模板 ${index + 1}`}</span><Tag color={template.template_status === 'active' ? 'green' : 'default'} style={{ marginInlineEnd: 0 }}>
                {template.template_status === 'active' ? '启用中' : '已暂停'}
              </Tag></Space>}
              extra={<Space wrap>
                <Button size="small" onClick={() => templateContext && onViewTemplate?.(template, templateContext)}>详情</Button>
                {directory?.can_edit && <Button size="small" onClick={() => templateContext && onEditTemplate?.(template, templateContext)}>编辑模板</Button>}
                {directory?.can_edit && template.template_status === 'active' && <Popconfirm
                  title="停用这份代付模板？"
                  description="停用只阻止以后生成新账单；已经生成的已付和未付账单都会保留。"
                  okText="确认停用" cancelText="取消"
                  onConfirm={() => runTemplateAction(template, 'stop')}>
                  <Button size="small" loading={templateAction === `stop:${template.template_id}`} disabled={Boolean(templateAction)}>停用</Button>
                </Popconfirm>}
                {directory?.can_edit && template.template_status === 'paused' && <Popconfirm
                  title="恢复启用这份代付模板？"
                  description="恢复后从下一个原定账期继续，不会补建停用期间漏掉的账单；已有账单保持不变。"
                  okText="确认恢复" cancelText="取消"
                  onConfirm={() => runTemplateAction(template, 'resume')}>
                  <Button size="small" loading={templateAction === `resume:${template.template_id}`} disabled={Boolean(templateAction)}>恢复启用</Button>
                </Popconfirm>}
                {directory?.can_edit && <Popconfirm
                  title="删除这份代付模板？"
                  description="只有能可靠证明从未关联任何账单、历史或其他记录的模板才能删除；否则系统会拒绝。"
                  okText="确认删除" cancelText="取消" okButtonProps={{ danger: true }}
                  onConfirm={() => runTemplateAction(template, 'delete')}>
                  <Button size="small" danger loading={templateAction === `delete:${template.template_id}`} disabled={Boolean(templateAction)}>删除</Button>
                </Popconfirm>}
              </Space>}>
              <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }}>
                {selected?.category === 'other' && <Descriptions.Item label="费用名称">{template.other_bill_name || '未命名'}</Descriptions.Item>}
                <Descriptions.Item label="收费公司/事项">{template.vendor || '—'}</Descriptions.Item>
                <Descriptions.Item label="Account Number">{template.account_number || '—'}</Descriptions.Item>
                <Descriptions.Item label="默认金额">{template.amount == null ? '—' : `$${Number(template.amount).toFixed(2)}`}</Descriptions.Item>
                <Descriptions.Item label="账单周期">{propertyPayableFrequencyLabel(template.cycle_months)}</Descriptions.Item>
                <Descriptions.Item label="预计收到账单日">{template.bill_expected_day_of_month ? `账单月 ${template.bill_expected_day_of_month} 号` : '—'}</Descriptions.Item>
                <Descriptions.Item label="付款截止日">{PROPERTY_PAYABLE_SETTLEMENT_DUE_LABEL}</Descriptions.Item>
                <Descriptions.Item label="起始月份">{template.start_month_key || '—'}</Descriptions.Item>
                <Descriptions.Item label="付款方式">{propertyPayablePaymentTypeLabel(template.payment_type || undefined)}</Descriptions.Item>
                <Descriptions.Item label="收款方">{template.pay_account_name || '—'}</Descriptions.Item>
                {template.payment_type === 'bank_account' && <>
                  <Descriptions.Item label="BSB">{template.pay_bsb || '—'}</Descriptions.Item>
                  <Descriptions.Item label="Account No.">{template.pay_account_number || '—'}</Descriptions.Item>
                  <Descriptions.Item label="付款 Reference">{template.pay_ref || '—'}</Descriptions.Item>
                </>}
                {template.payment_type === 'bpay' && <>
                  <Descriptions.Item label="BPAY Code">{template.bpay_code || '—'}</Descriptions.Item>
                  <Descriptions.Item label="付款 Reference">{template.pay_ref || '—'}</Descriptions.Item>
                </>}
                {template.payment_type === 'payid' && <>
                  <Descriptions.Item label="PayID 手机号">{template.pay_mobile_number || '—'}</Descriptions.Item>
                  <Descriptions.Item label="付款 Reference">{template.pay_ref || '—'}</Descriptions.Item>
                </>}
                <Descriptions.Item label="模板备注">{template.note || '—'}</Descriptions.Item>
              </Descriptions>
            </Card>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前房源和费用分类没有代付模板" />}
            <Space wrap>
              {directory?.can_edit && <Button type="primary" onClick={() => templateContext && onCreateTemplate?.(templateContext)}>新增代付模板</Button>}
            </Space>
          </Space>
        </Spin>
        <small>仅显示可核实关联的记录。模板已删除或来源不明确的记录不会在这里显示，原记录不会被修改。</small>
        {history?.error && <Alert type="error" showIcon message="暂时无法读取历史记录。" />}
        {history?.rows && (history.rows.length ? history.rows.map((row, index) => <Descriptions key={row.id || index} bordered size="small" column={1}
          items={[{ key: 'date', label: '日期', children: row.date || '—' }, { key: 'status', label: '状态', children: row.status === 'paid' ? '已付' : row.status || '—' },
            { key: 'amount', label: '金额', children: row.amount == null ? '—' : `$${Number(row.amount).toFixed(2)}` }]} />) : <Empty description="没有可验证的历史记录" />)}
      </Space>
    </Drawer>
  </section>
}
