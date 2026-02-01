"use client"
import { App, Button, Card, DatePicker, Form, Input, Select, Space, TimePicker, Typography, Upload } from 'antd'
import type { UploadFile } from 'antd/es/upload/interface'
import { DeleteOutlined, PlusOutlined, LockOutlined } from '@ant-design/icons'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { API_BASE } from '../../../lib/api'
import { sortProperties } from '../../../lib/properties'

type Property = { id: string; code?: string; address?: string }
type DetailItem = { project_desc?: string; started_at?: any; ended_at?: any; note?: string }

function storageKeyPassword() { return 'public_deep_cleaning_upload_password' }
function storageKeyToken() { return 'public_deep_cleaning_upload_token' }

function combineDateAndTimeToIso(dateVal: any, timeVal: any): string | undefined {
  try {
    if (!dateVal || !timeVal) return undefined
    const d = dayjs(dateVal)
    const t = dayjs(timeVal)
    if (!d.isValid() || !t.isValid()) return undefined
    const dt = d.hour(t.hour()).minute(t.minute()).second(t.second()).millisecond(0)
    return dt.toDate().toISOString()
  } catch {
    return undefined
  }
}

export default function PublicDeepCleaningUploadPage() {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [props, setProps] = useState<Property[]>([])
  const [pwd, setPwd] = useState('')
  const [token, setToken] = useState<string>('')
  const [loggingIn, setLoggingIn] = useState(false)
  const [preFiles, setPreFiles] = useState<Record<number, UploadFile[]>>({})
  const [preUrls, setPreUrls] = useState<Record<number, string[]>>({})
  const [postFiles, setPostFiles] = useState<Record<number, UploadFile[]>>({})
  const [postUrls, setPostUrls] = useState<Record<number, string[]>>({})

  useEffect(() => {
    fetch(`${API_BASE}/public/properties`).then(r => r.json()).then((j) => setProps(Array.isArray(j) ? j : [])).catch(() => setProps([]))
    try {
      const p = localStorage.getItem(storageKeyPassword()) || ''
      if (p) setPwd(p)
      const tk = localStorage.getItem(storageKeyToken()) || ''
      if (tk) setToken(tk)
    } catch {}
  }, [])

  const options = useMemo(() => sortProperties(props).map(p => ({ value: p.id, label: p.code || p.address || p.id })), [props])

  async function ensureToken(): Promise<string | null> {
    const pass = String(pwd || '').trim()
    if (pass.length < 4 || pass.length > 6 || !/^\d+$/.test(pass)) { message.error('请输入4-6位数字密码'); return null }
    if (token) return token
    setLoggingIn(true)
    try {
      const res = await fetch(`${API_BASE}/public/deep-cleaning-upload/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pass }) })
      const j = await res.json().catch(() => null)
      if (res.ok && j?.token) {
        const tk = String(j.token)
        setToken(tk)
        try { localStorage.setItem(storageKeyToken(), tk) } catch {}
        return tk
      }
      try { localStorage.removeItem(storageKeyToken()) } catch {}
      setToken('')
      message.error(j?.message || '认证失败')
      return null
    } catch {
      try { localStorage.removeItem(storageKeyToken()) } catch {}
      setToken('')
      message.error('认证失败')
      return null
    } finally {
      setLoggingIn(false)
    }
  }

  function xhrUpload(file: any, tk: string, onProgress?: (pct: number) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const fd = new FormData()
        fd.append('file', file)
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `${API_BASE}/public/deep-cleaning-upload/upload`)
        xhr.setRequestHeader('Authorization', `Bearer ${tk}`)
        xhr.upload.onprogress = (evt) => {
          if (evt.lengthComputable && onProgress) {
            const pct = Number((((evt.loaded || 0) / (evt.total || 1)) * 100).toFixed(0))
            onProgress(pct)
          }
        }
        xhr.onreadystatechange = () => {
          if (xhr.readyState !== 4) return
          try {
            const j = JSON.parse(xhr.responseText || '{}')
            if (xhr.status >= 200 && xhr.status < 300 && j?.url) resolve(String(j.url))
            else reject(new Error(String(j?.message || 'upload failed')))
          } catch (e) {
            reject(e)
          }
        }
        xhr.onerror = (e) => reject(e as any)
        xhr.send(fd)
      } catch (e) {
        reject(e)
      }
    })
  }

  function makeUploadProps(kind: 'pre' | 'post', idx: number) {
    const fileList = kind === 'pre' ? (preFiles[idx] || []) : (postFiles[idx] || [])
    const setFileList = kind === 'pre' ? setPreFiles : setPostFiles
    const setUrlList = kind === 'pre' ? setPreUrls : setPostUrls
    return {
      multiple: true,
      listType: 'picture' as const,
      fileList,
      onChange: ({ fileList: fl }: any) => { setFileList(s => ({ ...s, [idx]: fl as UploadFile[] })) },
      onRemove: (f: any) => {
        setFileList(s => ({ ...s, [idx]: (s[idx] || []).filter(x => x.uid !== f.uid) }))
        if (f.url) setUrlList(s => ({ ...s, [idx]: (s[idx] || []).filter(u => u !== f.url) }))
      },
      customRequest: async ({ file, onProgress, onSuccess, onError }: any) => {
        const tk = await ensureToken()
        if (!tk) { onError && onError(new Error('unauthorized')); return }
        const uid = Math.random().toString(36).slice(2)
        setFileList(s => ({ ...s, [idx]: [ ...(s[idx] || []), { uid, name: (file as any)?.name || 'file', status: 'uploading', percent: 0 } as UploadFile ] }))
        try {
          const url = await xhrUpload(file, tk, (pct) => {
            onProgress && onProgress({ percent: pct })
            setFileList(s => ({ ...s, [idx]: (s[idx] || []).map(x => x.uid === uid ? { ...x, percent: pct, status: 'uploading' } as UploadFile : x) }))
          })
          setUrlList(s => ({ ...s, [idx]: [ ...(s[idx] || []), url ] }))
          setFileList(s => ({ ...s, [idx]: (s[idx] || []).map(x => x.uid === uid ? { ...x, percent: 100, status: 'done', url } as UploadFile : x) }))
          onSuccess && onSuccess({ url }, file)
        } catch (e) {
          setFileList(s => ({ ...s, [idx]: (s[idx] || []).map(x => x.uid === uid ? { ...x, status: 'error' } as UploadFile : x) }))
          onError && onError(e)
        }
      }
    }
  }

  async function submit() {
    const v = await form.validateFields()
    const tk = await ensureToken()
    if (!tk) return
    const detailsArr: DetailItem[] = Array.isArray(v.details) ? v.details : []
    if (!detailsArr.length) { message.error('请至少添加一条清洁项目'); return }
    const baseDate = v.occurred_at ? dayjs(v.occurred_at) : dayjs()
    const payload = {
      property_id: v.property_id,
      occurred_at: baseDate.format('YYYY-MM-DD'),
      worker_name: String(v.worker_name || '').trim(),
      notes: String(v.notes || '').trim(),
      details: detailsArr.map((d, idx) => ({
        project_desc: String(d?.project_desc || '').trim(),
        started_at: combineDateAndTimeToIso(baseDate, d?.started_at),
        ended_at: combineDateAndTimeToIso(baseDate, d?.ended_at),
        note: d?.note ? String(d.note) : undefined,
        pre_photo_urls: preUrls[idx] || [],
        post_photo_urls: postUrls[idx] || [],
      })),
    }
    try {
      const res = await fetch(`${API_BASE}/public/deep-cleaning-upload/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
        body: JSON.stringify(payload)
      })
      const j = await res.json().catch(() => null)
      if (!res.ok) { message.error(j?.message || '提交失败'); return }
      message.success(`已提交 ${Number(j?.created || 0) || 0} 条深度清洁记录`)
      form.resetFields()
      setPreFiles({}); setPreUrls({})
      setPostFiles({}); setPostUrls({})
    } catch {
      message.error('提交失败')
    }
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: 16 }}>
      <Card title="深度清洁上传表（外部）" style={{ borderRadius: 12 }}>
        <Typography.Paragraph type="secondary">用于外部人员填写深度清洁记录，提交后会生成清洁记录。</Typography.Paragraph>
        <Form
          form={form}
          layout="vertical"
          initialValues={{ occurred_at: dayjs(), details: [{ project_desc: '', started_at: null, ended_at: null, note: '' }] }}
        >
          <div style={{ borderBottom: '1px solid #e6f4ff', paddingBottom: 8, marginBottom: 16, display:'flex', alignItems:'center', gap:8 }}>
            <LockOutlined style={{ color:'#1677ff' }} />
            <Typography.Text style={{ color:'#1d39c4', fontWeight: 600 }}>访问密码</Typography.Text>
          </div>
          <Form.Item name="password" label="访问密码（4-6位数字）" rules={[{ required: true }, { validator: (_, val) => {
            const s = String(val || '').trim()
            if (s.length < 4 || s.length > 6) return Promise.reject(new Error('长度需为4-6位'))
            if (!/^\d+$/.test(s)) return Promise.reject(new Error('仅允许数字'))
            setPwd(s)
            try { localStorage.setItem(storageKeyPassword(), s) } catch {}
            return Promise.resolve()
          } }]}><Input.Password placeholder="例如 1234" /></Form.Item>

          <div style={{ borderBottom: '1px solid #e6f4ff', paddingBottom: 8, marginBottom: 16, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width: 4, height: 18, background:'#1677ff', borderRadius: 2 }} />
            <Typography.Text style={{ color:'#1d39c4', fontWeight: 600 }}>基本信息</Typography.Text>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
            <Form.Item name="property_id" label="房号" rules={[{ required: true }]}>
              <Select options={options} showSearch optionFilterProp="label" />
            </Form.Item>
            <Form.Item name="occurred_at" label="日期" rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </div>
          <Form.Item name="worker_name" label="清洁人员姓名" rules={[{ required: true }]}><Input placeholder="请输入清洁人员姓名" /></Form.Item>

          <div style={{ borderBottom: '1px solid #e6f4ff', paddingBottom: 8, marginBottom: 16, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width: 4, height: 18, background:'#1677ff', borderRadius: 2 }} />
            <Typography.Text style={{ color:'#1d39c4', fontWeight: 600 }}>清洁项目</Typography.Text>
          </div>
          <Form.List name="details" rules={[{ validator: async (_, value) => {
            if (!value || !value.length) return Promise.reject(new Error('请至少添加一条清洁项目'))
            return Promise.resolve()
          } }]}>
            {(fields, { add, remove }, { errors }) => (
              <div>
                <Space direction="vertical" style={{ width: '100%' }}>
                  {fields.map((field, idx) => (
                    <Card
                      key={field.key}
                      size="small"
                      style={{ borderRadius: 12, border:'1px solid #e6f4ff', background:'#fafcff', boxShadow:'0 1px 0 rgba(22,119,255,0.06)' }}
                      title={<span style={{ color:'#1d39c4', fontWeight: 600 }}>清洁项目 {idx + 1}</span>}
                      extra={<Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />}
                    >
                      <Form.Item {...field} name={[field.name, 'project_desc']} label="清洁项目描述" rules={[{ required: true, min: 3 }]}>
                        <Input.TextArea rows={2} placeholder="例如：全屋深度清洁（厨房除油/浴室除垢/全屋消毒）" />
                      </Form.Item>
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
                        <Form.Item {...field} name={[field.name, 'started_at']} label="清洁开始时间" rules={[{ required: true }]}>
                          <TimePicker style={{ width: '100%' }} format="HH:mm" />
                        </Form.Item>
                        <Form.Item {...field} name={[field.name, 'ended_at']} label="清洁结束时间" rules={[{ required: true }]}>
                          <TimePicker style={{ width: '100%' }} format="HH:mm" />
                        </Form.Item>
                      </div>
                      <Form.Item noStyle shouldUpdate={(prev, cur) => prev?.details?.[idx]?.started_at !== cur?.details?.[idx]?.started_at || prev?.details?.[idx]?.ended_at !== cur?.details?.[idx]?.ended_at}>
                        {() => {
                          const s = form.getFieldValue(['details', idx, 'started_at'])
                          const e = form.getFieldValue(['details', idx, 'ended_at'])
                          const d0 = form.getFieldValue('occurred_at')
                          let txt = '-'
                          try {
                            if (d0 && s && e) {
                              const startIso = combineDateAndTimeToIso(d0, s)
                              const endIso = combineDateAndTimeToIso(d0, e)
                              const m = startIso && endIso ? dayjs(endIso).diff(dayjs(startIso), 'minute') : NaN
                              if (Number.isFinite(m) && m >= 0) {
                                const h = Math.floor(m / 60)
                                const mm = m % 60
                                txt = h > 0 ? `${h} 小时 ${mm} 分钟` : `${mm} 分钟`
                              }
                            }
                          } catch {}
                          return <div style={{ marginBottom: 12 }}><Typography.Text type="secondary">自动计算清洁时长：{txt}</Typography.Text></div>
                        }}
                      </Form.Item>
                      <Form.Item label="清洁前照片">
                        <Upload {...makeUploadProps('pre', idx)}>
                          <Button>上传</Button>
                        </Upload>
                      </Form.Item>
                      <Form.Item label="清洁后照片">
                        <Upload {...makeUploadProps('post', idx)}>
                          <Button>上传</Button>
                        </Upload>
                      </Form.Item>
                      <Form.Item {...field} name={[field.name, 'note']} label="备注">
                        <Input placeholder="可选" />
                      </Form.Item>
                    </Card>
                  ))}
                  <Button icon={<PlusOutlined />} onClick={() => add({ project_desc: '', started_at: null, ended_at: null, note: '' })}>新增清洁项目</Button>
                  <Form.ErrorList errors={errors} />
                </Space>
              </div>
            )}
          </Form.List>

          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={2} placeholder="可选" />
          </Form.Item>

          <Button type="primary" onClick={submit} loading={loggingIn} disabled={loggingIn}>提交</Button>
        </Form>
      </Card>
    </div>
  )
}
