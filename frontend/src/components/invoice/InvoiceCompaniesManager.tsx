"use client"

import { App, Button, Col, Divider, Form, Input, Modal, Popconfirm, Row, Select, Space, Switch, Table, Tag, Upload } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useEffect, useMemo, useState } from 'react'
import { API_BASE, authHeaders, getJSON } from '../../lib/api'

export function InvoiceCompaniesManager(props: { bordered?: boolean; onChanged?: () => void }) {
  const { message } = App.useApp()
  const bordered = props.bordered ?? false
  const [companies, setCompanies] = useState<any[]>([])
  const [loading, setLoading] = useState(false)

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<any | null>(null)
  const [form] = Form.useForm()
  const [logoFile, setLogoFile] = useState<any | null>(null)

  async function load() {
    setLoading(true)
    try {
      const rows = await getJSON<any[]>('/invoices/companies')
      setCompanies(Array.isArray(rows) ? rows : [])
    } catch (e: any) {
      message.error(String(e?.message || '加载失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load().then(() => {})
  }, [])

  function openModal(company?: any) {
    setEditing(company || null)
    setLogoFile(null)
    form.resetFields()
    if (company) form.setFieldsValue({ ...company, is_default: !!company.is_default })
    else form.setFieldsValue({ status: 'active', is_default: false })
    setModalOpen(true)
  }

  async function submit() {
    const v = await form.validateFields()
    const payload: any = { ...v }
    const isDefault = !!payload.is_default
    delete payload.logo_url
    const id = editing?.id
    const method = id ? 'PATCH' : 'POST'
    const url = id ? `${API_BASE}/invoices/companies/${id}` : `${API_BASE}/invoices/companies`
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ ...payload, is_default: isDefault }) })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) { message.error(String(j?.message || '保存失败')); return }
    const saved = j
    const pickedFile: any = (logoFile as any)?.originFileObj || (logoFile as any)?.file
    if (pickedFile) {
      const fd = new FormData()
      fd.append('file', pickedFile as any)
      const up = await fetch(`${API_BASE}/invoices/companies/${saved.id}/logo/upload`, { method: 'POST', headers: { ...authHeaders() }, body: fd })
      if (!up.ok) {
        const uj = await up.json().catch(() => ({}))
        message.error(String(uj?.message || 'Logo 上传失败'))
      }
    }
    message.success('已保存')
    setModalOpen(false)
    await load()
    props.onChanged?.()
  }

  async function deleteCompany(id: string) {
    const res = await fetch(`${API_BASE}/invoices/companies/${id}`, { method: 'DELETE', headers: { ...authHeaders() } })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) { message.error(String(j?.message || '删除失败')); return }
    message.success('已删除')
    await load()
    props.onChanged?.()
  }

  const columns: ColumnsType<any> = useMemo(() => ([
    { title: '代码', dataIndex: 'code', width: 110, render: (v) => v || '-' },
    { title: '公司名称', dataIndex: 'legal_name', width: 240 },
    { title: 'ABN/税号', dataIndex: 'abn', width: 160 },
    { title: '邮箱', dataIndex: 'email', width: 220, render: (v) => v || '-' },
    { title: '电话', dataIndex: 'phone', width: 140, render: (v) => v || '-' },
    { title: '默认', dataIndex: 'is_default', width: 90, render: (v) => v ? <Tag color="blue">默认</Tag> : null },
    { title: '状态', dataIndex: 'status', width: 120, render: (v) => String(v || 'active') === 'active' ? <Tag color="green">active</Tag> : <Tag>archived</Tag> },
    { title: '操作', key: 'act', width: 220, fixed: 'right', render: (_: any, r: any) => (
      <Space>
        <Button size="small" onClick={() => openModal(r)}>编辑</Button>
        <Popconfirm title="确认删除该开票主体？" okText="删除" cancelText="取消" onConfirm={() => deleteCompany(String(r.id))}>
          <Button size="small" danger>删除</Button>
        </Popconfirm>
      </Space>
    )},
  ]), [companies])

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Button type="primary" onClick={() => openModal()}>新增开票主体</Button>
      </div>
      <Table rowKey="id" columns={columns} dataSource={companies} loading={loading} scroll={{ x: 1200 }} pagination={{ pageSize: 20 }} bordered={bordered} />

      <Modal
        title={editing ? '编辑开票主体' : '新增开票主体'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={submit}
        okText="保存"
        cancelText="取消"
        width={860}
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item label="代码" name="code"><Input placeholder="例如：INV" /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="公司名称" name="legal_name" rules={[{ required: true, message: '必填' }]}><Input /></Form.Item>
            </Col>
            <Col xs={24} md={4}>
              <Form.Item label="默认" name="is_default" valuePropName="checked"><Switch /></Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item label="税号/ABN" name="abn" rules={[{ required: true, message: '必填' }]}><Input /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="状态" name="status"><Select options={[{ value: 'active', label: 'active' }, { value: 'archived', label: 'archived' }]} /></Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item label="邮箱" name="email"><Input /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="电话" name="phone"><Input /></Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item label="地址1" name="address_line1"><Input /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="地址2" name="address_line2"><Input /></Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item label="城市" name="address_city"><Input /></Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="州" name="address_state"><Input /></Form.Item>
            </Col>
            <Col xs={24} md={5}>
              <Form.Item label="邮编" name="address_postcode"><Input /></Form.Item>
            </Col>
            <Col xs={24} md={5}>
              <Form.Item label="国家" name="address_country"><Input /></Form.Item>
            </Col>
          </Row>
          <Divider />
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item label="开户名" name="bank_account_name"><Input /></Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item label="BSB" name="bank_bsb"><Input /></Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item label="账号" name="bank_account_no"><Input /></Form.Item>
            </Col>
          </Row>
          <Form.Item label="付款说明" name="payment_note"><Input.TextArea rows={2} /></Form.Item>
          <Form.Item label="Logo（PNG/JPG）">
            <Upload beforeUpload={() => false} maxCount={1} onChange={(info) => setLogoFile(info.fileList?.[0] || null)} fileList={logoFile ? [logoFile] : []}>
              <Button>选择文件</Button>
            </Upload>
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
