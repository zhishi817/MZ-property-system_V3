# 通知事件规则审计与落地状态

## 1. 目的

这份文档分成两部分：

- 历史现状审计：记录本轮修复前，通知系统在代码中的真实状态与主要问题。
- 当前落地状态：记录本轮修复后，当前代码已经收敛到什么规则，哪些地方已经统一，哪些地方仍是刻意保留的例外。

说明：

- 本文基于仓库代码快照，不等同于线上数据库全量配置。
- “manager” 在当前代码中的默认集合为：`admin`、`offline_manager`、`customer_service`。
- `cleaning_manager` 不纳入当前通知规则设计。

## 1.1 当前真实角色表

以下角色集合按你提供的后台“角色权限”页面对齐，本文后续所有角色表述与矩阵列都以这份角色表为准：

| 角色 | 说明 | 是否纳入当前通知矩阵 |
| --- | --- | --- |
| `admin` | 系统管理员 | 是 |
| `customer_service` | 客服 | 是 |
| `finance_staff` | 财务人员 | 是 |
| `inventory_manager` | 仓库管理员 | 是 |
| `maintenance_staff` | 维修人员 | 是 |
| `Finance_stuff_assistant` | 财务助理 | 是 |
| `cleaner` | 清洁人员 | 是 |
| `cleaning_inspector` | 检查人员 | 是 |
| `offline_manager` | 线下经理 | 是 |

补充说明：

- 文档中不再保留 `cleaner_inspector` 这一列。
- 文档中不再保留 `cleaning_manager` 这一列。
- 当前代码里的默认 manager 集合仍是：`admin + offline_manager + customer_service`。

## 2. 历史现状审计（修复前快照）

### 2.1 修复前的核心问题

| 主题 | 修复前状态 | 风险 |
| --- | --- | --- |
| 发送链路 | 同一业务动作可能同时调用 `emitNotificationEvent` 和 `notifyExpoUsers` | 双轨发送，难审计，容易重复或漂移 |
| push / inbox 关系 | 部分事件只有 push，没有统一进入 inbox | 用户能收到推送，但通知中心无记录 |
| manager 定义 | 默认 manager 角色与部分业务调用点手工写死角色不一致 | 同类事件收件人不稳定 |
| reminder 事件建模 | reminder / SLA / job 类通知复用 `WORK_TASK_UPDATED` 等普通事件类型 | 语义不清晰，后续规则难扩展 |
| 幂等 | reminder / SLA 事件缺少稳定去重键 | job 重跑可能导致重复通知 |
| recipient 保护 | 最终 recipients 为空时缺少统一兜底 | 容易静默丢通知，问题不易发现 |
| `mzapp_alerts` 定位 | 某些提醒逻辑既写 alert 又直接 push | 主通知中心与任务页提醒体系割裂 |

### 2.2 修复前主要事件源分类

#### A. 统一事件流

统一事件流入口原本已经存在，但没有完全覆盖所有通知发送：

- `CLEANING_TASK_UPDATED`
- `CLEANING_COMPLETED`
- `INSPECTION_COMPLETED`
- `KEY_PHOTO_UPLOADED`
- `ISSUE_REPORTED`
- `WORK_TASK_UPDATED`

这些事件通过 `emitNotificationEvent(...)` 进入 `user_notifications` 和 `event_queue`，但并不是所有业务动作都只走这条链路。

#### B. 业务层直推入口

修复前，以下类型的逻辑存在直接 `notifyExpoUsers(...)` 的历史分支：

- `mzapp` 中的退房标记 / 取消退房 / 批量退房 / 按订单退房
- `mzapp` 中的 `manager-fields` 更新
- `keyUploadReminderJob`
- `keyUploadSlaJob`

这导致“同一业务动作一部分走 inbox+queue，一部分直接 push”的双轨问题。

### 2.3 修复前 manager 角色问题

修复前代码中存在两种并存情况：

