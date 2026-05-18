"use client"

import { Button, Card, Form, Input, Space, Typography, message } from 'antd'
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE } from '../../../../../lib/api'
import SignaturePad, { type SignaturePadHandle } from '../../../../../components/SignaturePad'

const PdfPreview = dynamic(() => import('../../../../../components/PdfPreview'), { ssr: false })

type SignDoc = {
  id: string
  type: 'agency_authority' | 'property_service_agreement'
  document_no?: string
  property_code?: string
  property_address?: string
  landlord_name?: string
  mz_signed_name?: string
  mz_signed_at?: string
  landlord_signed_at?: string
  current_draft_url?: string
}

export default function PublicLandlordDocumentSignPage({ params }: { params: { token: string } }) {
  const token = String(params?.token || '')
  const [form] = Form.useForm()
  const signPadRef = useRef<SignaturePadHandle | null>(null)
  const [doc, setDoc] = useState<SignDoc | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [signedUrl, setSignedUrl] = useState('')

  const draftUrl = useMemo(() => `${API_BASE}/public/landlord-documents/sign/${encodeURIComponent(token)}/draft.pdf`, [token])

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/public/landlord-documents/sign/${encodeURIComponent(token)}`, { cache: 'no-store' })
      const j = await res.json().catch(() => null)
      if (!res.ok) throw new Error(j?.message || '加载失败')
      setDoc(j)
      form.setFieldsValue({ signed_name: j?.landlord_name || '' })
    } catch (e: any) {
      message.error(e?.message || '加载失败')
      setDoc(null)
    } finally {
      setLoading(false)
    }
  }, [form, token])

  async function submit() {
    const v = await form.validateFields()
    if (!signPadRef.current || signPadRef.current.isEmpty()) {
      message.error('请先签名')
      return
    }
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/public/landlord-documents/sign/${encodeURIComponent(token)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signed_name: String(v.signed_name || '').trim(),
          signature_data_url: signPadRef.current.toDataURL(),
        }),
      })
      const j = await res.json().catch(() => null)
      if (!res.ok) throw new Error(j?.message || '签署失败')
      setSubmitted(true)
      setSignedUrl(String(j?.signed_url || ''))
      message.success('签署完成')
    } catch (e: any) {
      message.error(e?.message || '签署失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [load])

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 16 }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card loading={loading} style={{ borderRadius: 12 }}>
          <Typography.Title level={3} style={{ marginTop: 0 }}>
            {doc?.type === 'agency_authority' ? '授权协议在线签署' : '房源合同在线签署'}
          </Typography.Title>
          <Typography.Paragraph style={{ marginBottom: 6 }}>文档编号：{doc?.document_no || '-'}</Typography.Paragraph>
          <Typography.Paragraph style={{ marginBottom: 6 }}>房源：{[doc?.property_code, doc?.property_address].filter(Boolean).join(' / ') || '-'}</Typography.Paragraph>
          <Typography.Paragraph style={{ marginBottom: 0 }}>MZ 签署人：{doc?.mz_signed_name || '-'} {doc?.mz_signed_at ? `(${String(doc.mz_signed_at).slice(0, 10)})` : ''}</Typography.Paragraph>
        </Card>

        <Card title="文档预览" style={{ borderRadius: 12 }}>
          <PdfPreview url={draftUrl} />
        </Card>

        <Card title="房东签署" style={{ borderRadius: 12 }}>
          {submitted ? (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 0 }}>签署已完成</Typography.Title>
              <Typography.Paragraph style={{ marginBottom: 0 }}>系统已生成最终签署版 PDF。</Typography.Paragraph>
              {signedUrl ? <Button type="primary" href={signedUrl} target="_blank">打开签署版 PDF</Button> : null}
            </Space>
          ) : (
            <Form form={form} layout="vertical">
              <Form.Item name="signed_name" label="签署姓名" rules={[{ required: true, message: '请填写签署姓名' }]}>
                <Input placeholder="请输入房东姓名" />
              </Form.Item>
              <Form.Item label="手写签名" required extra="请在下方签名，提交后系统会生成最终签署版 PDF。">
                <SignaturePad ref={signPadRef} />
                <Space style={{ marginTop: 8 }}>
                  <Button onClick={() => signPadRef.current?.clear()}>清空签名</Button>
                </Space>
              </Form.Item>
              <Button type="primary" onClick={submit} loading={loading}>确认签署</Button>
            </Form>
          )}
        </Card>
      </Space>
    </div>
  )
}
