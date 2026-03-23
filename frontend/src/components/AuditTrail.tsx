"use client"

import { Card, Table, Tag, Button, Space, Drawer, Descriptions, App } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { getJSON } from '../lib/api'

export type AuditEntityRef = { entity: string; entity_id: string }

type Actor = { id: string | null; username: string | null; display_name: string | null; email: string | null }

type AuditItem = {
  id: string
  entity: string
  entity_id: string
  action: string
  actor_id?: string | null
  actor?: Actor | null
  ip?: string | null
  user_agent?: string | null
  before_json?: any
  after_json?: any
  created_at: string
}

type AuditResp = { items: AuditItem[]; next_cursor: string | null }

function fmtActor(a?: Actor | null): string {
  if (!a) return ''
  return String(a.display_name || a.username || a.email || a.id || '')
}

function toMs(s?: string | null): number {
  if (!s) return 0
  const t = new Date(String(s)).getTime()
  return Number.isFinite(t) ? t : 0
}

function actionLabel(a: string): { label: string; color?: string } {
  const s = String(a || '')
  if (s === 'create' || s === 'created') return { label: 'created', color: 'green' }
  if (s === 'delete' || s === 'deleted') return { label: 'deleted', color: 'red' }
  if (s === 'archived') return { label: 'archived', color: 'orange' }
  if (s === 'unarchived') return { label: 'unarchived', color: 'blue' }
  if (s === 'voided') return { label: 'voided', color: 'red' }
  if (s === 'status_changed') return { label: 'status_changed', color: 'blue' }
  if (s === 'update' || s === 'updated') return { label: 'updated', color: 'gold' }
  return { label: s || 'event' }
}

export default function AuditTrail(props: { title?: string; refs: AuditEntityRef[] }) {
  const { message } = App.useApp()
  const refs = useMemo(() => (props.refs || []).filter(r => String(r.entity || '').trim() && String(r.entity_id || '').trim()), [props.refs])
  const [loading, setLoading] = useState(false)
  const [items, setItems] = useState<AuditItem[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerItem, setDrawerItem] = useState<AuditItem | null>(null)

  async function load() {
    if (!refs.length) { setItems([]); return }
    setLoading(true)
    try {
      const all: AuditItem[] = []
      for (const r of refs) {
        const qs = new URLSearchParams()
        qs.set('entity', r.entity)
        qs.set('entity_id', r.entity_id)
        qs.set('limit', '200')
        const j = await getJSON<AuditResp>(`/audits?${qs.toString()}`)
        const rows = Array.isArray(j?.items) ? j.items : []
        for (const it of rows) all.push(it)
      }
      const uniq: Record<string, AuditItem> = {}
      for (const it of all) uniq[String(it.id)] = it
      const merged = Object.values(uniq).sort((a, b) => toMs(b.created_at) - toMs(a.created_at))
      setItems(merged)
    } catch (e: any) {
      message.error(e?.message || '加载操作记录失败')
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [refs.map(r => `${r.entity}:${r.entity_id}`).join('|')])

  const summary = useMemo(() => {
    const asc = [...items].sort((a, b) => toMs(a.created_at) - toMs(b.created_at))
    const created = asc.find(x => ['create', 'created'].includes(String(x.action || '')))
    const updated = items.find(x => ['update', 'updated', 'status_changed', 'archived', 'unarchived', 'voided'].includes(String(x.action || '')))
    const archived = items.find(x => ['archived', 'voided'].includes(String(x.action || '')))
    return {
      created_at: created?.created_at || null,
      created_by: created?.actor ? fmtActor(created.actor) : (created?.actor_id ? String(created.actor_id) : ''),
      updated_at: updated?.created_at || null,
      updated_by: updated?.actor ? fmtActor(updated.actor) : (updated?.actor_id ? String(updated.actor_id) : ''),
      archived_at: archived?.created_at || null,
      archived_by: archived?.actor ? fmtActor(archived.actor) : (archived?.actor_id ? String(archived.actor_id) : ''),
    }
  }, [items])

  return (
    <Card
      size="small"
      title={props.title || '操作记录'}
      extra={<Button onClick={load} disabled={loading}>刷新</Button>}
    >
      <Descriptions size="small" column={3}>
        <Descriptions.Item label="创建">{summary.created_at ? `${dayjs(summary.created_at).format('YYYY-MM-DD HH:mm:ss')} ${summary.created_by || ''}` : ''}</Descriptions.Item>
        <Descriptions.Item label="更新">{summary.updated_at ? `${dayjs(summary.updated_at).format('YYYY-MM-DD HH:mm:ss')} ${summary.updated_by || ''}` : ''}</Descriptions.Item>
        <Descriptions.Item label="归档">{summary.archived_at ? `${dayjs(summary.archived_at).format('YYYY-MM-DD HH:mm:ss')} ${summary.archived_by || ''}` : ''}</Descriptions.Item>
      </Descriptions>
      <Table
        size="small"
        rowKey={(r: any) => String(r.id)}
        loading={loading}
        dataSource={items}
        pagination={{ defaultPageSize: 10, showSizeChanger: true }}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '时间', dataIndex: 'created_at', render: (v: any) => v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '' },
          { title: '动作', dataIndex: 'action', render: (v: any) => { const x = actionLabel(String(v || '')); return <Tag color={x.color}>{x.label}</Tag> } },
          { title: '操作者', render: (_: any, r: AuditItem) => <span>{r.actor ? fmtActor(r.actor) : (r.actor_id ? String(r.actor_id) : '')}</span> },
          { title: '来源', render: (_: any, r: AuditItem) => <Space size={4}><Tag>{String(r.entity || '')}</Tag><Tag>{String(r.ip || '')}</Tag></Space> },
          { title: '操作', render: (_: any, r: AuditItem) => (
            <Space>
              <Button size="small" onClick={() => { setDrawerItem(r); setDrawerOpen(true) }}>详情</Button>
            </Space>
          ) },
        ]}
      />
      <Drawer
        open={drawerOpen}
        title="记录详情"
        onClose={() => setDrawerOpen(false)}
        width={840}
      >
        <Descriptions size="small" column={1}>
          <Descriptions.Item label="时间">{drawerItem?.created_at ? dayjs(drawerItem.created_at).format('YYYY-MM-DD HH:mm:ss') : ''}</Descriptions.Item>
          <Descriptions.Item label="动作">{drawerItem ? actionLabel(drawerItem.action).label : ''}</Descriptions.Item>
          <Descriptions.Item label="操作者">{drawerItem?.actor ? fmtActor(drawerItem.actor) : (drawerItem?.actor_id ? String(drawerItem.actor_id) : '')}</Descriptions.Item>
          <Descriptions.Item label="IP">{String(drawerItem?.ip || '')}</Descriptions.Item>
          <Descriptions.Item label="User-Agent">{String(drawerItem?.user_agent || '')}</Descriptions.Item>
        </Descriptions>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Card size="small" title="Before">
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(drawerItem?.before_json ?? null, null, 2)}</pre>
          </Card>
          <Card size="small" title="After">
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(drawerItem?.after_json ?? null, null, 2)}</pre>
          </Card>
        </Space>
      </Drawer>
    </Card>
  )
}

