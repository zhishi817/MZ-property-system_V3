 "use client"
 import { Space, Button, Modal, Form, Input, App } from 'antd'
 import { ShareAltOutlined, LockOutlined } from '@ant-design/icons'
 import RepairReportPage from '../../public/repair-report/page'
 import { API_BASE, authHeaders } from '../../../lib/api'
 import { useState } from 'react'
 export default function MaintenancePublicRepairPage() {
   const [pwdOpen, setPwdOpen] = useState(false)
   const [sharePwdOpen, setSharePwdOpen] = useState(false)
   const [form] = Form.useForm()
   const [shareForm] = Form.useForm()
   const { message } = App.useApp()
   return (
     <Space direction="vertical" style={{ width: '100%' }}>
       <Space style={{ marginBottom: 12 }}>
         <Button icon={<ShareAltOutlined />} onClick={() => {
           try {
             const origin = typeof window !== 'undefined' ? window.location.origin : ''
             const link = `${origin}/public/repair-report`
             navigator.clipboard?.writeText(link)
             message.success('已复制分享链接')
           } catch {}
         }}>分享链接</Button>
         <Button icon={<LockOutlined />} onClick={() => setPwdOpen(true)}>设置报修密码</Button>
         <Button icon={<LockOutlined />} onClick={() => setSharePwdOpen(true)}>设置维修分享密码</Button>
       </Space>
       <RepairReportPage />
       <Modal open={pwdOpen} onCancel={() => setPwdOpen(false)} onOk={async ()=>{
         const v = await form.validateFields()
         const pass = String(v.new_password || '')
         try {
           const res = await fetch(`${API_BASE}/public/cleaning-guide/reset-password`, {
             method: 'POST',
             headers: { 'Content-Type': 'application/json', ...authHeaders() },
             body: JSON.stringify({ new_password: pass })
           })
           if (res.ok) { message.success('已更新报修密码'); setPwdOpen(false); form.resetFields() } else {
             const j = await res.json().catch(()=>null); message.error(j?.message || '更新失败')
           }
         } catch (e: any) { message.error('更新失败') }
       }} title="设置房源报修表密码" okText="保存">
         <Form form={form} layout="vertical">
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
     </Space>
   )
 }
