"use client"

import { Button, Card, Form, Input, Segmented, Space, Typography, message } from 'antd'
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE } from '../../../../../lib/api'
import SignaturePad, { type SignaturePadHandle } from '../../../../../components/SignaturePad'

const PdfPreview = dynamic(() => import('../../../../../components/PdfPreview'), { ssr: false })

type SignDoc = {
  id: string
  type: 'agency_authority' | 'property_service_agreement'
  status?: string
  document_no?: string
  property_code?: string
  property_address?: string
  landlord_name?: string
  mz_signed_name?: string
  mz_signed_at?: string
  landlord_signed_name?: string
  landlord_signed_at?: string
  current_draft_url?: string
  current_signed_url?: string
  signed?: boolean
}

type Locale = 'zh' | 'en'
type LanguagePreference = Locale | 'auto'

type SignPageCopy = {
  languageLabel: string
  languageAuto: string
  titleAgency: string
  titleServiceAgreement: string
  documentNo: string
  property: string
  mzSigner: string
  previewTitle: string
  signerTitle: string
  signedTitle: string
  signedBody: string
  signedThanks: string
  signedDate: string
  signedLinkUnavailableTitle: string
  signedLinkUnavailableBody: string
  openSignedPdf: string
  signedName: string
  signedNamePlaceholder: string
  signedNameRequired: string
  handSignature: string
  signatureExtra: string
  clearSignature: string
  confirmSign: string
  loadFailed: string
  signFirst: string
  signFailed: string
  signSuccess: string
  pdfPreview: {
    loading: string
    genericError: string
    notFoundError: string
    canvasInitError: string
    pageConvertError: string
    pageAlt: (pageNumber: number) => string
  }
  apiErrors: Record<string, string>
}

const LANGUAGE_STORAGE_KEY = 'public_landlord_document_sign_language_v1'

const COPY: Record<Locale, SignPageCopy> = {
  zh: {
    languageLabel: '显示语言',
    languageAuto: '跟随手机',
    titleAgency: '授权协议在线签署',
    titleServiceAgreement: '房源合同在线签署',
    documentNo: '文档编号',
    property: '房源',
    mzSigner: 'MZ 签署人',
    previewTitle: '文档预览',
    signerTitle: '房东签署',
    signedTitle: '签署已完成',
    signedBody: '系统已生成最终签署版 PDF。',
    signedThanks: '感谢您的配合。',
    signedDate: '签署日期',
    signedLinkUnavailableTitle: '签署已完成',
    signedLinkUnavailableBody: '该签署链接已关闭。如需签署版 PDF，请联系 MZ Property。',
    openSignedPdf: '打开签署版 PDF',
    signedName: '签署姓名',
    signedNamePlaceholder: '请输入房东姓名',
    signedNameRequired: '请填写签署姓名',
    handSignature: '手写签名',
    signatureExtra: '请在下方签名，提交后系统会生成最终签署版 PDF。',
    clearSignature: '清空签名',
    confirmSign: '确认签署',
    loadFailed: '加载失败',
    signFirst: '请先签名',
    signFailed: '签署失败',
    signSuccess: '签署完成',
    pdfPreview: {
      loading: '正在加载文档预览...',
      genericError: '文档预览加载失败',
      notFoundError: '文档预览暂时无法打开，草稿 PDF 可能尚未生成或链接已失效。',
      canvasInitError: '无法初始化 PDF 画布',
      pageConvertError: 'PDF 页面转换失败',
      pageAlt: (pageNumber) => `PDF 第 ${pageNumber} 页`,
    },
    apiErrors: {
      'missing token': '签署链接缺少令牌',
      'not found': '签署链接无效或已过期',
      'draft not found': '草稿 PDF 尚未生成或已失效',
      'file not found': 'PDF 文件不存在或已失效',
      'invalid signature image': '签名图片无效，请重新签名',
      missing_mz_signature: 'MZ 签名尚未完成，暂时不能提交',
      already_signed: '该文档已经签署完成',
      'no database configured': '系统暂时无法读取文档',
      'R2 not configured': '系统暂时无法读取 PDF 文件',
      'get public sign document failed': '加载签署文档失败',
      'public sign failed': '签署提交失败',
    },
  },
  en: {
    languageLabel: 'Display Language',
    languageAuto: 'Phone Language',
    titleAgency: 'Authority Agreement Online Signing',
    titleServiceAgreement: 'Property Agreement Online Signing',
    documentNo: 'Document No.',
    property: 'Property',
    mzSigner: 'MZ Signer',
    previewTitle: 'Document Preview',
    signerTitle: 'Landlord Signature',
    signedTitle: 'Signing Complete',
    signedBody: 'The final signed PDF has been generated.',
    signedThanks: 'Thank you for your cooperation.',
    signedDate: 'Signed Date',
    signedLinkUnavailableTitle: 'Signing Complete',
    signedLinkUnavailableBody: 'This signing link is now closed. Please contact MZ Property if you need the signed PDF.',
    openSignedPdf: 'Open Signed PDF',
    signedName: 'Signing Name',
    signedNamePlaceholder: 'Enter landlord name',
    signedNameRequired: 'Please enter the signing name',
    handSignature: 'Handwritten Signature',
    signatureExtra: 'Sign below. After submission, the system will generate the final signed PDF.',
    clearSignature: 'Clear Signature',
    confirmSign: 'Confirm Signature',
    loadFailed: 'Failed to load',
    signFirst: 'Please sign first',
    signFailed: 'Signing failed',
    signSuccess: 'Signed successfully',
    pdfPreview: {
      loading: 'Loading document preview...',
      genericError: 'Failed to load the document preview',
      notFoundError: 'The document preview is unavailable. The draft PDF may not be ready or the link may have expired.',
      canvasInitError: 'Unable to initialize the PDF canvas',
      pageConvertError: 'Failed to render the PDF page',
      pageAlt: (pageNumber) => `PDF page ${pageNumber}`,
    },
    apiErrors: {
      'missing token': 'The signing link is missing a token',
      'not found': 'This signing link is invalid or has expired',
      'draft not found': 'The draft PDF is not ready or has expired',
      'file not found': 'The PDF file does not exist or has expired',
      'invalid signature image': 'The signature image is invalid. Please sign again',
      missing_mz_signature: 'The MZ signature is not complete yet',
      already_signed: 'This document has already been signed',
      'no database configured': 'The system cannot read this document right now',
      'R2 not configured': 'The system cannot read the PDF file right now',
      'get public sign document failed': 'Failed to load the signing document',
      'public sign failed': 'Failed to submit the signature',
    },
  },
}

