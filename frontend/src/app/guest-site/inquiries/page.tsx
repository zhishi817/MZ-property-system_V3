"use client"

import { App, Button, Card, Drawer, Form, Input, Select, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { getJSON, patchJSON } from '../../../lib/api'
import type { GuestSiteInquiry } from '../../../lib/guestSite'

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'new', label: '新询单' },
  { value: 'contacted', label: '已联系' },
  { value: 'converted', label: '已转化' },
  { value: 'closed', label: '已关闭' },
]

function renderStatusTag(status: string) {
  const map: Record<string, { color: string; label: string }> = {
    new: { color: 'orange', label: '新询单' },
    contacted: { color: 'blue', label: '已联系' },
    converted: { color: 'green', label: '已转化' },
    closed: { color: 'default', label: '已关闭' },
  }
  const item = map[String(status || '')] || { color: 'default', label: String(status || '-') }
  return <Tag color={item.color}>{item.label}</Tag>
}

export default function Page() {
  const [rows, setRows] = useState<GuestSiteInquiry[]>([])
  const [loading, setLoading] = useState(false)
  const [statusFilter, setStatusFilter] = useState('')
  const [editing, setEditing] = useState<GuestSiteInquiry | null>(null)
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const { message } = App.useApp()

  async function load(nextStatus = statusFilter) {
    setLoading(true)
    try {
      const qs = nextStatus ? `?status=${encodeURIComponent(nextStatus)}` : ''
      const data = await getJSON<GuestSiteInquiry[]>(`/cms/guest-site/inquiries${qs}`).catch(() => [])
      setRows(Array.isArray(data) ? data : [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load('')
  }, [])

  async function openEditor(row: GuestSiteInquiry) {
    setEditing(row)
    form.setFieldsValue({ status: row.status, admin_note: row.admin_note || '' })
    setOpen(true)
  }

  async function submit() {
    if (!editing) return
    const values = await form.validateFields()
    await patchJSON(`/cms/guest-site/inquiries/${encodeURIComponent(editing.id)}`, values)
    message.success('询单已更新')
    setOpen(false)
    setEditing(null)
    await load()
  }

  return (
    <>
      <Card
        title="预定网站询单管理"
        extra={
          <Space wrap>
            <Select
              value={statusFilter}
              style={{ width: 180 }}
              onChange={(value) => {
                setStatusFilter(value)
                void load(value)
              }}
              options={STATUS_OPTIONS}
            />
            <Button onClick={() => void load()} disabled={loading}>
              刷新
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          客人在前台提交的询单会进入这里，方便客服或运营继续联系、转化和关闭。
        </Typography.Paragraph>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={rows}
          pagination={{ defaultPageSize: 20, showSizeChanger: true }}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: '房源', dataIndex: 'property_address', render: (_: any, row: GuestSiteInquiry) => row.property_address || row.property_code || row.property_id },
            { title: '客人', dataIndex: 'guest_name' },
            { title: '电话', dataIndex: 'guest_phone' },
            { title: '邮箱', dataIndex: 'guest_email' },
            { title: '入住日期', render: (_: any, row: GuestSiteInquiry) => `${row.checkin} 至 ${row.checkout}` },
            { title: '人数', dataIndex: 'guest_count', width: 80 },
            { title: '状态', dataIndex: 'status', width: 120, render: (status: string) => renderStatusTag(status) },
            { title: '操作', width: 120, render: (_: any, row: GuestSiteInquiry) => <Button onClick={() => void openEditor(row)}>详情 / 处理</Button> },
          ]}
        />
      </Card>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        width={520}
        title="询单详情"
        extra={
          <Space>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button type="primary" onClick={submit}>
              保存
            </Button>
          </Space>
        }
      >
        {editing ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <div><strong>房源</strong><div>{editing.property_address || editing.property_code || editing.property_id}</div></div>
            <div><strong>客人</strong><div>{editing.guest_name} / {editing.guest_phone}</div></div>
            <div><strong>留言</strong><div>{editing.message || '-'}</div></div>
            <Form form={form} layout="vertical">
              <Form.Item name="status" label="处理状态" rules={[{ required: true, message: '请选择处理状态' }]}>
                <Select options={STATUS_OPTIONS.filter((item) => item.value)} />
              </Form.Item>
              <Form.Item name="admin_note" label="后台备注">
                <Input.TextArea rows={6} />
              </Form.Item>
            </Form>
          </div>
        ) : null}
      </Drawer>
    </>
  )
}
