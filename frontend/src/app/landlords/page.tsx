"use client"
import { Table, Card, Button, Modal, Form, Input, InputNumber, Space, message, Select, Tag, Switch, Drawer, Descriptions, Divider, Row, Col, DatePicker as DP } from 'antd'
import { useEffect, useState } from 'react'
import { API_BASE, deleteJSON, getJSON, patchJSON, postJSON } from '../../lib/api'
import { sortProperties, cmpPropertyCode } from '../../lib/properties'
import { hasPerm } from '../../lib/auth'
import dayjs from 'dayjs'

type Landlord = {
  id: string
  name: string
  phone?: string
  email?: string
  emails?: string[]
  management_fee_rate?: number
  payout_bsb?: string
  payout_account?: string
  property_ids?: string[]
  management_fee_rules?: ManagementFeeRule[]
}

type ManagementFeeRule = {
  id: string
  landlord_id: string
  effective_from_month: string
  management_fee_rate: number
  note?: string | null
  created_at?: string
}

export default function LandlordsPage() {
  const [mounted, setMounted] = useState(false)
  const [data, setData] = useState<Landlord[]>([])
  const [open, setOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [form] = Form.useForm()
  const [editForm] = Form.useForm()
  const [current, setCurrent] = useState<Landlord | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detail, setDetail] = useState<Landlord | null>(null)
  const [pwdForm] = Form.useForm()
  const [ruleForm] = Form.useForm()
  const [properties, setProperties] = useState<{ id: string; address?: string; code?: string }[]>([])
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [ruleSaving, setRuleSaving] = useState(false)
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  async function refreshOne(id: string, target: 'edit' | 'detail' | 'both' = 'both') {
    const row = await getJSON<Landlord>(`/landlords/${id}`).catch(() => null as any)
    if (!row) return
    if (target === 'edit' || target === 'both') setCurrent(row)
    if (target === 'detail' || target === 'both') setDetail(row)
  }

  async function load() {
    const res = await getJSON<any>(`/landlords?include_archived=${showArchived ? 'true' : 'false'}`).catch(() => [])
    const arr = Array.isArray(res) ? res : []
    setData(showArchived ? arr : arr.filter((l: any) => !l.archived))
  }
  useEffect(() => { load() }, [showArchived])
  useEffect(() => { getJSON<any>('/properties').then((j) => setProperties(Array.isArray(j) ? j : [])).catch(() => setProperties([])) }, [])
  useEffect(() => { setMounted(true) }, [])

  async function submitCreate() {
    const v = await form.validateFields()
    const baselineMonth = v.management_fee_baseline_month ? dayjs(v.management_fee_baseline_month).format('YYYY-MM') : ''
    const rate = v.management_fee_rate
    if ((rate != null && rate !== '') && !baselineMonth) {
      message.error('填写管理费率时，请同时填写基线生效月份')
      return
    }
    const emails = Array.isArray((v as any).emails) ? (v as any).emails.filter(Boolean) : ((v as any).email ? [(v as any).email] : [])
    const payload = { ...v, emails }
    delete (payload as any).management_fee_baseline_month
    delete (payload as any).email
    const res = await fetch(`${API_BASE}/landlords`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(payload) })
    if (res.ok) {
      const created = await res.json().catch(() => null as any)
      if (created?.id && baselineMonth && rate != null && rate !== '') {
        const ruleResp = await postJSON<any>(`/landlords/${created.id}/management-fee-rules`, {
          effective_from_month: baselineMonth,
          management_fee_rate: Number(rate || 0),
          note: '初始基线规则',
        }).catch((e: any) => e)
        if (ruleResp instanceof Error) {
          message.warning('房东已创建，但基线费率规则创建失败，请进入编辑页补录')
        }
      }
      message.success('房东已创建')
      setOpen(false)
      form.resetFields()
      load()
    }
    else {
      let msg = '创建失败'
      try { const j = await res.json(); if (j?.message) msg = j.message } catch { try { msg = await res.text() } catch {} }
      message.error(msg)
    }
  }

  function openEdit(record: Landlord) {
    setCurrent(record); setEditOpen(true)
    const rr: any = record as any
    const emails = Array.isArray(rr.emails) ? rr.emails : (record.email ? [record.email] : [])
    editForm.setFieldsValue({ ...record, emails })
    ruleForm.resetFields()
    setEditingRuleId(null)
    void refreshOne(record.id, 'edit')
  }
  async function submitEdit() {
    const v = await editForm.validateFields()
    const emails = Array.isArray((v as any).emails) ? (v as any).emails.filter(Boolean) : ((v as any).email ? [(v as any).email] : [])
    const payload = { ...v, emails }
    delete (payload as any).email
    delete (payload as any).management_fee_rate
    const res = await fetch(`${API_BASE}/landlords/${current?.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(payload) })
    if (res.ok) { message.success('房东已更新'); setEditOpen(false); load() }
    else {
      let msg = '更新失败'
      try { const j = await res.json(); if (j?.message) msg = j.message } catch { try { msg = await res.text() } catch {} }
      message.error(msg)
    }
  }

  async function openDetail(id: string) {
    const r = await getJSON<any>(`/landlords/${id}`).catch(() => null)
    setDetail(r)
    setDetailOpen(true)
  }

  async function submitRule() {
    if (!current?.id) return
    const v = await ruleForm.validateFields()
    const payload = {
      effective_from_month: dayjs(v.effective_from_month).format('YYYY-MM'),
      management_fee_rate: Number(v.management_fee_rate || 0),
      note: String(v.note || '').trim() || undefined,
    }
    setRuleSaving(true)
    try {
      if (editingRuleId) {
        await patchJSON(`/landlords/${current.id}/management-fee-rules/${editingRuleId}`, payload)
        message.success('费率规则已更新')
      } else {
        await postJSON(`/landlords/${current.id}/management-fee-rules`, payload)
        message.success('费率规则已新增')
      }
      ruleForm.resetFields()
      setEditingRuleId(null)
      await refreshOne(current.id, editOpen ? 'edit' : 'both')
      await load()
    } catch (e: any) {
      const msg = String(e?.message || '')
      if (msg === 'duplicate_effective_from_month') message.error('同一生效月份只能有一条规则')
      else if (msg === 'rule_in_use') message.error('该规则已影响历史入账月份，不能修改')
      else message.error(msg || '保存规则失败')
    } finally {
      setRuleSaving(false)
    }
  }

  function startEditRule(rule: ManagementFeeRule) {
    setEditingRuleId(String(rule.id))
    ruleForm.setFieldsValue({
      effective_from_month: dayjs(`${rule.effective_from_month}-01`),
      management_fee_rate: Number(rule.management_fee_rate || 0),
      note: rule.note || undefined,
    })
  }

  async function removeRule(rule: ManagementFeeRule) {
    if (!current?.id) return
    Modal.confirm({
      title: '确认删除费率规则？',
      content: `将删除 ${rule.effective_from_month} 起生效的管理费率规则。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      async onOk() {
        try {
          await deleteJSON(`/landlords/${current.id}/management-fee-rules/${rule.id}`)
          message.success('费率规则已删除')
          if (editingRuleId === rule.id) {
            setEditingRuleId(null)
            ruleForm.resetFields()
          }
          await refreshOne(current.id, editOpen ? 'edit' : 'both')
          await load()
        } catch (e: any) {
          const msg = String(e?.message || '')
          if (msg === 'rule_in_use') message.error('该规则已影响历史入账月份，不能删除')
          else if (msg === 'only_latest_rule_can_delete') message.error('仅允许删除最新且未使用的规则')
          else message.error(msg || '删除规则失败')
        }
      }
    })
  }

  async function submitDelete() {
    if (!current) return
    const res = await fetch(`${API_BASE}/landlords/${current.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` } })
    if (res.ok) { message.success('房东已归档'); setCurrent(null); load() } else { const m = await res.json().catch(() => null); message.error(m?.message || '归档失败') }
  }

  function confirmDelete(record: Landlord) {
    setCurrent(record)
    Modal.confirm({
      title: '确认归档',
      content: `是否确认归档房东：${record.name}？`,
      okText: '归档',
      okType: 'danger',
      cancelText: '取消',
      onOk: submitDelete,
    })
  }

  async function submitDeletePassword() {
    const v = await pwdForm.validateFields()
    const res = await fetch(`${API_BASE}/auth/delete-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
      body: JSON.stringify({ password: v.password })
    })
    if (res.ok) { message.success('删除口令已更新'); pwdForm.resetFields() }
    else { const m = await res.json().catch(() => null); message.error(m?.message || '更新失败') }
  }

  const columns = [
    { title: '姓名', dataIndex: 'name', ellipsis: true, responsive: ['xs','sm','md','lg','xl'] },
    { title: '联系方式', dataIndex: 'phone', ellipsis: true, responsive: ['xs','sm','md','lg','xl'] },
    { title: '邮箱', dataIndex: 'emails', ellipsis: true, responsive: ['sm','md','lg','xl'], render: (_: any, r: Landlord) => {
      const rr: any = r as any
      const arr = Array.isArray(rr.emails) ? rr.emails : (r.email ? [r.email] : [])
      return arr.length ? arr.join(', ') : ''
    } },
    { title: '当前管理费', dataIndex: 'management_fee_rate', render: (v: number) => (v != null ? `${(v * 100).toFixed(1)}%` : '-'), responsive: ['sm','md','lg','xl'] },
    { title: 'BSB', dataIndex: 'payout_bsb', ellipsis: true, responsive: ['md','lg','xl'] },
    { title: '银行账户', dataIndex: 'payout_account', ellipsis: true, responsive: ['md','lg','xl'] },
    { title: '房源', dataIndex: 'property_ids', render: (ids: string[]) => (
      <Space wrap>
        {((ids || []).slice().sort((a,b)=> {
          const pa = properties.find(x=> x.id===a)
          const pb = properties.find(x=> x.id===b)
          return cmpPropertyCode(pa?.code, pb?.code)
        })).map(id => {
          const p = properties.find(x => x.id === id)
          const label = p ? (p.code || p.address || id) : id
          return <Tag key={id}>{label}</Tag>
        })}
      </Space>
    ), responsive: ['lg','xl'] },
    { title: '操作', fixed: 'right', render: (_: any, r: Landlord) => (
      <Space>
        <Button onClick={() => openDetail(r.id)}>详情</Button>
        {hasPerm('landlord.manage') && <Button onClick={() => openEdit(r)}>编辑</Button>}
        {hasPerm('landlord.manage') && <Button danger onClick={() => confirmDelete(r)}>归档</Button>}
      </Space>
    ), responsive: ['xs','sm','md','lg','xl'] },
  ]

  if (!mounted) return null
  return (
    <Card title="房东管理" extra={
      <Space>
        <span>显示归档</span>
        <Switch checked={showArchived} onChange={setShowArchived as any} />
        <Input.Search allowClear placeholder="搜索房东" onSearch={setQuery} onChange={(e) => setQuery(e.target.value)} style={{ width: 240 }} />
        <Button type="primary" disabled={!hasPerm('landlord.manage')} onClick={() => setOpen(true)}>新增房东</Button>
      </Space>
    }>
      <Table
        rowKey={(r) => r.id}
        columns={columns as any}
        dataSource={(Array.isArray(data) ? data : []).filter(l => {
          const q = query.trim().toLowerCase()
          if (!q) return true
          const propLabels = (l.property_ids || []).map(id => {
            const p = properties.find(x => x.id === id)
            return (p?.code || p?.address || id || '').toLowerCase()
          })
          return (
            (l.name || '').toLowerCase().includes(q) ||
            (l.phone || '').toLowerCase().includes(q) ||
            ((Array.isArray((l as any).emails) ? (l as any).emails.join(',') : (l.email || '')).toLowerCase().includes(q)) ||
            propLabels.some(s => s.includes(q))
          )
        })}
        pagination={{
          current: page,
          pageSize,
          showSizeChanger: true,
          pageSizeOptions: [10, 20, 50, 100],
          onChange: (nextPage, nextPageSize) => {
            setPage(nextPage)
            setPageSize(nextPageSize)
          },
          onShowSizeChange: (_current, nextPageSize) => {
            setPage(1)
            setPageSize(nextPageSize)
          },
        }}
        size="small"
        scroll={{ x: 'max-content' }}
      />
      <Modal open={open} onCancel={() => setOpen(false)} onOk={submitCreate} title="新增房东" width={600}>
        <Form form={form} layout="vertical">
          <Divider orientation="left">基础信息</Divider>
          <Row gutter={16}>
            <Col span={12}><Form.Item name="name" label="房东姓名" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={12}><Form.Item name="phone" label="联系方式"><Input /></Form.Item></Col>
            <Col span={24}><Form.Item name="emails" label="邮箱" rules={[{ validator: (_, v) => (Array.isArray(v) ? v : []).every((x: any) => !x || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(x))) ? Promise.resolve() : Promise.reject('邮箱格式不正确') }]}>
              <Select mode="tags" tokenSeparators={[',',';',' ']} open={false} placeholder="输入后按回车，可添加多个邮箱" />
            </Form.Item></Col>
          </Row>
          <Divider orientation="left">财务信息</Divider>
          <Row gutter={16}>
            <Col span={8}><Form.Item name="management_fee_rate" label="管理费率">
              <InputNumber<number> min={0} max={1} step={0.001} precision={3} style={{ width: '100%' }} formatter={value => `${(Number(value) * 100).toFixed(1)}%`} parser={value => Number(value?.replace('%', '')) / 100} />
            </Form.Item></Col>
            <Col span={8}><Form.Item name="management_fee_baseline_month" label="基线生效月份">
              <DP picker="month" style={{ width:'100%' }} />
            </Form.Item></Col>
            <Col span={8}><Form.Item name="payout_bsb" label="BSB"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="payout_account" label="银行账户"><Input /></Form.Item></Col>
          </Row>
          <Divider orientation="left">管理房源</Divider>
          <Form.Item name="property_ids" label="关联房源">
            <Select
              mode="multiple"
              placeholder="选择房源"
              showSearch
              optionFilterProp="label"
              filterOption={(input, option)=> String((option as any)?.label||'').toLowerCase().includes(String(input||'').toLowerCase())}
              options={sortProperties(Array.isArray(properties)?properties:[]).map(p=>({ value: p.id, label: (p.code || p.address || p.id) }))}
            />
          </Form.Item>
        </Form>
      </Modal>
      <Drawer
        title="编辑房东"
        width={600}
        onClose={() => setEditOpen(false)}
        open={editOpen}
        footer={
          <div style={{ textAlign: 'right' }}>
            <Space>
              <Button onClick={() => setEditOpen(false)}>取消</Button>
              <Button type="primary" onClick={submitEdit}>保存</Button>
            </Space>
          </div>
        }
      >
        <Form form={editForm} layout="vertical">
          <Divider orientation="left">基础信息</Divider>
          <Row gutter={16}>
            <Col span={12}><Form.Item name="name" label="房东姓名" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={12}><Form.Item name="phone" label="联系方式"><Input /></Form.Item></Col>
            <Col span={24}><Form.Item name="emails" label="邮箱" rules={[{ validator: (_, v) => (Array.isArray(v) ? v : []).every((x: any) => !x || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(x))) ? Promise.resolve() : Promise.reject('邮箱格式不正确') }]}>
              <Select mode="tags" tokenSeparators={[',',';',' ']} open={false} placeholder="输入后按回车，可添加多个邮箱" />
            </Form.Item></Col>
          </Row>
          <Divider orientation="left">财务信息</Divider>
          <Row gutter={16}>
            <Col span={8}><Form.Item label="当前管理费率"><Input value={current?.management_fee_rate != null ? `${(Number(current?.management_fee_rate || 0) * 100).toFixed(1)}%` : '未设置'} readOnly /></Form.Item></Col>
            <Col span={8}><Form.Item name="payout_bsb" label="BSB"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="payout_account" label="银行账户"><Input /></Form.Item></Col>
          </Row>
          <div style={{ marginBottom: 12, color: current?.management_fee_rules?.length ? '#667085' : '#b42318' }}>
            {current?.management_fee_rules?.length
              ? '管理费率由下方“费率历史规则”驱动，历史已入账月份不会被新规则改动。'
              : '当前缺少费率基线规则；系统不会为未入账月份自动重算管理费，请先补录一条历史起始规则。'}
          </div>
          <Divider orientation="left">管理房源</Divider>
          <Form.Item name="property_ids" label="关联房源">
            <Select
              mode="multiple"
              placeholder="选择房源"
              showSearch
              optionFilterProp="label"
              filterOption={(input, option)=> String((option as any)?.label||'').toLowerCase().includes(String(input||'').toLowerCase())}
              options={sortProperties(Array.isArray(properties)?properties:[]).map(p=>({ value: p.id, label: (p.code || p.address || p.id) }))}
            />
          </Form.Item>
          <Divider orientation="left">费率历史规则</Divider>
          <Table
            size="small"
            rowKey={(r: any) => r.id}
            pagination={false}
            dataSource={(current?.management_fee_rules || []).slice().sort((a, b) => String(b.effective_from_month || '').localeCompare(String(a.effective_from_month || '')))}
            columns={[
              { title: '生效月份', dataIndex: 'effective_from_month', width: 120 },
              { title: '费率', dataIndex: 'management_fee_rate', width: 100, render: (v: number) => `${(Number(v || 0) * 100).toFixed(1)}%` },
              { title: '备注', dataIndex: 'note', render: (v: any) => v || '-' },
              { title: '操作', width: 140, render: (_: any, r: ManagementFeeRule) => (
                <Space>
                  <Button size="small" onClick={() => startEditRule(r)}>编辑</Button>
                  <Button size="small" danger onClick={() => removeRule(r)}>删除</Button>
                </Space>
              )},
            ] as any}
          />
          <div style={{ marginTop: 12, padding: 12, border: '1px solid #f2f4f7', borderRadius: 8 }}>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>{editingRuleId ? '编辑费率规则' : '新增费率规则'}</div>
            <Form form={ruleForm} layout="vertical">
              <Row gutter={16}>
                <Col span={8}>
                  <Form.Item name="effective_from_month" label="生效月份" rules={[{ required: true, message: '请选择生效月份' }]}>
                    <DP picker="month" style={{ width:'100%' }} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="management_fee_rate" label="管理费率" rules={[{ required: true, message: '请输入管理费率' }]}>
                    <InputNumber<number> min={0} max={1} step={0.001} precision={3} style={{ width: '100%' }} formatter={value => `${(Number(value) * 100).toFixed(1)}%`} parser={value => Number(value?.replace('%', '')) / 100} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="note" label="备注">
                    <Input placeholder="例如：2026-05 起调整为 12%" />
                  </Form.Item>
                </Col>
              </Row>
              <Space>
                <Button type="primary" loading={ruleSaving} onClick={submitRule}>{editingRuleId ? '保存规则' : '新增规则'}</Button>
                {editingRuleId ? <Button onClick={() => { setEditingRuleId(null); ruleForm.resetFields() }}>取消编辑</Button> : null}
              </Space>
            </Form>
          </div>
        </Form>
      </Drawer>
      <Drawer title="房东详情" width={600} onClose={() => setDetailOpen(false)} open={detailOpen}>
        {detail && (
          <>
            <Descriptions title="基础信息" bordered column={1} labelStyle={{ width: '120px' }}>
              <Descriptions.Item label="姓名">{detail.name}</Descriptions.Item>
              <Descriptions.Item label="联系方式">{detail.phone || '-'}</Descriptions.Item>
              <Descriptions.Item label="邮箱">
                {(Array.isArray(detail.emails) ? detail.emails : (detail.email ? [detail.email] : [])).join(', ') || '-'}
              </Descriptions.Item>
            </Descriptions>
            
            <Divider orientation="left">财务信息</Divider>
            <Descriptions bordered column={1} labelStyle={{ width: '120px' }}>
              <Descriptions.Item label="当前管理费率">{detail.management_fee_rate != null ? `${(detail.management_fee_rate * 100).toFixed(1)}%` : '-'}</Descriptions.Item>
              <Descriptions.Item label="BSB">{detail.payout_bsb || '-'}</Descriptions.Item>
              <Descriptions.Item label="银行账户">{detail.payout_account || '-'}</Descriptions.Item>
            </Descriptions>
            <Divider orientation="left">费率历史规则</Divider>
            {(detail.management_fee_rules || []).length ? (
              <Table
                size="small"
                rowKey={(r: any) => r.id}
                pagination={false}
                dataSource={(detail.management_fee_rules || []).slice().sort((a, b) => String(b.effective_from_month || '').localeCompare(String(a.effective_from_month || '')))}
                columns={[
                  { title: '生效月份', dataIndex: 'effective_from_month', width: 120 },
                  { title: '费率', dataIndex: 'management_fee_rate', width: 100, render: (v: number) => `${(Number(v || 0) * 100).toFixed(1)}%` },
                  { title: '备注', dataIndex: 'note', render: (v: any) => v || '-' },
                ] as any}
              />
            ) : (
              <div style={{ color:'#b42318' }}>缺少费率基线规则，请在编辑页先补录一条历史起始规则。</div>
            )}

            <Divider orientation="left">管理房源</Divider>
            <Space wrap>
              {((detail.property_ids || []).slice().sort((a,b)=> {
                const pa = properties.find(x=> x.id===a)
                const pb = properties.find(x=> x.id===b)
                return cmpPropertyCode(pa?.code, pb?.code)
              })).map(id => {
                const p = (Array.isArray(properties) ? properties : []).find(x => x.id === id)
                const label = p ? (p.code || p.address || id) : id
                return <Tag key={id}>{label}</Tag>
              })}
              {(!detail.property_ids || detail.property_ids.length === 0) && <span>暂无管理房源</span>}
            </Space>
          </>
        )}
      </Drawer>
      
      
    </Card>
  )
}
