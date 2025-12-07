"use client"
import { Form, Input, InputNumber, Button, Card, App } from 'antd'
import { useEffect } from 'react'
import { getJSON, API_BASE, authHeaders } from '../../../lib/api'

export default function InvoiceSettingsPage() {
  const [form] = Form.useForm()
  const { message } = App.useApp()
  useEffect(() => { getJSON<any>('/config/invoice').then((cfg)=>form.setFieldsValue(cfg)).catch(()=>{}) }, [])
  async function save() {
    const v = await form.validateFields()
    const res = await fetch(`${API_BASE}/config/invoice`, { method:'PATCH', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(v) })
    if (!res.ok) { message.error('保存失败'); return }
    const j = await res.json(); form.setFieldsValue(j); message.success('已保存')
  }
  return (
    <Card title="发票设置">
      <Form form={form} layout="vertical">
        <Form.Item label="公司名称" name="company_name"><Input /></Form.Item>
        <Form.Item label="公司电话" name="company_phone"><Input /></Form.Item>
        <Form.Item label="ABN" name="company_abn"><Input /></Form.Item>
        <Form.Item label="Logo路径" name="logo_path"><Input /></Form.Item>
        <Form.Item label="税率(0-1)" name="tax_rate"><InputNumber step={0.01} min={0} max={1} style={{ width: 120 }} /></Form.Item>
        <Form.Item label="付款账户名" name="pay_account_name"><Input /></Form.Item>
        <Form.Item label="BSB" name="pay_bsb"><Input /></Form.Item>
        <Form.Item label="账号" name="pay_account_no"><Input /></Form.Item>
        <Button type="primary" onClick={save}>保存</Button>
      </Form>
    </Card>
  )
}