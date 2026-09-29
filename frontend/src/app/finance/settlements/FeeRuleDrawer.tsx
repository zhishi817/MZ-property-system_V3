"use client"

import { useCallback, useEffect, useState } from 'react'
import { Alert, App, Button, Card, DatePicker, Divider, Drawer, Empty, Form, Input, InputNumber, Select, Space, Spin, Tag, Typography } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { getJSON, postJSON } from '../../../lib/api'
import {
  CLEANING_PROPERTY_TYPES,
  FEE_COMPONENT_LABELS,
  PRICE_BASIS_LABELS,
  centsToDollars,
  cleaningPropertyTypeItems,
  cleaningRuleItemLabel,
  defaultComponentForPersonType,
  dollarsToCents,
  feeRuleCopyTargetEffectiveDate,
  feeRuleEffectiveDateLockMessage,
  feeRuleHistoricalSaveWarning,
  feeRuleItemsValidationError,
  feeRuleSaveErrorMessage,
  isFeeRuleEffectiveDateLocked,
  type CleaningPropertyType,
  type FeeComponentType,
  type FeePriceBasis,
  type FeeRuleEffectiveDateConstraint,
} from './feeRuleUi'

type FeeRuleItem = {
  id: string
  component_type: FeeComponentType
  property_id: string | null
  task_type: string | null
  conditions?: { property_type?: string | null } | null
  priority: number
  rate_cents: number
}

type FeeRule = {
  id: string
  user_id: string
  name: string
  status: 'draft' | 'active' | 'archived'
  effective_from: string
  effective_to: string | null
  price_basis: FeePriceBasis
  currency: 'AUD'
  notes: string | null
  created_at: string
  updated_at: string
  is_current: boolean
  items: FeeRuleItem[]
}

type RuleFormItem = {
  component_type?: FeeComponentType
  property_type?: CleaningPropertyType | null
  rate_dollars?: number
}
type RuleFormValues = {
  name: string
  effective_date: Dayjs
  price_basis: FeePriceBasis
  notes?: string
  items: RuleFormItem[]
}

