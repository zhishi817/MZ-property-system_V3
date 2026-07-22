"use client"

import { App, Button, Card, DatePicker, Descriptions, Drawer, Form, Image, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography, Upload } from 'antd'
import type { UploadFile } from 'antd/es/upload/interface'
import { PlusOutlined } from '@ant-design/icons'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { API_BASE, authHeaders, deleteJSON, getJSON, patchJSON, postJSON } from '../../../../../lib/api'
import { sortProperties } from '../../../../../lib/properties'
import { hasPerm } from '../../../../../lib/auth'
import TableRowActions from '../../../../../components/TableRowActions'

type PropertyRow = { id: string; code?: string | null; address?: string | null; region?: string | null }
type DailyItem = { id: string; item_name: string; sku: string; is_active?: boolean }
type DailyItemOption = { value: string; label: string; itemName: string }
type Me = { id: string; username?: string | null; display_name?: string | null }

type ReplacementRow = {
  id: string
  property_id?: string | null
  property_code?: string | null
  property_address?: string | null
  status?: string | null
  item_id?: string | null
  item_name?: string | null
  quantity?: number | null
  note?: string | null
  invoice_description_en?: string | null
  photo_urls?: string[] | null
  before_photo_urls?: string[] | null
  after_photo_urls?: string[] | null
  submitter_name?: string | null
  submitted_at?: string | null
  replacement_at?: string | null
  replacer_name?: string | null
  pay_method?: string | null
  created_at?: string | null
  updated_at?: string | null
}

function urlsToFiles(urls: string[]) {
  return (urls || []).filter(Boolean).map((url, idx) => ({
    uid: `${idx}-${url}`,
    name: url.split('/').pop() || `photo-${idx + 1}`,
    status: 'done' as const,
    url,
  }))
}

function cleanText(value: any) {
  return String(value || '').trim()
}

function optionalText(value: any) {
  const text = cleanText(value)
  return text || undefined
}

function replacementSubmitErrorMessage(error: any) {
  const msg = String(error?.message || '').trim()
  if (msg && msg !== 'HTTP 400') return msg
  const fieldLabels: Record<string, string> = {
    property_id: '房号',
    occurred_at: '日期',
    item_id: '更换物品',
    item_name: '更换物品',
    quantity: '数量',
    replacement_at: '更换日期',
    replacer_name: '更换人',
    pay_method: '扣款方式',
    status: '状态',
  }
  for (const [field, label] of Object.entries(fieldLabels)) {
    const errors = Array.isArray(error?.[field]?._errors) ? error[field]._errors : []
    if (errors.length) return `${label}：${errors[0]}`
  }
  return '保存失败：请检查房号、日期、更换物品、数量和状态'
}

