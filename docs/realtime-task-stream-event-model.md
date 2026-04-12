# 实时任务流 v2：事件模型文档

## 1. 目标

定义统一的任务变化事件模型，作为 SSE 实时任务流与断线补偿的唯一事实源。

当前仓库里的首版落地口径：

- 事件表与 SSE 补偿链路已经按本文实现
- `task_id` 当前先采用后端稳定源任务 id
  - `work_task:<work_tasks.id>`
  - `cleaning_task:<cleaning_tasks.id>`
- 对 `/mzapp/work-tasks` 中 cleaner / inspector / manager 的聚合 bucket，前端应优先把这类源任务事件视为增量线索
- 当事件不足以安全重建聚合结果时，按 `dirty/resync` 规则兜底全量同步

## 2. 事件表

建议表名：`work_task_events`

字段：

- `id text primary key`
- `event_id text unique not null`
- `sequence_no bigint not null unique`
- `task_id text not null`
- `task_version bigint not null`
- `source_type text not null`
- `source_ref_ids text[]`
- `event_type text not null`
- `change_scope text not null`
- `changed_fields text[]`
- `payload jsonb not null`
- `occurred_at timestamptz not null`
- `caused_by_user_id text`
- `visibility_hints jsonb`
- `created_at timestamptz default now()`

约束：

- `sequence_no`：全局单调递增
- `task_version`：同一任务单调递增
- 不能只依赖 `updated_at`

## 3. 事件类型

允许值：

- `TASK_CREATED`
- `TASK_UPDATED`
- `TASK_REMOVED`
- `TASK_ASSIGNMENT_CHANGED`
- `TASK_COMPLETED`
- `TASK_DETAIL_ASSET_CHANGED`

说明：

- `TASK_CREATED`
  - 任务首次进入 `/mzapp/work-tasks`
- `TASK_UPDATED`
  - 列表或详情字段更新
- `TASK_REMOVED`
  - 任务从当前任务结果中移除
- `TASK_ASSIGNMENT_CHANGED`
  - cleaner / inspector / assignee 变化，影响可见归属
- `TASK_COMPLETED`
  - 任务完成态推进
- `TASK_DETAIL_ASSET_CHANGED`
  - 钥匙照片、视频、补品、Reject、完成照片等详情资源变更

## 4. `change_scope`

允许值：

- `list`
- `detail`
- `membership`

### `list`

会影响：

- 列表可见字段
- 排序
- 状态
- 分组
- manager 聚合结果

### `detail`

只影响：

- 详情展开内容
- 附件/照片
- 说明性字段

### `membership`

会影响：

- 当前用户是否还能看到该任务
- 任务是否属于当前 `mine` bucket
- 任务是否应从某 bucket 移除或加入

## 5. payload 最小结构

建议：

```json
{
  "task_id": "cleaning_task:9d1f...",
  "source_type": "cleaning_tasks",
  "source_ref_ids": ["raw-cleaning-task-id-1", "raw-cleaning-task-id-2"],
  "event_type": "TASK_UPDATED",
  "change_scope": "detail",
  "changed_fields": ["old_code", "new_code"],
  "patch": {
    "old_code": "1234",
    "new_code": "5678"
  },
  "occurred_at": "2026-04-11T10:20:30.000Z",
  "task_version": 14,
  "sequence_no": 10923
}
```

要求：

- `patch` 只放这次变化真正需要的最小字段
- 不可为了省事把整个 task snapshot 塞进去

## 6. safe patch 白名单

前端只有收到以下字段变化时，才允许直接 patch 本地 store。

### list 级 safe patch

- `status`
- `scheduled_date`
- `start_time`
- `end_time`
- `urgency`
- `title`
- `summary`
- `old_code`
- `new_code`
- `guest_special_request`
- `checked_out_at`
- `key_photo_url`
- `lockbox_video_url`
- `sort_index`
- `sort_index_cleaner`
- `sort_index_inspector`
- `cleaner_name`
- `inspector_name`
- `keys_required`
- `keys_required_checkout`
- `keys_required_checkin`

### detail 级 safe patch

- `restock_items`
- `completion_photos_ok`
- `key_photo_url`
- `lockbox_video_url`
- `old_code`
- `new_code`
- `guest_special_request`
- `property.address`
- `property.access_guide_link`
- `property.wifi_ssid`
- `property.wifi_password`
- `property.router_location`

### 不在白名单中的字段

规则：

- 不直接 patch
- 标记 bucket `dirty`
- 触发后续 `resync` 或兜底全量拉取

## 7. dirty / resync 规则

### 直接 patch

满足以下条件时才允许：

- `change_scope` 为 `list` 或 `detail`
- `changed_fields` 全部在 safe patch 白名单中
- 本地已有该任务
- 收到的 `task_version` 大于本地版本

### 标记 dirty

以下任一命中都标记 dirty：

- `change_scope = membership`
- 本地没有该任务但事件不是 `TASK_CREATED`
- `patch` 不足以安全更新 bucket
- `changed_fields` 不全在 safe patch 白名单中
- manager 聚合 bucket 无法确定局部更新是否正确

### 触发 resync

以下任一命中触发全量同步：

- 收到后端 `resync_required`
- `Last-Event-ID` 无法补偿
- bucket 长时间 dirty 未消化
- 本地 `task_version` 检测到不可恢复跳跃
- 距离 `lastFullSyncTimestamp` 超过阈值
