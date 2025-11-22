"use client"
import { Table, Card, Tag, Space, Button, message, Modal, Form, Input, Select, Image, Upload } from 'antd'
import { useEffect, useState } from 'react'
import { API_BASE } from '../../lib/api'
import Link from 'next/link'
import { hasPerm } from '../../lib/auth'

type KeySet = { id: string; set_type: string; status: string; code?: string }

export default function KeysPage() {
  const [data, setData] = useState<KeySet[]>([])
  const [open, setOpen] = useState(false)
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [form] = Form.useForm()
  const [createForm] = Form.useForm()
  const [createOpen, setCreateOpen] = useState(false)
  const [properties, setProperties] = useState<{ id: string; code?: string; address: string }[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [addForm] = Form.useForm()
  const [addSetId, setAddSetId] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailSet, setDetailSet] = useState<any>(null)
  const [query, setQuery] = useState('')

  async function load() {
    const res = await fetch(`${API_BASE}/keys`)
    setData(await res.json())
  }
  useEffect(() => { load(); fetch(`${API_BASE}/properties`).then(r => r.json()).then(setProperties).catch(() => setProperties([])) }, [])

  async function flow(id: string, action: 'borrow'|'return'|'lost') {
    const res = await fetch(`${API_BASE}/keys/sets/${id}/flows`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
    if (res.ok) { message.success('已更新'); load() } else { message.error('操作失败') }
  }

  function openReplace(id: string) { setCurrentId(id); setOpen(true) }
  async function submitReplace() {
    const values = await form.validateFields()
    const res = await fetch(`${API_BASE}/keys/sets/${currentId}/flows`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'replace', new_code: values.new_code }) })
    if (res.ok) { message.success('已更换'); setOpen(false); form.resetFields(); load() } else { message.error('操作失败') }
  }

  async function submitCreateSet() {
    const v = await createForm.validateFields()
    const res = await fetch(`${API_BASE}/keys/sets`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ set_type: v.set_type, property_code: v.property_code }) })
    if (res.ok) { message.success('已创建套件'); setCreateOpen(false); createForm.resetFields(); load() } else { message.error('创建失败') }
  }

  async function submitAddItem() {
    const v = await addForm.validateFields()
    if (!addSetId) { message.error('缺少套件'); return }
    const fd = new FormData()
    fd.append('item_type', v.item_type)
    fd.append('code', v.code)
    if (v.photo && v.photo.file) fd.append('photo', v.photo.file as any)
    const res = await fetch(`${API_BASE}/keys/sets/${addSetId}/items`, { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }, body: fd })
    if (res.ok) { message.success('已添加'); setAddOpen(false); addForm.resetFields(); load() } else { const m = await res.json().catch(() => null); message.error(m?.message || '添加失败') }
  }

  async function openDetail(set?: any) {
    if (!set) return
    const res = await fetch(`${API_BASE}/keys/sets/${set.id}`)
    setDetailSet(await res.json())
    setDetailOpen(true)
  }

  async function updateItem(item: any, values: any) {
    const fd = new FormData()
    if (values.code) fd.append('code', values.code)
    if (values.photo && values.photo.file) fd.append('photo', values.photo.file as any)
    const r = await fetch(`${API_BASE}/keys/sets/${detailSet.id}/items/${item.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }, body: fd })
    if (r.ok) { message.success('已更新'); const res = await fetch(`${API_BASE}/keys/sets/${detailSet.id}`); setDetailSet(await res.json()); load() } else { const m = await r.json().catch(() => null); message.error(m?.message || '更新失败') }
  }

  async function removeItem(item: any) {
    const r = await fetch(`${API_BASE}/keys/sets/${detailSet.id}/items/${item.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
    if (r.ok) { message.success('已删除'); const res = await fetch(`${API_BASE}/keys/sets/${detailSet.id}`); setDetailSet(await res.json()); load() } else { const m = await r.json().catch(() => null); message.error(m?.message || '删除失败') }
  }

  const columns = [
    { title: '套件类型', dataIndex: 'set_type' },
    { title: '状态', dataIndex: 'status', render: (v: string) => <Tag>{v}</Tag> },
    { title: '房号', dataIndex: 'code' },
    { title: '操作', render: (_: any, r: KeySet) => (
      <Space>
        {hasPerm('key.flow') && <Button onClick={() => flow(r.id, 'borrow')}>借用</Button>}
        {hasPerm('key.flow') && <Button onClick={() => flow(r.id, 'return')}>归还</Button>}
        {hasPerm('key.flow') && <Button danger onClick={() => flow(r.id, 'lost')}>丢失</Button>}
        {hasPerm('keyset.manage') && <Button type="primary" onClick={() => openReplace(r.id)}>更换</Button>}
        <Link href={`/keys/${r.id}`}>查看</Link>
      </Space>
    ) },
  ]

  const rows = properties.filter(p => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return (p.code || '').toLowerCase().includes(q) || (p.address || '').toLowerCase().includes(q)
  }).map(p => {
    const findSet = (t: string) => data.find(s => s.code === (p.code || '') && s.set_type === t) as any
    const guest = findSet('guest')
    const spare1 = findSet('spare_1')
    const spare2 = findSet('spare_2')
    const other = findSet('other')
    return {
      key: p.id,
      code: p.code || '',
      guest,
      spare1,
      spare2,
      other,
    }
  })

  const imgCell = (set?: any) => {
    if (!set) return <Tag color="red">未初始化</Tag>
    const first = (set.items || [])[0]
    return (
      <Space wrap>
        {first && first.photo_url ? <Image width={40} src={`${API_BASE}${first.photo_url}`} /> : null}
        {hasPerm('keyset.manage') && <Button size="small" onClick={() => { setAddSetId(set.id); setAddOpen(true) }}>添加</Button>}
        <Button size="small" onClick={() => openDetail(set)}>查看详情</Button>
      </Space>
    )
  }

  const tableColumns = [
    { title: '房号', dataIndex: 'code' },
    { title: '客人钥匙/Fob', dataIndex: 'guest', render: (_: any, r: any) => r.guest ? imgCell(r.guest) : (
      <Space>
        <Tag color="red">未初始化</Tag>
        {hasPerm('keyset.manage') && <Button size="small" onClick={async () => { const res = await fetch(`${API_BASE}/keys/sets`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ set_type: 'guest', property_code: r.code }) }); if (res.ok) { message.success('已初始化'); load() } else { message.error('初始化失败') } }}>初始化</Button>}
      </Space>
    ) },
    { title: '备用钥匙/Fob-1', dataIndex: 'spare1', render: (_: any, r: any) => r.spare1 ? imgCell(r.spare1) : (
      <Space>
        <Tag color="red">未初始化</Tag>
        {hasPerm('keyset.manage') && <Button size="small" onClick={async () => { const res = await fetch(`${API_BASE}/keys/sets`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ set_type: 'spare_1', property_code: r.code }) }); if (res.ok) { message.success('已初始化'); load() } else { message.error('初始化失败') } }}>初始化</Button>}
      </Space>
    ) },
    { title: '备用钥匙/Fob-2', dataIndex: 'spare2', render: (_: any, r: any) => r.spare2 ? imgCell(r.spare2) : (
      <Space>
        <Tag color="red">未初始化</Tag>
        {hasPerm('keyset.manage') && <Button size="small" onClick={async () => { const res = await fetch(`${API_BASE}/keys/sets`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ set_type: 'spare_2', property_code: r.code }) }); if (res.ok) { message.success('已初始化'); load() } else { message.error('初始化失败') } }}>初始化</Button>}
      </Space>
    ) },
    { title: '房源其他钥匙', dataIndex: 'other', render: (_: any, r: any) => r.other ? imgCell(r.other) : (
      <Space>
        <Tag color="red">未初始化</Tag>
        {hasPerm('keyset.manage') && <Button size="small" onClick={async () => { const res = await fetch(`${API_BASE}/keys/sets`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ set_type: 'other', property_code: r.code }) }); if (res.ok) { message.success('已初始化'); load() } else { message.error('初始化失败') } }}>初始化</Button>}
      </Space>
    ) },
  ]

  return (
    <Card title="钥匙管理" extra={<Space><Input.Search allowClear placeholder="搜索房源" onSearch={setQuery} onChange={(e) => setQuery(e.target.value)} style={{ width: 260 }} /></Space>}>
      <Table rowKey={(r) => r.key} columns={tableColumns as any} dataSource={rows} pagination={{ pageSize: 20 }} />
      <Modal open={open} onCancel={() => setOpen(false)} onOk={submitReplace} title="更换编号">
        <Form form={form} layout="vertical">
          <Form.Item name="new_code" label="新编号" rules={[{ required: true }]}> 
            <Input />
          </Form.Item>
        </Form>
      </Modal>
      
      <Modal open={addOpen} onCancel={() => setAddOpen(false)} onOk={submitAddItem} title="添加物件">
        <Form form={addForm} layout="vertical">
          <Form.Item name="item_type" label="类型" rules={[{ required: true }]}>
            <Select options={[{ value: 'key', label: '钥匙' }, { value: 'fob', label: 'Fob' }]} />
          </Form.Item>
          <Form.Item name="code" label="编号" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="photo" label="照片">
            <Upload beforeUpload={() => false} maxCount={1}>
              <Button>选择文件</Button>
            </Upload>
          </Form.Item>
        </Form>
      </Modal>
      <Modal open={detailOpen} onCancel={() => setDetailOpen(false)} footer={null} title="套件详情">
        {detailSet && (
          <div>
            <Space style={{ marginBottom: 12 }}>
              <Tag>{detailSet.set_type}</Tag>
              <Tag>{detailSet.status}</Tag>
              <Tag>{detailSet.code}</Tag>
            </Space>
            <Table
              rowKey={(r: any) => r.id}
              columns={[
                { title: '类型', dataIndex: 'item_type' },
                { title: '编号', dataIndex: 'code' },
                { title: '照片', dataIndex: 'photo_url', render: (url: string) => url ? <Image width={60} src={`${API_BASE}${url}`} /> : null },
                { title: '操作', render: (_: any, it: any) => (
                  <Space>
                    <Button size="small" onClick={() => {
                      Modal.confirm({ title: '编辑物件', content: <Form form={addForm} layout="vertical"><Form.Item name="code" label="编号" initialValue={it.code}><Input /></Form.Item><Form.Item name="photo" label="照片"><Upload beforeUpload={() => false} maxCount={1}><Button>选择文件</Button></Upload></Form.Item></Form>, onOk: async () => { const v = await addForm.validateFields(); await updateItem(it, v) } })
                    }}>编辑</Button>
                    <Button size="small" danger onClick={() => removeItem(it)}>删除</Button>
                  </Space>
                ) },
              ] as any}
              dataSource={detailSet.items || []}
              pagination={false}
            />
          </div>
        )}
      </Modal>
    </Card>
  )
}