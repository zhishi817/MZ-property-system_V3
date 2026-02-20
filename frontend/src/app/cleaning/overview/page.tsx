"use client"
import { Alert, Button, DatePicker, Drawer, Form, Input, Modal, Popconfirm, Select, Space, message } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import dayjs, { type Dayjs } from 'dayjs'
import { API_BASE, deleteJSON, getJSON, patchJSON, postJSON } from '../../../lib/api'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { sortProperties } from '../../../lib/properties'
import { ClockCircleOutlined, DeleteOutlined, EditOutlined, EyeOutlined, PlusOutlined, RiseOutlined } from '@ant-design/icons'
import styles from './cleaningOverview.module.scss'

type OverviewResp = {
  date: string
  today: {
    total: number
    unassigned: number
    by_status: {
      pending: number
      assigned: number
      in_progress: number
      completed: number
      cancelled: number
    }
  }
  next7days: { date: string; total: number }[]
}

type OfflineTask = {
  id: string
  date: string
  task_type: 'property' | 'company' | 'other'
  title: string
  content?: string | null
  kind: string
  status: 'todo' | 'done'
  urgency: 'low' | 'medium' | 'high' | 'urgent'
  property_id?: string | null
  assignee_id?: string | null
}

type StaffLite = { id: string; name: string }
type PropertyLite = { id: string; code?: string; address?: string }

const kindLabel: Record<string, string> = {
  key_hanging: '挂钥匙',
  password_change: '换密码',
  restock: '补消耗品',
  maintenance: '维修',
  inspection: '检查（Inspection）',
  other: '其他',
}

