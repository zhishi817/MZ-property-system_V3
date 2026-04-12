# 实时任务流 v2：来源覆盖清单

本文列出所有影响 `GET /mzapp/work-tasks` 返回结果的已知写路径，并给出统一事件策略。

统一原则：

- 任何影响 `/mzapp/work-tasks` 结果的写入，无论修改的是哪张表，都必须在提交成功后进入统一的 `emitWorkTaskEvent(...)` 流程。
- `emitWorkTaskEvent(...)` 只负责写规范化事件，不负责 SSE 在线用户过滤。
- SSE broker 在推送阶段再根据当前连接用户做权限过滤。

当前代码已接入的写路径：

- `backend/src/modules/work_tasks.ts`
- `backend/src/modules/cleaning.ts`
- `backend/src/modules/cleaning_app.ts`
- `backend/src/modules/mzapp.ts`

仍待继续补齐的边缘来源，保持以下文档口径不变，并按清单继续追。

## 1. 返回结果影响面

`/mzapp/work-tasks` 当前由两部分组成：

- `work_tasks` 直接任务
- `cleaning_tasks` 聚合任务

并且会拼接以下外部来源：

- `orders`
- `properties`
- `users`
- `cleaning_task_media`
- `cleaning_consumable_usages`

因此，事件覆盖必须按“影响返回结果”而不是“改了哪张主表”来定义。

## 2. 写路径与事件策略

### A. `work_tasks` 直接任务链路

#### A1. `backend/src/modules/work_tasks.ts`

来源：

- `POST /work-tasks`
- `PATCH /work-tasks/:id`
- `DELETE /work-tasks/:id`
- `PATCH /work-tasks/:id/status`
- 任何 `propagateToSource(...)` 之后回写 `work_tasks` 的逻辑

影响字段：

- `task_kind`
- `property_id`
- `title`
- `summary`
- `scheduled_date`
- `start_time`
- `end_time`
- `assignee_id`
- `status`
- `urgency`

事件策略：

- 新增 -> `TASK_CREATED`, `change_scope = list`
- 删除 -> `TASK_REMOVED`, `change_scope = membership`
- 指派变化 -> `TASK_ASSIGNMENT_CHANGED`, `change_scope = membership`
- 其余展示字段变化 -> `TASK_UPDATED`, `change_scope = list`

#### A2. `backend/src/modules/cleaning.ts`

来源：

- `upsertWorkTaskFromOfflineTask(...)`

影响：

- 把 `cleaning_offline_tasks` 映射进 `work_tasks`

事件策略：

- 首次插入 -> `TASK_CREATED`, `change_scope = list`
- 更新映射字段 -> `TASK_UPDATED`, `change_scope = list`
- 删除/取消导致不再出现在 `work_tasks` -> `TASK_REMOVED`, `change_scope = membership`

#### A3. `backend/src/modules/crud.ts`

来源：

- 对 `property_maintenance`
- 对 `property_deep_cleaning`
- 对其他同步进 `work_tasks` 的 source 资源

影响：

- 通过 `INSERT/UPDATE/DELETE work_tasks` 改变 `/mzapp/work-tasks`

事件策略：

- 新增 -> `TASK_CREATED`, `change_scope = list`
- 更新 -> `TASK_UPDATED`, `change_scope = list`
- 删除 -> `TASK_REMOVED`, `change_scope = membership`
- 改 `assignee_id` -> `TASK_ASSIGNMENT_CHANGED`, `change_scope = membership`

### B. `cleaning_tasks` 主表链路

#### B1. `backend/src/services/cleaningSync.ts`

来源：

- 清洁任务同步服务对 `cleaning_tasks` 的 `INSERT / UPSERT / UPDATE`

影响字段：

- `task_date/date`
- `status`
- `task_type`
- `cleaner_id`
- `inspector_id`
- `assignee_id`
- `checkout_time`
- `checkin_time`
- `old_code`
- `new_code`
- `guest_special_request`
- `keys_required`
- `property_id`

事件策略：

- 新任务 -> `TASK_CREATED`
- 时间/状态/任务类型/房源/排序影响 -> `TASK_UPDATED`, `change_scope = list`
- cleaner/inspector/assignee 变化 -> `TASK_ASSIGNMENT_CHANGED`, `change_scope = membership`
- 密码/客需变化 -> `TASK_UPDATED`, `change_scope = detail`

#### B2. `backend/src/modules/cleaning.ts`

来源：

- 后台清洁任务编辑
- 取消任务
- 启停自动同步
- 其他更新 `cleaning_tasks` 的管理操作

事件策略：

- 取消 -> `TASK_REMOVED` 或 `TASK_UPDATED(change_scope=membership)`，取决于任务是否从 app 结果中消失
- 指派变化 -> `TASK_ASSIGNMENT_CHANGED`, `change_scope = membership`
- 时间/状态变化 -> `TASK_UPDATED`, `change_scope = list`
- 非结果字段变化 -> 不发事件

