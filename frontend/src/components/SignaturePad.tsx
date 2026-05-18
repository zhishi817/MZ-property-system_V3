"use client"

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

export type SignaturePadHandle = {
  clear: () => void
  isEmpty: () => boolean
  toDataURL: () => string
  loadDataURL: (dataUrl: string) => void
}

type Props = {
  height?: number
}

export const SignaturePad = forwardRef<SignaturePadHandle, Props>(function SignaturePad({ height = 180 }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawingRef = useRef(false)
  const emptyRef = useRef(true)

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const dpr = typeof window !== 'undefined' ? Math.max(1, window.devicePixelRatio || 1) : 1
    const prev = emptyRef.current ? '' : canvas.toDataURL('image/png')
    canvas.width = Math.max(1, Math.floor(rect.width * dpr))
    canvas.height = Math.max(1, Math.floor(height * dpr))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, rect.width, height)
    ctx.strokeStyle = '#111111'
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (prev) {
      const img = new Image()
      img.onload = () => {
        ctx.drawImage(img, 0, 0, rect.width, height)
      }
      img.src = prev
    }
  }, [height])

  function pointFromEvent(event: PointerEvent | ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  function startDraw(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    const point = pointFromEvent(event)
    if (!canvas || !ctx || !point) return
    drawingRef.current = true
    emptyRef.current = false
    canvas.setPointerCapture?.(event.pointerId)
    ctx.beginPath()
    ctx.moveTo(point.x, point.y)
  }

  function moveDraw(event: ReactPointerEvent<HTMLCanvasElement>) {
    const ctx = canvasRef.current?.getContext('2d')
    const point = pointFromEvent(event)
    if (!drawingRef.current || !ctx || !point) return
    ctx.lineTo(point.x, point.y)
    ctx.stroke()
  }

  function endDraw(event?: ReactPointerEvent<HTMLCanvasElement>) {
    drawingRef.current = false
    const canvas = canvasRef.current
    if (event && canvas) {
      try { canvas.releasePointerCapture?.(event.pointerId) } catch {}
    }
  }

  useEffect(() => {
    resizeCanvas()
    const onResize = () => resizeCanvas()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [resizeCanvas])

  useImperativeHandle(ref, () => ({
    clear() {
      emptyRef.current = true
      resizeCanvas()
    },
    isEmpty() {
      return emptyRef.current
    },
    toDataURL() {
      return canvasRef.current?.toDataURL('image/png') || ''
    },
    loadDataURL(dataUrl: string) {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      resizeCanvas()
      const next = String(dataUrl || '').trim()
      if (!next) {
        emptyRef.current = true
        return
      }
      emptyRef.current = false
      const img = new Image()
      img.onload = () => {
        const rect = canvas.getBoundingClientRect()
        ctx.drawImage(img, 0, 0, rect.width, height)
      }
      img.src = next
    },
  }), [height, resizeCanvas])

  return (
    <div style={{ border: '1px solid #d9d9d9', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height, display: 'block', touchAction: 'none', cursor: 'crosshair' }}
        onPointerDown={startDraw}
        onPointerMove={moveDraw}
        onPointerUp={endDraw}
        onPointerLeave={() => endDraw()}
      />
    </div>
  )
})

export default SignaturePad
