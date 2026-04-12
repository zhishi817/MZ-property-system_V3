# 实时任务流 v2：SSE 协议文档

## 1. Endpoint

- `GET /mzapp/work-task-events/stream`

请求头：

- `Authorization: Bearer <token>`
- `Last-Event-ID: <event_id>` 可选

说明：

- `view=mine / view=all` 不作为 SSE 连接参数
- 连接只表达当前登录用户身份

## 2. 连接建立

服务端行为：

- 校验登录态
- 建立 SSE 长连接
- 先发送一次 `connected`
- 读取 `Last-Event-ID`
- 尝试做历史补偿
- 补偿结束后进入实时推送

## 3. 心跳

服务端当前每 `25s` 推送一次：

```text
event: ping
data: {"t":1775874030000}
```

前端规则：

- 若 `45s` 内未收到任何 `ping` 或业务事件，则认为连接失活并重连

## 4. 业务事件

格式：

```text
id: 2c0f5d5e-...
event: work_task_event
data: {"event_id":"2c0f5d5e-...","sequence_no":10923,"task_id":"cleaning_task:...","task_version":14,"event_type":"TASK_UPDATED","change_scope":"detail","changed_fields":["old_code","new_code"],"payload":{"patch":{"old_code":"1234","new_code":"5678"}},"occurred_at":"2026-04-11T10:20:30.000Z"}
```

要求：

- `id` 必须稳定可重放
- `data.event_id` 与 SSE `id` 一致

## 5. Last-Event-ID 补偿

重连流程：

1. 前端带 `Last-Event-ID`
2. 后端从 `work_task_events` 找该事件
3. 若找到，则按其 `sequence_no` 返回后续事件
4. 若缺口过大，例如 `> 100` 条，返回 `resync_required`
5. 若该 ID 不存在，也返回 `resync_required`

## 6. `resync_required`

格式：

```text
event: resync_required
data: {"reason":"gap_too_large","last_event_id":"...","gap":135,"threshold":100}
```

触发条件：

- 缺口过大
- `Last-Event-ID` 找不到
- 事件裁剪导致无法补齐
- 服务端检测到补偿不安全

前端收到后：

- 不再尝试单靠增量追赶
- 立即执行 `/mzapp/work-tasks` 全量拉取
- 成功后更新 `lastFullSyncTimestamp`

## 7. 错误处理

### 401 / 403

- 停止重连
- 进入未登录/无权限状态

### 5xx

- 指数退避重连

### 网络断开

- 自动重连
- 重连必须带 `Last-Event-ID`

### 连接成功帧

当前实现会先发：

```text
event: connected
data: {"ok":true,"t":1775874030000}
```

流初始化失败时当前直接返回 HTTP 错误，不额外发送 `stream_error` 业务帧。

## 8. 重连策略

建议节奏：

- 第 1 次失败：1 秒
- 第 2 次失败：2 秒
- 第 3 次失败：5 秒
- 第 4 次及以后：10-15 秒

约束：

- app 全局只维护一条 SSE 连接
- 页面切换不重建连接
- app 回前台时优先检查并恢复连接
