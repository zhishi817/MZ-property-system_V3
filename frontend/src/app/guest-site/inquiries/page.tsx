"use client"

import { App, Button, Card, Descriptions, Divider, Drawer, Form, Input, Select, Space, Table, Tabs, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import TableRowActions from '../../../components/TableRowActions'
import { getApiFailureKind, getJSON, patchJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'
import type { GuestSiteContactMessage, GuestSiteInquiry } from '../../../lib/guestSite'

const INQUIRY_STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'new', label: '新询单' },
  { value: 'contacted', label: '已联系' },
  { value: 'converted', label: '已转化' },
  { value: 'closed', label: '已关闭' },
]

const CONTACT_STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'new', label: '新留言' },
  { value: 'contacted', label: '已联系' },
  { value: 'closed', label: '已关闭' },
]

function renderStatusTag(status: string, contact = false) {
  const map: Record<string, { color: string; label: string }> = {
    new: { color: 'orange', label: contact ? '新留言' : '新询单' },
    contacted: { color: 'blue', label: '已联系' },
    converted: { color: 'green', label: '已转化' },
    closed: { color: 'default', label: '已关闭' },
  }
  const item = map[String(status || '')] || { color: 'default', label: String(status || '-') }
  return <Tag color={item.color}>{item.label}</Tag>
}

function formatDateTime(value: string | null | undefined) {
  const date = value ? new Date(value) : null
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '-'
}

function loadFailureMessage(label: string, error: unknown) {
  const failure = error as { status?: unknown }
  const status = Number(failure?.status || 0)
  if (status === 404) return `${label}接口在当前后端不可用，请确认前后端版本一致`
  if (getApiFailureKind(error) === 'network_unavailable' || status >= 500) {
    return `${label}暂时无法加载，服务连接可能已中断，请稍后重试`
  }
  return `${label}暂时无法加载，请稍后重试`
}

