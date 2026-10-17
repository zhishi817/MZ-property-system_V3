"use client"

import { Alert, Card, Input, Select, Space, Switch, Typography } from 'antd'
import type { StayPolicyContent, StayPolicySection, StayServicePolicy } from '../lib/guestSiteStayPolicy'

const compactTimeOptions = ['12PM', '1PM', '2PM', '3PM', '4PM', '5PM', '6PM', '7PM', '8PM', '9PM', '10AM', '11AM'].map((value) => ({ value, label: value }))

export default function GuestSitePolicyContentEditor({
  section,
  value,
  onChange,
  disabled = false,
}: {
  section: StayPolicySection
  value: StayPolicyContent
  onChange: (value: StayPolicyContent) => void
  disabled?: boolean
}) {
  if (section === 'house_rules') {
    const items = (value as { items: string[] }).items || []
    return <Input.TextArea disabled={disabled} aria-label="英文房屋守则" rows={6} value={items.join('\n')} placeholder={'No smoking\nNo parties'} onChange={(event) => onChange({ items: event.target.value.split('\n').map((item) => item.trim()).filter(Boolean) })} />
  }
  if (section === 'cancellation_policy') {
    return <Input.TextArea disabled={disabled} aria-label="英文取消政策" rows={8} value={(value as { body: string }).body || ''} placeholder="Only enter confirmed English cancellation terms." onChange={(event) => onChange({ body: event.target.value })} />
  }
  if (section === 'stay_times') {
    const times = value as { checkin_time: string; checkout_time: string }
    return <Space wrap size={16} style={{ width: '100%' }}>
      <label><Typography.Text strong>入住时间</Typography.Text><Select disabled={disabled} aria-label="入住时间" style={{ display: 'block', width: 180, marginTop: 6 }} value={times.checkin_time} options={compactTimeOptions} onChange={(checkin_time) => onChange({ ...times, checkin_time })} /></label>
      <label><Typography.Text strong>退房时间</Typography.Text><Select disabled={disabled} aria-label="退房时间" style={{ display: 'block', width: 180, marginTop: 6 }} value={times.checkout_time} options={compactTimeOptions} onChange={(checkout_time) => onChange({ ...times, checkout_time })} /></label>
    </Space>
  }
  const services = (value as { services: StayServicePolicy[] }).services || []
  return <Space direction="vertical" size={12} style={{ width: '100%' }}>
    <Alert type="info" showIcon message="固定业务边界" description="早入住免费且不保证；晚退房至 11:30AM 为 A$20；放行李不代表可进入房间。三项均需提前申请和人工确认。" />
    {services.map((service, index) => <Card key={service.key} size="small" title={service.title || service.key} extra={<Switch disabled={disabled} checked={service.enabled} checkedChildren="显示" unCheckedChildren="隐藏" onChange={(enabled) => onChange({ services: services.map((item, itemIndex) => itemIndex === index ? { ...item, enabled } : item) })} />}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Input disabled={disabled} aria-label={`${service.key} 标题`} value={service.title} onChange={(event) => onChange({ services: services.map((item, itemIndex) => itemIndex === index ? { ...item, title: event.target.value } : item) })} />
        <Input disabled={disabled} aria-label={`${service.key} 摘要`} value={service.headline} onChange={(event) => onChange({ services: services.map((item, itemIndex) => itemIndex === index ? { ...item, headline: event.target.value } : item) })} />
        <Input.TextArea disabled={disabled} aria-label={`${service.key} 说明`} rows={3} value={service.description} onChange={(event) => onChange({ services: services.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item) })} />
      </Space>
    </Card>)}
  </Space>
}
