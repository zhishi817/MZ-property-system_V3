"use client"

import { App, Button, Card, Col, Form, Input, Row, Space, Typography, Upload } from 'antd'
import type { UploadFile } from 'antd/es/upload/interface'
import { useEffect, useState } from 'react'
import { API_BASE, authHeaders, getJSON, putJSON } from '../../../lib/api'
import type { GuestSiteConfig } from '../../../lib/guestSite'

export default function Page() {
  const [form] = Form.useForm<GuestSiteConfig>()
  const { message } = App.useApp()
  const [heroImages, setHeroImages] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    getJSON<GuestSiteConfig>('/cms/guest-site/config')
      .then((data) => {
        form.setFieldsValue(data)
        setHeroImages(Array.isArray(data.hero_background_urls) ? data.hero_background_urls : [])
      })
      .catch(() => {})
  }, [form])

  function syncHeroImages(next: string[]) {
    setHeroImages(next)
    form.setFieldValue('hero_background_urls', next)
  }

  async function uploadHeroImage(file: File) {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`${API_BASE}/cms/guest-site/config/hero-images/upload`, {
        method: 'POST',
        headers: { ...authHeaders() },
        body: fd,
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.url) throw new Error(String(json?.message || '上传失败'))
      syncHeroImages([...heroImages, String(json.url)])
      message.success('背景图已上传')
    } catch (e: any) {
      message.error(String(e?.message || '上传失败'))
    } finally {
      setUploading(false)
    }
    return false
  }

  async function submit() {
    const values = await form.validateFields()
    await putJSON('/cms/guest-site/config', { ...values, hero_background_urls: heroImages })
    message.success('站点设置已保存')
  }

  const uploadFileList: UploadFile[] = heroImages.map((url, index) => ({
    uid: `${index}-${url}`,
    name: `轮播图 ${index + 1}`,
    status: 'done',
    url,
  }))

  return (
    <Card
      title="预定网站设置"
      extra={
        <Space>
          <Button type="primary" onClick={submit}>
            保存设置
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 20 }}>
        管理首页 Banner、轮播背景图、品牌介绍、联系方式和 FAQ，这些内容会直接展示在独立的预定网站前台。
      </Typography.Paragraph>
      <Form form={form} layout="vertical" initialValues={{ hero_background_urls: [] }}>
        <Form.Item name="hero_background_urls" hidden>
          <Input />
        </Form.Item>
        <Card size="small" title="首页与品牌内容">
          <Form.Item name="banner_title" label="首页主标题" rules={[{ required: true, message: '请输入首页主标题' }]}>
            <Input placeholder="例如：Hosting Made Simple, Stay Made Memorable" />
          </Form.Item>
          <Form.Item name="banner_subtitle" label="首页副标题" rules={[{ required: true, message: '请输入首页副标题' }]}>
            <Input.TextArea rows={3} placeholder="用于展示在首页横幅下方的简短介绍" />
          </Form.Item>

          <Card size="small" title="首页轮播背景图" style={{ marginBottom: 16 }}>
            <Typography.Paragraph type="secondary">
              在这里上传首页顶部 Banner 的背景图。前台会按当前顺序自动轮播显示，第一张会优先作为默认首屏图。
            </Typography.Paragraph>
            <Space direction="vertical" style={{ width: '100%' }} size={16}>
              <Upload
                listType="picture-card"
                fileList={uploadFileList}
                multiple
                beforeUpload={(file) => uploadHeroImage(file as File)}
                onRemove={(file) => {
                  syncHeroImages(heroImages.filter((url) => url !== file.url))
                  return true
                }}
                showUploadList={{ showPreviewIcon: true, showRemoveIcon: true }}
              >
                {heroImages.length >= 12 ? null : <div>{uploading ? '上传中...' : '上传图片'}</div>}
              </Upload>
              {heroImages.length ? (
                <Space wrap>
                  {heroImages.map((url, index) => (
                    <Card
                      key={`${url}-${index}`}
                      size="small"
                      bodyStyle={{ padding: 12, width: 220 }}
                      cover={<img src={url} alt={`Hero ${index + 1}`} style={{ height: 120, objectFit: 'cover' }} />}
                      actions={[
                        <Button
                          key="up"
                          type="link"
                          disabled={index === 0}
                          onClick={() => {
                            if (index === 0) return
                            const next = [...heroImages]
                            ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
                            syncHeroImages(next)
                          }}
                        >
                          上移
                        </Button>,
                        <Button
                          key="down"
                          type="link"
                          disabled={index === heroImages.length - 1}
                          onClick={() => {
                            if (index >= heroImages.length - 1) return
                            const next = [...heroImages]
                            ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
                            syncHeroImages(next)
                          }}
                        >
                          下移
                        </Button>,
                        <Button key="delete" type="link" danger onClick={() => syncHeroImages(heroImages.filter((_, i) => i !== index))}>
                          删除
                        </Button>,
                      ]}
                    >
                      <Typography.Text type="secondary">第 {index + 1} 张</Typography.Text>
                    </Card>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary">还没有上传背景图。未上传时前台会回退使用房源图片。</Typography.Text>
              )}
            </Space>
          </Card>

          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="primary_button_text" label="主按钮文案" rules={[{ required: true, message: '请输入主按钮文案' }]}>
                <Input placeholder="例如：查看房源" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="primary_button_href" label="主按钮链接" rules={[{ required: true, message: '请输入主按钮链接' }]}>
                <Input placeholder="例如：/properties" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="secondary_button_text" label="次按钮文案">
                <Input placeholder="例如：联系我们" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="secondary_button_href" label="次按钮链接">
                <Input placeholder="例如：/#contact" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="brand_story" label="品牌介绍" rules={[{ required: true, message: '请输入品牌介绍' }]}>
            <Input.TextArea rows={5} />
          </Form.Item>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="contact_email" label="联系邮箱">
                <Input />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="contact_phone" label="联系电话">
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="contact_whatsapp" label="WhatsApp">
                <Input />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="contact_address" label="联系地址">
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Form.List name="faq_items">
            {(fields, { add, remove }) => (
              <div>
                <Typography.Title level={5}>常见问题</Typography.Title>
                {fields.map((field) => (
                  <Card key={field.key} size="small" style={{ marginBottom: 12 }} extra={<Button danger onClick={() => remove(field.name)}>删除</Button>}>
                    <Form.Item name={[field.name, 'question']} label="问题" rules={[{ required: true, message: '请输入问题' }]}>
                      <Input />
                    </Form.Item>
                    <Form.Item name={[field.name, 'answer']} label="回答" rules={[{ required: true, message: '请输入回答' }]}>
                      <Input.TextArea rows={3} />
                    </Form.Item>
                  </Card>
                ))}
                <Button onClick={() => add({ question: '', answer: '' })}>新增常见问题</Button>
              </div>
            )}
          </Form.List>
        </Card>
      </Form>
    </Card>
  )
}