function PanelHeader({
  description,
  extra,
  title,
}: {
  description: string
  extra: React.ReactNode
  title: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
      <div style={{ minWidth: 0 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>{title}</Typography.Title>
        <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0', maxWidth: 680 }}>
          {description}
        </Typography.Paragraph>
      </div>
      {extra}
    </div>
  )
}

function MessageBlock({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 16, border: '1px solid #e5e7eb', borderRadius: 8, background: '#f8fafc', color: '#334155', fontSize: 14, lineHeight: 1.75, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {children || '-'}
    </div>
  )
}

export default function Page() {
  const [activeTab, setActiveTab] = useState('inquiries')
  const [canWrite, setCanWrite] = useState(false)
  const [inquiryRows, setInquiryRows] = useState<GuestSiteInquiry[]>([])
  const [inquiryLoading, setInquiryLoading] = useState(false)
  const [inquiryStatus, setInquiryStatus] = useState('')
  const [editingInquiry, setEditingInquiry] = useState<GuestSiteInquiry | null>(null)
  const [inquiryDrawerOpen, setInquiryDrawerOpen] = useState(false)
  const [inquirySaving, setInquirySaving] = useState(false)
  const [contactRows, setContactRows] = useState<GuestSiteContactMessage[]>([])
  const [contactLoading, setContactLoading] = useState(false)
  const [contactLoaded, setContactLoaded] = useState(false)
  const [contactStatus, setContactStatus] = useState('')
  const [editingContact, setEditingContact] = useState<GuestSiteContactMessage | null>(null)
  const [contactDrawerOpen, setContactDrawerOpen] = useState(false)
  const [contactSaving, setContactSaving] = useState(false)
  const [inquiryForm] = Form.useForm()
  const [contactForm] = Form.useForm()
  const { message } = App.useApp()

  const loadInquiries = useCallback(async (nextStatus: string) => {
    setInquiryLoading(true)
    try {
      const qs = nextStatus ? `?status=${encodeURIComponent(nextStatus)}` : ''
      const data = await getJSON<GuestSiteInquiry[]>(`/cms/guest-site/inquiries${qs}`)
      setInquiryRows(Array.isArray(data) ? data : [])
    } catch (error) {
      setInquiryRows([])
      message.error(loadFailureMessage('询单', error))
    } finally {
      setInquiryLoading(false)
    }
  }, [message])

  async function loadContacts(nextStatus = contactStatus) {
    setContactLoading(true)
    try {
      const qs = nextStatus ? `?status=${encodeURIComponent(nextStatus)}` : ''
      const data = await getJSON<GuestSiteContactMessage[]>(`/cms/guest-site/contact-messages${qs}`)
      setContactRows(Array.isArray(data) ? data : [])
      setContactLoaded(true)
    } catch (error) {
      setContactRows([])
      message.error(loadFailureMessage('网站咨询', error))
    } finally {
      setContactLoading(false)
    }
  }

  useEffect(() => {
    setCanWrite(hasPerm('guest_site_inquiries.write'))
    void loadInquiries('')
  }, [loadInquiries])

  function openInquiryEditor(row: GuestSiteInquiry) {
    setEditingInquiry(row)
    inquiryForm.setFieldsValue({ status: row.status, admin_note: row.admin_note || '' })
    setInquiryDrawerOpen(true)
  }

  function closeInquiryEditor(force = false) {
    if (inquirySaving && !force) return
    setInquiryDrawerOpen(false)
    setEditingInquiry(null)
    inquiryForm.resetFields()
  }

  async function submitInquiry() {
    if (!editingInquiry || !canWrite) return
    let values
    try {
      values = await inquiryForm.validateFields()
    } catch {
      return
    }
    setInquirySaving(true)
    try {
      await patchJSON(`/cms/guest-site/inquiries/${encodeURIComponent(editingInquiry.id)}`, values)
      message.success('询单已更新')
      closeInquiryEditor(true)
      await loadInquiries(inquiryStatus)
    } catch {
      message.error('询单保存失败，请稍后重试')
    } finally {
      setInquirySaving(false)
    }
  }

  function openContactEditor(row: GuestSiteContactMessage) {
    setEditingContact(row)
    contactForm.setFieldsValue({ status: row.status, admin_note: row.admin_note || '' })
    setContactDrawerOpen(true)
  }

  function closeContactEditor(force = false) {
    if (contactSaving && !force) return
    setContactDrawerOpen(false)
    setEditingContact(null)
    contactForm.resetFields()
  }

  async function submitContact() {
    if (!editingContact || !canWrite) return
    let values
    try {
      values = await contactForm.validateFields()
    } catch {
      return
    }
    setContactSaving(true)
    try {
      await patchJSON(`/cms/guest-site/contact-messages/${encodeURIComponent(editingContact.id)}`, values)
      message.success('网站咨询已更新')
      closeContactEditor(true)
      await loadContacts()
    } catch {
      message.error('网站咨询保存失败，请稍后重试')
    } finally {
      setContactSaving(false)
    }
  }

  const inquiryPanel = (
    <div>
      <PanelHeader
        title="预订询单"
        description="客人在房源预订流程提交的询单，继续按房源、入住日期和人数处理。"
        extra={(
        <Space wrap>
          <Select
            aria-label="筛选预订询单状态"
            value={inquiryStatus}
            style={{ width: 180 }}
            onChange={(value) => {
              setInquiryStatus(value)
              void loadInquiries(value)
            }}
            options={INQUIRY_STATUS_OPTIONS}
          />
          <Button onClick={() => void loadInquiries(inquiryStatus)} loading={inquiryLoading}>刷新</Button>
        </Space>
      )}
      />
      <Table
        size="small"
        rowKey="id"
        loading={inquiryLoading}
        dataSource={inquiryRows}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '房源', dataIndex: 'property_address', render: (_: unknown, row: GuestSiteInquiry) => row.property_address || row.property_code || row.property_id },
          { title: '客人', dataIndex: 'guest_name' },
          { title: '电话', dataIndex: 'guest_phone' },
          { title: '邮箱', dataIndex: 'guest_email' },
          { title: '入住日期', render: (_: unknown, row: GuestSiteInquiry) => `${row.checkin} 至 ${row.checkout}` },
          { title: '人数', dataIndex: 'guest_count', width: 80 },
          { title: '状态', dataIndex: 'status', width: 120, render: (status: string) => renderStatusTag(status) },
          {
            title: '操作',
            width: 104,
            fixed: 'right',
            render: (_: unknown, row: GuestSiteInquiry) => (
              <TableRowActions actions={[{ key: 'detail', label: canWrite ? '处理' : '详情', onClick: () => openInquiryEditor(row) }]} />
            ),
          },
        ]}
      />
    </div>
  )

  const contactPanel = (
    <div>
      <PanelHeader
        title="网站咨询"
        description="网站联系表单只把咨询保存到后台，不发送邮件。客服可查看完整内容、标记联系状态并记录内部备注。"
        extra={(
        <Space wrap>
          <Select
            aria-label="筛选首页留言状态"
            value={contactStatus}
            style={{ width: 180 }}
            onChange={(value) => {
              setContactStatus(value)
              void loadContacts(value)
            }}
            options={CONTACT_STATUS_OPTIONS}
          />
          <Button onClick={() => void loadContacts()} loading={contactLoading}>刷新</Button>
        </Space>
      )}
      />
      <Table
        size="small"
        rowKey="id"
        loading={contactLoading}
        dataSource={contactRows}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '姓名', dataIndex: 'guest_name', width: 160 },
          { title: '邮箱', dataIndex: 'guest_email', width: 220 },
          { title: '留言', dataIndex: 'message', ellipsis: true, width: 360 },
          { title: '提交时间', dataIndex: 'created_at', width: 180, render: (value: string) => formatDateTime(value) },
          { title: '状态', dataIndex: 'status', width: 120, render: (status: string) => renderStatusTag(status, true) },
          {
            title: '操作',
            width: 104,
            fixed: 'right',
            render: (_: unknown, row: GuestSiteContactMessage) => (
              <TableRowActions actions={[{ key: 'detail', label: canWrite ? '处理' : '详情', onClick: () => openContactEditor(row) }]} />
            ),
          },
        ]}
      />
    </div>
  )

  return (
    <>
      <Card title="预订网站询单管理">
        <Typography.Paragraph type="secondary" style={{ marginTop: -4, marginBottom: 8 }}>
          分别查看房源预订询单和网站联系咨询；两类记录独立保存、独立处理。
        </Typography.Paragraph>
        <Tabs
          activeKey={activeTab}
          onChange={(key) => {
            setActiveTab(key)
            if (key === 'contacts' && !contactLoaded) void loadContacts('')
          }}
          items={[
            { key: 'inquiries', label: '预订询单', children: inquiryPanel },
            { key: 'contacts', label: '网站咨询', children: contactPanel },
          ]}
        />
      </Card>

      <Drawer
        open={inquiryDrawerOpen}
        onClose={() => closeInquiryEditor()}
        width={720}
        title="预订询单详情"
        destroyOnHidden
        footer={(
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button disabled={inquirySaving} onClick={() => closeInquiryEditor()}>{canWrite ? '取消' : '关闭'}</Button>
            {canWrite ? <Button type="primary" loading={inquirySaving} onClick={() => void submitInquiry()}>保存</Button> : null}
          </div>
        )}
      >
        {editingInquiry ? (
          <Space direction="vertical" size={20} style={{ width: '100%' }}>
            <div>
              <Typography.Title level={5} style={{ marginTop: 0 }}>客人与行程</Typography.Title>
              <Descriptions bordered column={1} styles={{ label: { width: 128 } }}>
                <Descriptions.Item label="房源">{editingInquiry.property_address || editingInquiry.property_code || editingInquiry.property_id}</Descriptions.Item>
                <Descriptions.Item label="客人">{editingInquiry.guest_name || '-'}</Descriptions.Item>
                <Descriptions.Item label="电话">{editingInquiry.guest_phone || '-'}</Descriptions.Item>
                <Descriptions.Item label="邮箱">{editingInquiry.guest_email || '-'}</Descriptions.Item>
                <Descriptions.Item label="入住日期">{editingInquiry.checkin} 至 {editingInquiry.checkout}</Descriptions.Item>
                <Descriptions.Item label="入住人数">{editingInquiry.guest_count || '-'} 人</Descriptions.Item>
                <Descriptions.Item label="当前状态">{renderStatusTag(editingInquiry.status)}</Descriptions.Item>
              </Descriptions>
            </div>
            <div>
              <Typography.Title level={5} style={{ marginTop: 0 }}>客人留言</Typography.Title>
              <MessageBlock>{editingInquiry.message}</MessageBlock>
            </div>
            <Divider orientation="left" style={{ margin: 0 }}>处理信息</Divider>
            <Form form={inquiryForm} layout="vertical" disabled={!canWrite}>
              <Form.Item name="status" label="处理状态" rules={[{ required: true, message: '请选择处理状态' }]}>
                <Select options={INQUIRY_STATUS_OPTIONS.filter((item) => item.value)} />
              </Form.Item>
              <Form.Item name="admin_note" label="后台备注" extra="仅后台人员可见，不会发送给客人。"><Input.TextArea rows={6} maxLength={4000} showCount /></Form.Item>
            </Form>
          </Space>
        ) : null}
      </Drawer>

      <Drawer
        open={contactDrawerOpen}
        onClose={() => closeContactEditor()}
        width={720}
        title="网站咨询详情"
        destroyOnHidden
        footer={(
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button disabled={contactSaving} onClick={() => closeContactEditor()}>{canWrite ? '取消' : '关闭'}</Button>
            {canWrite ? <Button type="primary" loading={contactSaving} onClick={() => void submitContact()}>保存</Button> : null}
          </div>
        )}
      >
        {editingContact ? (
          <Space direction="vertical" size={20} style={{ width: '100%' }}>
            <div>
              <Typography.Title level={5} style={{ marginTop: 0 }}>访客信息</Typography.Title>
              <Descriptions bordered column={1} styles={{ label: { width: 128 } }}>
                <Descriptions.Item label="姓名">{editingContact.guest_name || '-'}</Descriptions.Item>
                <Descriptions.Item label="邮箱"><Typography.Link href={`mailto:${editingContact.guest_email}`}>{editingContact.guest_email}</Typography.Link></Descriptions.Item>
                <Descriptions.Item label="提交时间">{formatDateTime(editingContact.created_at)}</Descriptions.Item>
                <Descriptions.Item label="当前状态">{renderStatusTag(editingContact.status, true)}</Descriptions.Item>
                {editingContact.handled_at ? <Descriptions.Item label="最近处理">{formatDateTime(editingContact.handled_at)} / {editingContact.handled_by || '-'}</Descriptions.Item> : null}
              </Descriptions>
            </div>
            <div>
              <Typography.Title level={5} style={{ marginTop: 0 }}>留言内容</Typography.Title>
              <MessageBlock>{editingContact.message}</MessageBlock>
            </div>
            <Divider orientation="left" style={{ margin: 0 }}>处理信息</Divider>
            <Form form={contactForm} layout="vertical" disabled={!canWrite}>
              <Form.Item name="status" label="处理状态" rules={[{ required: true, message: '请选择处理状态' }]}>
                <Select options={CONTACT_STATUS_OPTIONS.filter((item) => item.value)} />
              </Form.Item>
              <Form.Item name="admin_note" label="后台备注" extra="仅后台人员可见，不会发送给访客。"><Input.TextArea rows={6} maxLength={4000} showCount /></Form.Item>
            </Form>
          </Space>
        ) : null}
      </Drawer>
    </>
  )
}
