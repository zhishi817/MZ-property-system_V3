"use client"

import { CopyOutlined, PlusOutlined } from '@ant-design/icons'
import { App, Button, Card, DatePicker, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography } from 'antd'
import dayjs from 'dayjs'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TableRowActions from '../../../components/TableRowActions'
import { deleteJSON, getJSON, patchJSON, postJSON } from '../../../lib/api'

type OfflinePasswordRow = {
  id: string
  title: string
  property_code?: string | null
  property_codes?: string[] | null
  property_ids?: string[] | null
  secret_kind?: string | null
  box_number?: string | null
  location?: string | null
  rotation_interval_days?: number | null
  next_rotation_at?: string | null
  secret?: string | null
  note?: string | null
  status?: 'active' | 'inactive' | null
  updated_at?: string | null
}

type PropertyRow = {
  id: string
  code?: string | null
  address?: string | null
  archived?: boolean | null
}

const PASSWORD_KIND_OPTIONS = [
  { value: 'office', label: '办公室密码' },
  { value: 'mailbox', label: '信箱密码' },
  { value: 'door_lock', label: '房门电子锁' },
  { value: 'mailbox_lockbox', label: '信箱内密码盒' },
  { value: 'garage_lockbox', label: '车库密码盒' },
  { value: 'mailbox_key_lockbox', label: '存放信箱钥匙的密码盒' },
  { value: 'locker', label: 'Locker' },
  { value: 'backup_key', label: '备用钥匙密码盒' },
  { value: 'company_rotating', label: '固定周期公司密码' },
  { value: 'other', label: '其他' },
]

const PASSWORD_KIND_LABELS: Record<string, string> = {
  ...Object.fromEntries(PASSWORD_KIND_OPTIONS.map((item) => [item.value, item.label])),
  password_box: '密码盒（历史类型）',
}

const PROPERTY_LINKED_KINDS = new Set(['mailbox', 'backup_key', 'door_lock', 'mailbox_lockbox', 'garage_lockbox', 'mailbox_key_lockbox', 'locker'])
const NUMBERED_BOX_KINDS = new Set(['backup_key', 'mailbox_lockbox', 'garage_lockbox', 'mailbox_key_lockbox'])

