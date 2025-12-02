"use client"
import React from 'react'
import CrudTable, { type Field } from '../../components/CrudTable'

export default function Page() {
  const columns = [
    { title: 'Slug', dataIndex: 'slug' },
    { title: '标题', dataIndex: 'title' },
    { title: '状态', dataIndex: 'status' },
    { title: '发布日期', dataIndex: 'published_at' },
  ]
  const fields: Field[] = [
    { key: 'slug', label: 'Slug', type: 'text', required: true },
    { key: 'title', label: '标题', type: 'text', required: true },
    { key: 'content', label: '内容', type: 'text' },
    { key: 'status', label: '状态', type: 'select', options: [{ value: 'draft', label: 'draft' }, { value: 'published', label: 'published' }] },
    { key: 'published_at', label: '发布日期', type: 'date' },
  ]
  return <CrudTable resource="cms_pages" columns={columns as any} fields={fields} />
}