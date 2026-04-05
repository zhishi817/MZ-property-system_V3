"use client"
import { DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons'
import { Button, Card, DatePicker, Descriptions, Divider, Drawer, Form, Input, InputNumber, Modal, Space, Switch, Table, Tag, Typography, message } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { deleteJSON, getJSON, patchJSON, postJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'

type Supplier = { id: string; name: string; kind: string; active: boolean }
type LinenType = { code: string; name: string; sort_order?: number; active: boolean; item_id?: string | null }
type SupplierPrice = {
  id: string
  supplier_id: string
  supplier_name: string
  item_id: string
  item_name: string
  item_sku: string
  linen_type_code?: string | null
  purchase_unit_price: number
  refund_unit_price: number
  effective_from?: string | null
  active: boolean
}
type PriceDraftRow = {
  id?: string
  supplier_id: string
  linen_type_code: string
  item_id: string
  linen_type_name: string
  purchase_unit_price: number
  refund_unit_price: number
  effective_from?: string
  active: boolean
  deleted?: boolean
}

export default function InventorySuppliersPage() {
  const [rows, setRows] = useState<Supplier[]>([])
  const [linenTypes, setLinenTypes] = useState<LinenType[]>([])
  const [prices, setPrices] = useState<SupplierPrice[]>([])
  const [detailOpen, setDetailOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [linenTypeOpen, setLinenTypeOpen] = useState(false)
  const [viewing, setViewing] = useState<Supplier | null>(null)
  const [editing, setEditing] = useState<Supplier | null>(null)
  const [priceDrafts, setPriceDrafts] = useState<Record<string, PriceDraftRow>>({})
  const [submittingSupplier, setSubmittingSupplier] = useState(false)
  const [savingPrices, setSavingPrices] = useState(false)
  const [creatingLinenType, setCreatingLinenType] = useState(false)
  const [form] = Form.useForm()
  const [linenTypeForm] = Form.useForm()
  const canManage = hasPerm('inventory.po.manage')

  function is404Error(e: any) {
    const msg = String(e?.message || '')
    return msg.includes('404') || msg.includes('Cannot POST') || msg.includes('Cannot PATCH') || msg.includes('Cannot DELETE')
  }

  function makeId(prefix: string) {
    const rand = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
    return `${prefix}${rand}`
  }

  async function loadLinenTypes() {
    try {
      return await getJSON<LinenType[]>('/inventory/linen-types')
    } catch {
      const items = await getJSON<any[]>('/inventory/items?active=true&category=linen')
      return (items || [])
        .filter((x) => x.active && x.linen_type_code)
        .map((x, idx) => ({
          code: String(x.linen_type_code),
          name: String(x.name || x.linen_type_code),
          sort_order: Number(x.sort_order ?? idx),
          item_id: String(x.id || ''),
          active: true,
        }))
    }
  }

  async function loadSupplierPrices() {
    try {
      return await getJSON<SupplierPrice[]>('/inventory/supplier-item-prices')
    } catch {
      return await getJSON<SupplierPrice[]>('/crud/supplier_item_prices')
    }
  }

  async function load() {
    const [suppliersRes, linenTypesRes, pricesRes] = await Promise.allSettled([
      getJSON<Supplier[]>('/inventory/suppliers'),
      loadLinenTypes(),
      loadSupplierPrices(),
    ])

    if (suppliersRes.status === 'fulfilled') setRows((suppliersRes.value || []).filter((x) => x.active !== false))
    else throw suppliersRes.reason

    if (linenTypesRes.status === 'fulfilled') {
      setLinenTypes((linenTypesRes.value || []).filter((x) => x.active).sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)))
    } else {
      setLinenTypes([])
    }

    if (pricesRes.status === 'fulfilled') {
      setPrices(pricesRes.value || [])
    } else {
      setPrices([])
      message.warning('床品价格表接口加载失败，已先显示供应商列表')
    }
  }

  useEffect(() => { load().catch((e) => message.error(e?.message || '加载失败')) }, [])

  useEffect(() => {
    const supplierId = String(editing?.id || '')
    if (!supplierId) {
      setPriceDrafts({})
      return
    }
    const byLinenType = new Map<string, SupplierPrice>()
    for (const row of prices || []) {
      if (row.supplier_id !== supplierId) continue
      const code = String(row.linen_type_code || '')
      if (!code) continue
      byLinenType.set(code, row)
    }
    const next: Record<string, PriceDraftRow> = {}
    for (const linenType of linenTypes || []) {
      const existing = byLinenType.get(String(linenType.code))
      next[String(linenType.code)] = {
        id: existing?.id,
        supplier_id: supplierId,
        linen_type_code: String(linenType.code),
        item_id: existing?.item_id || String(linenType.item_id || ''),
        linen_type_name: String(linenType.name),
        purchase_unit_price: Number(existing?.purchase_unit_price || 0),
        refund_unit_price: Number(existing?.refund_unit_price || 0),
        effective_from: existing?.effective_from || '',
        active: existing ? !!existing.active : true,
        deleted: false,
      }
    }
    setPriceDrafts(next)
  }, [editing, prices, linenTypes])

  function kindTag(k: string) {
    if (k === 'linen') return <Tag color="blue">床品</Tag>
    if (k === 'daily') return <Tag color="purple">日用品</Tag>
    if (k === 'consumable') return <Tag color="green">消耗品</Tag>
    return <Tag>{k || '其他'}</Tag>
  }

  function openDetail(supplier: Supplier) {
    setViewing(supplier)
    setDetailOpen(true)
  }

  function openCreate() {
    setViewing(null)
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ name: '', kind: 'linen', active: true })
    setPriceDrafts({})
    setEditOpen(true)
  }

  function openEdit(supplier: Supplier) {
    setViewing(null)
    setDetailOpen(false)
    setEditing(supplier)
    form.resetFields()
    form.setFieldsValue({ name: supplier.name, kind: supplier.kind, active: supplier.active })
    setEditOpen(true)
  }

  function updateDraft(linenTypeCode: string, patch: Partial<PriceDraftRow>) {
    const supplierId = String(editing?.id || '')
    setPriceDrafts((prev) => ({
      ...prev,
      [linenTypeCode]: {
        ...(prev[linenTypeCode] || {
          supplier_id: supplierId,
          linen_type_code: linenTypeCode,
          item_id: String(linenTypes.find((x) => x.code === linenTypeCode)?.item_id || ''),
          linen_type_name: linenTypes.find((x) => x.code === linenTypeCode)?.name || linenTypeCode,
          purchase_unit_price: 0,
          refund_unit_price: 0,
          effective_from: '',
          active: true,
          deleted: false,
        }),
        ...patch,
      },
    }))
  }

  async function submitSupplier() {
    setSubmittingSupplier(true)
    try {
      const v = await form.validateFields()
      if (editing) {
        const updated = await patchJSON<Supplier>(`/inventory/suppliers/${editing.id}`, v)
        setEditing(updated || { ...editing, ...v })
        if (viewing?.id === editing.id) setViewing(updated || { ...editing, ...v })
        message.success('已更新供应商')
        await load()
        return
      }

      const created = await postJSON<Supplier>('/inventory/suppliers', v)
      message.success('已创建供应商')
      await load()
      if (created?.id) {
        setEditing(created)
        form.setFieldsValue({ name: created.name, kind: created.kind, active: created.active })
      } else {
        setEditOpen(false)
      }
    } finally {
      setSubmittingSupplier(false)
    }
  }

  async function saveAllPrices() {
    if (!editing?.id) {
      message.warning('请先保存供应商，再维护床品价格')
      return
    }
    setSavingPrices(true)
    try {
      const pending = Object.values(priceDrafts)
      for (const row of pending) {
        if (row.deleted) {
          if (row.id) {
            try {
              await deleteJSON(`/inventory/supplier-item-prices/${row.id}`)
            } catch (e: any) {
              if (is404Error(e)) await deleteJSON(`/crud/supplier_item_prices/${row.id}`)
              else throw e
            }
          }
          continue
        }
        const resolvedItemId = row.item_id || String(linenTypes.find((x) => x.code === row.linen_type_code)?.item_id || '')
        const payload: any = {
          supplier_id: editing.id,
          linen_type_code: row.linen_type_code,
          purchase_unit_price: Number(row.purchase_unit_price || 0),
          refund_unit_price: Number(row.refund_unit_price || 0),
          effective_from: row.effective_from || undefined,
          active: !!row.active,
        }
        if (resolvedItemId) payload.item_id = resolvedItemId
        if (row.id) {
          try {
            await patchJSON(`/inventory/supplier-item-prices/${row.id}`, payload)
          } catch (e: any) {
            if (is404Error(e)) await patchJSON(`/crud/supplier_item_prices/${row.id}`, payload)
            else throw e
          }
        } else {
          try {
            await postJSON('/inventory/supplier-item-prices', payload)
          } catch (e: any) {
            if (is404Error(e)) {
              await postJSON('/crud/supplier_item_prices', { id: makeId('sip.'), ...payload })
            } else {
              throw e
            }
          }
        }
      }
      message.success('床品价格已保存')
      await load()
    } finally {
      setSavingPrices(false)
    }
  }

  async function removeSupplier(supplier: Supplier) {
    Modal.confirm({
      title: '确认删除供应商？',
      content: `将删除供应商：${supplier.name}。若已有采购、价格、规则或返厂退款记录将无法删除。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          try {
            await deleteJSON(`/inventory/suppliers/${supplier.id}`)
          } catch (e: any) {
            if (String(e?.message || '').includes('404')) {
              try {
                await postJSON(`/inventory/suppliers/${supplier.id}/delete`, {})
              } catch (e2: any) {
                if (String(e2?.message || '').includes('404')) {
                  await patchJSON(`/inventory/suppliers/${supplier.id}`, { active: false })
                } else {
                  throw e2
                }
              }
            } else {
              throw e
            }
          }
          message.success('已删除')
          if (viewing?.id === supplier.id) setDetailOpen(false)
          if (editing?.id === supplier.id) {
            setEditOpen(false)
            setEditing(null)
            form.resetFields()
            setPriceDrafts({})
          }
          await load()
        } catch (e: any) {
          message.error(e?.message || '删除失败')
        }
      },
    })
  }

  async function createLinenType() {
    setCreatingLinenType(true)
    try {
      const values = await linenTypeForm.validateFields()
      const code = String(values.code || '').trim()
      const name = String(values.name || '').trim()
      try {
        await postJSON('/inventory/linen-types', {
          code,
          name,
          sort_order: Number(values.sort_order || 0),
          in_set: true,
          set_divisor: 1,
          active: true,
        })
      } catch (e: any) {
        if (is404Error(e)) {
          await postJSON('/inventory/items', {
            name,
            sku: `LT:${code}`,
            category: 'linen',
            linen_type_code: code,
            unit: 'pcs',
            default_threshold: 0,
            active: true,
            is_key_item: false,
          })
        } else {
          throw e
        }
      }
      message.success('已新增床品类型')
      setLinenTypeOpen(false)
      linenTypeForm.resetFields()
      await load()
    } finally {
      setCreatingLinenType(false)
    }
  }

  async function deleteLinenType(row: PriceDraftRow) {
    Modal.confirm({
      title: '确认删除床品类型？',
      content: `将删除床品类型：${row.linen_type_name}。如果已有库存、采购或流水记录，系统会阻止删除。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          try {
            await deleteJSON(`/inventory/linen-types/${row.linen_type_code}`)
          } catch (e: any) {
            if (is404Error(e)) {
              const items = await getJSON<any[]>(`/inventory/items?active=true&category=linen&linen_type_code=${encodeURIComponent(row.linen_type_code)}`)
              const item = (items || [])[0]
              if (!item?.id) throw new Error('当前环境不支持直接删除床品类型，请先部署最新后端')
              await patchJSON(`/inventory/items/${item.id}`, { active: false })
            } else {
              throw e
            }
          }
          message.success(`已删除 ${row.linen_type_name}`)
          await load()
        } catch (e: any) {
          message.error(e?.message || '删除失败')
        }
      },
    })
  }

  const editingKind = Form.useWatch('kind', form)
  const viewingPriceCount = useMemo(() => prices.filter((p) => p.supplier_id === viewing?.id).length, [prices, viewing])
  const viewingPrices = useMemo(() => {
    if (!viewing?.id) return []
    return prices
      .filter((p) => p.supplier_id === viewing.id)
      .sort((a, b) => String(a.item_name || '').localeCompare(String(b.item_name || '')))
  }, [prices, viewing])
  const editingPriceRows = useMemo(() => {
    if (!editing?.id || editingKind !== 'linen') return []
    return (linenTypes || [])
      .map((linenType) => (
        priceDrafts[String(linenType.code)] || {
          supplier_id: editing.id,
          linen_type_code: String(linenType.code),
          item_id: String(linenType.item_id || ''),
          linen_type_name: String(linenType.name),
          purchase_unit_price: 0,
          refund_unit_price: 0,
          effective_from: '',
          active: true,
          deleted: false,
        }
      ))
      .filter((row) => !row.deleted)
  }, [editing, editingKind, linenTypes, priceDrafts])

  const supplierColumns: any[] = [
    { title: '名称', dataIndex: 'name' },
    { title: '类型', dataIndex: 'kind', render: (v: string) => kindTag(v) },
    { title: '床品价格条数', render: (_: any, r: Supplier) => prices.filter((p) => p.supplier_id === r.id).length },
    canManage ? {
      title: '操作',
      width: 220,
      render: (_: any, r: Supplier) => (
        <Space>
          <Button onClick={() => openDetail(r)}>详情</Button>
          <Button onClick={() => openEdit(r)}>编辑</Button>
          <Button danger onClick={() => removeSupplier(r)}>删除</Button>
        </Space>
      ),
    } : null,
  ].filter(Boolean)

  const priceColumns: any[] = [
    { title: '床品类型', dataIndex: 'linen_type_name' },
    {
      title: '采购单价',
      render: (_: any, r: PriceDraftRow) => (
        <InputNumber min={0} value={r.purchase_unit_price} onChange={(v) => updateDraft(r.linen_type_code, { purchase_unit_price: Number(v || 0) })} style={{ width: 140 }} />
      ),
    },
    {
      title: '退款单价',
      render: (_: any, r: PriceDraftRow) => (
        <InputNumber min={0} value={r.refund_unit_price} onChange={(v) => updateDraft(r.linen_type_code, { refund_unit_price: Number(v || 0) })} style={{ width: 140 }} />
      ),
    },
    {
      title: '生效日',
      render: (_: any, r: PriceDraftRow) => (
        <DatePicker
          value={r.effective_from ? dayjs(r.effective_from) : null}
          format="YYYY-MM-DD"
          allowClear
          onChange={(v) => updateDraft(r.linen_type_code, { effective_from: v ? v.format('YYYY-MM-DD') : '' })}
          style={{ width: 160 }}
        />
      ),
    },
    canManage ? {
      title: '',
      width: 72,
      render: (_: any, r: PriceDraftRow) => (
        <Button
          type="text"
          danger
          icon={<DeleteOutlined />}
          onClick={() => {
            if (r.id) deleteLinenType(r).catch((e) => message.error(e?.message || '删除失败'))
            else updateDraft(r.linen_type_code, { deleted: true })
          }}
        />
      ),
    } : null,
  ].filter(Boolean)

  return (
    <>
      <Card title="供应商列表" extra={canManage ? <Button type="primary" onClick={openCreate}>新增供应商</Button> : null}>
        <Table
          rowKey={(r) => r.id}
          columns={supplierColumns}
          dataSource={rows}
          pagination={{ pageSize: 20 }}
        />
      </Card>

      <Drawer
        title="供应商详情"
        width={800}
        open={detailOpen}
        onClose={() => { setDetailOpen(false); setViewing(null) }}
        extra={viewing ? (
          <Space>
            {canManage ? <Button onClick={() => openEdit(viewing)}>编辑</Button> : null}
            {canManage ? <Button danger onClick={() => removeSupplier(viewing)}>删除</Button> : null}
          </Space>
        ) : null}
      >
        {viewing ? (
          <>
            <Descriptions title="供应商基础信息" bordered column={2} labelStyle={{ width: '120px' }}>
              <Descriptions.Item label="名称">{viewing.name}</Descriptions.Item>
              <Descriptions.Item label="类型">{kindTag(viewing.kind)}</Descriptions.Item>
              <Descriptions.Item label="状态">{viewing.active ? '启用' : '停用'}</Descriptions.Item>
              <Descriptions.Item label="床品价格条数">{viewingPriceCount}</Descriptions.Item>
            </Descriptions>

            {viewing.kind === 'linen' ? (
              <>
                <Divider orientation="left">床品价格信息</Divider>
                <Table
                  rowKey={(r) => r.id}
                  pagination={false}
                  dataSource={viewingPrices}
                  columns={[
                    { title: '床品类型', dataIndex: 'item_name' },
                    { title: '采购单价', dataIndex: 'purchase_unit_price' },
                    { title: '退款单价', dataIndex: 'refund_unit_price' },
                    { title: '生效日', render: (_: any, r: SupplierPrice) => r.effective_from || '-' },
                  ]}
                />
              </>
            ) : null}
          </>
        ) : null}
      </Drawer>

      <Drawer
        title={editing ? '编辑供应商' : '新增供应商'}
        width={980}
        open={editOpen}
        onClose={() => { setEditOpen(false); setEditing(null); form.resetFields(); setPriceDrafts({}) }}
        extra={
          <Space>
            <Typography.Text type="secondary">启用</Typography.Text>
            <Form form={form} component={false}>
              <Form.Item name="active" noStyle valuePropName="checked">
                <Switch />
              </Form.Item>
            </Form>
          </Space>
        }
        footer={
          <div style={{ textAlign: 'right' }}>
            <Space>
              <Button onClick={() => { setEditOpen(false); setEditing(null); form.resetFields(); setPriceDrafts({}) }}>取消</Button>
              {editing?.id && editingKind === 'linen' ? (
                <Button loading={savingPrices} icon={<SaveOutlined />} onClick={() => saveAllPrices().catch((e) => message.error(e?.message || '保存失败'))}>保存床品价格</Button>
              ) : null}
              <Button type="primary" loading={submittingSupplier} onClick={() => submitSupplier().catch((e) => message.error(e?.message || '保存失败'))}>保存供应商</Button>
            </Space>
          </div>
        }
      >
        <Form form={form} layout="vertical">
          <Divider orientation="left">供应商基础信息</Divider>
          <Descriptions bordered column={1} labelStyle={{ width: '120px' }}>
            <Descriptions.Item label="名称">
              <Form.Item name="name" noStyle rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Descriptions.Item>
            <Descriptions.Item label="类型">
              <Form.Item name="kind" noStyle rules={[{ required: true }]}>
                <Input
                  disabled
                  value={
                    editingKind === 'linen'
                      ? '床品'
                      : editingKind === 'daily'
                        ? '日用品'
                        : editingKind === 'consumable'
                          ? '消耗品'
                          : editingKind || ''
                  }
                />
              </Form.Item>
            </Descriptions.Item>
          </Descriptions>
        </Form>

        {editingKind === 'linen' ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 24, marginBottom: 12 }}>
              <div>
                <Typography.Title level={5} style={{ margin: 0 }}>床品价格表</Typography.Title>
                <Typography.Text type="secondary">所有床品类型统一编辑，最后一次性保存。</Typography.Text>
              </div>
              {canManage ? (
                <Space>
                  <Button type="text" icon={<PlusOutlined />} onClick={() => setLinenTypeOpen(true)} />
                </Space>
              ) : null}
            </div>
            {editing?.id ? (
              <Table rowKey={(r) => `${r.supplier_id}-${r.linen_type_code}`} columns={priceColumns} dataSource={editingPriceRows} pagination={false} />
            ) : (
              <Typography.Text type="secondary">先保存供应商，再维护床品价格。</Typography.Text>
            )}
          </>
        ) : null}
      </Drawer>

      <Modal
        title="新增床品类型"
        open={linenTypeOpen}
        onCancel={() => { setLinenTypeOpen(false); linenTypeForm.resetFields() }}
        onOk={() => createLinenType().catch((e) => message.error(e?.message || '保存失败'))}
        confirmLoading={creatingLinenType}
        okText="保存"
        cancelText="取消"
      >
        <Form form={linenTypeForm} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}><Input placeholder="例如：浴袍" /></Form.Item>
          <Form.Item name="code" label="编码" rules={[{ required: true, message: '请输入编码' }]}><Input placeholder="例如：bathrobe" /></Form.Item>
          <Form.Item name="sort_order" label="排序"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
        </Form>
      </Modal>
    </>
  )
}
