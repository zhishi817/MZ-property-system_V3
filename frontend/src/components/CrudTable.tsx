import React, { useEffect, useState } from 'react'
import { Table, Button, Modal, Form, Input, InputNumber, DatePicker, Select, Space, App } from 'antd'
import dayjs from 'dayjs'
import { apiList, apiCreate, apiUpdate, apiDelete } from '../lib/api'

type Field = { key: string; label: string; type?: 'text'|'number'|'date'|'select'; required?: boolean; options?: { value: string; label: string }[] }
type Column = any

export default function CrudTable({ resource, columns, fields }: { resource: string; columns: Column[]; fields: Field[] }) {
  const [data, setData] = useState<any[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<any | null>(null)
  const [form] = Form.useForm()
  const { message } = App.useApp()

  async function load() {
    try { const rows = await apiList<any[]>(resource); setData(Array.isArray(rows) ? rows : []) } catch { setData([]) }
  }
  useEffect(() => { load() }, [resource])

  function fieldNode(f: Field) {
    const common = { style: { width: '100%' } }
    switch (f.type) {
      case 'number': return <InputNumber {...common} />
      case 'date': return <DatePicker {...common} format="DD/MM/YYYY" />
      case 'select': return <Select {...common} options={f.options || []} />
      default: return <Input {...common} />
    }
  }

  async function submit() {
    const v = await form.validateFields()
    const payload: any = {}
    for (const f of fields) {
      let val = v[f.key]
      if (f.type === 'date' && val) val = dayjs(val).format('YYYY-MM-DD')
      payload[f.key] = val
    }
    try {
      if (editing) await apiUpdate(resource, editing.id, payload); else await apiCreate(resource, payload)
      setOpen(false); setEditing(null); form.resetFields(); load(); message.success('已保存')
    } catch (e: any) {
      message.error(`保存失败：${e?.message || ''}`)
    }
  }

  async function remove(row: any) {
    Modal.confirm({ title: '确认删除？', onOk: async () => { try { await apiDelete(resource, row.id); load(); message.success('已删除') } catch (e: any) { message.error(`删除失败：${e?.message || ''}`) } } })
  }

  const opsCol = { title: '操作', render: (_: any, r: any) => (<Space><Button onClick={() => { setEditing(r); setOpen(true); form.setFieldsValue(r) }}>编辑</Button><Button danger onClick={() => remove(r)}>删除</Button></Space>) }

  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={() => { setEditing(null); form.resetFields(); setOpen(true) }}>新建</Button>
        <Button onClick={load}>刷新</Button>
      </Space>
      <Table rowKey={(r) => r.id} dataSource={data} columns={[...columns, opsCol] as any} pagination={{ pageSize: 10 }} />
      <Modal open={open} onCancel={() => setOpen(false)} onOk={submit} title={editing ? '编辑' : '新建'}>
        <Form form={form} layout="vertical">
          {fields.map(f => (
            <Form.Item key={f.key} name={f.key} label={f.label} rules={f.required ? [{ required: true }] : []}>
              {fieldNode(f)}
            </Form.Item>
          ))}
        </Form>
      </Modal>
    </div>
  )
}