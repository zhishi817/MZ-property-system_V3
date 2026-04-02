 "use client"
 import { Space, Button, Modal, Form, Input, App, Card, Typography } from 'antd'
 import { ShareAltOutlined, LockOutlined } from '@ant-design/icons'
 import RepairReportPage from '../../public/repair-report/page'
 import { API_BASE, authHeaders } from '../../../lib/api'
 import { useEffect, useState } from 'react'
 import { hasPerm } from '../../../lib/auth'
 export default function MaintenancePublicRepairPage() {
   const [pwdOpen, setPwdOpen] = useState(false)
   const [form] = Form.useForm()
   const { message } = App.useApp()
   const canViewPwd = hasPerm('rbac.manage')
   const [pwdInfo, setPwdInfo] = useState<{ configured: boolean; password_updated_at: string | null } | null>(null)
   const [pwdCurrent, setPwdCurrent] = useState<{ configured: boolean; password: string | null; password_updated_at: string | null; reason?: string } | null>(null)
  const [pwdVisible, setPwdVisible] = useState(false)

   async function safeAdminGet<T>(path: string): Promise<T | null> {
     try {
       const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store', headers: authHeaders() })
       if (res.status === 401) return null
       if (!res.ok) return null
       return (await res.json().catch(() => null)) as T
     } catch {
       return null
     }
   }

   useEffect(() => {
     if (!canViewPwd) return
     ;(async () => {
       const info = await safeAdminGet<{ configured: boolean; password_updated_at: string | null }>('/public/cleaning-guide/password-info')
       setPwdInfo(info || null)
       const cur = await safeAdminGet<{ configured: boolean; password: string | null; password_updated_at: string | null; reason?: string }>('/public/cleaning-guide/current-password')
       setPwdCurrent((prev) => {
         if (cur?.password) return cur
         if (prev?.password) return prev
         return cur || null
       })
     })()
   }, [canViewPwd, pwdOpen])

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
         {canViewPwd ? <Button icon={<LockOutlined />} onClick={() => setPwdOpen(true)}>设置报修密码</Button> : null}
       </Space>
       {canViewPwd ? (
         <Card size="small" title="外部链接密码" style={{ marginBottom: 12 }}>
           <Space direction="vertical" style={{ width:'100%' }}>
             <Typography.Text type="secondary">
               最后更新时间：{pwdInfo?.password_updated_at ? new Date(pwdInfo.password_updated_at).toLocaleString() : '未知'}
             </Typography.Text>
             {pwdCurrent?.password ? (
               <Space.Compact style={{ width:'100%' }}>
                 <Input readOnly type={pwdVisible ? 'text' : 'password'} value={pwdCurrent.password} style={{ width:'100%' }} />
                 <Button onClick={() => setPwdVisible(v => !v)}>{pwdVisible ? '隐藏密码' : '查看密码'}</Button>
                 <Button onClick={async () => {
                   try { await navigator.clipboard?.writeText(String(pwdCurrent.password || '')); message.success('已复制') } catch { message.error('复制失败') }
                 }}>复制</Button>
               </Space.Compact>
             ) : (
               <Typography.Text type="secondary">
                {pwdCurrent?.configured ? (pwdCurrent?.reason === 'missing_key' ? '服务器未配置加密密钥（刷新后无法显示），请配置 PUBLIC_ACCESS_PASSWORD_ENC_KEY' : '未保存明文（需要重置一次后才能显示）') : '未配置'}
               </Typography.Text>
             )}
           </Space>
         </Card>
       ) : null}
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
           if (res.ok) {
             message.success('已更新报修密码')
             setPwdOpen(false)
             form.resetFields()
             const nowIso = new Date().toISOString()
             setPwdInfo({ configured: true, password_updated_at: nowIso })
             setPwdCurrent({ configured: true, password: pass, password_updated_at: nowIso })
           } else {
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
     </Space>
   )
 }