- 一部分逻辑依赖 `listManagerUserIds()` 默认集合。
- 一部分逻辑直接写死 `['admin', 'offline_manager']` 或手工拼上 `customer_service`。

结果是：

- 同类 manager 事件的接收人并不稳定。
- `customer_service` 是否收到通知，取决于具体调用点有没有手工补。

### 2.4 修复前 reminder / SLA 事件问题

修复前以下提醒类事件没有独立的通知事件模型：

- 日终交接提醒
- 日终交接 manager 提醒
- 钥匙上传提醒
- 钥匙上传 SLA 提醒
- 钥匙上传 SLA 升级

这些逻辑要么直接 push，要么借用普通任务更新事件类型，存在两个问题：

- 事件语义不精确。
- 很难稳定建立幂等与去重规则。

## 3. 当前代码落地状态（已修复）

### 3.1 当前统一规则

#### 规则 1：业务发送入口统一为 `emitNotificationEvent`

当前业务模块、job、脚本统一要求只调用：

- `emitNotificationEvent(...)`

`notifyExpoUsers(...)` 仍然保留在底层模块中，但只允许由 queue worker 调用，用于把已入队的通知派生为 Expo push。

#### 规则 2：push 是 inbox 的派生结果

当前通知主事实来源为：

- `user_notifications`
- `event_queue`

push 不再被业务代码直接发送，而是从 queue worker 异步派生。

这意味着：

- 所有 push 都必须先进入 inbox / queue
- 不允许再出现“只有 push、没有 inbox”的业务通知

#### 规则 3：默认 manager 集合统一

当前默认 manager 集合为：

- `admin`
- `offline_manager`
- `customer_service`

当前默认 manager 查询统一通过 `listManagerUserIds()` 获取。

说明：

- `customer_service` 现在属于默认 manager 集合。
- `cleaning_manager` 不存在于当前通知规则设计中，也不应作为默认收件角色出现。

#### 规则 4：reminder / SLA 使用独立事件类型

当前代码已新增并使用以下专用事件类型：

- `DAY_END_HANDOVER_REMINDER`
- `DAY_END_HANDOVER_MANAGER_REMINDER`
- `KEY_UPLOAD_REMINDER`
- `KEY_UPLOAD_SLA_REMINDER`
- `KEY_UPLOAD_SLA_ESCALATION`

`WORK_TASK_UPDATED` 不再承担 reminder / SLA / job 类通知的语义。

#### 规则 5：reminder / SLA 事件必须显式带幂等键

当前 reminder / SLA 相关逻辑已显式传入稳定 `eventId`，用于承接唯一约束和去重逻辑。

当前已落地的典型键格式包括：

- `day_end_handover_reminder:${date}:${at}:${userId}`
- `day_end_handover_manager_reminder:${date}:${at}:${targetUserId}`
- `key_upload_reminder:${date}:${at}:cleaner:${userId}`
- `key_upload_reminder:${date}:${at}:manager:${userId}`
- `key_upload_sla:${date}:${position}:remind:${cleanerId}`
- `key_upload_sla:${date}:${position}:escalate:${managerId}:${cleanerId}`

#### 规则 6：job 场景不传 actor

当前 job / 定时任务类提醒遵循以下语义：

- 有明确人工操作者时，默认排除 actor
- 无人工操作者的系统 job，不传 `actorUserId`
- 不引入“系统 actor”占位用户

结果是：

- job 不会误把第一接收人排掉
- “exclude actor” 只在真实人工操作场景中生效

#### 规则 7：最终 recipient 为空时必须失败并报警

当前 `emitNotificationEvent(...)` 已增加统一兜底保护：

- 计算完最终 recipients 后，如果为空，不再静默成功
- 返回失败结果：
  - `ok: false`
  - `sent: 0`
  - `error_code: 'NO_RECIPIENTS'`
- 同时记录结构化错误日志

这条规则用于兜住：

- 默认 recipient 规则变化
- 显式 recipients 过滤后为空
- property scope 过滤后为空
- actor 排除后为空

