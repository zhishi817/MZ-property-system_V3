"use client"

import { Badge, Button, Empty, List, Popover, Space, Tag, Typography } from 'antd'
import { BellOutlined, DeleteOutlined } from '@ant-design/icons'
import { useEffect, useMemo, useState } from 'react'
import {
  ADMIN_NOTIFICATIONS_CHANGED,
  clearAdminNotifications,
  loadAdminNotifications,
  markAdminNotificationsRead,
  type AdminNotification,
  type AdminNotificationType,
} from '../lib/adminNotifications'

const typeColor: Record<AdminNotificationType, string> = {
  info: 'blue',
  success: 'green',
  warning: 'gold',
  error: 'red',
}

const typeText: Record<AdminNotificationType, string> = {
  info: '提示',
  success: '成功',
  warning: '注意',
  error: '失败',
}

function formatNoticeTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

export function AdminNotificationBell() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<AdminNotification[]>([])

  const reload = () => setItems(loadAdminNotifications())

  useEffect(() => {
    reload()
    window.addEventListener(ADMIN_NOTIFICATIONS_CHANGED, reload)
    window.addEventListener('storage', reload)
    return () => {
      window.removeEventListener(ADMIN_NOTIFICATIONS_CHANGED, reload)
      window.removeEventListener('storage', reload)
    }
  }, [])

  const unreadCount = useMemo(() => items.filter((item) => !item.read).length, [items])

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen) {
      markAdminNotificationsRead()
      reload()
    }
  }

  const content = (
    <div className="mz-admin-notification-panel">
      <div className="mz-admin-notification-head">
        <Typography.Text strong>通知</Typography.Text>
        <Button
          type="text"
          size="small"
          icon={<DeleteOutlined />}
          disabled={!items.length}
          onClick={() => {
            clearAdminNotifications()
            reload()
          }}
        >
          清空
        </Button>
      </div>
      {items.length ? (
        <List
          size="small"
          dataSource={items}
          renderItem={(item) => (
            <List.Item className={!item.read ? 'mz-admin-notification-unread' : undefined}>
              <div className="mz-admin-notification-item">
                <Space size={6} wrap>
                  <Tag color={typeColor[item.type]}>{typeText[item.type]}</Tag>
                  <Typography.Text strong>{item.title}</Typography.Text>
                </Space>
                <Typography.Paragraph className="mz-admin-notification-message">
                  {item.message}
                </Typography.Paragraph>
                <Typography.Text type="secondary" className="mz-admin-notification-time">
                  {formatNoticeTime(item.created_at)}
                </Typography.Text>
              </div>
            </List.Item>
          )}
        />
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无通知" />
      )}
    </div>
  )

  return (
    <Popover
      trigger="click"
      placement="bottomRight"
      open={open}
      onOpenChange={handleOpenChange}
      content={content}
    >
      <Badge count={unreadCount} size="small" offset={[-2, 2]}>
        <Button
          className="mz-admin-notification-button"
          type="text"
          shape="circle"
          icon={<BellOutlined />}
          aria-label="通知"
        />
      </Badge>
    </Popover>
  )
}
