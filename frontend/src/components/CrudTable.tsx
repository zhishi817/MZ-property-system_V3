"use client"
import React, { useEffect, useState } from 'react'
import { Table, Button, Modal, Form, Input, InputNumber, DatePicker, Select, Space, App, Upload, Card, Typography } from 'antd'
import type { UploadProps } from 'antd'
import dayjs from 'dayjs'
import { apiList, apiCreate, apiUpdate, apiDelete } from '../lib/api'
import { API_BASE, authHeaders } from '../lib/api'

export type Field = { key: string; label: string; type?: 'text'|'number'|'date'|'select'|'rich'; required?: boolean; options?: { value: string; label: string }[] }
type Column = any

export default function CrudTable({ resource, columns, fields }: { resource: string; columns: Column[]; fields: Field[] }) {
  const [data, setData] = useState<any[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<any | null>(null)
  const [form] = Form.useForm()
  const { message } = App.useApp()

  async function load() {
    try { const rows = await apiList<any[]>(resource); setData(Array.isArray(rows) ? rows : []) } catch { setData([]) }
  }
  useEffect(() => { load() }, [resource])

  function fieldNode(f: Field) {
    const common = { style: { width: '100%' } }
    switch (f.type) {
      case 'number': return <InputNumber {...common} />
      case 'date': return <DatePicker {...common} format="DD/MM/YYYY" />
      case 'select': return <Select {...common} options={f.options || []} />
      case 'rich': return <RichContentEditor form={form} fieldKey={f.key} />
      default: return <Input {...common} />
    }
  }

  async function submit() {
    const v = await form.validateFields()
    const payload: any = {}
    for (const f of fields) {
      let val = v[f.key]
      if (f.type === 'date' && val) val = dayjs(val).format('YYYY-MM-DD')
      payload[f.key] = val
    }
    try {
      if (editing) await apiUpdate(resource, editing.id, payload); else await apiCreate(resource, payload)
      setOpen(false); setEditing(null); form.resetFields(); load(); message.success('已保存')
    } catch (e: any) {
      message.error(`保存失败：${e?.message || ''}`)
    }
  }

  async function remove(row: any) {
    Modal.confirm({ title: '确认删除？', onOk: async () => { try { await apiDelete(resource, row.id); load(); message.success('已删除') } catch (e: any) { message.error(`删除失败：${e?.message || ''}`) } } })
  }

  const opsCol = { title: '操作', render: (_: any, r: any) => (<Space><Button onClick={() => { setEditing(r); setOpen(true); form.setFieldsValue(r) }}>编辑</Button><Button danger onClick={() => remove(r)}>删除</Button></Space>) }

  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={() => { setEditing(null); form.resetFields(); setOpen(true) }}>新建</Button>
        <Button onClick={load}>刷新</Button>
      </Space>
      <Table rowKey={(r) => r.id} dataSource={data} columns={[...columns, opsCol] as any} pagination={{ pageSize: 10 }} />
      <Modal open={open} onCancel={() => setOpen(false)} onOk={submit} title={editing ? '编辑' : '新建'}>
        <Form form={form} layout="vertical">
          {fields.map(f => (
            <Form.Item key={f.key} name={f.key} label={f.label} rules={f.required ? [{ required: true }] : []}>
              {fieldNode(f)}
            </Form.Item>
          ))}
        </Form>
      </Modal>
    </div>
  )
}

