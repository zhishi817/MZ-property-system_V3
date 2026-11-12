'use client'

import { Button, Image, Space, Spin } from 'antd'
import { useEffect, useState } from 'react'
import { deepCleaningMediaReferences, deepCleaningNonImageLink, deepCleaningMediaRequest, loadDeepCleaningMedia } from '../lib/deepCleaningRecordDisplay'

export function DeepCleaningMediaItem({ reference }: { reference: string }) {
  const [source, setSource] = useState('')
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const fileLink = deepCleaningNonImageLink(reference)
  const publicFallback = deepCleaningMediaRequest(reference)?.authenticated === false ? reference : ''
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl = ''
    setSource(''); setFailed(false); setLoading(true)
    if (fileLink) { setSource(fileLink); setLoading(false); return () => controller.abort() }
    void loadDeepCleaningMedia(reference, controller.signal).then(resolved => {
      if (controller.signal.aborted) { if (resolved.revoke) URL.revokeObjectURL(resolved.src); return }
      if (resolved.revoke) objectUrl = resolved.src
      setSource(resolved.src)
    }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [reference, attempt, fileLink])
  if (loading) return <div style={{ height: 140, display: 'grid', placeItems: 'center' }}><Spin size="small" /></div>
  if (failed || !source) return <Space direction="vertical"><span>材料加载失败或无访问权限</span><Button size="small" onClick={() => setAttempt(x => x + 1)}>重试</Button>{publicFallback ? <a href={publicFallback} target="_blank" rel="noreferrer">打开原始材料</a> : null}</Space>
  if (fileLink) return <a href={fileLink} target="_blank" rel="noreferrer">{reference.split('/').pop()?.split(/[?#]/)[0] || '查看材料'}</a>
  return <Image src={source} alt="深度清洁照片" width="100%" height={140} style={{ objectFit: 'cover', borderRadius: 8 }} onError={() => setFailed(true)} />
}

export default function DeepCleaningMedia({ references }: { references: unknown }) {
  const items = deepCleaningMediaReferences(references)
  if (!items.length) return <span>-</span>
  return <Image.PreviewGroup><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
    {items.map(reference => <DeepCleaningMediaItem key={reference} reference={reference} />)}
  </div></Image.PreviewGroup>
}