#### 规则 8：`mzapp_alerts` 降级为辅助视图

当前 `mzapp_alerts` 仍然保留，主要用于任务页的结构化提醒，尤其是 key upload SLA 相关场景。

但它现在不再承担“主发送源”的角色：

- alert 可以继续写
- 但不能替代 inbox
- alert 成功写入后，仍需同步进入统一通知事件流

主通知事实来源仍然是 inbox。

### 3.2 当前已落地的关键调用点

#### A. 已改为单轨发送的业务入口

以下历史双轨入口已收敛为只走 `emitNotificationEvent(...)`：

- `dayEndHandoverReminderJob`
- `keyUploadReminderJob`
- `keyUploadSlaJob`
- `mzapp` 的退房标记 / 取消退房 / 批量退房 / 按订单退房
- `mzapp` 的 `manager-fields` 更新

#### B. 当前仍保留的显式 recipient 例外

并不是所有事件都完全依赖默认 manager 集合；部分事件仍保留显式 recipients，这是刻意设计，不是遗漏。

典型例子：

- `ISSUE_REPORTED` 相关路径仍显式包含 `customer_service`

原则是：

- 默认 manager 事件走默认集合
- 有明确业务含义的例外事件，允许继续显式指定 recipients

## 4. 当前事件类型状态

### 4.1 普通业务事件

- `ORDER_UPDATED`
- `CLEANING_TASK_UPDATED`
- `CLEANING_COMPLETED`
- `INSPECTION_COMPLETED`
- `KEY_PHOTO_UPLOADED`
- `ISSUE_REPORTED`
- `WORK_TASK_UPDATED`

说明：

- `WORK_TASK_UPDATED` 现在只保留给真实 work task 更新类事件。

### 4.2 reminder / SLA 专用事件

- `DAY_END_HANDOVER_REMINDER`
- `DAY_END_HANDOVER_MANAGER_REMINDER`
- `KEY_UPLOAD_REMINDER`
- `KEY_UPLOAD_SLA_REMINDER`
- `KEY_UPLOAD_SLA_ESCALATION`

这些事件已经拥有独立标题、正文和优先级语义，不再伪装成普通任务更新。

### 4.3 当前事件通知规则表

下表按“当前代码落地状态”整理。这里的“当前通知对象”描述的是当前 recipient 解析规则，而不是业务期望。

| 事件类型 | 典型触发动作 | 当前通道 | 当前通知对象 | 排除操作者 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `ORDER_UPDATED` | 订单信息更新 | inbox + queue + push | 关联 cleaning task 参与人 + 默认 manager | 是，若传 `actorUserId` | 默认规则来自 `notificationEvents.ts` |
| `CLEANING_TASK_UPDATED` | 清洁任务字段更新、退房类任务更新 | inbox + queue + push | cleaning task 参与人 + 默认 manager | 是，若传 `actorUserId` | `mzapp` 多个退房入口已统一只走这一类事件 |
| `CLEANING_COMPLETED` | 清洁完成 | inbox + queue + push | cleaning task 参与人 + 默认 manager | 是，若传 `actorUserId` | 默认规则 |
| `INSPECTION_COMPLETED` | 检查完成 | inbox + queue + push | inspection task 参与人 + 默认 manager | 是，若传 `actorUserId` | 默认规则 |
| `KEY_PHOTO_UPLOADED` | 上传钥匙照片 | inbox + queue + push | cleaning task 参与人 + 默认 manager | 是，若传 `actorUserId` | 默认规则 |
| `ISSUE_REPORTED` | 问题上报 | inbox + queue + push | 默认 manager；部分调用点显式指定 `admin + offline_manager + customer_service` | 是，若传 `actorUserId` | 当前属于刻意保留的显式例外 |
| `WORK_TASK_UPDATED` | 真实 work task 更新 | inbox + queue + push | 默认无接收人，必须显式传 `recipientUserIds` | 是，若传 `actorUserId` | 当前不再给 reminder / SLA 复用 |
| `DAY_END_HANDOVER_REMINDER` | 日终交接提醒 job | inbox + queue + push | 显式 `recipientUserIds`，发给待提交用户 | 否，job 不传 actor | 带稳定 `eventId` |
| `DAY_END_HANDOVER_MANAGER_REMINDER` | 日终交接 manager 提醒 job | inbox + queue + push | 显式 `recipientUserIds`，发给默认 manager | 否，job 不传 actor | 按未提交用户逐条生成提醒，带稳定 `eventId` |
| `KEY_UPLOAD_REMINDER` | 钥匙上传提醒 job | inbox + queue + push | 显式 `recipientUserIds`，分别发 cleaner 或 manager | 否，job 不传 actor | cleaner / manager 各自独立 `eventId` |
| `KEY_UPLOAD_SLA_REMINDER` | 钥匙上传 SLA 提醒 | inbox + queue + push，且保留 `mzapp_alerts` | 显式 `recipientUserIds`，发给对应 cleaner | 否，job 不传 actor | alert 是辅助视图，不是发送源 |
| `KEY_UPLOAD_SLA_ESCALATION` | 钥匙上传 SLA 升级 | inbox + queue + push，且保留 `mzapp_alerts` | 显式 `recipientUserIds`，逐个发给默认 manager | 否，job 不传 actor | 每个 manager + cleaner 组合一个稳定 `eventId` |

