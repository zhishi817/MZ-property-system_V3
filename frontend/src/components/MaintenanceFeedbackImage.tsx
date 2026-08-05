'use client'

import { Image, Spin } from 'antd'
import type { ComponentProps } from 'react'
import { useEffect, useState } from 'react'
import { loadMaintenanceFeedbackMedia } from '../lib/maintenanceFeedbackMedia'

type Props = Omit<ComponentProps<typeof Image>, 'src'> & {
  reference: string
}

export default function MaintenanceFeedbackImage({ reference, ...imageProps }: Props) {
  const [source, setSource] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    let objectUrl = ''
    setLoading(true)
    setSource('')
    void loadMaintenanceFeedbackMedia(reference, controller.signal)
      .then((resolved) => {
        if (controller.signal.aborted) {
          if (resolved.revoke) URL.revokeObjectURL(resolved.src)
          return
        }
        if (resolved.revoke) objectUrl = resolved.src
        setSource(resolved.src)
      })
      .catch(() => {
        if (!controller.signal.aborted) setSource('')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [reference])

  if (loading) return <div style={{ height: 140, display: 'grid', placeItems: 'center' }}><Spin size="small" /></div>
  if (!source) return <span>图片加载失败</span>
  return <Image {...imageProps} alt={imageProps.alt || '维修照片'} src={source} />
}
