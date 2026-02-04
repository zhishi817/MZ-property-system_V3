"use client"
import { Card, Form, Input, InputNumber, DatePicker, Select, Upload, Button, Table, Space, App, Modal, Alert, Radio, Drawer, AutoComplete, Typography } from 'antd'
import { UploadOutlined } from '@ant-design/icons'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { API_BASE, getJSON, authHeaders, apiList, apiCreate, apiUpdate, apiDelete } from '../../../lib/api'
import { sortProperties } from '../../../lib/properties'
import { hasPerm } from '../../../lib/auth'
import { getExpenseDateForDisplay } from '../../../lib/expenseDate'

type Tx = { id: string; kind: 'income'|'expense'; amount: number; currency: string; category?: string; category_detail?: string; property_id?: string; property_code?: string; fixed_expense_id?: string; occurred_at: string; due_date?: string; paid_date?: string; created_at?: string; note?: string }
type ExpenseInvoice = { id: string; expense_id: string; url: string; file_name?: string; mime_type?: string; file_size?: number }

export default function ExpensesPage() {
  const [form] = Form.useForm()
  const { message, modal } = App.useApp()
  const now = dayjs()
  const [list, setList] = useState<Tx[]>([])
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string }[]>([])
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dupOpen, setDupOpen] = useState(false)
  const [dupResult, setDupResult] = useState<any | null>(null)
  const [editing, setEditing] = useState<Tx | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [invoiceOpen, setInvoiceOpen] = useState<{ expenseId: string } | null>(null)
  const [invoices, setInvoices] = useState<ExpenseInvoice[]>([])
  const [pendingFiles, setPendingFiles] = useState<any[]>([])
  const [codeQuery, setCodeQuery] = useState('')
  const [catFilter, setCatFilter] = useState<string | undefined>(undefined)
  const [dateRange, setDateRange] = useState<[any, any] | null>(null)
  const [mode] = useState<'property'>('property')
  const [pageSize, setPageSize] = useState<number>(10)
  const [shareOpen, setShareOpen] = useState(false)
  const [shareUrl, setShareUrl] = useState('')
  const [sharePwdUpdatedAt, setSharePwdUpdatedAt] = useState<string | null>(null)
  const [sharePwdValue, setSharePwdValue] = useState('')
  const [sharePwdLoading, setSharePwdLoading] = useState(false)
  const [sharePwdSaving, setSharePwdSaving] = useState(false)
  const role = (typeof window !== 'undefined') ? (localStorage.getItem('role') || sessionStorage.getItem('role')) : null
  const canViewList = (role === 'admin') || hasPerm('menu.finance') || hasPerm('property_expenses.view') || role === 'customer_service' || hasPerm('finance.tx.write')
  async function loadSharePasswordInfo() {
    setSharePwdLoading(true)
    try {
      const res = await fetch(`${API_BASE}/public/property-expense/password-info`, { headers: authHeaders() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json().catch(() => ({} as any))
      setSharePwdUpdatedAt(j?.password_updated_at || null)
    } catch (e: any) {
      setSharePwdUpdatedAt(null)
      message.error(`加载密码状态失败：${e?.message || ''}`)
    } finally {
      setSharePwdLoading(false)
    }
  }
  async function resetSharePassword() {
    if (sharePwdSaving) return
    const newPwd = String(sharePwdValue || '').trim()
    if (!newPwd) { message.error('请输入新密码'); return }
    setSharePwdSaving(true)
    try {
      const res = await fetch(`${API_BASE}/public/property-expense/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ new_password: newPwd })
      })
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.message || `HTTP ${res.status}`)
      }
      message.success('密码已重置，旧 Token 已失效')
      setSharePwdValue('')
      loadSharePasswordInfo()
    } catch (e: any) {
      message.error(`重置失败：${e?.message || ''}`)
    } finally {
      setSharePwdSaving(false)
    }
  }
  async function load() {
    const resource = 'property_expenses'
    if (canViewList) {
      const rows: any[] = await apiList<any[]>(resource)
      const mapped: Tx[] = (rows || []).map((r: any) => ({ id: r.id, kind: 'expense', amount: Number(r.amount || 0), currency: r.currency || 'AUD', category: r.category, category_detail: r.category_detail, property_id: r.property_id || undefined, property_code: r.property_code || undefined, fixed_expense_id: r.fixed_expense_id || undefined, occurred_at: r.occurred_at, due_date: r.due_date, paid_date: r.paid_date, created_at: r.created_at, note: r.note }))
      const sorted = mapped.sort((a, b) => {
        const ad = getExpenseDateForDisplay(a, now)
        const bd = getExpenseDateForDisplay(b, now)
        const at = ad ? new Date(ad).getTime() : 0
        const bt = bd ? new Date(bd).getTime() : 0
        return bt - at
      })
      setList(sorted)
    } else {
      setList([])
    }
  }
  useEffect(() => { load(); getJSON<any>('/properties?include_archived=true').then((j) => setProperties(Array.isArray(j) ? j : [])).catch(() => setProperties([])) }, [mode])
  async function submit() {
    if (saving) return
    setSaving(true)
    const v = await form.validateFields()
    const payload = {
      kind: 'expense',
      amount: Number(v.amount || 0),
      currency: v.currency || 'AUD',
      category: v.category,
      property_id: v.property_id,
      note: v.note,
      category_detail: v.category === 'other' ? (v.other_detail || '') : undefined,
      occurred_at: dayjs(v.paid_date).format('YYYY-MM-DD'),
      paid_date: dayjs(v.paid_date).format('YYYY-MM-DD')
    }
    try {
      const res = await fetch(`${API_BASE}/finance/expenses/validate-duplicate`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ ...payload, mode: 'exact' }) })
      const j = await res.json().catch(()=>null)
      if (res.ok && j?.is_duplicate) { setDupResult(j); setDupOpen(true); setSaving(false); return }
    } catch {}
    const resource = 'property_expenses'
    try {
      if (editing) {
        await apiUpdate(resource, editing.id, payload)
        if (pendingFiles.length) {
          for (const f of pendingFiles) { await uploadExpenseInvoice(editing.id, f) }
        }
      } else {
        const created: any = await apiCreate(resource, payload)
        const expId = created?.id
        if (expId && pendingFiles.length) {
          for (const f of pendingFiles) { await uploadExpenseInvoice(expId, f) }
        }
      }
      message.success(editing ? '已更新支出' : '已记录支出'); form.resetFields(); setPendingFiles([]); setOpen(false); setEditing(null); load()
    } catch (e: any) {
      message.error(e?.message || '提交失败')
    } finally { setSaving(false) }
  }
  async function proceedCreateForce() {
    const v = form.getFieldsValue()
    const payload = {
      kind: 'expense', amount: Number(v.amount || 0), currency: v.currency || 'AUD', category: v.category, property_id: v.property_id,
      note: v.note, category_detail: v.category === 'other' ? (v.other_detail || '') : undefined, occurred_at: dayjs(v.paid_date).format('YYYY-MM-DD'), paid_date: dayjs(v.paid_date).format('YYYY-MM-DD')
    }
    try {
      const created: any = editing ? await apiUpdate('property_expenses', editing.id, payload) : await apiCreate('property_expenses', payload)
      message.success(editing ? '已更新支出' : '已记录支出'); form.resetFields(); setPendingFiles([]); setOpen(false); setEditing(null); setDupOpen(false); load()
    } catch (e: any) { message.error(e?.message || '提交失败') }
  }
  async function openInvoices(expenseId: string) {
    try {
      const rows = await getJSON<ExpenseInvoice[]>(`/finance/expense-invoices/${expenseId}`)
      setInvoices(Array.isArray(rows) ? rows : [])
      setInvoiceOpen({ expenseId })
    } catch { setInvoices([]); setInvoiceOpen({ expenseId }) }
  }
  async function uploadExpenseInvoice(expenseId: string, file: any) {
    const fd = new FormData(); fd.append('file', file)
    const res = await fetch(`${API_BASE}/finance/expense-invoices/${expenseId}/upload`, { method: 'POST', headers: { ...authHeaders() }, body: fd })
    if (res.ok) {
      const j = await res.json().catch(() => ({} as any))
      message.success('上传成功')
      const rows = await getJSON<ExpenseInvoice[]>(`/finance/expense-invoices/${expenseId}`)
      setInvoices(Array.isArray(rows) ? rows : [])
      const urlRaw = (j && (j.url || (j[0]?.url))) as string | undefined
      const raw = urlRaw ? (/^https?:\/\//.test(urlRaw) ? urlRaw : `${API_BASE}${urlRaw}`) : ''
      if (invoiceOpen && raw) { const bust = raw + (raw.includes('?') ? '&' : '?') + `_=${Date.now()}`; setPreviewUrl(bust); setPreviewOpen(true) }
    } else { message.error('上传失败') }
    return false
  }
  async function removeExpenseInvoice(id: string, expenseId: string) {
    const res = await fetch(`${API_BASE}/finance/expense-invoices/${id}`, { method: 'DELETE', headers: { ...authHeaders() } })
    if (res.ok) { message.success('已删除'); const rows = await getJSON<ExpenseInvoice[]>(`/finance/expense-invoices/${expenseId}`); setInvoices(Array.isArray(rows) ? rows : []) } else { message.error('删除失败') }
  }
  const CATS = [
    { value: 'electricity', label: '电费' },
    { value: 'water', label: '水费' },
    { value: 'gas_hot_water', label: '煤气/热水费' },
    { value: 'internet', label: '网费' },
    { value: 'consumables', label: '消耗品费' },
    { value: 'carpark', label: '车位费' },
    { value: 'owners_corp', label: '物业费' },
    { value: 'council_rate', label: '市政费' },
    { value: 'other', label: '其他' }
  ]
  const catLabel = (v?: string) => (CATS.find(c => c.value === v)?.label || v || '-')
  function catKey(v?: string): string | undefined {
    const s = String(v || '').trim()
    if (!s) return undefined
    const low = s.toLowerCase()
    if (s.includes('车位') || low.includes('carpark') || low.includes('parking')) return 'parking_fee'
    if (s === 'carpark') return 'parking_fee'
    return s
  }
  function catFilterLabel(k?: string): string {
    if (!k) return '-'
    if (k === 'parking_fee') return '车位费'
    return catLabel(k)
  }
  const catOptions = Array.from(new Set(list.map(x => catKey(x.category)).filter(Boolean) as string[]))
    .sort((a, b) => catFilterLabel(a).localeCompare(catFilterLabel(b)))
    .map((k) => ({ value: k, label: catFilterLabel(k) }))
  const fmt = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  function melDay(s: any): string {
    try {
      const d = new Date(String(s))
      const fmt = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' })
      const parts = fmt.formatToParts(d)
      const Y = parts.find(p => p.type === 'year')?.value || '0000'
      const M = parts.find(p => p.type === 'month')?.value || '00'
      const D = parts.find(p => p.type === 'day')?.value || '00'
      return `${D}/${M}/${Y}`
    } catch { return s ? dayjs(s).format('DD/MM/YYYY') : '-' }
  }
  const columns = [
    { title: '日期', dataIndex: 'occurred_at', render: (_: any, r: Tx) => {
      const d = getExpenseDateForDisplay(r, now)
      return melDay(d)
    } },
    { title: '房号', dataIndex: 'property_code', render: (v: string, r: any) => (v || (()=>{ const p = properties.find(x => x.id === r.property_id); return p?.code || r.property_id || '-' })()) },
    { title: '类别', dataIndex: 'category', render: (_: any, r: Tx) => {
      if (!r?.category) return '-'
      return r.category === 'other' ? `其他: ${r.category_detail || ''}` : catLabel(r.category)
    } },
    { title: '金额', dataIndex: 'amount', render: (v: number) => `$${fmt(Number(v || 0))}` },
    { title: '发票', key: 'invoices', render: (_: any, r: Tx) => (
      <Button type="link" onClick={() => openInvoices(r.id)}>管理发票</Button>
    ) },
    { title: '备注', dataIndex: 'note' },
    { title: '操作', render: (_: any, r: Tx) => (hasPerm('property_expenses.write') || hasPerm('finance.tx.write')) ? (
      <Space>
        <Button onClick={() => { setEditing(r); setOpen(true); form.setFieldsValue({
          paid_date: dayjs(r.paid_date || r.occurred_at), property_id: r.property_id, category: r.category,
          other_detail: r.category === 'other' ? r.category_detail : undefined,
          amount: r.amount, currency: r.currency, note: r.note,
        }) }}>编辑</Button>
        {hasPerm('property_expenses.delete') && (
        <Button danger onClick={() => {
          modal.confirm({ title: '确认删除支出', okType: 'danger', onOk: async () => {
            const resource = 'property_expenses'
            try { await apiDelete(resource, r.id); message.success('已删除'); load() } catch (e: any) { message.error(e?.message || '删除失败') }
          } })
        }}>删除</Button>
        )}
      </Space>
    ) : null },
  ]
  return (
    <Card title="房源支出" extra={<Space>
      <Button onClick={() => {
        try {
          const origin = typeof window !== 'undefined' ? window.location.origin : ''
          setShareUrl(origin ? `${origin}/public/property-expense` : '/public/property-expense')
        } catch { setShareUrl('/public/property-expense') }
        loadSharePasswordInfo()
        setShareOpen(true)
      }}>房源支出外部登记链接</Button>
      {(hasPerm('property_expenses.write') || hasPerm('finance.tx.write')) ? <Button type="primary" onClick={() => { setEditing(null); form.resetFields(); setOpen(true) }}>记录支出</Button> : null}
    </Space>}>
      <Space style={{ marginBottom: 12 }} wrap>
        {canViewList ? (
          <>
            <AutoComplete
              value={codeQuery}
              onChange={(v) => setCodeQuery(String(v || ''))}
              style={{ width: 260 }}
              options={sortProperties(properties).map((p) => {
                const code = String(p.code || p.id || '').trim()
                return { value: code }
              })}
              filterOption={(inputValue, option) => {
                const q = String(inputValue || '').trim().toLowerCase()
                if (!q) return true
                const v = String((option as any)?.value || '').toLowerCase()
                return v.includes(q)
              }}
              placeholder="按房号搜索"
            >
              <Input allowClear />
            </AutoComplete>
            <Select allowClear placeholder="按类别筛选" value={catFilter} onChange={setCatFilter} style={{ width: 240 }} options={catOptions} />
            <DatePicker.RangePicker onChange={(v) => setDateRange(v as any)} format="DD/MM/YYYY" />
          </>
        ) : (
          <Alert type="info" message="您可以记录房源支出，列表明细对客服不可见" showIcon />
        )}
      </Space>
      {canViewList && (
        <Table rowKey={r => r.id} columns={columns as any} dataSource={list.filter(x => {
          const label = String((x as any).property_code || (()=>{ const p = properties.find(pp => pp.id === x.property_id); return p?.code || '' })() || '')
          const codeOk = (!codeQuery || label.toLowerCase().includes(codeQuery.trim().toLowerCase()))
          const catOk = !catFilter || catKey(x.category) === catFilter
          const baseDate = getExpenseDateForDisplay(x, now)
          const inRange = !dateRange || (!!baseDate && (!dateRange[0] || dayjs(baseDate).diff(dateRange[0], 'day') >= 0) && (!dateRange[1] || dayjs(baseDate).diff(dateRange[1], 'day') <= 0))
          const kindOk = x.kind === 'expense'
          const scopeOk = !!x.property_id
          return kindOk && scopeOk && codeOk && catOk && inRange
        })} pagination={{ pageSize, showSizeChanger: true, pageSizeOptions: [10,20,50,100], onChange: (_p, ps) => setPageSize(ps), onShowSizeChange: (_p, ps) => setPageSize(ps) }} scroll={{ x: 'max-content' }} />
      )}
      {canViewList && (
        <Alert
          type="info"
          showIcon
          message="提示：固定支出在历史月份按到期日展示，方便对应已支付的历史账期；当月及未来月份仍按创建时间展示。"
          style={{ marginTop: 12 }}
        />
      )}
      <Drawer open={open} onClose={() => setOpen(false)} title={editing? '编辑支出':'记录支出'} width={720} footer={
        <div style={{ textAlign: 'right' }}>
          <Space>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button type="primary" onClick={submit} loading={saving}>保存</Button>
          </Space>
        </div>
      }>
        <Form form={form} layout="vertical">
          <Form.Item name="paid_date" label="付款日期" rules={[{ required: true }]}> 
            <DatePicker style={{ width: '100%' }} format="DD/MM/YYYY" />
          </Form.Item>
          <Form.Item name="property_id" label="房号" rules={[{ required: true }]}> 
            <Select
              showSearch
              optionFilterProp="label"
              filterOption={(input, option) => String((option as any)?.label || '').toLowerCase().includes(String(input || '').toLowerCase())}
              options={sortProperties(properties).map(p => ({ value: p.id, label: p.code || p.id }))}
            />
          </Form.Item>
          <Form.Item name="category" label="类别" rules={[{ required: true }]}> 
            <Radio.Group optionType="button" buttonStyle="solid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(140px, 1fr))', gap: 12 }}>
              {CATS.map(c => (
                <Radio.Button
                  key={c.value}
                  value={c.value}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    textAlign: 'center',
                    padding: '10px 14px',
                    borderRadius: 9999,
                    minHeight: 40,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                >
                  {c.label}
                </Radio.Button>
              ))}
            </Radio.Group>
          </Form.Item>
          <Form.Item noStyle shouldUpdate>
            {() => {
              const v = form.getFieldValue('category')
              if (v === 'other') {
                return (
                  <Form.Item name="other_detail" label="其他明细" rules={[{ required: true }]}> 
                    <Input />
                  </Form.Item>
                )
              }
              return null
            }}
          </Form.Item>
          <Form.Item name="amount" label="金额" rules={[{ required: true }]}> 
            <InputNumber min={0} step={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="currency" initialValue="AUD" label="币种">
            <Select options={[{value:'AUD',label:'AUD'}]} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input />
          </Form.Item>
          <Form.Item label="发票（可选）">
            <Upload
              multiple
              beforeUpload={(file) => { setPendingFiles(prev => [...prev, file]); return false }}
              fileList={pendingFiles as any}
              onRemove={(file) => { setPendingFiles(prev => prev.filter((f: any) => (f.uid || f.name) !== (file as any).uid && (f.uid || f.name) !== (file as any).name)) }}
              accept=".pdf,.jpg,.jpeg,.png"
            >
              <Button icon={<UploadOutlined />}>选择发票</Button>
            </Upload>
            {editing ? (
              <Button type="link" style={{ marginLeft: 8 }} onClick={() => { setInvoiceOpen({ expenseId: editing.id }); openInvoices(editing.id) }}>已关联发票</Button>
            ) : null}
          </Form.Item>
          
        </Form>
      </Drawer>
      <Modal open={shareOpen} onCancel={() => setShareOpen(false)} footer={null} title="房源支出外部登记链接">
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            复制链接发给外部人员填写房源支出；可在此处设置/重置访问密码（重置后旧 Token 会失效）。
          </Typography.Paragraph>
          <Input value={shareUrl} readOnly />
          <Space>
            <Button type="primary" onClick={async () => {
              try {
                await navigator.clipboard.writeText(shareUrl)
                message.success('已复制链接')
              } catch {
                message.error('复制失败，请手动复制')
              }
            }}>复制链接</Button>
            <Button onClick={() => setShareOpen(false)}>关闭</Button>
          </Space>
          <div style={{ height: 8 }} />
          <Typography.Text strong>访问密码设置</Typography.Text>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            当前密码最后更新时间：{sharePwdLoading ? '加载中...' : (sharePwdUpdatedAt ? new Date(sharePwdUpdatedAt).toLocaleString() : '未知')}
          </Typography.Paragraph>
          <Space>
            <Input.Password placeholder="新密码" value={sharePwdValue} onChange={(e)=>setSharePwdValue(e.target.value)} style={{ width: 320 }} />
            <Button type="primary" loading={sharePwdSaving} onClick={resetSharePassword}>重置密码</Button>
            <Button loading={sharePwdLoading} onClick={loadSharePasswordInfo}>刷新</Button>
          </Space>
        </Space>
      </Modal>
      <Modal open={dupOpen} onCancel={() => setDupOpen(false)} footer={null} title="疑似重复支出" width={860}>
        {dupResult ? (
          <>
            <Alert type="warning" message={`检测到重复风险：${(dupResult.reasons||[]).join(', ')}`} showIcon style={{ marginBottom: 12 }} />
            <Space style={{ marginBottom: 12 }}>验证编号: <code>{dupResult.verification_id}</code></Space>
            <Table rowKey={(r:any)=> r.id} dataSource={Array.isArray(dupResult.similar)? dupResult.similar : []} size="small" pagination={{ defaultPageSize: 5 }}
              columns={[
                { title:'房号', render: (_:any, r:any) => { const p = properties.find(x => String(x.id)===String(r.property_id)); return p?.code || r.property_code || r.property_id } },
                { title:'类别', dataIndex:'category' },
                { title:'金额', dataIndex:'amount' },
                { title:'付款日', render: (_:any, r:any) => melDay(r.paid_date || r.occurred_at) },
                { title:'备注', dataIndex:'note' }
              ] as any}
            />
            <Space style={{ marginTop: 12 }}>
              <Button type="primary" onClick={proceedCreateForce}>继续提交（确认非重复）</Button>
              <Button onClick={()=> setDupOpen(false)}>返回</Button>
            </Space>
          </>
        ) : null}
      </Modal>
      <Modal open={!!invoiceOpen} onCancel={() => { setInvoiceOpen(null); setInvoices([]) }} footer={null} width={1350} title="发票管理">
        {invoiceOpen ? (
          <>
            <Upload beforeUpload={(file) => uploadExpenseInvoice(invoiceOpen.expenseId, file)} multiple accept=".pdf,.jpg,.jpeg,.png" showUploadList={false} fileList={[]}
            key={invoiceOpen.expenseId}>
              <Button icon={<UploadOutlined />}>上传发票</Button>
            </Upload>
            <Table
              rowKey={(r: any) => r.id}
              columns={[
                { title: '文件名', dataIndex: 'file_name' },
                { title: '预览', render: (_: any, rec: ExpenseInvoice) => {
                  const raw = rec.url && /^https?:\/\//.test(rec.url) ? rec.url : (rec.url ? `${API_BASE}${rec.url}` : '')
                  const u = raw ? withBust(raw) : ''
                  if (!u) return '-'
                  if (/\.pdf($|\?)/i.test(u)) {
                    return (
                      <object data={u} type="application/pdf" style={{ width:'100%', height: 390 }} key={u}>
                        <a href={u} target="_blank" rel="noreferrer">打开原文件</a>
                      </object>
                    )
                  }
                  return <img src={u} style={{ maxWidth:'100%', maxHeight: 390 }} alt="invoice" />
                } },
                { title: '操作', render: (_: any, rec: ExpenseInvoice) => (
                  <Button danger onClick={() => removeExpenseInvoice(rec.id, invoiceOpen.expenseId)}>删除</Button>
                ) }
              ] as any}
              dataSource={invoices}
              pagination={false}
              style={{ marginTop: 12 }}
            />
          </>
        ) : null}
      </Modal>
      <Modal open={previewOpen} onCancel={() => setPreviewOpen(false)} footer={null} width={900} title="发票预览">
        {previewUrl ? (
          (/\.pdf($|\?)/i.test(previewUrl) ? (
            <object data={previewUrl} type="application/pdf" style={{ width:'100%', height: 680 }} key={previewUrl}>
              <a href={previewUrl} target="_blank" rel="noreferrer">打开原文件</a>
            </object>
          ) : (
            <img src={previewUrl} style={{ maxWidth:'100%' }} key={previewUrl} />
          ))
        ) : null}
      </Modal>
    </Card>
  )
}
  function withBust(u: string): string { if (!u) return ''; const sep = u.includes('?') ? '&' : '?'; return `${u}${sep}_=${Date.now()}` }
