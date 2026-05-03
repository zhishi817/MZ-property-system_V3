"use client"

import { App, Button, Card, Drawer, Form, Input, InputNumber, Space, Switch, Table, Tag, Typography, Upload } from 'antd'
import type { UploadProps } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { API_BASE, authHeaders, getJSON, patchJSON } from '../../../lib/api'
import { formatLineList, parseLineList, type GuestSiteProperty } from '../../../lib/guestSite'

type PropertyEditor = GuestSiteProperty & {
  gallery_urls_text?: string
  feature_tags_text?: string
  amenities_text?: string
  house_rules_text?: string
  booking_highlights_text?: string
  public_capacity_override?: number | null
}

const BOOKING_SITE_BASE =
  process.env.NEXT_PUBLIC_BOOKING_SITE_URL ||
  process.env.NEXT_PUBLIC_BOOKING_FRONTEND_URL ||
  'http://localhost:3004'

export default function Page() {
  const [data, setData] = useState<GuestSiteProperty[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [actionRowId, setActionRowId] = useState('')
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<GuestSiteProperty | null>(null)
  const [form] = Form.useForm<PropertyEditor>()
  const { message } = App.useApp()
  const watchedGalleryUrlsText = Form.useWatch('gallery_urls_text', form)
  const watchedHeroImageUrl = Form.useWatch('hero_image_url', form)
  const currentGallery = useMemo(() => parseLineList(watchedGalleryUrlsText || ''), [watchedGalleryUrlsText])

  async function load() {
    setLoading(true)
    try {
      const rows = await getJSON<GuestSiteProperty[]>('/cms/guest-site/properties').catch(() => [])
      const list = Array.isArray(rows) ? rows : []
      setData(
        [...list].sort((a, b) => {
          const regionA = String(a.public_region_label || a.region || '未分区')
          const regionB = String(b.public_region_label || b.region || '未分区')
          if (regionA !== regionB) return regionA.localeCompare(regionB)
          const sortGap = Number(a.sort_order || 99999) - Number(b.sort_order || 99999)
          if (sortGap) return sortGap
          return String(a.code || a.address || '').localeCompare(String(b.code || b.address || ''))
        }),
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const regionSummary = useMemo(() => Array.from(new Set(data.map((row) => row.public_region_label || row.region).filter(Boolean))), [data])

  function beginEdit(row: GuestSiteProperty) {
    setEditing(row)
    form.setFieldsValue({
      ...row,
      gallery_urls_text: formatLineList(row.gallery_urls),
      feature_tags_text: formatLineList(row.feature_tags),
      amenities_text: formatLineList(row.amenities),
      house_rules_text: formatLineList(row.house_rules),
      booking_highlights_text: formatLineList(row.booking_highlights),
    })
    setOpen(true)
  }

  async function saveRow(row: GuestSiteProperty, overrides?: Partial<PropertyEditor>) {
    setSaving(true)
    try {
      const values = overrides
        ? {
            is_published: overrides.is_published ?? row.is_published,
            hero_title: overrides.hero_title ?? row.hero_title,
            short_description: overrides.short_description ?? row.short_description,
            long_description: overrides.long_description ?? row.long_description,
            hero_image_url: overrides.hero_image_url ?? row.hero_image_url,
            gallery_urls_text: overrides.gallery_urls_text ?? formatLineList(row.gallery_urls),
            feature_tags_text: overrides.feature_tags_text ?? formatLineList(row.feature_tags),
            amenities_text: overrides.amenities_text ?? formatLineList(row.amenities),
            house_rules_text: overrides.house_rules_text ?? formatLineList(row.house_rules),
            booking_highlights_text: overrides.booking_highlights_text ?? formatLineList(row.booking_highlights),
            sort_order: overrides.sort_order ?? row.sort_order,
            public_region_label: overrides.public_region_label ?? row.public_region_label,
            public_capacity_override: overrides.public_capacity_override ?? row.public_capacity_override ?? null,
            bedroom_count: overrides.bedroom_count ?? row.bedroom_count ?? null,
            bathroom_count: overrides.bathroom_count ?? row.bathroom_count ?? null,
            bed_count: overrides.bed_count ?? row.bed_count ?? null,
            checkin_time: overrides.checkin_time ?? row.checkin_time ?? '',
            checkout_time: overrides.checkout_time ?? row.checkout_time ?? '',
            location_note: overrides.location_note ?? row.location_note ?? '',
            price_label: overrides.price_label ?? row.price_label ?? '',
          }
        : await form.validateFields()

      await patchJSON(`/cms/guest-site/properties/${encodeURIComponent(row.id)}`, {
        is_published: !!values.is_published,
        hero_title: values.hero_title || '',
        short_description: values.short_description || '',
        long_description: values.long_description || '',
        hero_image_url: values.hero_image_url || '',
        gallery_urls: parseLineList(values.gallery_urls_text || ''),
        feature_tags: parseLineList(values.feature_tags_text || ''),
        amenities: parseLineList(values.amenities_text || ''),
        house_rules: parseLineList(values.house_rules_text || ''),
        sort_order: Number(values.sort_order || 0),
        public_region_label: values.public_region_label || '',
        public_capacity_override: values.public_capacity_override ?? null,
        bedroom_count: values.bedroom_count ?? null,
        bathroom_count: values.bathroom_count ?? null,
        bed_count: values.bed_count ?? null,
        checkin_time: values.checkin_time || '',
        checkout_time: values.checkout_time || '',
        location_note: values.location_note || '',
        price_label: values.price_label || '',
        booking_highlights: parseLineList(values.booking_highlights_text || ''),
      })
      message.success('房源展示信息已保存')
      setOpen(false)
      setEditing(null)
      form.resetFields()
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function togglePublish(row: GuestSiteProperty, publish: boolean) {
    setActionRowId(row.id)
    try {
      await saveRow(row, { is_published: publish })
    } finally {
      setActionRowId('')
    }
  }

  async function uploadFile(file: File) {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`${API_BASE}/cms/guest-site/properties/upload-image`, { method: 'POST', headers: { ...authHeaders() }, body: fd })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      throw new Error(String(j?.message || `HTTP ${res.status}`))
    }
    const j = await res.json().catch(() => ({}))
    const url = String(j?.url || '')
    if (!url) throw new Error('missing_url')
    const current = form.getFieldValue('gallery_urls_text') || ''
    form.setFieldsValue({
      hero_image_url: form.getFieldValue('hero_image_url') || url,
      gallery_urls_text: current ? `${current}\n${url}` : url,
    })
    message.success('房源图片上传成功')
  }

  const uploadProps: UploadProps = {
    multiple: true,
    showUploadList: false,
    beforeUpload: (file) => {
      uploadFile(file as any).catch((e: any) => message.error(e?.message || '上传失败'))
      return false
    },
  }

  function previewUrl(row: GuestSiteProperty) {
    const preview = row.is_published ? '' : '?preview=1'
    return `${BOOKING_SITE_BASE.replace(/\/+$/g, '')}/properties/${encodeURIComponent(row.id)}${preview}`
  }

  return (
    <>
      <Card
        title="预定网站房源展示"
        extra={
          <Space wrap>
            <Button onClick={() => void load()} disabled={loading}>
              刷新
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 10 }}>
          这里只显示未归档房源，并按区域排序展示。前台标题默认使用 Airbnb Listing 标题，可维护房型、图片、文案、排序和上下架状态。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          当前区域：{regionSummary.length ? regionSummary.join(' / ') : '暂无'}
        </Typography.Paragraph>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={data}
          pagination={{ defaultPageSize: 20, showSizeChanger: true }}
          scroll={{ x: 'max-content' }}
          columns={[
            {
              title: '区域',
              dataIndex: 'public_region_label',
              width: 140,
              render: (_: any, row: GuestSiteProperty) => row.public_region_label || row.region || '-',
            },
            { title: '房号', dataIndex: 'code', width: 110 },
            {
              title: '前台标题',
              dataIndex: 'hero_title',
              render: (_: any, row: GuestSiteProperty) => row.hero_title || row.airbnb_listing_name || row.address || '-',
            },
            {
              title: '房型',
              dataIndex: 'type',
              width: 140,
              render: (v: string) => v || '-',
            },
            {
              title: '人数',
              dataIndex: 'capacity',
              width: 90,
              render: (_: any, row: GuestSiteProperty) => row.public_capacity_override || row.capacity || '-',
            },
            { title: '排序', dataIndex: 'sort_order', width: 90 },
            {
              title: '上架状态',
              dataIndex: 'is_published',
              width: 110,
              render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? '已上架' : '未上架'}</Tag>,
            },
            {
              title: '操作',
              width: 320,
              render: (_: any, row: GuestSiteProperty) => (
                <Space>
                  <Button
                    onClick={() => void togglePublish(row, !row.is_published)}
                    loading={actionRowId === row.id}
                    disabled={saving && actionRowId !== row.id}
                  >
                    {row.is_published ? '下架' : '上架'}
                  </Button>
                  <Button onClick={() => beginEdit(row)}>
                    编辑
                  </Button>
                  <Button onClick={() => window.open(previewUrl(row), '_blank')}>
                    预览
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        width={760}
        title={editing ? `编辑房源展示：${editing.code || editing.address}` : '编辑房源展示'}
        extra={
          <Space>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button type="primary" onClick={() => editing && void saveRow(editing)} loading={saving}>
              保存
            </Button>
          </Space>
        }
      >
        {editing ? (
          <Card size="small" style={{ marginBottom: 16 }}>
            <Space direction="vertical" size={6}>
              <Typography.Text>房号：{editing.code || '-'}</Typography.Text>
              <Typography.Text>区域：{editing.public_region_label || editing.region || '-'}</Typography.Text>
              <Typography.Text>Airbnb 标题：{editing.airbnb_listing_name || '-'}</Typography.Text>
              <Typography.Text>房型：{editing.type || '-'}</Typography.Text>
            </Space>
          </Card>
        ) : null}
        <Form form={form} layout="vertical">
          <Form.Item name="is_published" label="是否上架" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="hero_title" label="前台主标题">
            <Input placeholder="留空时默认使用 Airbnb Listing 标题" />
          </Form.Item>
          <Form.Item name="short_description" label="简短介绍">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="long_description" label="详细介绍">
            <Input.TextArea rows={6} />
          </Form.Item>
          <Form.Item name="hero_image_url" label="封面图片链接">
            <Input placeholder="上传第一张图片后会自动填入" />
          </Form.Item>
          <Form.Item name="gallery_urls_text" label="房源图片">
            <Input.TextArea rows={6} placeholder="每行一个图片链接，支持上传后自动追加" />
          </Form.Item>
          <Form.Item label="图片管理">
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Upload {...uploadProps}>
                <Button>上传房源图片（可多选）</Button>
              </Upload>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                上传后会自动追加到图片列表。你也可以在下方预览区把任意一张设为封面照。
              </Typography.Paragraph>
              {(watchedHeroImageUrl || currentGallery.length) ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))', gap: 12 }}>
                  {currentGallery.map((url, idx) => {
                    const isCover = url === watchedHeroImageUrl || (!watchedHeroImageUrl && idx === 0)
                    return (
                      <div
                        key={`${url}-${idx}`}
                        style={{
                          border: isCover ? '2px solid #1677ff' : '1px solid #e5e7eb',
                          borderRadius: 12,
                          overflow: 'hidden',
                          background: '#fff',
                        }}
                      >
                        <img
                          src={url}
                          alt={`房源图 ${idx + 1}`}
                          style={{ width: '100%', height: 120, objectFit: 'cover', display: 'block', background: '#f5f5f5' }}
                        />
                        <div style={{ padding: 8, display: 'grid', gap: 8 }}>
                          <Typography.Text style={{ fontSize: 12 }}>{isCover ? `图片 ${idx + 1} · 当前封面` : `图片 ${idx + 1}`}</Typography.Text>
                          <Button size="small" type={isCover ? 'primary' : 'default'} onClick={() => form.setFieldsValue({ hero_image_url: url })}>
                            {isCover ? '封面照' : '设为封面'}
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                  {!currentGallery.length && watchedHeroImageUrl ? (
                    <div
                      style={{
                        border: '2px solid #1677ff',
                        borderRadius: 12,
                        overflow: 'hidden',
                        background: '#fff',
                      }}
                    >
                      <img src={watchedHeroImageUrl} alt="封面图" style={{ width: '100%', height: 120, objectFit: 'cover', display: 'block', background: '#f5f5f5' }} />
                      <div style={{ padding: 8 }}>
                        <Typography.Text style={{ fontSize: 12 }}>当前封面照</Typography.Text>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  还没有上传图片。
                </Typography.Paragraph>
              )}
            </Space>
          </Form.Item>
          <Form.Item name="feature_tags_text" label="房源设置">
            <Input.TextArea rows={4} placeholder="每行一个设置标签，例如：整套房源、免费停车、自助入住" />
          </Form.Item>
          <Form.Item name="amenities_text" label="设施项目">
            <Input.TextArea rows={4} placeholder="每行一个设施，例如：免费停车、暖气、吹风机" />
          </Form.Item>
          <Form.Item name="house_rules_text" label="房屋守则">
            <Input.TextArea rows={4} placeholder="每行一条规则，例如：禁止带宠物、禁止吸烟" />
          </Form.Item>
          <Form.Item name="booking_highlights_text" label="预订侧栏提示">
            <Input.TextArea rows={3} placeholder="每行一条提示，例如：人工确认可订性、支持长住咨询" />
          </Form.Item>
          <Space style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 16 }}>
            <Form.Item name="sort_order" label="排序值">
              <InputNumber style={{ width: '100%' }} min={0} />
            </Form.Item>
            <Form.Item name="public_region_label" label="前台区域名称">
              <Input />
            </Form.Item>
            <Form.Item name="public_capacity_override" label="前台人数覆盖">
              <InputNumber style={{ width: '100%' }} min={1} />
            </Form.Item>
            <Form.Item label="房型">
              <Input value={editing?.type || ''} disabled />
            </Form.Item>
          </Space>
          <Space style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 16 }}>
            <Form.Item name="bedroom_count" label="卧室数">
              <InputNumber style={{ width: '100%' }} min={0} />
            </Form.Item>
            <Form.Item name="bathroom_count" label="浴室数">
              <InputNumber style={{ width: '100%' }} min={0} />
            </Form.Item>
            <Form.Item name="bed_count" label="床数">
              <InputNumber style={{ width: '100%' }} min={0} />
            </Form.Item>
            <Form.Item name="price_label" label="侧栏价格文案">
              <Input placeholder="例如：A$420 / 晚" />
            </Form.Item>
          </Space>
          <Space style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <Form.Item name="checkin_time" label="入住时间">
              <Input placeholder="例如：02:00 下午" />
            </Form.Item>
            <Form.Item name="checkout_time" label="退房时间">
              <Input placeholder="例如：12:00 中午前" />
            </Form.Item>
          </Space>
          <Form.Item name="location_note" label="位置说明">
            <Input.TextArea rows={3} placeholder="例如：Southbank, Melbourne, Australia" />
          </Form.Item>
        </Form>
      </Drawer>
    </>
  )
}
