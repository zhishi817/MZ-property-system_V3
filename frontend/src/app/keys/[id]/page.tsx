"use client"
import { Card, Table, Image, Form, Input, Select, Upload, Button, message } from 'antd'
import { useEffect, useState } from 'react'
import { API_BASE } from '../../../lib/api'

type Item = { item_type: 'key'|'fob'; code: string; photo_url?: string }
type SetDetail = { id: string; set_type: string; status: string; code?: string; items: Item[] }
type Flow = { id: string; action: string; timestamp: string; old_code?: string; new_code?: string; note?: string }

export default function KeySetDetail({ params }: { params: { id: string } }) {
  const [data, setData] = useState<SetDetail | null>(null)
  const [form] = Form.useForm()
  const [flows, setFlows] = useState<Flow[]>([])

  async function load() {
    const res = await fetch(`${API_BASE}/keys/sets/${params.id}`)
    setData(await res.json())
    const fh = await fetch(`${API_BASE}/keys/sets/${params.id}/history`).then(r => r.json())
    setFlows(fh)
  }
  useEffect(() => { load() }, [])

  async function submit() {
    const v = await form.validateFields()
    const fd = new FormData()
    fd.append('item_type', v.item_type)
    fd.append('code', v.code)
    if (v.photo && v.photo.file) fd.append('photo', v.photo.file as any)
    const res = await fetch(`${API_BASE}/keys/sets/${params.id}/items`, { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }, body: fd })
    if (res.ok) { message.success('已添加'); form.resetFields(); load() } else { message.error('添加失败') }
  }

  const columns = [
    { title: '类型', dataIndex: 'item_type' },
    { title: '编号', dataIndex: 'code' },
    { title: '照片', dataIndex: 'photo_url', render: (url: string) => url ? <Image width={80} src={url} /> : null },
  ]
  const flowCols = [
    { title: '动作', dataIndex: 'action' },
    { title: '时间', dataIndex: 'timestamp' },
    { title: '旧编号', dataIndex: 'old_code' },
    { title: '新编号', dataIndex: 'new_code' },
    { title: '备注', dataIndex: 'note' },
  ]

  return (
    <Card title={`钥匙套件详情 ${data?.code || ''}`}> 
      <Table rowKey={(r) => r.code} columns={columns as any} dataSource={data?.items || []} pagination={false} />
      <Table style={{ marginTop: 16 }} rowKey={(r) => r.id} columns={flowCols as any} dataSource={flows} pagination={false} />
      <Form form={form} layout="inline" style={{ marginTop: 16 }}>
        <Form.Item name="item_type" label="类型" rules={[{ required: true }]}> 
          <Select style={{ width: 120 }} options={[{ value: 'key', label: '钥匙' }, { value: 'fob', label: 'Fob' }]} />
        </Form.Item>
        <Form.Item name="code" label="编号" rules={[{ required: true }]}> 
          <Input style={{ width: 160 }} />
        </Form.Item>
        <Form.Item name="photo" label="照片"> 
          <Upload beforeUpload={() => false} maxCount={1}> 
            <Button>选择文件</Button>
          </Upload>
        </Form.Item>
        <Form.Item> 
          <Button type="primary" onClick={submit}>添加物件</Button>
        </Form.Item>
      </Form>
    </Card>
  )
}