export default function FeeRuleDrawer(props: {
  open: boolean
  userId: string | null
  personName: string
  personType: string
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  const { message, modal } = App.useApp()
  const [form] = Form.useForm<RuleFormValues>()
  const [history, setHistory] = useState<FeeRule[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [legacyFlatRateCents, setLegacyFlatRateCents] = useState<number | null>(null)
  const [effectiveDateConstraints, setEffectiveDateConstraints] = useState<FeeRuleEffectiveDateConstraint | null>(null)
  const [copiedFromEffectiveDate, setCopiedFromEffectiveDate] = useState<string | null>(null)
  const watchedItems = Form.useWatch('items', form) || []
  const watchedEffectiveDate = Form.useWatch('effective_date', form)

  const setFormFromRule = useCallback((rule?: FeeRule, effectiveDate?: string) => {
    const currentItems = rule?.items || []
    const legacyCleaning = currentItems.find((item) => item.component_type === 'cleaning_task' && !item.conditions?.property_type)
    const cleaningByPropertyType = new Map(
      currentItems
        .filter((item) => item.component_type === 'cleaning_task' && item.conditions?.property_type)
        .map((item) => [String(item.conditions?.property_type), item]),
    )
    const needsCleaningMatrix = props.personType === 'cleaner'
      || currentItems.some((item) => item.component_type === 'cleaning_task')
    const nonCleaningItems = currentItems
      .filter((item) => item.component_type !== 'cleaning_task')
      .map((item) => ({ component_type: item.component_type, rate_dollars: centsToDollars(item.rate_cents) }))
    const formItems: RuleFormItem[] = needsCleaningMatrix
      ? [
          ...CLEANING_PROPERTY_TYPES.map((propertyType) => {
            const configured = cleaningByPropertyType.get(propertyType)
            return {
              component_type: 'cleaning_task' as const,
              property_type: propertyType,
              rate_dollars: configured ? centsToDollars(configured.rate_cents) : undefined,
            }
          }),
          ...nonCleaningItems,
        ]
      : currentItems.length
        ? nonCleaningItems
        : defaultComponentForPersonType(props.personType) === 'cleaning_task'
          ? cleaningPropertyTypeItems({ rate_dollars: undefined })
          : [{ component_type: defaultComponentForPersonType(props.personType), rate_dollars: 0 }]
    setLegacyFlatRateCents(legacyCleaning?.rate_cents ?? null)
    form.setFieldsValue({
      name: rule?.name || `${props.personName} 费用规则`,
      effective_date: dayjs(effectiveDate || rule?.effective_from || undefined),
      price_basis: rule?.price_basis || 'exclusive_gst',
      notes: rule?.notes || '',
      items: formItems,
    })
  }, [form, props.personName, props.personType])

  const resetForm = useCallback((rules: FeeRule[], preferredEffectiveDate?: string) => {
    const current = (preferredEffectiveDate
      ? rules.find((rule) => rule.effective_from === preferredEffectiveDate)
      : null) || rules.find((rule) => rule.is_current) || rules[0]
    setFormFromRule(current)
  }, [setFormFromRule])

  const loadHistory = useCallback(async (preferredEffectiveDate?: string) => {
    if (!props.userId) return
    setLoading(true)
    try {
      const [rules, constraints] = await Promise.all([
        getJSON<FeeRule[]>(`/finance/settlements/profiles/${encodeURIComponent(props.userId)}/rules`, { authSensitive: true }),
        getJSON<FeeRuleEffectiveDateConstraint>(`/finance/settlements/profiles/${encodeURIComponent(props.userId)}/rule-constraints`, { authSensitive: true }),
      ])
      setHistory(rules)
      setEffectiveDateConstraints(constraints)
      resetForm(rules, preferredEffectiveDate)
    } catch (error: any) {
      message.error(String(error?.message || '费用规则加载失败'))
    } finally {
      setLoading(false)
    }
  }, [message, props.userId, resetForm])

  useEffect(() => {
    if (props.open) {
      setCopiedFromEffectiveDate(null)
      void loadHistory()
    }
  }, [loadHistory, props.open])

  async function persistRule(values: RuleFormValues) {
    if (!props.userId) return
    setSaving(true)
    try {
      const saved = await postJSON<FeeRule>(`/finance/settlements/profiles/${encodeURIComponent(props.userId)}/rules`, {
        name: values.name.trim(),
        effective_date: values.effective_date.format('YYYY-MM-DD'),
        price_basis: values.price_basis,
        notes: values.notes?.trim() || null,
        items: values.items.map((item, index) => {
          if (!item.component_type) throw new Error('invalid_rule_component_type')
          return {
            component_type: item.component_type,
            conditions: item.component_type === 'cleaning_task'
              ? { property_type: item.property_type }
              : {},
            rate_cents: dollarsToCents(item.rate_dollars),
            priority: values.items.length - index,
          }
        }),
      }, { authSensitive: true })
      const savedPeriod = saved?.effective_to
        ? `${saved.effective_from} 至 ${saved.effective_to}`
        : `${saved?.effective_from || values.effective_date.format('YYYY-MM-DD')} 起`
      message.success(saved?.is_current
        ? `当前费用规则已保存（${savedPeriod}）`
        : `历史费用规则已保存（${savedPeriod}），当前版本未改变`)
      setCopiedFromEffectiveDate(null)
      await loadHistory(saved?.effective_from || values.effective_date.format('YYYY-MM-DD'))
      await props.onSaved()
    } catch (error: any) {
      if (error?.errorFields) return
      message.error(feeRuleSaveErrorMessage(error, effectiveDateConstraints))
    } finally {
      setSaving(false)
    }
  }

  async function save() {
    if (!props.userId) return
    const values = await form.validateFields()
    const validationError = feeRuleItemsValidationError(values.items)
    if (validationError) {
      message.error(validationError)
      return
    }
    const effectiveDate = values.effective_date.format('YYYY-MM-DD')
    const historicalWarning = feeRuleHistoricalSaveWarning(effectiveDate, history)
    if (historicalWarning) {
      modal.confirm({
        title: '确认保存为历史版本？',
        content: historicalWarning,
        okText: '仍然保存历史版本',
        cancelText: '返回修改',
        onOk: () => persistRule(values),
      })
      return
    }
    await persistRule(values)
  }

  function copyHistoricalRuleToCurrent(rule: FeeRule) {
    const targetDate = feeRuleCopyTargetEffectiveDate(
      history,
      effectiveDateConstraints,
      dayjs().format('YYYY-MM-DD'),
    )
    setFormFromRule(rule, targetDate)
    setCopiedFromEffectiveDate(rule.effective_from)
    message.info(`已复制 ${rule.effective_from} 版本，请核对后保存`)
    requestAnimationFrame(() => form.scrollToField('name', { block: 'start' }))
  }

  return (
    <Drawer
      width={860}
      forceRender
      open={props.open}
      title={`费用规则 · ${props.personName}`}
      onClose={() => { if (!saving) props.onClose() }}
      footer={<div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><Button disabled={saving} onClick={props.onClose}>关闭</Button><Button type="primary" loading={saving} onClick={() => void save()}>保存规则</Button></div>}
    >
      <Alert
        showIcon
        type="info"
        message="每人可配置一个规则版本，版本内可组合多种计算方式。修改生效日期会保留旧版本；同一天再次保存会修正当天版本。"
        description="清洁必须按 6 种房型分别填写单价。未含 GST：已注册 GST 的人员会在单价上另加 10%；已含 GST：系统从总额中拆分 GST。"
        style={{ marginBottom: 16 }}
      />
      {legacyFlatRateCents != null ? (
        <Alert
          showIcon
          type="warning"
          message={`检测到旧统一单价 $${centsToDollars(legacyFlatRateCents).toFixed(2)}`}
          description="旧价格只供参考，未自动复制到房型。请填完六种房型价格后保存新版本；在此之前，新的清洁周结算会将该人员列为待财务处理。"
          style={{ marginBottom: 16 }}
        />
      ) : null}
      {copiedFromEffectiveDate ? (
        <Alert
          showIcon
          type="info"
          message={`已复制 ${copiedFromEffectiveDate} 历史版本`}
          description={`表单已完整带入历史规则，生效日期设为 ${watchedEffectiveDate?.format?.('YYYY-MM-DD') || '-'}；请核对后点击“保存规则”，历史版本本身不会被删除。`}
          style={{ marginBottom: 16 }}
        />
      ) : null}
      <Spin spinning={loading}>
        <Form form={form} layout="vertical">
          <Form.Item label="规则名称" name="name" rules={[{ required: true, whitespace: true, message: '请输入规则名称' }]}><Input maxLength={120} /></Form.Item>
          <Space align="start" size={16} style={{ display: 'flex' }}>
            <Form.Item
              label="费用规则生效日期"
              name="effective_date"
              extra="控制本页计费方式和单价从哪一天开始用于结算。"
              rules={[
                { required: true, message: '请选择费用规则生效日期' },
                {
                  validator: async (_, value: Dayjs | null) => {
                    if (value && isFeeRuleEffectiveDateLocked(value.format('YYYY-MM-DD'), effectiveDateConstraints)) {
                      throw new Error(feeRuleEffectiveDateLockMessage(effectiveDateConstraints))
                    }
                  },
                },
              ]}
              style={{ flex: 1 }}
            ><DatePicker
              format="YYYY-MM-DD"
              disabledDate={(value) => isFeeRuleEffectiveDateLocked(value.format('YYYY-MM-DD'), effectiveDateConstraints)}
              style={{ width: '100%' }}
            /></Form.Item>
            <Form.Item label="单价口径" name="price_basis" rules={[{ required: true, message: '请选择单价口径' }]} style={{ flex: 2 }}><Select options={Object.entries(PRICE_BASIS_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item>
          </Space>
          {effectiveDateConstraints?.locked_through ? (
            <Alert
              showIcon
              type="warning"
              message="历史费用规则已锁定"
              description={feeRuleEffectiveDateLockMessage(effectiveDateConstraints)}
              style={{ marginBottom: 16 }}
            />
          ) : null}
          <Form.List name="items">
            {(fields, { add, remove }) => <>
              <Space align="center" style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }}>
                <Typography.Title level={5} style={{ margin: 0 }}>计算方式与单价</Typography.Title>
                <Space wrap>
                  {CLEANING_PROPERTY_TYPES.some((propertyType) => !watchedItems.some((item: RuleFormItem) => item.component_type === 'cleaning_task' && item.property_type === propertyType)) ? (
                    <Button
                      onClick={() => {
                        const configured = new Set(watchedItems.filter((item: RuleFormItem) => item.component_type === 'cleaning_task').map((item: RuleFormItem) => item.property_type))
                        cleaningPropertyTypeItems({ rate_dollars: undefined })
                          .filter((item) => !configured.has(item.property_type))
                          .forEach((item) => add(item))
                      }}
                    >补齐清洁房型</Button>
                  ) : null}
                  <Button icon={<PlusOutlined />} onClick={() => add({ rate_dollars: undefined })}>增加其他计算方式</Button>
                </Space>
              </Space>
              <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 2fr) minmax(140px, 1fr) minmax(140px, 1fr) 44px', gap: 12, padding: '10px 12px', background: '#fafafa', fontWeight: 600 }}>
                  <span>计算方式</span><span>房型</span><span>单价（AUD）</span><span />
                </div>
                {fields.map((field) => {
                  const componentType = watchedItems[field.name]?.component_type
                  return (
                    <div key={field.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 2fr) minmax(140px, 1fr) minmax(140px, 1fr) 44px', gap: 12, alignItems: 'start', padding: 12, borderTop: '1px solid #f0f0f0' }}>
                      <Form.Item name={[field.name, 'component_type']} rules={[{ required: true, message: '请选择计算方式' }]} style={{ marginBottom: 0 }}>
                        <Select showSearch optionFilterProp="label" options={Object.entries(FEE_COMPONENT_LABELS).map(([value, label]) => ({ value, label }))} />
                      </Form.Item>
                      {componentType === 'cleaning_task' ? (
                        <Form.Item name={[field.name, 'property_type']} rules={[{ required: true, message: '请选择房型' }]} style={{ marginBottom: 0 }}>
                          <Select options={CLEANING_PROPERTY_TYPES.map((propertyType) => ({ value: propertyType, label: propertyType }))} />
                        </Form.Item>
                      ) : <Typography.Text type="secondary" style={{ paddingTop: 5 }}>不适用</Typography.Text>}
                      <Form.Item name={[field.name, 'rate_dollars']} rules={[{ required: true, message: '请输入单价' }]} style={{ marginBottom: 0 }}>
                        <InputNumber min={0} max={1_000_000} precision={2} step={1} style={{ width: '100%' }} />
                      </Form.Item>
                      <Button aria-label="删除计算方式" danger type="text" icon={<DeleteOutlined />} disabled={fields.length === 1} onClick={() => remove(field.name)} />
                    </div>
                  )
                })}
              </div>
            </>}
          </Form.List>
          <Form.Item label="备注（可选）" name="notes"><Input.TextArea maxLength={1000} showCount rows={2} /></Form.Item>
        </Form>

        <Divider orientation="left">规则历史</Divider>
        {history.length ? <Space direction="vertical" size={10} style={{ width: '100%' }}>
          {history.map((rule) => (
            <Card
              key={rule.id}
              size="small"
              title={<Space><span>{rule.name}</span>{rule.is_current ? <Tag color="green">当前生效</Tag> : <Tag>历史版本</Tag>}</Space>}
              extra={!rule.is_current ? (
                <Button type="link" size="small" onClick={() => copyHistoricalRuleToCurrent(rule)}>复制到当前版本</Button>
              ) : null}
            >
              <Space direction="vertical" size={4}>
                <Typography.Text>生效期间：{rule.effective_from} 至 {rule.effective_to || '持续有效'}</Typography.Text>
                <Typography.Text>单价口径：{PRICE_BASIS_LABELS[rule.price_basis]}</Typography.Text>
                {rule.items.map((item) => <Typography.Text key={item.id}>• {item.component_type === 'cleaning_task' ? cleaningRuleItemLabel(item.conditions?.property_type) : FEE_COMPONENT_LABELS[item.component_type]}：${centsToDollars(item.rate_cents).toFixed(2)}</Typography.Text>)}
                {rule.notes ? <Typography.Text type="secondary">备注：{rule.notes}</Typography.Text> : null}
              </Space>
            </Card>
          ))}
        </Space> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未配置费用规则" />}
      </Spin>
    </Drawer>
  )
}
