"use client"
import { App, Button, Card, DatePicker, Form, Input, InputNumber, Select, Space, Switch, Typography, Upload } from 'antd'
import type { UploadFile } from 'antd/es/upload/interface'
import { DeleteOutlined, PlusOutlined, UploadOutlined, LockOutlined } from '@ant-design/icons'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { API_BASE } from '../../../lib/api'
import { sortProperties } from '../../../lib/properties'

type Property = { id: string; code?: string; address?: string }

type DetailItem = {
  content?: string
  item?: string
  maintenance_amount?: number | string
  has_parts?: boolean
  parts_amount?: number | string
  pay_method?: string
  pay_other_note?: string
}

function storageKeyPassword() { return 'public_maintenance_progress_password' }
function storageKeyToken() { return 'public_maintenance_progress_token' }

export default function PublicMaintenanceProgressPage() {
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
      const res = await fetch(`${API_BASE}/public/maintenance-progress/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pass }) })
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
        xhr.open('POST', `${API_BASE}/public/maintenance-progress/upload`)
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
        setFileList(s => ({ ...s, [idx]: [ ...(s[idx] || []), { uid, name: (file as any)?.name || 'image', status: 'uploading', percent: 0 } as UploadFile ] }))
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
    if (!detailsArr.length) { message.error('请至少添加一条维修详情'); return }
    const payload = {
      property_id: v.property_id,
      occurred_at: v.occurred_at ? dayjs(v.occurred_at).format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
      worker_name: String(v.worker_name || '').trim(),
      notes: String(v.notes || '').trim(),
      details: detailsArr.map((d, idx) => ({
        category: String(d?.content || '').trim(),
        item: String(d?.item || '').trim(),
        maintenance_amount: d?.maintenance_amount !== undefined ? Number(d.maintenance_amount || 0) : undefined,
        has_parts: d?.has_parts === true,
        parts_amount: d?.parts_amount !== undefined ? Number(d.parts_amount || 0) : undefined,
        pay_method: d?.pay_method ? String(d.pay_method) : undefined,
        pay_other_note: d?.pay_other_note ? String(d.pay_other_note) : undefined,
        pre_photo_urls: preUrls[idx] || [],
        post_photo_urls: postUrls[idx] || [],
      }))
    }
    try {
      const res = await fetch(`${API_BASE}/public/maintenance-progress/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
        body: JSON.stringify(payload)
      })
      const j = await res.json().catch(() => null)
      if (!res.ok) { message.error(j?.message || '提交失败'); return }
      message.success(`已提交 ${Number(j?.created || 0) || 0} 条维修记录`)
      form.resetFields()
      setPreFiles({}); setPreUrls({})
      setPostFiles({}); setPostUrls({})
    } catch {
      message.error('提交失败')
    }
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: 16 }}>
      <Card title="房源维修进度表（外部）" style={{ borderRadius: 12 }}>
        <Typography.Paragraph type="secondary">用于外部人员填写维修进度，提交后会生成维修记录。</Typography.Paragraph>
        <Form form={form} layout="vertical" initialValues={{ occurred_at: dayjs(), details: [{ content:'', item:'' }] }}>
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
          <Form.Item name="worker_name" label="工作人员姓名" rules={[{ required: true }]}><Input placeholder="请输入维修人员姓名" /></Form.Item>

          <div style={{ borderBottom: '1px solid #e6f4ff', paddingBottom: 8, marginBottom: 16, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width: 4, height: 18, background:'#1677ff', borderRadius: 2 }} />
            <Typography.Text style={{ color:'#1d39c4', fontWeight: 600 }}>维修详情</Typography.Text>
          </div>
          <Form.List name="details" rules={[{ validator: async (_, value) => {
            if (!value || !value.length) return Promise.reject(new Error('请至少添加一条维修详情'))
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
                      title={<span style={{ color:'#1d39c4', fontWeight: 600 }}>维修详情 {idx + 1}</span>}
                      extra={<Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />}
                    >
                      <Space direction="vertical" style={{ width:'100%' }}>
                        <Form.Item {...field} name={[field.name, 'content']} label="问题区域" rules={[{ required: true }]}>
                          <Select
                            placeholder="请选择问题发生区域"
                            style={{ width: '100%' }}
                            options={['入户走廊','客厅','厨房','卧室','阳台','浴室','其他'].map(x => ({ value:x, label:x }))}
                            showSearch
                            optionFilterProp="label"
                          />
                        </Form.Item>
                        <Form.Item {...field} name={[field.name, 'item']} label="问题摘要">
                          <Input placeholder="例如：灯具松动需紧固" style={{ width: '100%' }} />
                        </Form.Item>
                        <div style={{ border:'1px dashed #9cc5ff', padding:12, borderRadius:12, background:'#f8fbff' }}>
                          <Typography.Text style={{ color:'#1d39c4', fontWeight:600 }}>费用信息</Typography.Text>
                          <Space direction="vertical" style={{ width:'100%', marginTop:8 }}>
                            <Form.Item {...field} name={[field.name, 'maintenance_amount']} label="维修金额（AUD）">
                              <InputNumber min={0} step={1} style={{ width:'100%' }} placeholder="请输入维修金额（AUD）" />
                            </Form.Item>
                            <Form.Item {...field} name={[field.name, 'has_parts']} label="是否包含配件费" valuePropName="checked">
                              <Switch />
                            </Form.Item>
                            <Form.Item noStyle shouldUpdate={(prev, cur) => prev?.details?.[idx]?.has_parts !== cur?.details?.[idx]?.has_parts}>
                              {() => {
                                const hp = form.getFieldValue(['details', idx, 'has_parts'])
                                return (
                                  <Form.Item {...field} name={[field.name, 'parts_amount']} label="配件费金额（AUD）" style={{ display: hp ? 'block' : 'none' }}>
                                    <InputNumber min={0} step={1} style={{ width:'100%' }} placeholder="请输入配件费（AUD）" />
                                  </Form.Item>
                                )
                              }}
                            </Form.Item>
                            <Form.Item {...field} name={[field.name, 'pay_method']} label="扣款方式">
                              <Select
                                placeholder="请选择扣款方式"
                                options={[
                                  { value:'rent_deduction', label:'租金扣除' },
                                  { value:'tenant_pay', label:'房客支付' },
                                  { value:'company_pay', label:'公司承担' },
                                  { value:'landlord_pay', label:'房东支付' },
                                  { value:'other_pay', label:'其他人支付' },
                                ]}
                              />
                            </Form.Item>
                            <Form.Item noStyle shouldUpdate={(prev, cur) => prev?.details?.[idx]?.pay_method !== cur?.details?.[idx]?.pay_method}>
                              {() => {
                                const pm = form.getFieldValue(['details', idx, 'pay_method'])
                                return (
                                  <Form.Item {...field} name={[field.name, 'pay_other_note']} label="其他人备注" style={{ display: pm === 'other_pay' ? 'block' : 'none' }}>
                                    <Input placeholder="请输入其他支付人说明" />
                                  </Form.Item>
                                )
                              }}
                            </Form.Item>
                          </Space>
                        </div>
                        <Form.Item label="维修前照片">
                          <Upload.Dragger {...makeUploadProps('pre', idx)} style={{ width: '100%', borderColor:'#9cc5ff', background:'#f7fbff', borderStyle:'dashed', borderRadius:12 }}>
                            <p className="ant-upload-drag-icon"><UploadOutlined style={{ color:'#1677ff' }} /></p>
                            <p className="ant-upload-text">上传维修前照片</p>
                          </Upload.Dragger>
                        </Form.Item>
                        <Form.Item label="维修后照片">
                          <Upload.Dragger {...makeUploadProps('post', idx)} style={{ width: '100%', borderColor:'#9cc5ff', background:'#f7fbff', borderStyle:'dashed', borderRadius:12 }}>
                            <p className="ant-upload-drag-icon"><UploadOutlined style={{ color:'#1677ff' }} /></p>
                            <p className="ant-upload-text">上传维修后照片</p>
                          </Upload.Dragger>
                        </Form.Item>
                      </Space>
                    </Card>
                  ))}
                  <Button icon={<PlusOutlined />} onClick={() => add({ content:'', item:'' })} style={{ width: '100%' }}>添加维修详情</Button>
                  {errors && errors.length ? <Typography.Text type="danger">{errors.join(',')}</Typography.Text> : null}
                </Space>
              </div>
            )}
          </Form.List>
          <Form.Item name="notes" label="备注"><Input.TextArea rows={3} /></Form.Item>
          <Form.Item>
            <Button type="primary" onClick={submit} loading={loggingIn}>提交</Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}