#### B3. `backend/src/modules/mzapp.ts`

来源：

- `/cleaning-tasks/reorder`
- `/cleaning-tasks/:id/checkout*`
- `/cleaning-tasks/:id/...` 各类状态推进、完成、检查、客需、密码相关操作

关键影响：

- `sort_index_cleaner`
- `sort_index_inspector`
- `checked_out_at`
- `status`
- `old_code/new_code`
- `guest_special_request`
- `keys_required`

事件策略：

- 排序变化 -> `TASK_UPDATED`, `change_scope = list`
- 退房标记变化 -> `TASK_UPDATED`, `change_scope = list`
- 密码/客需 -> `TASK_UPDATED`, `change_scope = detail`
- 完成/检查完成 -> `TASK_COMPLETED`, `change_scope = list`

#### B4. `backend/src/modules/cleaning_app.ts`

来源：

- 清洁员 app 完成清洁
- 检查员 app 完成检查
- 补品填报
- 钥匙上传/删除
- 日终交接相关状态推进

事件策略：

- 影响状态推进 -> `TASK_UPDATED` 或 `TASK_COMPLETED`, `change_scope = list`
- 影响钥匙、补品、Reject、照片等详情 -> `TASK_DETAIL_ASSET_CHANGED`, `change_scope = detail`
- 若补品/Reject 导致列表状态变化，同时额外发 `TASK_UPDATED`, `change_scope = list`

### C. 非主表但影响 cleaning 聚合结果的来源

#### C1. `cleaning_task_media`

来源文件：

- `backend/src/modules/mzapp.ts`
- `backend/src/modules/cleaning_app.ts`

影响字段：

- `key_photo_url`
- `lockbox_video_url`
- `completion_photos_ok`
- 检查照片/完成照片相关详情

事件策略：

- `TASK_DETAIL_ASSET_CHANGED`, `change_scope = detail`
- 若媒体存在与否会改变列表状态，也额外发 `TASK_UPDATED`, `change_scope = list`

#### C2. `cleaning_consumable_usages`

来源文件：

- `backend/src/modules/mzapp.ts`
- `backend/src/modules/cleaning_app.ts`

影响字段：

- `restock_items`
- 低库存/待补品状态

事件策略：

- 详情变化 -> `TASK_DETAIL_ASSET_CHANGED`, `change_scope = detail`
- 状态变化 -> `TASK_UPDATED`, `change_scope = list`

#### C3. `orders`

`/mzapp/work-tasks` 当前直接读取：

- `checkin`
- `checkout`
- `nights`
- `status`
- `keys_required`

任何改这些字段且关联到 cleaning 任务的写入，都必须发事件。

事件策略：

- `checkin/checkout/nights/keys_required/status` 变化 -> `TASK_UPDATED`, `change_scope = list`
- 仅与任务返回无关的订单字段变化 -> 不发事件

#### C4. `properties`

`/mzapp/work-tasks` 当前直接读取：

- `code`
- `address`
- `type`
- `region`
- `access_guide_link`
- `wifi_ssid`
- `wifi_password`
- `router_location`

事件策略：

- `code/type/region` -> `TASK_UPDATED`, `change_scope = list`
- `address/access_guide_link/wifi/router_location` -> `TASK_UPDATED`, `change_scope = detail`

#### C5. `users`

`/mzapp/work-tasks` 当前直接读取：

- `cleaner_name`
- `inspector_name`

事件策略：

- 影响任务展示名字时 -> `TASK_UPDATED`, `change_scope = list`

### D. 管理视图二次聚合来源

#### D1. `/mzapp/work-tasks?view=all`

该接口会把同一房源同一天的 cleaning / inspection 结果再次合并成 manager 视图项。

因此任何影响以下内容的写入，都必须对 manager bucket 视为 `list` 级变化：

- `source_ids`
- `cleaning_status`
- `inspection_status`
- `start_time/end_time`
- `restock_items`
- `key_photo_url`
- `lockbox_video_url`
- `keys_required_*`

事件策略：

- 普通 task 事件照常写
- 前端 `all` bucket 收到后按 manager 聚合规则决定是否 safe patch，否则标记 dirty

## 3. 统一策略总结

### 一定发事件

- 新增任务
- 删除任务
- 取消导致任务不再可见
- cleaner / inspector / assignee 变化
- 状态变化
- 日期/时间变化
- 房源变化
- 排序变化
- 密码/客需变化
- 钥匙照片/挂钥匙视频变化
- 补品/Reject/完成照片变化
- orders 中影响 task 展示的字段变化
- properties 中影响 task 展示的字段变化
- users 中影响 cleaner_name / inspector_name 的字段变化

### 可以不发事件

- 完全不参与 `/mzapp/work-tasks` 构造的后台字段
- 只影响审计日志、不影响任务结果的字段
