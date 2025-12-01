import React from 'react'
import CrudTable, { type Field } from '../../../../components/CrudTable'

export default function Page() {
  const columns = [
    { title: '房号', dataIndex: 'code' },
    { title: '地址', dataIndex: 'address' },
    { title: '类型', dataIndex: 'type' },
    { title: '容量', dataIndex: 'capacity' },
  ]
  const fields: Field[] = [
    { key: 'code', label: '房号', type: 'text', required: true },
    { key: 'address', label: '地址', type: 'text', required: true },
    { key: 'type', label: '类型', type: 'text' },
    { key: 'capacity', label: '容量', type: 'number' },
  ]
  return <CrudTable resource="properties" columns={columns} fields={fields} />
}