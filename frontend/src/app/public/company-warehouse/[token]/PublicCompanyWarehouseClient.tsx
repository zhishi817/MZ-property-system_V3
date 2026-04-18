"use client"

import { Alert, App, Card, Spin, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { API_BASE } from '../../../../lib/api'

type StepItem = { type: 'text' | 'image' | 'video'; text?: string; url?: string; caption?: string }
type Block =
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'callout'; text: string }
  | { type: 'image'; url: string; caption?: string }
  | { type: 'video'; url: string; caption?: string }
  | { type: 'step'; title: string; contents: StepItem[] }
  | { type: 'legacy_html'; html: string }

function safeHttpUrl(url: string) {
  const s = String(url || '').trim()
  if (!s) return ''
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.toString()
  } catch {
    return ''
  }
}

function isVideoFileUrl(url: string) {
  const s = String(url || '').trim().toLowerCase()
  return s.endsWith('.mp4') || s.endsWith('.webm') || s.endsWith('.ogg')
}

function parseBlocks(content: string | null | undefined): Block[] {
  const raw = String(content || '')
  const s = raw.trim()
  if (!s) return []
  try {
    const j = JSON.parse(s)
    if (Array.isArray(j)) return j as Block[]
  } catch {}
  return [{ type: 'legacy_html', html: raw }]
}

function BlocksRenderer({ blocks }: { blocks: Block[] }) {
  let stepNo = 0
  return (
    <div style={{ lineHeight: 1.7 }}>
      {blocks.map((b, idx) => {
        if (b.type === 'legacy_html') return <div key={idx} dangerouslySetInnerHTML={{ __html: b.html || '' }} />
        if (b.type === 'heading') return <h2 key={idx} style={{ margin: '16px 0 8px' }}>{b.text}</h2>
        if (b.type === 'callout') return <div key={idx} style={{ background: '#fff7e6', border: '1px solid #ffd591', padding: 10, borderRadius: 8, margin: '10px 0' }}>{b.text}</div>
        if (b.type === 'paragraph') return <p key={idx} style={{ margin: '8px 0' }}>{b.text}</p>
        if (b.type === 'image') {
          const url = safeHttpUrl(b.url)
          return (
            <figure key={idx} style={{ margin: '0 0 12px' }}>
              {url ? <img src={url} style={{ maxWidth: '100%', borderRadius: 8 }} /> : null}
              {b.caption ? <figcaption style={{ color: '#666', fontSize: 12, marginTop: 4 }}>{b.caption}</figcaption> : null}
            </figure>
          )
        }
        if (b.type === 'video') {
          const url = safeHttpUrl(b.url)
          if (!url) return null
          return (
            <div key={idx} style={{ margin: '0 0 12px' }}>
              {isVideoFileUrl(url) ? (
                <video controls src={url} style={{ width: '100%', borderRadius: 8 }} />
              ) : (
                <a href={url} target="_blank" rel="noreferrer">{url}</a>
              )}
              {b.caption ? <div style={{ color: '#666', fontSize: 12, marginTop: 4 }}>{b.caption}</div> : null}
            </div>
          )
        }
        if (b.type === 'step') {
          stepNo += 1
          const items = Array.isArray(b.contents) ? b.contents : []
          return (
            <div key={idx} style={{ margin: '14px 0 18px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <div style={{ minWidth: 28, color: '#111827', fontWeight: 700 }}>{`${stepNo}.`}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>{b.title}</div>
                {items.length ? (
                  <div style={{ marginTop: 6 }}>
                    {items.map((it, i) => {
                      if (it.type === 'text') return <div key={i} style={{ margin: '4px 0' }}>{it.text}</div>
                      const url = safeHttpUrl(String(it.url || ''))
                      if (it.type === 'image') {
                        return (
                          <figure key={i} style={{ margin: '6px 0 12px' }}>
                            {url ? <img src={url} style={{ maxWidth: '100%', borderRadius: 8 }} /> : null}
                            {it.caption ? <figcaption style={{ color: '#666', fontSize: 12, marginTop: 4 }}>{it.caption}</figcaption> : null}
                          </figure>
                        )
                      }
                      if (it.type === 'video') {
                        if (!url) return null
                        return (
                          <div key={i} style={{ margin: '6px 0 12px' }}>
                            {isVideoFileUrl(url) ? (
                              <video controls src={url} style={{ width: '100%', borderRadius: 8 }} />
                            ) : (
                              <a href={url} target="_blank" rel="noreferrer">{url}</a>
                            )}
                            {it.caption ? <div style={{ color: '#666', fontSize: 12, marginTop: 4 }}>{it.caption}</div> : null}
                          </div>
                        )
                      }
                      return null
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          )
        }
        return null
      })}
    </div>
  )
}

export default function PublicCompanyWarehouseClient({ token }: { token: string }) {
  const { message } = App.useApp()
  const [loading, setLoading] = useState(false)
  const [row, setRow] = useState<any | null>(null)

  const blocks = useMemo(() => parseBlocks(row?.content || ''), [row?.content])

  useEffect(() => {
    let active = true
    async function load() {
      if (!token) return
      setLoading(true)
      try {
        const res = await fetch(`${API_BASE}/public/company-warehouse/${encodeURIComponent(token)}`, { cache: 'no-store' })
        const j = await res.json().catch(() => null)
        if (!active) return
        if (!res.ok) {
          setRow(null)
          message.error(j?.message || '加载失败')
          return
        }
        setRow(j)
      } catch {
        if (!active) return
        setRow(null)
        message.error('加载失败')
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => { active = false }
  }, [token, message])

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', padding: '32px 16px' }}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <Card bordered={false} style={{ borderRadius: 20, boxShadow: '0 12px 32px rgba(15,23,42,0.08)' }}>
          {loading ? (
            <div style={{ padding: '60px 0', textAlign: 'center' }}>
              <Spin />
            </div>
          ) : !row ? (
            <Alert type="error" message="链接无效或已失效" showIcon />
          ) : (
            <div>
              <Typography.Title level={2} style={{ marginTop: 0, marginBottom: 8 }}>{String(row.title || '仓库指南')}</Typography.Title>
              <Typography.Text type="secondary">最后更新：{String(row.updated_at || row.published_at || '-')}</Typography.Text>
              <div style={{ marginTop: 24 }}>
                <BlocksRenderer blocks={blocks} />
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