补充说明：

- 默认 manager 集合当前为：`admin + offline_manager + customer_service`
- `WORK_TASK_UPDATED` 现在是“必须显式给 recipients”的事件类型，默认不会自动扩散
- 所有 job 类 reminder / SLA 事件当前都不传 `actorUserId`，因此不会发生 actor 排除

### 4.4 当前事件-角色矩阵

标记规则：

- `直接发送`：该事件默认就包含该角色集合
- `条件发送`：只有在任务参与、显式 recipients、例外覆盖等条件下才会收到
- `不发送`：当前代码看不到该角色进入 recipients

| 事件类型 | admin | offline_manager | customer_service | cleaner | cleaning_inspector | finance_staff | Finance_stuff_assistant | inventory_manager | maintenance_staff |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ORDER_UPDATED` | 直接发送 | 直接发送 | 直接发送 | 条件发送 | 条件发送 | 不发送 | 不发送 | 不发送 | 不发送 |
| `CLEANING_TASK_UPDATED` | 直接发送 | 直接发送 | 直接发送 | 条件发送 | 条件发送 | 不发送 | 不发送 | 不发送 | 不发送 |
| `CLEANING_COMPLETED` | 直接发送 | 直接发送 | 直接发送 | 条件发送 | 条件发送 | 不发送 | 不发送 | 不发送 | 不发送 |
| `INSPECTION_COMPLETED` | 直接发送 | 直接发送 | 直接发送 | 不发送 | 条件发送 | 不发送 | 不发送 | 不发送 | 不发送 |
| `KEY_PHOTO_UPLOADED` | 直接发送 | 直接发送 | 直接发送 | 条件发送 | 条件发送 | 不发送 | 不发送 | 不发送 | 不发送 |
| `ISSUE_REPORTED` | 直接发送 | 直接发送 | 直接发送 | 不发送 | 不发送 | 不发送 | 不发送 | 不发送 | 不发送 |
| `WORK_TASK_UPDATED` | 条件发送 | 条件发送 | 条件发送 | 条件发送 | 条件发送 | 条件发送 | 条件发送 | 条件发送 | 条件发送 |
| `DAY_END_HANDOVER_REMINDER` | 不发送 | 不发送 | 不发送 | 条件发送 | 条件发送 | 不发送 | 不发送 | 不发送 | 不发送 |
| `DAY_END_HANDOVER_MANAGER_REMINDER` | 直接发送 | 直接发送 | 直接发送 | 不发送 | 不发送 | 不发送 | 不发送 | 不发送 | 不发送 |
| `KEY_UPLOAD_REMINDER` | 条件发送 | 条件发送 | 条件发送 | 条件发送 | 不发送 | 不发送 | 不发送 | 不发送 | 不发送 |
| `KEY_UPLOAD_SLA_REMINDER` | 不发送 | 不发送 | 不发送 | 条件发送 | 不发送 | 不发送 | 不发送 | 不发送 | 不发送 |
| `KEY_UPLOAD_SLA_ESCALATION` | 直接发送 | 直接发送 | 直接发送 | 不发送 | 不发送 | 不发送 | 不发送 | 不发送 | 不发送 |

说明：

- `customer_service` 当前属于默认 manager，所以在所有“默认 manager 事件”里都是 `直接发送`
- `finance_staff`、`Finance_stuff_assistant`、`inventory_manager`、`maintenance_staff` 当前在这批通知事件里没有默认进入 recipient 规则
- `WORK_TASK_UPDATED` 被标成全列 `条件发送`，是因为它完全依赖显式 `recipientUserIds`，并不自带默认角色扩散

## 5. 状态对照表

| 主题 | 修复前 | 当前实现 |
| --- | --- | --- |
| 业务发送入口 | `emitNotificationEvent` 与 `notifyExpoUsers` 混用 | 业务层统一只走 `emitNotificationEvent` |
| push 产生方式 | 业务侧可直接 push | 仅 worker 从 queue 派生 push |
| inbox 一致性 | 存在 `push only` 事件 | push 必须先有 inbox / queue |
| manager 默认集合 | 调用点不一致 | 默认统一为 `admin + offline_manager + customer_service` |
| `customer_service` 身份 | 部分路径手工补收件 | 当前属于默认 manager 集合 |
| reminder 事件类型 | 复用普通 task update 语义 | 使用独立 reminder / SLA 事件类型 |
| reminder 幂等 | 缺少稳定去重键 | 已显式传稳定 `eventId` |
| recipient 为空 | 容易静默丢通知 | 返回 `NO_RECIPIENTS` 并打结构化日志 |
| `mzapp_alerts` | 兼具提醒视图与部分发送职责 | 只保留为辅助提醒视图 |

## 6. 当前静态校验结果

本轮修复完成后，已做过静态与编译校验。

### 6.1 `notifyExpoUsers` 调用清理结果

扫描目标：

- 禁止业务模块直接调用 `notifyExpoUsers`
- 禁止业务模块 import / require `notifyExpoUsers`

当前代码状态：

- `notifyExpoUsers` 只保留在底层实现模块中定义
- 只有 `notificationQueueWorker` 会实际调用它
- 业务模块中已不存在直接 import / require / 调用

### 6.2 编译校验结果

已完成 `backend` 编译校验，当前改动可通过 TypeScript 构建。

## 7. 后续维护约束

后续如果新增通知事件，应继续遵循以下约束：

1. 业务代码不得直接调用 `notifyExpoUsers(...)`
2. reminder / SLA / 定时任务类通知应优先新增精确事件类型，不要复用 `WORK_TASK_UPDATED`
3. 需要幂等的提醒必须显式传 `eventId`
4. 默认 manager 事件应依赖 `listManagerUserIds()` 当前默认集合
5. 只有业务上明确需要更窄或更特殊收件范围时，才显式传 `recipientUserIds`
6. `mzapp_alerts` 不能替代 inbox

## 8. 结论

本轮修复后，通知系统已经从“历史双轨、语义混用、部分 push-only”的状态，收敛为：

- 单一业务发送源
- 单一默认 manager 规则
- 可去重的 reminder / SLA 事件模型
- 有失败保护的 recipient 解析流程
- inbox 为主、push 为派生、alert 为辅助的统一结构

后续如果继续扩展规则，建议优先在 `emitNotificationEvent(...)` 这一层统一建模，不再回到业务侧手工推送。