function detectBrowserLocale(): Locale {
  if (typeof navigator === 'undefined') return 'zh'
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  return languages.some((value) => /^zh([_-]|$)/i.test(String(value || ''))) ? 'zh' : 'en'
}

function isLanguagePreference(value: any): value is LanguagePreference {
  return value === 'auto' || value === 'zh' || value === 'en'
}

function apiMessage(raw: any, fallback: string, copy: SignPageCopy) {
  const key = String(raw || '').trim()
  if (!key) return fallback
  return copy.apiErrors[key] || key
}

function displayValue(value: any) {
  return String(value || '').trim() || '-'
}

export default function PublicLandlordDocumentSignPage({ params }: { params: { token: string } }) {
  const token = String(params?.token || '')
  const [form] = Form.useForm()
  const signPadRef = useRef<SignaturePadHandle | null>(null)
  const [doc, setDoc] = useState<SignDoc | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [linkClosed, setLinkClosed] = useState(false)
  const [signedUrl, setSignedUrl] = useState('')
  const [browserLocale, setBrowserLocale] = useState<Locale>('zh')
  const [languagePreference, setLanguagePreference] = useState<LanguagePreference>('auto')
  const [languageReady, setLanguageReady] = useState(false)

  const draftUrl = useMemo(() => `${API_BASE}/public/landlord-documents/sign/${encodeURIComponent(token)}/draft.pdf`, [token])
  const locale = languagePreference === 'auto' ? browserLocale : languagePreference
  const copy = COPY[locale]
  const copyRef = useRef(copy)
  const languageOptions = useMemo(() => [
    { label: copy.languageAuto, value: 'auto' },
    { label: '中文', value: 'zh' },
    { label: 'English', value: 'en' },
  ], [copy])
  const completed = submitted || Boolean(doc?.signed || doc?.landlord_signed_at)
  const signedPdfUrl = signedUrl || doc?.current_signed_url || ''

  const load = useCallback(async () => {
    if (!token) return
    const activeCopy = copyRef.current
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/public/landlord-documents/sign/${encodeURIComponent(token)}`, { cache: 'no-store' })
      const j = await res.json().catch(() => null)
      if (res.status === 404) {
        setDoc(null)
        setSubmitted(true)
        setLinkClosed(true)
        setSignedUrl('')
        return
      }
      if (!res.ok) throw new Error(apiMessage(j?.message, activeCopy.loadFailed, activeCopy))
      setDoc(j)
      setLinkClosed(false)
      setSubmitted(Boolean(j?.signed || j?.landlord_signed_at))
      setSignedUrl(String(j?.current_signed_url || ''))
      form.setFieldsValue({ signed_name: j?.landlord_name || '' })
    } catch (e: any) {
      message.error(e?.message || activeCopy.loadFailed)
      setDoc(null)
    } finally {
      setLoading(false)
    }
  }, [form, token])

  async function submit() {
    const v = await form.validateFields()
    if (!signPadRef.current || signPadRef.current.isEmpty()) {
      message.error(copy.signFirst)
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
      if (!res.ok) throw new Error(apiMessage(j?.message, copy.signFailed, copy))
      setSubmitted(true)
      setLinkClosed(false)
      setSignedUrl(String(j?.signed_url || ''))
      message.success(copy.signSuccess)
    } catch (e: any) {
      message.error(e?.message || copy.signFailed)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setBrowserLocale(detectBrowserLocale())
    try {
      const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
      if (isLanguagePreference(saved)) setLanguagePreference(saved)
    } catch {}
    setLanguageReady(true)
  }, [])

  useEffect(() => {
    copyRef.current = copy
  }, [copy])

  useEffect(() => {
    if (!languageReady) return
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, languagePreference)
    } catch {}
  }, [languagePreference, languageReady])

  useEffect(() => {
    if (languageReady) load()
  }, [languageReady, load])

  return (
    <div lang={locale === 'zh' ? 'zh-CN' : 'en'} style={{ maxWidth: 1100, margin: '0 auto', padding: 16 }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Typography.Text type="secondary">{copy.languageLabel}</Typography.Text>
          <Segmented
            size="small"
            value={languagePreference}
            options={languageOptions}
            onChange={(value) => setLanguagePreference(value as LanguagePreference)}
          />
        </div>

        <Card loading={loading} style={{ borderRadius: 12 }}>
          <Typography.Title level={3} style={{ marginTop: 0 }}>
            {linkClosed ? copy.signedLinkUnavailableTitle : doc?.type === 'agency_authority' ? copy.titleAgency : copy.titleServiceAgreement}
          </Typography.Title>
          {linkClosed ? (
            <>
              <Typography.Paragraph style={{ marginBottom: 6 }}>{copy.signedLinkUnavailableBody}</Typography.Paragraph>
              <Typography.Paragraph style={{ marginBottom: 0 }}>{copy.signedThanks}</Typography.Paragraph>
            </>
          ) : (
            <>
              <Typography.Paragraph style={{ marginBottom: 6 }}>{copy.documentNo}: {displayValue(doc?.document_no)}</Typography.Paragraph>
              <Typography.Paragraph style={{ marginBottom: 6 }}>{copy.property}: {displayValue([doc?.property_code, doc?.property_address].filter(Boolean).join(' / '))}</Typography.Paragraph>
              <Typography.Paragraph style={{ marginBottom: 0 }}>{copy.mzSigner}: {displayValue(doc?.mz_signed_name)} {doc?.mz_signed_at ? `(${String(doc.mz_signed_at).slice(0, 10)})` : ''}</Typography.Paragraph>
            </>
          )}
        </Card>

        {completed ? (
          <Card title={copy.signedTitle} style={{ borderRadius: 12 }}>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 0 }}>{copy.signedTitle}</Typography.Title>
              <Typography.Paragraph style={{ marginBottom: 0 }}>{linkClosed ? copy.signedLinkUnavailableBody : copy.signedBody}</Typography.Paragraph>
              {doc?.landlord_signed_at ? <Typography.Paragraph style={{ marginBottom: 0 }}>{copy.signedDate}: {String(doc.landlord_signed_at).slice(0, 10)}</Typography.Paragraph> : null}
              <Typography.Paragraph style={{ marginBottom: 0 }}>{copy.signedThanks}</Typography.Paragraph>
              {signedPdfUrl ? <Button type="primary" href={signedPdfUrl} target="_blank">{copy.openSignedPdf}</Button> : null}
            </Space>
          </Card>
        ) : (
          <>
            <Card title={copy.previewTitle} style={{ borderRadius: 12 }}>
              <PdfPreview url={draftUrl} messages={copy.pdfPreview} />
            </Card>

            <Card title={copy.signerTitle} style={{ borderRadius: 12 }}>
              <Form form={form} layout="vertical">
                <Form.Item name="signed_name" label={copy.signedName} rules={[{ required: true, message: copy.signedNameRequired }]}>
                  <Input placeholder={copy.signedNamePlaceholder} />
                </Form.Item>
                <Form.Item label={copy.handSignature} required extra={copy.signatureExtra}>
                  <SignaturePad ref={signPadRef} />
                  <Space style={{ marginTop: 8 }}>
                    <Button onClick={() => signPadRef.current?.clear()}>{copy.clearSignature}</Button>
                  </Space>
                </Form.Item>
                <Button type="primary" onClick={submit} loading={loading}>{copy.confirmSign}</Button>
              </Form>
            </Card>
          </>
        )}
      </Space>
    </div>
  )
}
