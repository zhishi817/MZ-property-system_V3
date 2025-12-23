"use client"
import React from 'react'
import CrudTable, { type Field } from '../../../components/CrudTable'
import { Alert, Typography } from 'antd'

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
    { key: 'content', label: '内容（图片 + 文字）', type: 'rich' },
    { key: 'status', label: '状态', type: 'select', options: [{ value: 'draft', label: 'draft' }, { value: 'published', label: 'published' }] },
    { key: 'published_at', label: '发布日期', type: 'date' },
  ]
  return (
    <div>
      <Typography.Title level={3}>清洁公开指南</Typography.Title>
      <Alert type="info" message="使用 slug 约定：通用指南用 cleaning:general；房源指南用 cleaning:<property_code>（例如 cleaning:RM-1001）" style={{ marginBottom: 12 }} />
      <CrudTable resource="cms_pages" columns={columns as any} fields={fields} />
    </div>
  )
}