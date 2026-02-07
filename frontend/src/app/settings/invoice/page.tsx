"use client"
import { App, Button, Card, Col, Divider, Form, Input, InputNumber, Row, Tabs } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { API_BASE, authHeaders, getJSON } from '../../../lib/api'
import { InvoiceCompaniesManager } from '../../../components/invoice/InvoiceCompaniesManager'
import { InvoiceCustomersManager } from '../../../components/invoice/InvoiceCustomersManager'

export default function InvoiceSettingsPage() {
  const { message } = App.useApp()
  const [baseForm] = Form.useForm()

  async function loadBaseConfig() {
    try {
      const cfg = await getJSON<any>('/config/invoice')
      baseForm.setFieldsValue(cfg || {})
    } catch {}
  }

  async function saveBaseConfig() {
    const v = await baseForm.validateFields()
    const res = await fetch(`${API_BASE}/config/invoice`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(v) })
    if (!res.ok) { message.error('保存失败'); return }
    const j = await res.json()
    baseForm.setFieldsValue(j)
    message.success('已保存')
  }

  useEffect(() => {
    loadBaseConfig().then(() => {})
  }, [])

  const tabs = useMemo(() => ([
    {
      key: 'companies',
      label: '开票主体',
      children: (
        <Card bordered={false}>
          <InvoiceCompaniesManager />
        </Card>
      ),
    },
    {
      key: 'customers',
      label: '常用客户',
      children: (
        <Card bordered={false}>
          <InvoiceCustomersManager />
        </Card>
      ),
    },
    {
      key: 'base',
      label: '基础设置',
      children: (
        <Card bordered={false}>
          <Form form={baseForm} layout="vertical">
            <Row gutter={16}>
              <Col xs={24} md={12}>
                <Form.Item label="公司名称" name="company_name"><Input /></Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item label="公司电话" name="company_phone"><Input /></Form.Item>
              </Col>
            </Row>
            <Row gutter={16}>
              <Col xs={24} md={12}>
                <Form.Item label="ABN" name="company_abn"><Input /></Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item label="Logo路径" name="logo_path"><Input /></Form.Item>
              </Col>
            </Row>
            <Row gutter={16}>
              <Col xs={24} md={12}>
                <Form.Item label="税率(0-1)" name="tax_rate"><InputNumber step={0.01} min={0} max={1} style={{ width: 160 }} /></Form.Item>
              </Col>
            </Row>
            <Divider />
            <Row gutter={16}>
              <Col xs={24} md={8}>
                <Form.Item label="付款账户名" name="pay_account_name"><Input /></Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item label="BSB" name="pay_bsb"><Input /></Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item label="账号" name="pay_account_no"><Input /></Form.Item>
              </Col>
            </Row>
            <Button type="primary" onClick={saveBaseConfig}>保存</Button>
          </Form>
        </Card>
      ),
    },
  ]), [])

  return (
    <Card title="发票设置" styles={{ body: { padding: 0 } }}>
      <Tabs items={tabs as any} />
    </Card>
  )
}
