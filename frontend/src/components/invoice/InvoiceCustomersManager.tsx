"use client"

import { App, Button, Col, Form, Input, Modal, Popconfirm, Row, Select, Space, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useEffect, useMemo, useState } from 'react'
import { API_BASE, authHeaders, getJSON } from '../../lib/api'

export function InvoiceCustomersManager(props: { bordered?: boolean; onChanged?: () => void }) {
  const { message } = App.useApp()
  const bordered = props.bordered ?? false
  const [customers, setCustomers] = useState<any[]>([])
  const [loading, setLoading] = useState(false)

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<any | null>(null)
  const [form] = Form.useForm()

  async function load() {
    setLoading(true)
    try {
      const rows = await getJSON<any[]>('/invoices/customers')
      setCustomers(Array.isArray(rows) ? rows : [])
    } catch (e: any) {
      message.error(String(e?.message || '加载失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load().then(() => {})
  }, [])

  function openModal(customer?: any) {
    setEditing(customer || null)
    form.resetFields()
    if (customer) form.setFieldsValue({ ...customer, status: customer.status || 'active' })
    else form.setFieldsValue({ status: 'active' })
    setModalOpen(true)
  }

  async function submit() {
    const v = await form.validateFields()
    const id = editing?.id
    const method = id ? 'PATCH' : 'POST'
    const url = id ? `${API_BASE}/invoices/customers/${id}` : `${API_BASE}/invoices/customers`
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(v) })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) { message.error(String(j?.message || '保存失败')); return }
    message.success('已保存')
    setModalOpen(false)
    await load()
    props.onChanged?.()
  }

  async function deleteCustomer(id: string) {
    const res = await fetch(`${API_BASE}/invoices/customers/${id}`, { method: 'DELETE', headers: { ...authHeaders() } })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) { message.error(String(j?.message || '删除失败')); return }
    message.success('已删除')
    await load()
    props.onChanged?.()
  }

  const columns: ColumnsType<any> = useMemo(() => ([
    { title: '客户名称', dataIndex: 'name', width: 220 },
    { title: '税号', dataIndex: 'abn', width: 160, render: (v) => v || '-' },
    { title: '邮箱', dataIndex: 'email', width: 220, render: (v) => v || '-' },
    { title: '电话', dataIndex: 'phone', width: 140, render: (v) => v || '-' },
    { title: '地址', dataIndex: 'address', width: 280, render: (v) => v || '-' },
    { title: '状态', dataIndex: 'status', width: 120, render: (v) => String(v || 'active') === 'active' ? <Tag color="green">active</Tag> : <Tag>archived</Tag> },
    { title: '操作', key: 'act', width: 220, fixed: 'right', render: (_: any, r: any) => (
      <Space>
        <Button size="small" onClick={() => openModal(r)}>编辑</Button>
        <Popconfirm title="确认删除该客户？" okText="删除" cancelText="取消" onConfirm={() => deleteCustomer(String(r.id))}>
          <Button size="small" danger>删除</Button>
        </Popconfirm>
      </Space>
    )},
  ]), [customers])

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Button type="primary" onClick={() => openModal()}>新增常用客户</Button>
      </div>
      <Table rowKey="id" columns={columns} dataSource={customers} loading={loading} scroll={{ x: 1200 }} pagination={{ pageSize: 20 }} bordered={bordered} />

      <Modal
        title={editing ? '编辑常用客户' : '新增常用客户'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={submit}
        okText="保存"
        cancelText="取消"
        width={760}
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item label="客户名称" name="name" rules={[{ required: true, message: '必填' }]}><Input /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="税号" name="abn"><Input /></Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item label="电子邮箱" name="email"><Input /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="联系电话" name="phone"><Input /></Form.Item>
            </Col>
          </Row>
          <Form.Item label="联系地址" name="address"><Input.TextArea rows={2} /></Form.Item>
          <Form.Item label="状态" name="status"><Select options={[{ value: 'active', label: 'active' }, { value: 'archived', label: 'archived' }]} /></Form.Item>
        </Form>
      </Modal>
    </>
  )
}

