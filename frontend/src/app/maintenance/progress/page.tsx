 "use client"
 import { Card, Form, Input, Select, DatePicker, Button, Space, App, Upload, Typography, InputNumber, Switch, Modal } from 'antd'
 import type { UploadFile } from 'antd/es/upload/interface'
 import { useEffect, useMemo, useState } from 'react'
 import dayjs from 'dayjs'
 import { apiCreate, getJSON, API_BASE, authHeaders } from '../../../lib/api'
 import { sortProperties } from '../../../lib/properties'
 import { DeleteOutlined, PlusOutlined, UploadOutlined, ShareAltOutlined, LockOutlined } from '@ant-design/icons'
 
 type Property = { id: string; code?: string; address?: string }
 
 export default function MaintenanceProgressPage() {
   const [props, setProps] = useState<Property[]>([])
   const [form] = Form.useForm()
   const { message } = App.useApp()
  const [sharePwdOpen, setSharePwdOpen] = useState(false)
  const [shareForm] = Form.useForm()
  const [preFiles, setPreFiles] = useState<Record<number, UploadFile[]>>({})
  const [preUrls, setPreUrls] = useState<Record<number, string[]>>({})
  const [postFiles, setPostFiles] = useState<Record<number, UploadFile[]>>({})
  const [postUrls, setPostUrls] = useState<Record<number, string[]>>({})
 
   useEffect(() => {
     ;(async () => {
       try {
         const ps = await getJSON<Property[]>('/properties').catch(()=>[])
         setProps(Array.isArray(ps) ? ps : [])
       } catch { setProps([]) }
     })()
   }, [])
 
   const options = useMemo(() => sortProperties(props).map(p => ({ value: p.id, label: p.code || p.address || p.id })), [props])
 
  async function submit() {
    const v = await form.validateFields()
    const base = {
      property_id: v.property_id,
      occurred_at: v.occurred_at ? dayjs(v.occurred_at).format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
      worker_name: v.worker_name || '',
      submitter_name: v.worker_name || '',
      notes: v.notes || '',
      status: 'completed',
      submitted_at: new Date().toISOString()
    }
    const detailsArr: any[] = Array.isArray(v.details) ? v.details : []
    if (!detailsArr.length) { message.error('请至少添加一条维修详情'); return }
    try {
      let okCount = 0
      for (let i = 0; i < detailsArr.length; i++) {
        const d = detailsArr[i] || {}
        const payload: any = {
          ...base,
          // 问题区域映射到 category；问题摘要映射到 details[0].content
          category: String(d?.content || ''),
          details: [{ content: String(d?.item || ''), item: String(d?.item || '') }],
          completed_at: new Date().toISOString()
        }
        if (d?.maintenance_amount !== undefined) payload.maintenance_amount = Number(d.maintenance_amount || 0)
        if (d?.has_parts !== undefined) payload.has_parts = !!d.has_parts
        if (d?.parts_amount !== undefined) payload.parts_amount = Number(d.parts_amount || 0)
        if (d?.pay_method) payload.pay_method = String(d.pay_method)
        if (d?.pay_other_note) payload.pay_other_note = String(d.pay_other_note)
        const before = (preUrls[i] || []) as string[]
        const after = (postUrls[i] || []) as string[]
        if (before.length) payload.photo_urls = before
        if (after.length) payload.repair_photo_urls = after
        await apiCreate('property_maintenance', payload)
        okCount++
      }
      message.success(`已提交 ${okCount} 条维修记录`)
      form.resetFields()
      setPreFiles({}); setPreUrls({})
      setPostFiles({}); setPostUrls({})
    } catch (e: any) {
      message.error(e?.message || '提交失败')
    }
  }
 
   return (
     <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <Space style={{ marginTop: 24, marginBottom: 12 }}>
        <Button icon={<ShareAltOutlined />} onClick={() => {
          try {
            const origin = typeof window !== 'undefined' ? window.location.origin : ''
            const link = `${origin}/public/maintenance-progress`
            navigator.clipboard?.writeText(link)
            message.success('已复制外部分享链接')
          } catch {}
        }}>分享链接</Button>
        <Button icon={<LockOutlined />} onClick={() => setSharePwdOpen(true)}>设置维修分享密码</Button>
      </Space>
       <Card title="房源维修进度表" style={{ marginTop: 24 }}>
         <Form form={form} layout="vertical" initialValues={{ occurred_at: dayjs(), details: [{ content:'', item:'' }] }}>
          <div style={{ borderBottom: '1px solid #e6f4ff', paddingBottom: 8, marginBottom: 16, display:'flex', alignItems:'center', gap:8 }}>
             <div style={{ width: 4, height: 18, background:'#1677ff', borderRadius: 2 }} />
             <Typography.Text style={{ color:'#1d39c4', fontWeight: 600 }}>基本信息</Typography.Text>
           </div>
           <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
             <Form.Item name="property_id" label="房号" rules={[{ required: true }]}>
               <Select
                 options={options}
                 showSearch
                 optionFilterProp="label"
                 filterOption={(input, option) => {
                   const lbl = String((option as any)?.label || '')
                   return lbl.toLowerCase().includes(String(input || '').toLowerCase())
                 }}
               />
             </Form.Item>
             <Form.Item name="occurred_at" label="日期" rules={[{ required: true }]}>
               <DatePicker style={{ width: '100%' }} />
             </Form.Item>
           </div>
           <Form.Item name="worker_name" label="工作人员姓名" rules={[{ required: true }]}>
             <Input placeholder="请输入维修人员姓名" />
           </Form.Item>
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
                              <Form.Item noStyle shouldUpdate={(prev, cur) => {
                                const i = idx
                                return prev?.details?.[i]?.has_parts !== cur?.details?.[i]?.has_parts
                              }}>
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
                              <Form.Item noStyle shouldUpdate={(prev, cur) => {
                                const i = idx
                                return prev?.details?.[i]?.pay_method !== cur?.details?.[i]?.pay_method
                              }}>
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
                        </Space>
                        <Space direction="vertical" style={{ width:'100%', marginTop: 8 }}>
                          <Form.Item label="维修前照片">
                            <Upload.Dragger
                              listType="picture"
                              fileList={preFiles[field.name] || []}
                              onChange={({ fileList }) => {
                                setPreFiles(s => ({ ...s, [field.name]: fileList as UploadFile[] }))
                              }}
                              onRemove={(f) => {
                                setPreFiles(s => ({ ...s, [field.name]: (s[field.name] || []).filter(x => x.uid !== f.uid) }))
                                if ((f as any).url) setPreUrls(s => ({ ...s, [field.name]: (s[field.name] || []).filter(u => u !== (f as any).url) }))
                              }}
                               customRequest={async ({ file, onProgress, onSuccess, onError }: any) => {
                                const fd = new FormData(); fd.append('file', file)
                                try {
                                  const xhr = new XMLHttpRequest()
                                  xhr.open('POST', `${API_BASE}/maintenance/upload`)
                                  const headers = authHeaders() as any
                                  Object.keys(headers || {}).forEach(k => xhr.setRequestHeader(k, headers[k]))
                                  xhr.upload.onprogress = (evt) => {
                                    if (evt.lengthComputable && onProgress) {
                                      const pct = Number((((evt.loaded || 0) / (evt.total || 1)) * 100).toFixed(0))
                                      onProgress({ percent: pct })
                                    }
                                  }
                                  xhr.onreadystatechange = () => {
                                    if (xhr.readyState === 4) {
                                      try {
                                        const j = JSON.parse(xhr.responseText || '{}')
                                        if (xhr.status >= 200 && xhr.status < 300 && j?.url) {
                                          setPreUrls(s => ({ ...s, [field.name]: [ ...(s[field.name] || []), j.url ] }))
                                          onSuccess && onSuccess(j, file)
                                        } else {
                                          onError && onError(j)
                                        }
                                      } catch (e) { onError && onError(e) }
                                    }
                                  }
                                  xhr.onerror = (e) => { onError && onError(e) }
                                  xhr.send(fd)
                                } catch (e) { onError && onError(e) }
                              }}
                              style={{ width: '100%', borderColor:'#9cc5ff', background:'#f7fbff', borderStyle:'dashed', borderRadius:12 }}
                            >
                              <p className="ant-upload-drag-icon"><UploadOutlined style={{ color:'#1677ff' }} /></p>
                              <p className="ant-upload-text">上传维修前照片</p>
                            </Upload.Dragger>
                          </Form.Item>
                          <Form.Item label="维修后照片">
                            <Upload.Dragger
                              listType="picture"
                              fileList={postFiles[field.name] || []}
                              onChange={({ fileList }) => {
                                setPostFiles(s => ({ ...s, [field.name]: fileList as UploadFile[] }))
                              }}
                              onRemove={(f) => {
                                setPostFiles(s => ({ ...s, [field.name]: (s[field.name] || []).filter(x => x.uid !== f.uid) }))
                                if ((f as any).url) setPostUrls(s => ({ ...s, [field.name]: (s[field.name] || []).filter(u => u !== (f as any).url) }))
                              }}
                               customRequest={async ({ file, onProgress, onSuccess, onError }: any) => {
                                const fd = new FormData(); fd.append('file', file)
                                try {
                                  const xhr = new XMLHttpRequest()
                                  xhr.open('POST', `${API_BASE}/maintenance/upload`)
                                  const headers = authHeaders() as any
                                  Object.keys(headers || {}).forEach(k => xhr.setRequestHeader(k, headers[k]))
                                  xhr.upload.onprogress = (evt) => {
                                    if (evt.lengthComputable && onProgress) {
                                      const pct = Number((((evt.loaded || 0) / (evt.total || 1)) * 100).toFixed(0))
                                      onProgress({ percent: pct })
                                    }
                                  }
                                  xhr.onreadystatechange = () => {
                                    if (xhr.readyState === 4) {
                                      try {
                                        const j = JSON.parse(xhr.responseText || '{}')
                                        if (xhr.status >= 200 && xhr.status < 300 && j?.url) {
                                          setPostUrls(s => ({ ...s, [field.name]: [ ...(s[field.name] || []), j.url ] }))
                                          onSuccess && onSuccess(j, file)
                                        } else {
                                          onError && onError(j)
                                        }
                                      } catch (e) { onError && onError(e) }
                                    }
                                  }
                                  xhr.onerror = (e) => { onError && onError(e) }
                                  xhr.send(fd)
                                } catch (e) { onError && onError(e) }
                              }}
                              style={{ width: '100%', borderColor:'#9cc5ff', background:'#f7fbff', borderStyle:'dashed', borderRadius:12 }}
                            >
                              <p className="ant-upload-drag-icon"><UploadOutlined style={{ color:'#1677ff' }} /></p>
                              <p className="ant-upload-text">上传维修后照片</p>
                            </Upload.Dragger>
                          </Form.Item>
                        </Space>
                      </Card>
                    ))}
                   <Form.ErrorList errors={errors} />
                    <div
                      onClick={() => add()}
                      style={{ border:'1px dashed #9cc5ff', borderRadius: 12, padding:12, textAlign:'center', cursor:'pointer', color:'#1677ff', background:'#f8fbff' }}
                    >
                      <PlusOutlined /> 新增一条维修详情
                    </div>
                 </Space>
               </div>
             )}
           </Form.List>
           <Form.Item name="notes" label="其他备注">
             <Input.TextArea rows={3} placeholder="可填写其他说明" />
           </Form.Item>
           <div style={{ display:'flex', justifyContent:'flex-end' }}>
             <Button type="primary" onClick={submit}>提交进度</Button>
           </div>
         </Form>
       </Card>
      <Modal open={sharePwdOpen} onCancel={() => setSharePwdOpen(false)} onOk={async ()=>{
        const v = await shareForm.validateFields()
        const pass = String(v.new_password || '')
        try {
          const res = await fetch(`${API_BASE}/public/maintenance-share/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ new_password: pass })
          })
          if (res.ok) { message.success('已更新维修分享密码'); setSharePwdOpen(false); shareForm.resetFields() } else {
            const j = await res.json().catch(()=>null); message.error(j?.message || '更新失败')
          }
        } catch (e: any) { message.error('更新失败') }
      }} title="设置维修记录分享密码" okText="保存">
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
      </Modal>
     </div>
   )
 }
