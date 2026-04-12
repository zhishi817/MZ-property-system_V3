# 实时任务流 v2：调试手册

## 1. 查“某次写入有没有发事件”

按顺序检查：

1. 看业务接口日志
   - 该写入是否成功提交
2. 查 `work_task_events`
   - 按 `task_id`
   - 或 `source_ref_ids`
   - 或写入时间窗口
3. 核对事件内容
   - `event_type`
   - `change_scope`
   - `changed_fields`
   - `sequence_no`
   - `task_version`

如果业务写成功但没有事件：

- 该写路径没有接 `emitWorkTaskEvent(...)`
- 或事务回滚导致事件一并没落库

## 2. 查“某个用户有没有收到”

看两层：

### 后端

- SSE broker 是否建立了该用户连接
- 推送该事件时，权限过滤是否命中
- 是否把该 `event_id` 写到该连接输出

建议日志：

- `sse.connect user_id=...`
- `sse.catchup.start last_event_id=...`
- `sse.push user_id=... event_id=...`
- `sse.resync_required user_id=... reason=...`

### 前端

- 当前 SSE 连接是否在线
- `lastReceivedEventId` 是否推进
- 当前 bucket 是否 dirty
- 当前 view 是 `mine` 还是 `all`

## 3. 查“前端为什么没更新”

固定按这条链查：

1. 事件有没有写进 `work_task_events`
2. SSE 有没有把该事件发到客户端
3. 客户端有没有收到并更新 `lastReceivedEventId`
4. `task_version` 是否比本地新
5. `changed_fields` 是否命中 safe patch 白名单
6. 如果没命中，bucket 是否被标记 dirty
7. dirty 后是否触发全量同步
8. 全量同步后 `/mzapp/work-tasks` 返回是否已经包含新结果

## 4. 推荐 SQL / 检查点

### 查最近事件

```sql
SELECT event_id, sequence_no, task_id, task_version, event_type, change_scope, changed_fields, occurred_at
FROM work_task_events
ORDER BY sequence_no DESC
LIMIT 50;
```

### 查某任务事件

```sql
SELECT event_id, sequence_no, task_id, task_version, event_type, change_scope, changed_fields, payload, occurred_at
FROM work_task_events
WHERE task_id = $1
ORDER BY sequence_no DESC;
```

### 查补偿起点

```sql
SELECT event_id, sequence_no
FROM work_task_events
WHERE event_id = $1
LIMIT 1;
```

## 5. 前端建议日志点

- `workTasksStore.sse.connected`
- `workTasksStore.sse.disconnected`
- `workTasksStore.sse.event_received`
- `workTasksStore.sse.resync_required`
- `workTasksStore.patch_applied`
- `workTasksStore.bucket_dirty`
- `workTasksStore.full_sync.start`
- `workTasksStore.full_sync.done`

## 6. 常见问题定位

### 问题 1：业务改了，事件没发

优先怀疑：

- 写路径漏接 `emitWorkTaskEvent(...)`
- 写路径在事务外发事件，结果业务失败
- 写路径在事务里但事件写入异常被吞掉

### 问题 2：事件发了，但用户没收到

优先怀疑：

- SSE 连接断了
- 权限过滤把用户排掉了
- 重连时 `Last-Event-ID` 找不到
- 被判定成 `resync_required` 但前端没做全量同步

### 问题 3：用户收到了，但 UI 没变

优先怀疑：

- `task_version` 旧于本地版本
- 不在 safe patch 白名单
- manager 聚合 bucket 无法局部 patch
- bucket 被标 dirty 但未触发 full sync

## 7. 最小排查闭环

当用户反馈“任务没实时更新”，按这条顺序：

1. 找这次写入的接口日志
2. 查对应 `work_task_events`
3. 查该用户 SSE 推送日志
4. 查客户端 `lastReceivedEventId`
5. 查该事件是否被 patch 或标 dirty
6. 查是否执行 full sync
7. 查全量 `/mzapp/work-tasks` 结果是否正确