function RichContentEditor({ form, fieldKey }: { form: any; fieldKey: string }) {
  const [blocks, setBlocks] = useState<Array<{ type: 'text'|'image'|'heading'|'step'; text?: string; url?: string; caption?: string; title?: string; contents?: Array<{ type:'text'|'image'; text?: string; url?: string; caption?: string }> }>>([])
  const [initialLoaded, setInitialLoaded] = useState(false)
  const { message } = App.useApp()

  function parseInitial(html: string) {
    const arr: Array<{ type: 'text'|'image'|'heading'|'step'; text?: string; url?: string; caption?: string; title?: string; contents?: Array<{ type:'text'|'image'; text?: string; url?: string; caption?: string }> }> = []
    try {
      const div = document.createElement('div')
      div.innerHTML = html || ''
      const imgs = Array.from(div.querySelectorAll('img'))
      if (!imgs.length) {
        const ps = Array.from(div.querySelectorAll('p'))
        ps.forEach(p => arr.push({ type: 'text', text: p.textContent || '' }))
      } else {
        Array.from(div.childNodes).forEach((n: any) => {
          if (n.tagName === 'P') {
            arr.push({ type: 'text', text: n.textContent || '' })
          } else if (n.tagName === 'FIGURE') {
            const img = n.querySelector('img')
            const fc = n.querySelector('figcaption')
            if (img) arr.push({ type: 'image', url: img.getAttribute('src') || '', caption: fc?.textContent || '' })
          } else if (n.tagName === 'IMG') {
            arr.push({ type: 'image', url: n.getAttribute('src') || '' })
          } else if (n.tagName === 'H2') {
            arr.push({ type: 'heading', text: n.textContent || '' })
          } else if (n.tagName === 'OL') {
            const steps: any[] = []
            Array.from(n.children).forEach((li: any) => {
              const t = li.querySelector('strong')?.textContent || ''
              const subTexts = Array.from(li.querySelectorAll('ol li')).map((x: any) => ({ type:'text', text: x.textContent || '' }))
              const figs = Array.from(li.querySelectorAll('figure')).map((f: any) => ({ type:'image', url: f.querySelector('img')?.getAttribute('src') || '', caption: f.querySelector('figcaption')?.textContent || '' }))
              steps.push({ type:'step', title: t, contents: [...subTexts, ...figs] })
            })
            arr.push(...steps)
          }
        })
      }
    } catch {}
    return arr
  }

  useEffect(() => {
    if (initialLoaded) return
    try {
      const v = form.getFieldValue(fieldKey) || ''
      if (v) setBlocks(parseInitial(String(v)))
    } catch {}
    setInitialLoaded(true)
  }, [initialLoaded, form, fieldKey])

  function toHTML(b: Array<{ type: 'text'|'image'|'heading'|'step'; text?: string; url?: string; caption?: string; title?: string; contents?: Array<{ type:'text'|'image'; text?: string; url?: string; caption?: string }> }>): string {
    const parts: string[] = []
    let inSteps = false
    b.forEach(x => {
      if (x.type === 'step') {
        if (!inSteps) { parts.push('<ol style="margin:12px 0 12px 20px">'); inSteps = true }
        const inner: string[] = []
        const items = Array.isArray(x.contents) ? x.contents : []
        const texts = items.filter(i => i.type === 'text')
        const images = items.filter(i => i.type === 'image')
        if (texts.length) {
          inner.push('<ol type="a" style="margin:6px 0 6px 18px">')
          texts.forEach(t => inner.push(`<li>${(t.text || '').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</li>`))
          inner.push('</ol>')
        }
        images.forEach(img => inner.push(`<figure style="margin:6px 0 12px"><img src="${img.url || ''}" style="max-width:100%;border-radius:8px"/>${img.caption ? `<figcaption style="color:#666;font-size:12px;margin-top:4px">${img.caption}</figcaption>` : ''}</figure>`))
        parts.push(`<li><strong>${(x.title || '').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</strong>${inner.join('')}</li>`)
      } else {
        if (inSteps) { parts.push('</ol>'); inSteps = false }
        if (x.type === 'heading') parts.push(`<h2 style="margin:16px 0">${(x.text || '').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</h2>`)
        else if (x.type === 'text') parts.push(`<p>${(x.text || '').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>`)
        else parts.push(`<figure style="margin:0 0 12px"><img src="${x.url || ''}" style="max-width:100%;border-radius:8px"/>${x.caption ? `<figcaption style="color:#666;font-size:12px;margin-top:4px">${x.caption}</figcaption>` : ''}</figure>`)
      }
    })
    if (inSteps) parts.push('</ol>')
    return parts.join('\n')
  }

  function syncForm(b = blocks) { try { form.setFieldsValue({ [fieldKey]: toHTML(b) }) } catch {} }

  function addText() { const nb = [...blocks, { type: 'text', text: '' }]; setBlocks(nb); syncForm(nb) }
  function addHeading() { const nb = [...blocks, { type: 'heading', text: '' }]; setBlocks(nb); syncForm(nb) }
  function addStep() { const nb = [...blocks, { type: 'step', title: '', contents: [] }]; setBlocks(nb); syncForm(nb) }
  function addImage(url: string) { const nb = [...blocks, { type: 'image', url }]; setBlocks(nb); syncForm(nb) }
  function addStepText(idx: number) { const nb = blocks.slice(); const c = Array.isArray(nb[idx].contents) ? nb[idx].contents : []; c.push({ type:'text', text:'' }); nb[idx].contents = c; setBlocks(nb); syncForm(nb) }
  function addStepImage(idx: number, url: string) { const nb = blocks.slice(); const c = Array.isArray(nb[idx].contents) ? nb[idx].contents : []; c.push({ type:'image', url }); nb[idx].contents = c; setBlocks(nb); syncForm(nb) }

  async function uploadFile(file: File, stepIndex?: number) {
    const fd = new FormData()
    fd.append('file', file)
    try {
      const res = await fetch(`${API_BASE}/maintenance/upload`, { method: 'POST', headers: { ...authHeaders() }, body: fd })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      const url = j?.url || ''
      if (!url) throw new Error('missing url')
      if (typeof stepIndex === 'number') addStepImage(stepIndex, url); else addImage(url)
      message.success('图片已上传')
    } catch (e: any) { message.error(`上传失败：${e?.message || ''}`) }
  }

  const uploadProps: UploadProps = {
    multiple: false,
    showUploadList: false,
    beforeUpload: (file) => { uploadFile(file as any); return false },
  }

  function updateText(i: number, val: string) { const nb = blocks.slice(); nb[i] = { ...nb[i], text: val }; setBlocks(nb); syncForm(nb) }
  function updateHeading(i: number, val: string) { const nb = blocks.slice(); nb[i] = { ...nb[i], text: val }; setBlocks(nb); syncForm(nb) }
  function updateStepTitle(i: number, val: string) { const nb = blocks.slice(); nb[i] = { ...nb[i], title: val }; setBlocks(nb); syncForm(nb) }
  function updateCaption(i: number, val: string) { const nb = blocks.slice(); nb[i] = { ...nb[i], caption: val }; setBlocks(nb); syncForm(nb) }
  function remove(i: number) { const nb = blocks.slice(); nb.splice(i,1); setBlocks(nb); syncForm(nb) }
  function updateStepText(si: number, idx: number, val: string) { const nb = blocks.slice(); const c = Array.isArray(nb[si].contents) ? nb[si].contents : []; if (c[idx]) c[idx] = { ...c[idx], text: val }; nb[si].contents = c; setBlocks(nb); syncForm(nb) }
  function removeStepItem(si: number, idx: number) { const nb = blocks.slice(); const c = Array.isArray(nb[si].contents) ? nb[si].contents : []; c.splice(idx,1); nb[si].contents = c; setBlocks(nb); syncForm(nb) }

  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        <Button onClick={addHeading}>添加标题</Button>
        <Button onClick={addStep}>添加步骤</Button>
        <Button onClick={addText}>添加文字</Button>
        <Upload {...uploadProps}><Button>上传图片</Button></Upload>
        <Button onClick={() => syncForm()}>生成内容</Button>
      </Space>
      <div style={{ display:'flex', gap:16, alignItems:'flex-start', flexWrap:'wrap' }}>
        <div style={{ flex: 1, minWidth: 320 }}>
          {blocks.map((b, i) => (
            <Card key={i} size="small" style={{ marginBottom: 8 }} title={b.type === 'text' ? '文字' : (b.type === 'image' ? '图片' : (b.type === 'heading' ? '标题' : '步骤'))} extra={<Button danger size="small" onClick={()=>remove(i)}>删除</Button>}>
              {b.type === 'text' && (
                <Input.TextArea value={b.text} onChange={(e)=>updateText(i, e.target.value)} autoSize={{ minRows: 3 }} />
              )}
              {b.type === 'heading' && (
                <Input value={b.text} onChange={(e)=>updateHeading(i, e.target.value)} />
              )}
              {b.type === 'image' && (
                <div>
                  {b.url ? <img src={b.url} style={{ maxWidth:'100%', borderRadius:8 }} /> : <div style={{ color:'#888' }}>尚未选择图片</div>}
                  <Input placeholder="图片说明（可选）" value={b.caption} onChange={(e)=>updateCaption(i, e.target.value)} style={{ marginTop:8 }} />
                </div>
              )}
              {b.type === 'step' && (
                <div>
                  <Input placeholder="步骤标题" value={b.title} onChange={(e)=>updateStepTitle(i, e.target.value)} style={{ marginBottom:8 }} />
                  <Space style={{ marginBottom:8 }}>
                    <Button onClick={()=>addStepText(i)}>添加文字子项</Button>
                    <Upload multiple={false} showUploadList={false} beforeUpload={(file)=>{ uploadFile(file as any, i); return false }}><Button>上传图片到步骤</Button></Upload>
                  </Space>
                  {(b.contents || []).map((c, idx) => (
                    <Card key={idx} size="small" style={{ marginBottom:8 }} title={c.type === 'text' ? '子项文字' : '子项图片'} extra={<Button danger size="small" onClick={()=>removeStepItem(i, idx)}>删除</Button>}>
                      {c.type === 'text' ? (
                        <Input.TextArea value={c.text} onChange={(e)=>updateStepText(i, idx, e.target.value)} autoSize={{ minRows: 2 }} />
                      ) : (
                        <div>
                          {c.url ? <img src={c.url} style={{ maxWidth:'100%', borderRadius:8 }} /> : <div style={{ color:'#888' }}>尚未选择图片</div>}
                          <Input placeholder="图片说明（可选）" value={c.caption} onChange={(e)=>{ const nb = blocks.slice(); const cc = Array.isArray(nb[i].contents) ? nb[i].contents : []; if (cc[idx]) cc[idx] = { ...cc[idx], caption: e.target.value }; nb[i].contents = cc; setBlocks(nb); syncForm(nb) }} style={{ marginTop:8 }} />
                        </div>
                      )}
                    </Card>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
        <div style={{ width: 375, border:'1px solid #eee', borderRadius:24, padding:12, boxShadow:'0 6px 20px rgba(0,0,0,0.08)' }}>
          <Typography.Text type="secondary">手机预览</Typography.Text>
          <div style={{ marginTop:8 }}>
            <div style={{ fontSize:16, fontWeight:600, marginBottom:8 }}>预览</div>
            <div dangerouslySetInnerHTML={{ __html: toHTML(blocks) }} style={{ lineHeight:1.6 }} />
          </div>
        </div>
      </div>
    </div>
  )
}