export default function Page() {
  const { message } = App.useApp()
  const [mounted, setMounted] = useState(false)
  const [rows, setRows] = useState<OfflinePasswordRow[]>([])
  const [properties, setProperties] = useState<PropertyRow[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<OfflinePasswordRow | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [form] = Form.useForm()
  const secretKind = Form.useWatch('secret_kind', form)
  const propertyLinked = PROPERTY_LINKED_KINDS.has(secretKind)
  const numberedBox = NUMBERED_BOX_KINDS.has(secretKind)

  const propertyById = useMemo(() => new Map(properties.map((property) => [String(property.id), property])), [properties])
  const propertyIdByCode = useMemo(() => new Map(properties
    .map((property) => [String(property.code || '').trim(), String(property.id)] as const)
    .filter(([code]) => Boolean(code))), [properties])
  const propertyOptions = useMemo(() => properties
    .slice()
    .sort((a, b) => String(a.code || a.id).localeCompare(String(b.code || b.id), 'zh-CN'))
    .map((property) => {
      const code = String(property.code || property.id)
      return {
        value: String(property.id),
        label: `${code}${property.archived ? '（已归档）' : ''}`,
      }
    }), [properties])
  const filteredRows = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return rows
    return rows.filter((row) => {
      const propertyTexts = [
        row.property_code,
        ...(row.property_codes || []),
        ...(row.property_ids || []).flatMap((propertyId) => {
          const property = propertyById.get(String(propertyId))
          return [propertyId, property?.code, property?.address]
        }),
      ]
      return [
        row.title,
        row.secret_kind,
        PASSWORD_KIND_LABELS[String(row.secret_kind || '')],
        row.box_number,
        row.location,
        row.note,
        ...propertyTexts,
      ].some((value) => String(value || '').toLowerCase().includes(keyword))
    })
  }, [propertyById, query, rows])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ include_secret: '1' })
      const data = await getJSON<OfflinePasswordRow[]>(`/cms/company/secrets?${params.toString()}`)
      setRows(Array.isArray(data) ? data : [])
    } catch (error: any) {
      message.error(String(error?.message || '加载失败'))
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [message])

  const loadProperties = useCallback(async () => {
    try {
      const data = await getJSON<PropertyRow[]>('/properties?include_archived=true')
      setProperties(Array.isArray(data) ? data : [])
    } catch (error: any) {
      message.error(String(error?.message || '房源档案加载失败'))
      setProperties([])
    }
  }, [message])

  useEffect(() => { setMounted(true) }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => { loadProperties() }, [loadProperties])
  useEffect(() => {
    if (!open) return
    if (!editing) {
      form.setFieldsValue({ secret_kind: 'backup_key', status: 'active', property_ids: [] })
      return
    }
    const legacyPropertyCodes = Array.from(new Set([
      ...(editing.property_codes || []),
      editing.property_code || '',
    ].map((code) => String(code).trim()).filter(Boolean)))
    const linkedPropertyIds = editing.property_ids?.length
      ? editing.property_ids
      : legacyPropertyCodes.map((code) => propertyIdByCode.get(code)).filter((id): id is string => Boolean(id))
    form.setFieldsValue({
      title: editing.title,
      property_ids: linkedPropertyIds,
      secret_kind: editing.secret_kind || 'other',
      box_number: editing.box_number || '',
      location: editing.location || '',
      rotation_interval_days: editing.rotation_interval_days || undefined,
      next_rotation_at: editing.next_rotation_at ? dayjs(editing.next_rotation_at) : null,
      secret: editing.secret || '',
      note: editing.note || '',
      status: editing.status || 'active',
    })
  }, [editing, form, open, propertyIdByCode])

  function openCreate() {
    setEditing(null)
    form.resetFields()
    setOpen(true)
  }

  function openEdit(row: OfflinePasswordRow) {
    setEditing(row)
    form.resetFields()
    setOpen(true)
  }

  function closeEditor() {
    if (savingRef.current) return
    setOpen(false)
    setEditing(null)
    form.resetFields()
  }

  async function submit() {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)

    try {
      const values = await form.validateFields()
      const selectedPropertyIds = propertyLinked ? (values.property_ids || []).map(String) : []
      const selectedPropertyCodes = selectedPropertyIds.map((id: string) => String(propertyById.get(id)?.code || id))
      const boxNumber = numberedBox ? String(values.box_number || '').trim() : ''
      const enteredTitle = String(values.title || '').trim()
      const generatedTitle = propertyLinked
        ? `${selectedPropertyCodes.join('/')} ${PASSWORD_KIND_LABELS[values.secret_kind] || '线下密码'}${boxNumber ? ` ${boxNumber}` : ''}`
        : PASSWORD_KIND_LABELS[values.secret_kind] || '线下密码'
      const payload: any = {
        title: enteredTitle || generatedTitle,
        property_code: '',
        property_ids: selectedPropertyIds,
        secret_kind: values.secret_kind,
        box_number: boxNumber,
        location: String(values.location || '').trim(),
        note: String(values.note || '').trim(),
        status: values.status,
      }
      if (values.secret_kind === 'company_rotating') {
        payload.rotation_interval_days = Number(values.rotation_interval_days)
        payload.next_rotation_at = values.next_rotation_at ? values.next_rotation_at.format('YYYY-MM-DD') : null
      } else if (editing) {
        payload.rotation_interval_days = null
        payload.next_rotation_at = null
      }
      if (!editing || values.secret) payload.secret = String(values.secret || '')

      if (editing) {
        await patchJSON(`/cms/company/secrets/${encodeURIComponent(editing.id)}`, payload)
        message.success('线下密码已更新')
      } else {
        await postJSON('/cms/company/secrets', payload)
        message.success('线下密码已新增')
      }
      setOpen(false)
      setEditing(null)
      form.resetFields()
      await load()
    } catch (error: any) {
      if (Array.isArray(error?.errorFields)) return
      message.error(String(error?.message || '保存失败'))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  function remove(row: OfflinePasswordRow) {
    Modal.confirm({
      title: `确认删除“${row.title}”？`,
      content: '删除后无法在系统内恢复。',
      okType: 'danger',
      onOk: async () => {
        try {
          await deleteJSON(`/cms/company/secrets/${encodeURIComponent(row.id)}`)
          message.success('已删除')
          await load()
        } catch (error: any) {
          message.error(String(error?.message || '删除失败'))
        }
      },
    })
  }

  async function copyPassword(row: OfflinePasswordRow) {
    const value = String(row.secret || '')
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      await postJSON(`/cms/company/secrets/${encodeURIComponent(row.id)}/log-copy`, {})
      message.success('密码已复制')
    } catch {
      message.error('复制失败，请手动复制')
    }
  }

  function renderLinkedProperties(row: OfflinePasswordRow) {
    const propertyIds = Array.isArray(row.property_ids) ? row.property_ids : []
    if (propertyIds.length) {
      return (
        <Space size={[4, 4]} wrap>
          {propertyIds.map((propertyId, index) => {
            const property = propertyById.get(String(propertyId))
            const code = property?.code || row.property_codes?.[index] || propertyId
            return <Tag key={propertyId}>{code}</Tag>
          })}
        </Space>
      )
    }
    return Array.isArray(row.property_codes) && row.property_codes.length
      ? <Space size={[4, 4]} wrap>{row.property_codes.map((code) => <Tag key={code}>{code}（待关联）</Tag>)}</Space>
      : '-'
  }

  const columns = [
    { title: '名称', dataIndex: 'title', width: 190 },
    { title: '类型', dataIndex: 'secret_kind', width: 170, render: (value: any) => PASSWORD_KIND_LABELS[String(value || '')] || '其他' },
    { title: '关联房源', width: 260, render: (_: any, row: OfflinePasswordRow) => renderLinkedProperties(row) },
    { title: '密码盒编号', dataIndex: 'box_number', width: 130, render: (value: any) => value || '-' },
    { title: '位置', dataIndex: 'location', width: 180, render: (value: any) => value || '-' },
    {
      title: '修改周期',
      width: 170,
      render: (_: any, row: OfflinePasswordRow) => row.secret_kind === 'company_rotating'
        ? <span>{row.rotation_interval_days ? `${row.rotation_interval_days} 天` : '-'}{row.next_rotation_at ? `；下次 ${row.next_rotation_at}` : ''}</span>
        : '-',
    },
    {
      title: '密码',
      dataIndex: 'secret',
      width: 180,
      render: (value: any, row: OfflinePasswordRow) => (
        <Space>
          <Typography.Text copyable={false}>{value || '-'}</Typography.Text>
          <Button size="small" icon={<CopyOutlined />} disabled={!value} onClick={() => copyPassword(row)}>复制</Button>
        </Space>
      ),
    },
    { title: '备注', dataIndex: 'note', width: 220, render: (value: any) => value || '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: any) => value === 'inactive' ? <Tag>停用</Tag> : <Tag color="green">启用</Tag>,
    },
    { title: '更新时间', dataIndex: 'updated_at', width: 190, render: (value: any) => value ? new Date(value).toLocaleString() : '-' },
    {
      title: '操作',
      width: 170,
      fixed: 'right' as const,
      render: (_: any, row: OfflinePasswordRow) => (
        <div onClick={(event) => event.stopPropagation()}>
          <TableRowActions
            actions={[
              { key: 'edit', label: '编辑', onClick: () => openEdit(row) },
              { key: 'delete', label: '删除', danger: true, onClick: () => remove(row) },
            ]}
          />
        </div>
      ),
    },
  ]

  if (!mounted) return null

  return (
    <Card>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <div>
          <Typography.Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>线下密码管理</Typography.Title>
          <Typography.Text type="secondary">房源类密码直接关联房源档案；密码在页面明文显示，数据库仍加密保存。</Typography.Text>
        </div>

        <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
          <Input
            type="search"
            name="offline-password-record-search"
            autoComplete="off"
            allowClear
            value={query}
            placeholder="输入后自动搜索房号、地址、密码盒编号、类型、位置或备注"
            onChange={(event) => setQuery(event.target.value)}
            style={{ width: 640, maxWidth: '100%' }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增线下密码</Button>
        </Space>

        <Table
          rowKey="id"
          loading={loading}
          dataSource={filteredRows}
          columns={columns as any}
          pagination={{ pageSize: 20, showSizeChanger: true }}
          scroll={{ x: 1960 }}
        />
      </Space>

      <Modal
        open={open}
        title={editing ? '编辑线下密码' : '新增线下密码'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        closable={!saving}
        maskClosable={!saving}
        keyboard={!saving}
        cancelButtonProps={{ disabled: saving }}
        onCancel={closeEditor}
        onOk={() => void submit()}
        forceRender
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="secret_kind" label="密码类型" rules={[{ required: true }] }>
            <Select options={PASSWORD_KIND_OPTIONS} />
          </Form.Item>
          <Form.Item
            name="title"
            label="名称"
            rules={propertyLinked ? [] : [{ required: true, message: '请输入名称' }]}
          >
            <Input placeholder={propertyLinked ? '可留空，系统会按房号和类型生成' : '例如：公司办公室前门'} />
          </Form.Item>
          {propertyLinked && (
            <Form.Item
              name="property_ids"
              label="关联房源"
              rules={[{ required: true, type: 'array', min: 1, message: '请至少选择一个房源' }]}
            >
              <Select
                mode="multiple"
                showSearch
                allowClear
                optionFilterProp="label"
                options={propertyOptions}
                placeholder="按房号搜索并选择，可选择多个"
              />
            </Form.Item>
          )}
          {numberedBox && (
            <Form.Item name="box_number" label="密码盒编号" rules={[{ required: true, message: '请输入密码盒编号' }] }>
              <Input placeholder="例如：1号、FG-03" />
            </Form.Item>
          )}
          {secretKind === 'company_rotating' && (
            <Space align="start" style={{ width: '100%' }}>
              <Form.Item name="rotation_interval_days" label="修改周期（天）" rules={[{ required: true, message: '请输入修改周期' }] }>
                <InputNumber min={1} max={3650} precision={0} placeholder="例如：90" style={{ width: 180 }} />
              </Form.Item>
              <Form.Item name="next_rotation_at" label="下次修改日期">
                <DatePicker format="YYYY-MM-DD" />
              </Form.Item>
            </Space>
          )}
          <Form.Item name="location" label="位置">
            <Input placeholder="例如：大门左侧、办公室前台" />
          </Form.Item>
          <Form.Item
            name="secret"
            label="密码"
            rules={editing ? [] : [{ required: true, message: '请输入密码' }]}
          >
            <Input autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="status" label="状态" rules={[{ required: true }] }>
            <Select options={[{ value: 'active', label: '启用' }, { value: 'inactive', label: '停用' }]} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