export default function CleaningOverviewPage() {
  const [data, setData] = useState<OverviewResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [offlineTasks, setOfflineTasks] = useState<OfflineTask[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [staff, setStaff] = useState<StaffLite[]>([])
  const [properties, setProperties] = useState<PropertyLite[]>([])
  const [createForm] = Form.useForm()
  const [editForm] = Form.useForm()
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<OfflineTask | null>(null)
  const [rescheduleOpen, setRescheduleOpen] = useState(false)
  const [rescheduleTask, setRescheduleTask] = useState<OfflineTask | null>(null)
  const [rescheduleDate, setRescheduleDate] = useState<Dayjs | null>(null)
  const [dbStatus, setDbStatus] = useState<any>(null)

  const reload = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true)
    if (!opts?.silent) setLoadError(null)
    try {
      const resp = await getJSON<OverviewResp>('/stats/cleaning-overview')
      const tasks = await getJSON<OfflineTask[]>(`/cleaning/offline-tasks?date=${encodeURIComponent(resp.date)}&include_overdue=1`)
      setData(resp)
      setOfflineTasks(Array.isArray(tasks) ? tasks : [])
    } catch (e: any) {
      if (!opts?.silent) setLoadError(String(e?.message || '加载失败'))
    } finally {
      if (!opts?.silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    reload().catch(() => {})
  }, [reload])
  useEffect(() => {
    getJSON<StaffLite[]>('/cleaning/staff')
      .then((rows) => setStaff(Array.isArray(rows) ? rows : []))
      .catch(() => setStaff([]))
    getJSON<PropertyLite[]>('/properties')
      .then((rows) => setProperties(Array.isArray(rows) ? rows : []))
      .catch(() => setProperties([]))
    getJSON<any>('/health/db').then(setDbStatus).catch(() => setDbStatus(null))
  }, [])
  useEffect(() => {
    const id = window.setInterval(() => {
      reload({ silent: true }).catch(() => {})
    }, 5 * 60 * 1000)
    return () => window.clearInterval(id)
  }, [reload])
  useEffect(() => {
    let es: EventSource | null = null
    try {
      es = new EventSource(`${API_BASE}/events/orders`)
      es.onmessage = () => reload({ silent: true }).catch(() => {})
    } catch {}
    return () => { try { es?.close() } catch {} }
  }, [reload])

  const dateLabel = data?.date ? `（${data.date}）` : ''
  const viewDate = data?.date || dayjs().format('YYYY-MM-DD')
  const today = data?.today

  const updateOfflineTask = useCallback(async (id: string, patch: Partial<Pick<OfflineTask, 'status' | 'urgency' | 'title' | 'content' | 'kind' | 'property_id' | 'task_type' | 'assignee_id' | 'date'>>) => {
    const updated = await patchJSON<OfflineTask>(`/cleaning/offline-tasks/${id}`, patch)
    setOfflineTasks((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, ...updated } : t))
      const u = next.find((t) => t.id === id)
      if (u && String(u.date).slice(0, 10) !== viewDate) return next.filter((t) => t.id !== id)
      return next
    })
    return updated
  }, [viewDate])

  const openCreate = useCallback(() => {
    setCreateOpen(true)
    createForm.setFieldsValue({
      date: dayjs(viewDate),
      task_type: 'other',
      title: '',
      content: '',
      kind: 'other',
      urgency: 'medium',
      property_id: undefined,
      assignee_id: undefined,
    })
  }, [createForm, viewDate])

  const createOfflineTask = useCallback(async () => {
    const v = await createForm.validateFields()
    const payload: any = {
      date: v.date ? dayjs(v.date).format('YYYY-MM-DD') : viewDate,
      task_type: v.task_type,
      title: String(v.title || '').trim(),
      content: String(v.content || '').trim(),
      kind: v.kind,
      urgency: v.urgency,
      property_id: v.task_type === 'property' ? v.property_id : undefined,
      assignee_id: v.assignee_id || undefined,
    }
    const created = await postJSON<OfflineTask>('/cleaning/offline-tasks', payload)
    if (String(created.date).slice(0, 10) === viewDate) setOfflineTasks((prev) => [created, ...prev])
    else reload({ silent: true }).catch(() => {})
    setCreateOpen(false)
    createForm.resetFields()
    message.success('任务已创建')
  }, [createForm, reload, viewDate])

  const openEdit = useCallback((t: OfflineTask) => {
    setEditing(t)
    setEditOpen(true)
    editForm.setFieldsValue({
      date: dayjs(String(t.date).slice(0, 10)),
      task_type: t.task_type || 'other',
      title: t.title || '',
      content: t.content || '',
      kind: t.kind || 'other',
      urgency: t.urgency || 'medium',
      property_id: t.property_id || undefined,
      assignee_id: t.assignee_id || undefined,
      status: t.status,
    })
  }, [editForm])

  const saveEdit = useCallback(async () => {
    if (!editing) return
    const v = await editForm.validateFields()
    const patch: any = {
      date: v.date ? dayjs(v.date).format('YYYY-MM-DD') : undefined,
      task_type: v.task_type,
      title: String(v.title || '').trim(),
      content: String(v.content || '').trim(),
      kind: v.kind,
      urgency: v.urgency,
      status: v.status,
      property_id: v.task_type === 'property' ? (v.property_id || null) : null,
      assignee_id: v.assignee_id || null,
    }
    const updated = await updateOfflineTask(editing.id, patch)
    setEditing(updated)
    if (String(updated.date).slice(0, 10) !== viewDate) setEditOpen(false)
    message.success('已保存')
  }, [editForm, editing, updateOfflineTask, viewDate])

  const deleteOfflineTask = useCallback(async (id: string) => {
    await deleteJSON(`/cleaning/offline-tasks/${id}`)
    setOfflineTasks((prev) => prev.filter((t) => t.id !== id))
    if (editing?.id === id) setEditOpen(false)
    message.success('已删除')
  }, [editing?.id])

  const openReschedule = useCallback((t: OfflineTask) => {
    setRescheduleTask(t)
    setRescheduleDate(dayjs(viewDate).add(1, 'day'))
    setRescheduleOpen(true)
  }, [viewDate])

  const submitReschedule = useCallback(async () => {
    if (!rescheduleTask) return
    const nextDate = rescheduleDate ? dayjs(rescheduleDate).format('YYYY-MM-DD') : null
    if (!nextDate) return
    await updateOfflineTask(rescheduleTask.id, { date: nextDate, status: 'todo' })
    setRescheduleOpen(false)
    setRescheduleTask(null)
    message.success('已更新执行日期')
  }, [rescheduleDate, rescheduleTask, updateOfflineTask])

  const staffNameById = useCallback((id?: string | null) => {
    if (!id) return null
    return staff.find((s) => String(s.id) === String(id))?.name || String(id)
  }, [staff])

  const propertyLabelById = useCallback((id?: string | null) => {
    if (!id) return null
    const p = properties.find((x) => String(x.id) === String(id))
    return p ? (p.code || p.address || p.id) : String(id)
  }, [properties])

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.topTitle}>清洁总览{dateLabel}</div>
        {loadError ? <Alert type="error" showIcon message="清洁总览数据加载失败" description={loadError} /> : null}
        {dbStatus && dbStatus.pg === false ? <Alert type="warning" showIcon message="后端未连接数据库" description={String(dbStatus.pg_error || 'pg=false')} /> : null}

        <div className={styles.row2} aria-label="统计卡片">
          <div className={`${styles.card} ${styles.metricCard}`} aria-label="今日清洁任务">
            <div className={styles.metricHead}>
              <div className={styles.metricTitle}>今日清洁任务</div>
              <div className={styles.metricIcon} aria-hidden="true">
                <RiseOutlined />
              </div>
            </div>
            <div className={styles.metricValue}>
              {today?.total ?? 0}
              <span className={styles.metricUnit}>间</span>
            </div>
            <div className={styles.divider} aria-hidden="true" />
            <div className={styles.platformGrid} aria-label="状态拆分">
              <div><div className={styles.platformK}>PENDING</div><div className={styles.platformV}>{today?.by_status?.pending ?? 0}</div></div>
              <div><div className={styles.platformK}>ASSIGNED</div><div className={styles.platformV}>{today?.by_status?.assigned ?? 0}</div></div>
              <div><div className={styles.platformK}>IN PROGRESS</div><div className={styles.platformV}>{today?.by_status?.in_progress ?? 0}</div></div>
              <div><div className={styles.platformK}>COMPLETED</div><div className={styles.platformV}>{today?.by_status?.completed ?? 0}</div></div>
            </div>
          </div>

          <div className={`${styles.card} ${styles.metricCard}`} aria-label="今日未分配数量">
            <div className={styles.metricHead}>
              <div className={styles.metricTitle}>今日未分配</div>
              <div className={`${styles.metricIcon} ${styles.metricIconOrange}`} aria-hidden="true">
                <RiseOutlined />
              </div>
            </div>
            <div className={`${styles.metricValue} ${styles.metricValueOrange}`}>
              {today?.unassigned ?? 0}
              <span className={styles.metricUnit}>个</span>
            </div>
            <div className={styles.divider} aria-hidden="true" />
            <div className={styles.platformGrid} aria-label="今日取消/完成">
              <div><div className={styles.platformK}>CANCELLED</div><div className={styles.platformV}>{today?.by_status?.cancelled ?? 0}</div></div>
              <div><div className={styles.platformK}>COMPLETED</div><div className={styles.platformV}>{today?.by_status?.completed ?? 0}</div></div>
            </div>
          </div>
        </div>

        <div className={`${styles.card} ${styles.sectionCard}`} aria-label="未来7天清洁任务趋势">
          <div className={styles.cardHead}>
            <div className={styles.cardTitle}>未来 7 天清洁任务趋势</div>
          </div>
          <div className={styles.chartWrap}>
            <div className={styles.chartBox}>
              <ResponsiveContainer>
                <BarChart
                  data={data?.next7days || []}
                  margin={{ top: 18, right: 18, left: 8, bottom: 10 }}
                  barCategoryGap={34}
                  barGap={10}
                >
                  <CartesianGrid stroke="var(--clean-overview-divider)" strokeDasharray="2 6" vertical={false} />
                  <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: 'var(--clean-overview-subtle)', fontSize: 12, fontWeight: 600 }} />
                  <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fill: 'var(--clean-overview-subtle)', fontSize: 12, fontWeight: 600 }} />
                  <Tooltip />
                  <Legend content={() => null} />
                  <Bar dataKey="total" name="清洁任务" fill="var(--clean-overview-blue)" radius={[6, 6, 0, 0]} maxBarSize={44} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        <div className={`${styles.card} ${styles.sectionCard}`} aria-label="今日其他线下任务">
          <div className={styles.cardHead}>
            <div className={styles.taskHeaderLeft}>
              <div className={styles.cardTitle}>今日其他线下任务</div>
              <div className={styles.countPill}>{offlineTasks.length} 个任务</div>
            </div>
            <Button type="primary" className={styles.primaryBtn} icon={<PlusOutlined />} onClick={openCreate}>
              新增任务
            </Button>
          </div>

          <div className={styles.tableWrap} role="table" aria-label="线下任务表格">
            <div className={`${styles.tableRow} ${styles.tableHeadRow}`} role="row">
              <div className={styles.cell} role="columnheader">任务信息</div>
              <div className={styles.cell} role="columnheader">执行人</div>
              <div className={styles.cell} role="columnheader">房源 ID</div>
              <div className={styles.cell} role="columnheader">优先级</div>
              <div className={styles.cell} role="columnheader">状态</div>
              <div className={styles.cell} role="columnheader">操作</div>
            </div>
            {offlineTasks.map((t) => {
              const urgencyLabel = t.urgency === 'low' ? '低' : t.urgency === 'medium' ? '中' : t.urgency === 'high' ? '高' : '紧急'
              const isDone = t.status === 'done'
              return (
                <div key={t.id} className={`${styles.tableRow} ${styles.bodyRow} ${styles.rowHover} ${isDone ? styles.doneRow : ''}`} role="row">
                  <div className={styles.cell} role="cell">
                    <div className={styles.taskInfo}>
                      <div className={styles.taskIcon} aria-hidden="true"><ClockCircleOutlined /></div>
                      <div className={styles.taskMeta}>
                        <div className={styles.taskTitleLink} onClick={() => openEdit(t)}>{t.title}</div>
                        <div className={styles.taskSub}>
                          <span>{String(t.date || '').slice(0, 10)}</span>
                          <span className={styles.pill}>{kindLabel[t.kind] || t.kind}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className={styles.cell} role="cell">
                    <span className={`${styles.pill} ${styles.pillGreen}`}>{staffNameById(t.assignee_id) || '-'}</span>
                  </div>
                  <div className={styles.cell} role="cell">
                    <span>{t.property_id ? (propertyLabelById(t.property_id) || t.property_id) : '-'}</span>
                  </div>
                  <div className={styles.cell} role="cell">
                    <span className={`${styles.pill} ${styles.pillBlue}`}>{urgencyLabel}</span>
                  </div>
                  <div className={styles.cell} role="cell">
                    <Select
                      size="small"
                      value={t.status}
                      style={{ width: 120 }}
                      options={[
                        { label: '未完成', value: 'todo' },
                        { label: '已完成', value: 'done' },
                      ]}
                      onChange={(v) => updateOfflineTask(t.id, { status: v as any }).catch(() => {})}
                    />
                  </div>
                  <div className={styles.cell} role="cell">
                    <div className={styles.ops}>
                      <Button className={styles.iconBtn} icon={<EyeOutlined />} aria-label="查看" onClick={() => openEdit(t)} />
                      <Button className={styles.iconBtn} icon={<EditOutlined />} aria-label="编辑" onClick={() => openEdit(t)} />
                      <Popconfirm title="确认删除该任务？" okText="删除" cancelText="取消" onConfirm={() => deleteOfflineTask(t.id).catch(() => {})}>
                        <Button className={styles.iconBtn} icon={<DeleteOutlined />} aria-label="删除" />
                      </Popconfirm>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

      <Modal
        open={createOpen}
        title="新增线下任务"
        okText="创建"
        onOk={() => createOfflineTask().catch((e) => message.error(e?.message || '创建失败'))}
        onCancel={() => setCreateOpen(false)}
      >
        <Form
          form={createForm}
          layout="vertical"
          onValuesChange={(changed, all) => {
            if (changed?.task_type && all.task_type !== 'property') createForm.setFieldsValue({ property_id: undefined })
          }}
        >
          <Form.Item name="date" label="执行日期" rules={[{ required: true, message: '请选择执行日期' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="task_type" label="任务类型" rules={[{ required: true, message: '请选择任务类型' }]}>
            <Select options={[{ label: '房源', value: 'property' }, { label: '公司', value: 'company' }, { label: '其他', value: 'other' }]} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.task_type !== cur.task_type}>
            {() => (createForm.getFieldValue('task_type') === 'property' ? (
              <Form.Item name="property_id" label="房源" rules={[{ required: true, message: '请选择房源' }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  filterOption={(input, option) => String((option as any)?.label || '').toLowerCase().includes(String(input || '').toLowerCase())}
                  options={sortProperties(Array.isArray(properties) ? properties : []).map((p) => ({ value: p.id, label: p.code || p.address || p.id }))}
                />
              </Form.Item>
            ) : null)}
          </Form.Item>
          <Form.Item name="title" label="任务标题" rules={[{ required: true, message: '请输入任务标题' }]}>
            <Input placeholder="例如：换密码 / 挂钥匙 / 维修跟进" />
          </Form.Item>
          <Form.Item name="content" label="任务具体内容">
            <Input.TextArea rows={4} placeholder="填写任务说明、需要注意的点、联系人等" />
          </Form.Item>
          <Form.Item name="assignee_id" label="分配人员">
            <Select allowClear placeholder="选择人员" options={staff.map((s) => ({ value: s.id, label: s.name }))} />
          </Form.Item>
          <Form.Item name="kind" label="任务分类" rules={[{ required: true, message: '请选择任务分类' }]}>
            <Select
              options={[
                { label: '挂钥匙', value: 'key_hanging' },
                { label: '换密码', value: 'password_change' },
                { label: '补消耗品', value: 'restock' },
                { label: '维修', value: 'maintenance' },
                { label: '检查（Inspection）', value: 'inspection' },
                { label: '其他', value: 'other' },
              ]}
            />
          </Form.Item>
          <Form.Item name="urgency" label="紧急程度" rules={[{ required: true, message: '请选择紧急程度' }]}>
            <Select
              options={[
                { label: '低', value: 'low' },
                { label: '中', value: 'medium' },
                { label: '高', value: 'high' },
                { label: '紧急', value: 'urgent' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        open={editOpen}
        title="查看 / 编辑线下任务"
        width={560}
        onClose={() => setEditOpen(false)}
        footer={
          <div style={{ textAlign: 'right' }}>
            <Space>
              <Popconfirm title="确认删除该任务？" okText="删除" cancelText="取消" onConfirm={() => (editing ? deleteOfflineTask(editing.id).catch((e) => message.error(e?.message || '删除失败')) : undefined)}>
                <Button danger disabled={!editing}>
                  删除
                </Button>
              </Popconfirm>
              <Button onClick={() => setEditOpen(false)}>关闭</Button>
              <Button type="primary" onClick={() => saveEdit().catch((e) => message.error(e?.message || '保存失败'))} disabled={!editing}>
                保存
              </Button>
            </Space>
          </div>
        }
      >
        <Form
          form={editForm}
          layout="vertical"
          onValuesChange={(changed, all) => {
            if (changed?.task_type && all.task_type !== 'property') editForm.setFieldsValue({ property_id: undefined })
          }}
        >
          <Form.Item name="date" label="执行日期" rules={[{ required: true, message: '请选择执行日期' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="task_type" label="任务类型" rules={[{ required: true, message: '请选择任务类型' }]}>
            <Select options={[{ label: '房源', value: 'property' }, { label: '公司', value: 'company' }, { label: '其他', value: 'other' }]} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.task_type !== cur.task_type}>
            {() => (editForm.getFieldValue('task_type') === 'property' ? (
              <Form.Item name="property_id" label="房源" rules={[{ required: true, message: '请选择房源' }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  filterOption={(input, option) => String((option as any)?.label || '').toLowerCase().includes(String(input || '').toLowerCase())}
                  options={sortProperties(Array.isArray(properties) ? properties : []).map((p) => ({ value: p.id, label: p.code || p.address || p.id }))}
                />
              </Form.Item>
            ) : null)}
          </Form.Item>
          <Form.Item name="title" label="任务标题" rules={[{ required: true, message: '请输入任务标题' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="content" label="任务具体内容">
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item name="assignee_id" label="分配人员">
            <Select allowClear options={staff.map((s) => ({ value: s.id, label: s.name }))} />
          </Form.Item>
          <Form.Item name="kind" label="任务分类" rules={[{ required: true, message: '请选择任务分类' }]}>
            <Select
              options={[
                { label: '挂钥匙', value: 'key_hanging' },
                { label: '换密码', value: 'password_change' },
                { label: '补消耗品', value: 'restock' },
                { label: '维修', value: 'maintenance' },
                { label: '检查（Inspection）', value: 'inspection' },
                { label: '其他', value: 'other' },
              ]}
            />
          </Form.Item>
          <Form.Item name="urgency" label="紧急程度" rules={[{ required: true, message: '请选择紧急程度' }]}>
            <Select
              options={[
                { label: '低', value: 'low' },
                { label: '中', value: 'medium' },
                { label: '高', value: 'high' },
                { label: '紧急', value: 'urgent' },
              ]}
            />
          </Form.Item>
          <Form.Item name="status" label="完成状态" rules={[{ required: true, message: '请选择状态' }]}>
            <Select options={[{ label: '未完成', value: 'todo' }, { label: '已完成', value: 'done' }]} />
          </Form.Item>
        </Form>
      </Drawer>

      <Modal
        open={rescheduleOpen}
        title="设置下次执行日期"
        okText="确定"
        onOk={() => submitReschedule().catch((e) => message.error(e?.message || '更新失败'))}
        onCancel={() => setRescheduleOpen(false)}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <div style={{ color: '#888' }}>{rescheduleTask ? `任务：${rescheduleTask.title}` : ''}</div>
          <DatePicker style={{ width: '100%' }} value={rescheduleDate} onChange={setRescheduleDate} />
        </Space>
      </Modal>
      </div>
    </div>
  )
}
