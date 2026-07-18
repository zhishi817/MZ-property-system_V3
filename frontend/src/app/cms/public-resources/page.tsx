"use client"

import { App, Button, Card, Form, Input, Modal, Space, Table, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getJSON, postJSON } from '../../../lib/api'
import PublicCleaningGuideManager from '../public-cleaning/page'

export default function Page() {
  const { message } = App.useApp()
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(false)

  const items = useMemo(() => ([
    { key: 'cleaning-guide', name: '清洁公开指南', info: '/public/cleaning-guide/password-info', current: '/public/cleaning-guide/current-password', reset: '/public/cleaning-guide/reset-password', clear: '/public/cleaning-guide/clear-password' },
    { key: 'maintenance-share', name: '维修分享外链', info: '/public/maintenance-share/password-info', current: '/public/maintenance-share/current-password', reset: '/public/maintenance-share/reset-password', clear: '/public/maintenance-share/clear-password' },
    { key: 'maintenance-progress', name: '维修进度公开页', info: '/public/maintenance-progress/password-info', current: '/public/maintenance-progress/current-password', reset: '/public/maintenance-progress/reset-password', clear: '/public/maintenance-progress/clear-password' },
    { key: 'deep-cleaning-share', name: '深清分享外链', info: '/public/deep-cleaning-share/password-info', current: '/public/deep-cleaning-share/current-password', reset: '/public/deep-cleaning-share/reset-password', clear: '/public/deep-cleaning-share/clear-password' },
    { key: 'deep-cleaning-upload', name: '深清上传外链', info: '/public/deep-cleaning-upload/password-info', current: '/public/deep-cleaning-upload/current-password', reset: '/public/deep-cleaning-upload/reset-password', clear: '/public/deep-cleaning-upload/clear-password' },
    { key: 'company-expense', name: '公司支出外部登记', info: '/public/company-expense/password-info', current: '/public/company-expense/current-password', reset: '/public/company-expense/reset-password', clear: '/public/company-expense/clear-password' },
    { key: 'property-expense', name: '房源支出外部登记', info: '/public/property-expense/password-info', current: '/public/property-expense/current-password', reset: '/public/property-expense/reset-password', clear: '/public/property-expense/clear-password' },
    { key: 'property-guide', name: '入住指南外链', info: '/public/property-guide/password-info', current: '/public/property-guide/current-password', reset: '/public/property-guide/reset-password', clear: '/public/property-guide/clear-password' },
  ]), [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const out: any[] = []
      for (const item of items) {
        try {
          const info = await getJSON<any>(item.info)
          let password: string | null = null
          try {
            const current = await getJSON<any>(item.current)
            password = current?.password ? String(current.password) : null
          } catch {}
          out.push({ ...item, configured: !!info?.configured, password_updated_at: info?.password_updated_at || null, password })
        } catch (error: any) {
          out.push({ ...item, configured: false, password_updated_at: null, password: null, error: String(error?.message || 'failed') })
        }
      }
      setRows(out)
    } finally {
      setLoading(false)
    }
  }, [items])

  useEffect(() => { load() }, [load])

  async function resetPassword(row: any) {
    const holder: any = { form: null }
    const FormInner = () => {
      const [form] = Form.useForm()
      holder.form = form
      return (
        <Form form={form} layout="vertical">
          <Form.Item name="new_password" label="新密码" rules={[{ required: true }]}><Input.Password /></Form.Item>
        </Form>
      )
    }
    Modal.confirm({
      title: `重置密码：${String(row.name || '')}`,
      content: <FormInner />,
      onOk: async () => {
        const values = await holder.form.validateFields()
        const result = await postJSON<any>(row.reset, { new_password: values.new_password })
        if (result?.ok) {
          const storageWarning = result?.stored === false ? '（未加密存储，缺少密钥）' : ''
          message.success(`已重置，新密码：${String(result?.password || values.new_password)}${storageWarning}`)
        } else {
          message.success('已重置')
        }
        await load()
      },
    })
  }

  function clearPassword(row: any) {
    Modal.confirm({
      title: `清除配置：${String(row.name || '')}`,
      content: '将删除该入口的 public_access 记录，外部访问将失效（直到重新设置）。',
      okType: 'danger',
      onOk: async () => {
        try {
          await postJSON<any>(String(row.clear || ''), {})
          message.success('已清除')
          await load()
        } catch (error: any) {
          message.error(String(error?.message || '清除失败'))
        }
      },
    })
  }

  const columns = [
    { title: '项目', dataIndex: 'name', width: 220 },
    { title: '配置状态', dataIndex: 'configured', width: 120, render: (value: any) => value ? <Tag color="green">已配置</Tag> : <Tag>未配置</Tag> },
    { title: '密码', dataIndex: 'password', width: 220, render: (value: any) => value ? <Tag color="blue">{String(value)}</Tag> : <Tag>-</Tag> },
    { title: '更新时间', dataIndex: 'password_updated_at', width: 220 },
    { title: '错误', dataIndex: 'error', width: 220, render: (value: any) => value ? <Tag color="red">{String(value)}</Tag> : null },
    {
      title: '操作',
      width: 220,
      render: (_: any, row: any) => (
        <Space>
          <Button onClick={() => resetPassword(row)}>重置密码</Button>
          <Button danger onClick={() => clearPassword(row)}>清除</Button>
        </Space>
      ),
    },
  ]

  return (
    <Card>
      <Typography.Title level={3} style={{ marginTop: 0 }}>公开指南与外链</Typography.Title>
      <Space direction="vertical" size={24} style={{ width: '100%' }}>
        <PublicCleaningGuideManager />
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 0 }}>访问密码管理（对外入口）</Typography.Title>
            <Button onClick={load} loading={loading}>刷新</Button>
          </div>
          <div style={{ height: 12 }} />
          <Table
            rowKey={(row) => String(row.key)}
            dataSource={rows}
            columns={columns as any}
            loading={loading}
            pagination={false}
            tableLayout="auto"
            scroll={{ x: 'max-content' }}
          />
        </div>
      </Space>
    </Card>
  )
}
