"use client"
import { Card, Form, Input, InputNumber, Select, Button, message, Space, Tag } from 'antd'
import { useEffect, useState } from 'react'
import { API_BASE } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'

type Property = {
  id: string
  code?: string
  address: string
  type: string
  capacity: number
  region?: string
  area_sqm?: number
  landlord_id?: string
  building_name?: string
  building_facilities?: string[]
  building_contact_name?: string
  building_contact_phone?: string
  building_contact_email?: string
  bed_config?: string
  tv_model?: string
  wifi_ssid?: string
  wifi_password?: string
  router_location?: string
  safety_smoke_alarm?: string
  safety_extinguisher?: string
  safety_first_aid?: string
  notes?: string
  created_at?: string
  updated_at?: string
  created_by?: string
  updated_by?: string
}

export default function PropertyDetail({ params }: { params: { id: string } }) {
  const [data, setData] = useState<Property | null>(null)
  const [dicts, setDicts] = useState<any>({})
  const [form] = Form.useForm()
  const [landlords, setLandlords] = useState<{ id: string; name: string }[]>([])
  function getBedroomCount(type?: string) {
    switch (type) {
      case '一房一卫': return 1
      case '两房一卫':
      case '两房两卫': return 2
      case '三房两卫':
      case '三房三卫': return 3
      default: return 0
    }
  }
  useEffect(() => {
    fetch(`${API_BASE}/properties/${params.id}`).then(r => r.json()).then(d => { setData(d); form.setFieldsValue(d) })
    fetch(`${API_BASE}/config/dictionaries`).then(r => r.json()).then(setDicts)
    fetch(`${API_BASE}/landlords`).then(r => r.json()).then(setLandlords)
  }, [params.id])

  async function save() {
    const v = await form.validateFields()
    const bedroomCount = getBedroomCount(v.type)
    const beds = (v.bedrooms || []).slice(0, bedroomCount)
    const bed_config = beds.map((b: string, i: number) => `Bedroom ${i + 1}: ${b || ''}`).join('; ')
    const payload = { ...v, bed_config }
    const res = await fetch(`${API_BASE}/properties/${params.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(payload) })
    if (res.ok) { message.success('已保存') } else { message.error('保存失败') }
  }

  return (
    <Card title="房源详情">
      <Form form={form} layout="vertical" disabled={!hasPerm('property.write')}>
        <Form.Item label="房号"><Input value={data?.code} readOnly /></Form.Item>
        <Form.Item name="address" label="地址" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="type" label="房型" rules={[{ required: true }]}><Select options={[{value:'一房一卫',label:'一房一卫'},{value:'两房一卫',label:'两房一卫'},{value:'两房两卫',label:'两房两卫'},{value:'三房两卫',label:'三房两卫'},{value:'三房三卫',label:'三房三卫'}]} /></Form.Item>
        <Form.Item name="capacity" label="可住人数" rules={[{ required: true }]}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
        <Form.Item name="region" label="区域"><Select options={(dicts.regions || []).map((v: string) => ({ value: v, label: v }))} /></Form.Item>
        <Form.Item name="area_sqm" label="面积(㎡)"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
        <Form.Item name="landlord_id" label="房东"><Select allowClear options={landlords.map(l => ({ value: l.id, label: l.name }))} /></Form.Item>
        <Form.Item name="floor" label="楼层"><Select options={(dicts.floors || []).map((v: string) => ({ value: v, label: v }))} /></Form.Item>
        <Form.Item name="parking_type" label="停车"><Select options={(dicts.parking_types || []).map((v: string) => ({ value: v, label: v }))} /></Form.Item>
        <Form.Item name="parking_space" label="车位"><Input /></Form.Item>
        <Form.Item name="building_name" label="大楼名称"><Input /></Form.Item>
        <Form.Item name="building_facilities" label="大楼设施"><Select mode="multiple" options={(dicts.facilities || []).map((v: string) => ({ value: v, label: v }))} /></Form.Item>
        <Form.Item name="building_contact_name" label="大楼联系人"><Input /></Form.Item>
        <Form.Item name="building_contact_phone" label="联系电话"><Input /></Form.Item>
        <Form.Item name="building_contact_email" label="联系邮箱"><Input /></Form.Item>
        <Form.Item name="access_type" label="门禁/访问方式"><Select options={(dicts.access_types || []).map((v: string) => ({ value: v, label: v }))} /></Form.Item>
        <Form.Item name="access_guide_link" label="入门指南链接"><Input /></Form.Item>
        <Form.Item name="keybox_location" label="钥匙箱位置"><Input /></Form.Item>
        <Form.Item name="keybox_code" label="钥匙箱编码"><Input /></Form.Item>
        <Form.Item name="garage_guide_link" label="车库指南链接"><Input /></Form.Item>
        {/* 动态卧室床型选择 */}
        {Array.from({ length: getBedroomCount(form.getFieldValue('type')) || 0 }).map((_, i) => (
          <Form.Item key={i} name={['bedrooms', i]} label={`Bedroom ${i + 1} 床型`}>
            <Select placeholder="选择床型" options={[{value:'Queen',label:'Queen'},{value:'King',label:'King'},{value:'Double',label:'Double'}]} />
          </Form.Item>
        ))}
        <Form.Item name="aircon_model" label="空调型号"><Input placeholder="空调品牌/型号" /></Form.Item>
        <Form.Item name="tv_model" label="电视型号"><Input /></Form.Item>
        
        <Form.Item name="notes" label="备注"><Input.TextArea rows={3} /></Form.Item>
        <Space>
          <Tag>创建时间: {data?.created_at || ''}</Tag>
          <Tag>最后修改: {data?.updated_at || ''}</Tag>
        </Space>
        {hasPerm('property.write') && <Button type="primary" onClick={save}>保存</Button>}
      </Form>
    </Card>
  )
}
