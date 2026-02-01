"use client"
import { App, Button, Card, DatePicker, Form, Input, Modal, Select, Space, TimePicker, Typography, Upload } from 'antd'
import type { UploadFile } from 'antd/es/upload/interface'
import { DeleteOutlined, PlusOutlined, ShareAltOutlined, LockOutlined } from '@ant-design/icons'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { API_BASE, apiCreate, authHeaders, getJSON } from '../../../lib/api'
import { sortProperties } from '../../../lib/properties'
import { getRole, hasPerm } from '../../../lib/auth'

type Property = { id: string; code?: string; address?: string }
type DetailItem = { project_desc?: string; started_at?: any; ended_at?: any; note?: string }

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

export default function DeepCleaningUploadPage() {
  const { message } = App.useApp()
  const [props, setProps] = useState<Property[]>([])
  const [form] = Form.useForm()
  const [sharePwdOpen, setSharePwdOpen] = useState(false as any)
  const [shareForm] = Form.useForm()
  const [sharePwdInfo, setSharePwdInfo] = useState<{ configured: boolean; password_updated_at: string | null } | null>(null)
  const [preFiles, setPreFiles] = useState<Record<number, UploadFile[]>>({})
  const [preUrls, setPreUrls] = useState<Record<number, string[]>>({})
  const [postFiles, setPostFiles] = useState<Record<number, UploadFile[]>>({})
  const [postUrls, setPostUrls] = useState<Record<number, string[]>>({})

  const canSetSharePwd = hasPerm('rbac.manage') && String(getRole() || '') !== 'maintenance_staff'

  useEffect(() => {
    ;(async () => {
      try {
        const ps = await getJSON<Property[]>('/properties').catch(()=>[])
        setProps(Array.isArray(ps) ? ps : [])
      } catch { setProps([]) }
    })()
  }, [])

  useEffect(() => {
    if (!sharePwdOpen || !canSetSharePwd) return
    ;(async () => {
      try {
        const info = await getJSON<{ configured: boolean; password_updated_at: string | null }>('/public/deep-cleaning-upload/password-info')
        setSharePwdInfo(info || null)
      } catch { setSharePwdInfo(null) }
    })()
  }, [sharePwdOpen, canSetSharePwd])

  const options = useMemo(() => sortProperties(props).map(p => ({ value: p.id, label: p.code || p.address || p.id })), [props])

  async function upload(file: any) {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`${API_BASE}/deep-cleaning/upload`, { method: 'POST', headers: authHeaders(), body: fd })
    const j = await res.json().catch(() => null)
    if (!res.ok) throw new Error(j?.message || `HTTP ${res.status}`)
    const url = String(j?.url || '')
    if (!url) throw new Error('upload failed')
    return url
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
      customRequest: async ({ file, onSuccess, onError }: any) => {
        try {
          const url = await upload(file)
          setUrlList(s => ({ ...s, [idx]: [ ...(s[idx] || []), url ] }))
          onSuccess && onSuccess({ url }, file)
        } catch (e: any) {
          onError && onError(e)
        }
      }
    }
  }

  async function submit() {
    const v = await form.validateFields()
    const detailsArr: DetailItem[] = Array.isArray(v.details) ? v.details : []
    if (!detailsArr.length) { message.error('请至少添加一条清洁项目'); return }
    const base = {
      property_id: v.property_id,
      occurred_at: v.occurred_at ? dayjs(v.occurred_at).format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
      worker_name: String(v.worker_name || '').trim(),
      submitter_name: String(v.worker_name || '').trim(),
      notes: String(v.notes || '').trim(),
      status: 'completed',
      submitted_at: new Date().toISOString(),
      review_status: 'pending',
    }
    try {
      let okCount = 0
      for (let i = 0; i < detailsArr.length; i++) {
        const d = detailsArr[i] || {}
        const projectDesc = String((d as any)?.project_desc || '').trim()
        if (!projectDesc) continue
        const started = combineDateAndTimeToIso(v.occurred_at ? dayjs(v.occurred_at) : dayjs(), (d as any)?.started_at) || null
        const ended = combineDateAndTimeToIso(v.occurred_at ? dayjs(v.occurred_at) : dayjs(), (d as any)?.ended_at) || null
        if (!started || !ended) continue
        const dur = Math.max(0, dayjs(ended).diff(dayjs(started), 'minute'))
        const payload: any = {
          ...base,
          project_desc: projectDesc,
          started_at: started,
          ended_at: ended,
          duration_minutes: Number.isFinite(dur) ? dur : null,
          details: JSON.stringify([{ content: projectDesc }]),
          notes: (() => {
            const baseNotes = String(v.notes || '').trim()
            const itemNote = String((d as any)?.note || '').trim()
            if (baseNotes && itemNote) return `${baseNotes}\n${itemNote}`
            return baseNotes || itemNote || ''
          })(),
          completed_at: ended || new Date().toISOString(),
        }
        const before = preUrls[i] || []
        const after = postUrls[i] || []
        if (before.length) payload.photo_urls = before
        if (after.length) payload.repair_photo_urls = after
        await apiCreate('property_deep_cleaning', payload)
        okCount++
      }
      message.success(`已提交 ${okCount} 条深度清洁记录`)
      form.resetFields()
      setPreFiles({}); setPreUrls({})
      setPostFiles({}); setPostUrls({})
    } catch (e: any) {
      message.error(e?.message || '提交失败')
    }
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <Space style={{ marginTop: 24, marginBottom: 12 }} wrap>
        <Button icon={<ShareAltOutlined />} onClick={() => {
          try {
            const origin = typeof window !== 'undefined' ? window.location.origin : ''
            const link = `${origin}/public/deep-cleaning-upload`
            navigator.clipboard?.writeText(link)
            message.success('已复制外部分享链接')
          } catch {}
        }}>分享链接</Button>
        {canSetSharePwd ? <Button icon={<LockOutlined />} onClick={() => setSharePwdOpen(true)}>设置上传表密码</Button> : null}
      </Space>

      <Card title="深度清洁上传表" style={{ marginTop: 24 }}>
        <Form form={form} layout="vertical" initialValues={{ occurred_at: dayjs(), details: [{ project_desc: '', started_at: null, ended_at: null, note: '' }] }}>
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
          <Form.Item name="worker_name" label="清洁人员姓名" rules={[{ required: true }]}>
            <Input placeholder="请输入清洁人员姓名" />
          </Form.Item>

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
                      <Form.Item noStyle shouldUpdate={(prev, cur) => prev?.details?.[idx]?.started_at !== cur?.details?.[idx]?.started_at || prev?.details?.[idx]?.ended_at !== cur?.details?.[idx]?.ended_at || prev?.occurred_at !== cur?.occurred_at}>
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
                              if (Number.isFinite(m) && m >= 0) txt = `${m} 分钟`
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

          <Button type="primary" onClick={submit}>提交</Button>
        </Form>
      </Card>

      <Modal open={sharePwdOpen} onCancel={() => setSharePwdOpen(false)} onOk={async ()=>{
        const v = await shareForm.validateFields()
        const pass = String(v.new_password || '')
        try {
          const res = await fetch(`${API_BASE}/public/deep-cleaning-upload/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ new_password: pass })
          })
          if (res.ok) {
            message.success('已更新上传表密码'); setSharePwdOpen(false); shareForm.resetFields()
            setSharePwdInfo({ configured: true, password_updated_at: new Date().toISOString() })
          } else {
            const j = await res.json().catch(()=>null); message.error(j?.message || '更新失败')
          }
        } catch { message.error('更新失败') }
      }} title="设置深度清洁上传表密码" okText="保存">
        <Space direction="vertical" style={{ width:'100%' }}>
          {sharePwdInfo ? (
            <Typography.Text type="secondary">最后更新时间：{sharePwdInfo.password_updated_at ? new Date(sharePwdInfo.password_updated_at).toLocaleString() : '未知'}</Typography.Text>
          ) : null}
          <Form form={shareForm} layout="vertical">
            <Form.Item name="new_password" label="新密码（4-6位数字）" rules={[
              { required: true, message: '请输入密码' },
              { validator: (_, val) => {
                const s = String(val || '')
                if (s.length < 4 || s.length > 6) return Promise.reject(new Error('长度需为4-6位'))
                if (!/^\d+$/.test(s)) return Promise.reject(new Error('仅允许数字'))
                return Promise.resolve()
              } }
            ]}>
              <Input placeholder="例如 1234" maxLength={6} />
            </Form.Item>
          </Form>
        </Space>
      </Modal>
    </div>
  )
}