export default function DailyReplacementsPage() {
  const { message } = App.useApp()
  const [properties, setProperties] = useState<PropertyRow[]>([])
  const [items, setItems] = useState<DailyItem[]>([])
  const [me, setMe] = useState<Me | null>(null)
  const [rows, setRows] = useState<ReplacementRow[]>([])
  const [propertyId, setPropertyId] = useState<string>('')
  const [status, setStatus] = useState<string>('need_replace,replaced,no_action')
  const [payMethod, setPayMethod] = useState<string>('')
  const [range, setRange] = useState<[any, any] | null>(null)
  const [q, setQ] = useState<string>('')
  const [detailOpen, setDetailOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<ReplacementRow | null>(null)
  const [viewing, setViewing] = useState<ReplacementRow | null>(null)
  const [beforeFiles, setBeforeFiles] = useState<UploadFile[]>([])
  const [afterFiles, setAfterFiles] = useState<UploadFile[]>([])
  const [beforeUrls, setBeforeUrls] = useState<string[]>([])
  const [afterUrls, setAfterUrls] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm()
  const canWrite = hasPerm('inventory_daily_replacements.write') || hasPerm('inventory.move')
  const canDelete = hasPerm('inventory_daily_replacements.delete')

  async function loadBase() {
    const [ps, dailyItems, meRow] = await Promise.all([
      getJSON<PropertyRow[]>('/properties'),
      getJSON<DailyItem[]>('/inventory/daily-items-prices'),
      getJSON<Me>('/me').catch(() => null),
    ])
    const normalizedProperties = (Array.isArray(ps) ? ps : []).map((row) => ({
      id: String(row.id),
      code: row.code || undefined,
      address: row.address || undefined,
      region: row.region || undefined,
    }))
    setProperties(sortProperties(normalizedProperties))
    setItems((dailyItems || []).filter((row) => row.is_active !== false))
    setMe(meRow || null)
  }

  async function load() {
    const params: Record<string, string> = { limit: '200' }
    if (propertyId) params.property_id = propertyId
    if (status) params.status = status
    if (payMethod) params.pay_method = payMethod
    if (range?.[0]) params.from = dayjs(range[0]).toISOString()
    if (range?.[1]) params.to = dayjs(range[1]).toISOString()
    const data = await getJSON<ReplacementRow[]>(`/inventory/daily-replacements?${new URLSearchParams(params as any).toString()}`)
    const filtered = q
      ? (data || []).filter((r) => `${r.property_code || ''} ${r.item_name || ''} ${r.note || ''} ${r.submitter_name || ''} ${r.replacer_name || ''}`.toLowerCase().includes(q.toLowerCase()))
      : (data || [])
    setRows(filtered)
  }

  useEffect(() => {
    loadBase().then(() => load()).catch((e) => message.error(e?.message || '加载失败'))
  }, [])

  const propOptions = useMemo(
    () => [{ value: '', label: '全部房号' }, ...(properties || []).map((p) => ({ value: p.id, label: p.code || p.id }))],
    [properties],
  )
  const itemOptions = useMemo(
    () => (items || []).map((item) => ({ value: item.id, label: `${item.item_name} (${item.sku})`, itemName: item.item_name })),
    [items],
  )
  const editorItemOptions = useMemo(() => {
    const base = itemOptions as DailyItemOption[]
    if (!editing?.item_name) return base
    const itemId = String(editing.item_id || '').trim()
    const itemName = String(editing.item_name || '').trim()
    const matched = base.some((item) => String(item.value) === itemId || item.itemName.trim().toLowerCase() === itemName.toLowerCase())
    if (matched) return base
    return [
      { value: `legacy:${editing.id}`, label: `${itemName}（当前记录）`, itemName },
      ...base,
    ]
  }, [editing, itemOptions])

  const statusOptions = [
    { value: 'need_replace,replaced,no_action', label: '全部状态' },
    { value: 'need_replace', label: '待更换' },
    { value: 'replaced', label: '待审核' },
    { value: 'no_action', label: '无需更换' },
  ]
  const payMethodOptions = [
    { value: '', label: '全部扣款方式' },
    { value: 'rent_deduction', label: '租金扣除' },
    { value: 'tenant_pay', label: '房客支付' },
    { value: 'company_pay', label: '公司承担' },
    { value: 'landlord_pay', label: '房东支付' },
    { value: 'other_pay', label: '其他人支付' },
  ]

  const statusTag = (value: any) => {
    const s = String(value || '').trim()
    if (s === 'need_replace') return <Tag color="orange">待更换</Tag>
    if (s === 'replaced') return <Tag color="purple">待审核</Tag>
    if (s === 'no_action') return <Tag>无需更换</Tag>
    return <Tag>{s || '-'}</Tag>
  }
  const payMethodLabel = (value: any) => {
    const s = String(value || '').trim()
    if (!s) return '-'
    if (s === 'rent_deduction') return '租金扣除'
    if (s === 'tenant_pay') return '房客支付'
    if (s === 'company_pay') return '公司承担'
    if (s === 'landlord_pay') return '房东支付'
    if (s === 'other_pay') return '其他人支付'
    return s
  }
  function itemValueForRow(row: ReplacementRow) {
    const itemId = String(row.item_id || '').trim()
    const itemName = String(row.item_name || '').trim()
    const matched = (itemOptions as DailyItemOption[]).find((item) => (
      (itemId && String(item.value) === itemId) ||
      (!!itemName && item.itemName.trim().toLowerCase() === itemName.toLowerCase())
    ))
    if (matched) return matched.value
    return itemName ? `legacy:${row.id}` : undefined
  }

  function resetEditor() {
    setEditing(null)
    setBeforeFiles([])
    setAfterFiles([])
    setBeforeUrls([])
    setAfterUrls([])
    form.resetFields()
    form.setFieldsValue({
      property_id: undefined,
      occurred_at: dayjs(),
      item_id: undefined,
      quantity: 1,
      note: '',
      invoice_description_en: '',
      submitter_name: me?.display_name || me?.username || '',
      status: 'need_replace',
      replacement_at: dayjs(),
      replacer_name: '',
      pay_method: undefined,
    })
  }

  function openCreate() {
    resetEditor()
    setEditorOpen(true)
  }

  function openEdit(row: ReplacementRow) {
    setEditing(row)
    const before = Array.isArray(row.before_photo_urls) ? row.before_photo_urls.filter(Boolean) : Array.isArray(row.photo_urls) ? row.photo_urls.filter(Boolean) : []
    const after = Array.isArray(row.after_photo_urls) ? row.after_photo_urls.filter(Boolean) : []
    setBeforeUrls(before)
    setAfterUrls(after)
    setBeforeFiles(urlsToFiles(before))
    setAfterFiles(urlsToFiles(after))
    form.setFieldsValue({
      property_id: row.property_id || undefined,
      occurred_at: row.submitted_at ? dayjs(row.submitted_at) : (row.created_at ? dayjs(row.created_at) : dayjs()),
      item_id: itemValueForRow(row),
      quantity: Number(row.quantity || 1),
      note: row.note || '',
      invoice_description_en: row.invoice_description_en || '',
      submitter_name: row.submitter_name || me?.display_name || me?.username || '',
      status: row.status || 'need_replace',
      replacement_at: row.replacement_at ? dayjs(row.replacement_at) : null,
      replacer_name: row.replacer_name || '',
      pay_method: row.pay_method || undefined,
    })
    setEditorOpen(true)
  }

  function openDetail(row: ReplacementRow) {
    setViewing(row)
    setDetailOpen(true)
  }

  function openEditFromDetail(row: ReplacementRow) {
    setDetailOpen(false)
    openEdit(row)
  }

  async function upload(file: File) {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`${API_BASE}/inventory/upload`, { method: 'POST', headers: authHeaders(), body: fd })
    const j = await res.json().catch(() => null)
    if (!res.ok) throw new Error(j?.message || `HTTP ${res.status}`)
    const url = String(j?.url || '')
    if (!url) throw new Error('upload failed')
    return url
  }

  function makeUploadProps(kind: 'before' | 'after') {
    const fileList = kind === 'before' ? beforeFiles : afterFiles
    const setFileList = kind === 'before' ? setBeforeFiles : setAfterFiles
    const setUrlList = kind === 'before' ? setBeforeUrls : setAfterUrls
    return {
      multiple: true,
      listType: 'picture-card' as const,
      fileList,
      onChange: ({ fileList: fl }: any) => setFileList(fl as UploadFile[]),
      onRemove: (file: any) => {
        setFileList((current) => current.filter((item) => item.uid !== file.uid))
        if (file.url) setUrlList((current) => current.filter((url) => url !== file.url))
      },
      customRequest: async ({ file, onSuccess, onError }: any) => {
        try {
          const url = await upload(file as File)
          setUrlList((current) => Array.from(new Set([...current, url])))
          onSuccess?.({ url }, file)
        } catch (e: any) {
          onError?.(e)
        }
      },
    }
  }

  async function submit() {
    setSubmitting(true)
    try {
      const values = await form.validateFields()
      const selectedItem = editorItemOptions.find((item) => String(item.value) === String(values.item_id || ''))
      const itemValue = cleanText(values.item_id)
      const legacyItem = itemValue.startsWith('legacy:')
      const nextStatus = cleanText(values.status)
      const payload: any = {
        property_id: cleanText(values.property_id),
        occurred_at: dayjs(values.occurred_at).toISOString(),
        item_name: cleanText(selectedItem?.itemName || editing?.item_name),
        quantity: Number(values.quantity || 1),
        note: optionalText(values.note),
        invoice_description_en: optionalText(values.invoice_description_en),
        before_photo_urls: beforeUrls.filter(Boolean),
        status: nextStatus,
      }
      const nextItemId = legacyItem ? '' : itemValue
      if (nextItemId) payload.item_id = nextItemId

      if (nextStatus === 'replaced') {
        payload.replacement_at = values.replacement_at ? dayjs(values.replacement_at).toISOString() : null
        payload.replacer_name = optionalText(values.replacer_name)
        payload.pay_method = optionalText(values.pay_method)
        payload.after_photo_urls = afterUrls.filter(Boolean)
      } else {
        const hadReplacementData = !!(
          editing?.replacement_at ||
          editing?.replacer_name ||
          editing?.pay_method ||
          (Array.isArray(editing?.after_photo_urls) && editing.after_photo_urls.length)
        )
        if (hadReplacementData || cleanText(editing?.status) === 'replaced') {
          payload.replacement_at = null
          payload.replacer_name = null
          payload.pay_method = null
          payload.after_photo_urls = []
        }
      }

      if (!editing) {
        await postJSON('/inventory/daily-replacements', payload)
        message.success(values.status === 'replaced' ? '待审核记录已提交' : values.status === 'no_action' ? '无需更换记录已提交' : '待更换记录已提交')
      } else {
        await patchJSON(`/inventory/daily-replacements/${editing.id}`, payload)
        message.success(values.status === 'replaced' ? '已更新为待审核记录' : '更换记录已更新')
      }
      setEditorOpen(false)
      resetEditor()
      await load()
    } catch (e: any) {
      message.error(replacementSubmitErrorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  function confirmDelete(row: ReplacementRow) {
    Modal.confirm({
      title: '确认删除这条日用品更换记录？',
      content: '删除后，该记录关联的自动支出快照会被作废。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await deleteJSON(`/inventory/daily-replacements/${encodeURIComponent(String(row.id))}`)
        message.success('已删除')
        if (viewing?.id === row.id) {
          setDetailOpen(false)
          setViewing(null)
        }
        await load()
      },
    })
  }

  const columns: any[] = [
    { title: '日期', dataIndex: 'submitted_at', width: 120, render: (_: any, r: ReplacementRow) => dayjs(r.submitted_at || r.created_at).format('YYYY-MM-DD') },
    { title: '房号', dataIndex: 'property_code', width: 120, render: (value: string) => value || '-' },
    { title: '状态', dataIndex: 'status', width: 100, render: statusTag },
    { title: '更换物品', dataIndex: 'item_name', width: 180, render: (value: string) => value || '-' },
    { title: '数量', dataIndex: 'quantity', width: 80, render: (value: any) => (value == null ? '-' : value) },
    { title: '扣款方式', dataIndex: 'pay_method', width: 140, render: payMethodLabel },
    { title: '提交人', dataIndex: 'submitter_name', width: 120, render: (value: string) => value || '-' },
    { title: '更换人', dataIndex: 'replacer_name', width: 120, render: (value: string) => value || '-' },
    {
      title: '照片',
      width: 160,
      render: (_: any, r: ReplacementRow) => {
        const beforeCount = Array.isArray(r.before_photo_urls) ? r.before_photo_urls.length : Array.isArray(r.photo_urls) ? r.photo_urls.length : 0
        const afterCount = Array.isArray(r.after_photo_urls) ? r.after_photo_urls.length : 0
        return <span>前 {beforeCount} / 后 {afterCount}</span>
      },
    },
    { title: '备注', dataIndex: 'note', render: (value: string) => value || '-' },
    {
      title: '操作',
      width: 260,
      fixed: 'right',
      render: (_: any, r: ReplacementRow) => (
        <TableRowActions
          actions={[
            { key: 'detail', label: '详情', onClick: () => openDetail(r) },
            { key: 'edit', label: String(r.status || '') === 'need_replace' ? '去更换' : '编辑', onClick: () => openEdit(r), hidden: !canWrite },
            { key: 'delete', label: '删除', onClick: () => confirmDelete(r), danger: true, hidden: !canDelete },
          ]}
        />
      ),
    },
  ]

  return (
    <>
      <Card
        title="日用品更换记录"
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增更换记录</Button>}
      >
        <Space wrap style={{ marginBottom: 12 }}>
          <Select
            value={propertyId}
            options={propOptions}
            onChange={setPropertyId}
            style={{ minWidth: 220 }}
            showSearch
            optionFilterProp="label"
            placeholder="按房号筛选"
          />
          <Select value={status} options={statusOptions} onChange={setStatus} style={{ width: 180 }} />
          <Select value={payMethod} options={payMethodOptions} onChange={setPayMethod} style={{ width: 180 }} />
          <DatePicker.RangePicker value={range as any} onChange={(v) => setRange(v as any)} allowClear />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="关键字筛选" style={{ width: 180 }} allowClear />
          <Button type="primary" onClick={() => load().catch((e) => message.error(e?.message || '加载失败'))}>查询</Button>
        </Space>
        <Table rowKey={(r) => r.id} columns={columns} dataSource={rows} pagination={{ pageSize: 20 }} />
      </Card>

      <Drawer
        title={editing ? '编辑更换记录' : '新增更换记录'}
        placement="right"
        width={780}
        open={editorOpen}
        onClose={() => { setEditorOpen(false); resetEditor() }}
        extra={
          <Space>
            <Button onClick={() => { setEditorOpen(false); resetEditor() }}>取消</Button>
            <Button type="primary" loading={submitting} onClick={() => submit().catch(() => {})}>
              {editing ? '保存' : '提交记录'}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(220px, 1fr))', gap: 16 }}>
            <Form.Item name="property_id" label="房号" rules={[{ required: true, message: '请选择房号' }]}>
              <Select
                options={(properties || []).map((p) => ({ value: p.id, label: p.code || p.id }))}
                showSearch
                optionFilterProp="label"
                placeholder="请选择房号"
              />
            </Form.Item>
            <Form.Item name="occurred_at" label="日期" rules={[{ required: true, message: '请选择日期' }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="item_id" label="更换物品" rules={[{ required: true, message: '请选择更换物品' }]}>
              <Select options={editorItemOptions} showSearch optionFilterProp="label" placeholder="请选择日用品" />
            </Form.Item>
            <Form.Item name="quantity" label="数量" rules={[{ required: true, message: '请输入数量' }]}>
              <InputNumber min={1} precision={0} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="submitter_name" label="提交人">
              <Input disabled />
            </Form.Item>
            <Form.Item name="status" label="状态" rules={[{ required: true, message: '请选择状态' }]}>
              <Select
                options={[
                  { value: 'need_replace', label: '待更换' },
                  { value: 'replaced', label: '待审核' },
                  { value: 'no_action', label: '无需更换' },
                ]}
              />
            </Form.Item>
          </div>

          <Form.Item name="note" label="备注">
            <Input.TextArea rows={3} placeholder="可选" />
          </Form.Item>
          <Form.Item name="invoice_description_en" label="开票英文描述">
            <Input.TextArea rows={3} placeholder="Optional English description for invoices" />
          </Form.Item>

          <div style={{ marginBottom: 8, fontWeight: 600 }}>更换前照片</div>
          <Upload {...makeUploadProps('before')}>
            <div>上传</div>
          </Upload>

          <Form.Item shouldUpdate noStyle>
            {({ getFieldValue }) => getFieldValue('status') === 'replaced' ? (
              <div style={{ marginTop: 24 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(220px, 1fr))', gap: 16 }}>
                  <Form.Item name="replacement_at" label="更换日期" rules={[{ required: true, message: '请选择更换日期' }]}>
                    <DatePicker style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name="replacer_name" label="更换人" rules={[{ required: true, message: '请输入更换人' }]}>
                    <Input placeholder="请输入更换人" />
                  </Form.Item>
                  <Form.Item name="pay_method" label="扣款方式" rules={[{ required: true, message: '请选择扣款方式' }]}>
                    <Select options={payMethodOptions.filter((item) => item.value)} placeholder="请选择扣款方式" />
                  </Form.Item>
                </div>
                <div style={{ marginBottom: 8, fontWeight: 600 }}>更换后照片</div>
                <Upload {...makeUploadProps('after')}>
                  <div>上传</div>
                </Upload>
              </div>
            ) : null}
          </Form.Item>
        </Form>
      </Drawer>

      <Drawer
        title="更换记录详情"
        placement="right"
        width={760}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        extra={viewing && canWrite ? <Button type="primary" onClick={() => openEditFromDetail(viewing)}>编辑</Button> : null}
      >
        {viewing ? (
          <div style={{ display: 'grid', gap: 16 }}>
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label="房号">{viewing.property_code || '-'}</Descriptions.Item>
              <Descriptions.Item label="日期">{dayjs(viewing.submitted_at || viewing.created_at).format('YYYY-MM-DD')}</Descriptions.Item>
              <Descriptions.Item label="状态">{statusTag(viewing.status)}</Descriptions.Item>
              <Descriptions.Item label="更换物品">{viewing.item_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="数量">{viewing.quantity ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="扣款方式">{payMethodLabel(viewing.pay_method)}</Descriptions.Item>
              <Descriptions.Item label="提交人">{viewing.submitter_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="更换人">{viewing.replacer_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="更换日期">{viewing.replacement_at ? dayjs(viewing.replacement_at).format('YYYY-MM-DD') : '-'}</Descriptions.Item>
              <Descriptions.Item label="备注">{viewing.note || '-'}</Descriptions.Item>
              <Descriptions.Item label="开票英文描述">{viewing.invoice_description_en || '-'}</Descriptions.Item>
            </Descriptions>

            <div>
              <Typography.Title level={5}>更换前照片</Typography.Title>
              {(Array.isArray(viewing.before_photo_urls) ? viewing.before_photo_urls : Array.isArray(viewing.photo_urls) ? viewing.photo_urls : []).length ? (
                <Image.PreviewGroup>
                  <Space wrap>
                    {(Array.isArray(viewing.before_photo_urls) ? viewing.before_photo_urls : Array.isArray(viewing.photo_urls) ? viewing.photo_urls : []).map((url) => (
                      <Image key={url} src={url} width={180} alt="before" />
                    ))}
                  </Space>
                </Image.PreviewGroup>
              ) : (
                <Typography.Text type="secondary">暂无照片</Typography.Text>
              )}
            </div>

            <div>
              <Typography.Title level={5}>更换后照片</Typography.Title>
              {(Array.isArray(viewing.after_photo_urls) ? viewing.after_photo_urls : []).length ? (
                <Image.PreviewGroup>
                  <Space wrap>
                    {(viewing.after_photo_urls || []).map((url) => (
                      <Image key={url} src={url} width={180} alt="after" />
                    ))}
                  </Space>
                </Image.PreviewGroup>
              ) : (
                <Typography.Text type="secondary">暂无照片</Typography.Text>
              )}
            </div>
          </div>
        ) : null}
      </Drawer>
    </>
  )
}
