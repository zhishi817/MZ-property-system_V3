# /cleaning/calendar-range 接口说明

## 用途
用于清洁安排页面拉取指定日期区间内的清洁任务与线下任务，并为当日任务卡片提供顶部摘要所需字段。

## 请求
- Method: GET
- Path: `/cleaning/calendar-range`
- Query:
  - `from`: `YYYY-MM-DD`
  - `to`: `YYYY-MM-DD`

## 权限
需要具备以下任一权限：
- `cleaning.view`
- `cleaning.schedule.manage`
- `cleaning.task.assign`

## 响应（数组）
数组中每个元素为一个日历条目，字段如下（只列出与清洁安排使用相关的字段）：

### 通用字段
- `source`: `'cleaning_tasks' | 'offline_tasks'`
- `entity_id`: string
- `task_date`: `YYYY-MM-DD`
- `label`: string
- `status`: string
- `assignee_id`: string | null
- `scheduled_at`: string | null（ISO 时间戳或 null）

### 房源字段
- `property_id`: string | null
- `property_code`: string | null（房号，例如 `SH1910`）
- `property_region`: string | null（区域，例如 `Southbank`）

### 订单字段（source=cleaning_tasks 时可能存在）
- `order_id`: string | null
- `order_code`: string | null（订单号，优先使用 `orders.confirmation_code`）
- `nights`: number | null

### 顶部摘要字段（用于 1:1 UI 还原）
- `summary_checkout_time`: string | null（默认 `11:30`）
- `summary_checkin_time`: string | null（默认 `3pm`）

### 密码字段（source=cleaning_tasks）
- `old_code`: string | null
- `new_code`: string | null

## 过滤规则（后端已处理）
为避免“订单已删除/已取消但清洁任务仍显示”的脏数据影响 UI，本接口会过滤：
- `cleaning_tasks.status = 'cancelled'`
- `order_id` 有值但订单不存在
- 订单状态为空/invalid/包含 cancel

