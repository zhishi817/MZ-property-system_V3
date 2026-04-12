# 实时任务流 v2：验收 Checklist

- [x] `work_task_events` 表已创建，包含 `sequence_no` 与 `task_version`
- [x] `sequence_no` 全局单调递增
- [x] `task_version` 对同一任务单调递增
- [x] `emitWorkTaskEvent(...)` 只写规范化事件，不做连接过滤
- [ ] 所有影响 `/mzapp/work-tasks` 的写路径都有事件策略
- [x] 非 `cleaning_tasks` 主表变化也会写事件
- [x] SSE endpoint 已提供：`GET /mzapp/work-task-events/stream`
- [x] SSE 需要鉴权
- [x] SSE 支持 `Last-Event-ID`
- [x] SSE 支持历史补偿
- [x] 缺口过大时会返回 `resync_required`
- [x] 心跳包每 20-30 秒发送一次
- [ ] 前端维护 `lastReceivedEventId`
- [ ] 前端维护 `lastFullSyncTimestamp`
- [ ] 前端只保留一条全局 SSE 连接
- [ ] 页面切换不会重建 SSE 连接
- [ ] app 回前台时会校验连接并必要时重连
- [ ] 后台改任务时间后，在线前端列表自动更新
- [ ] 后台改密码/客需后，前端详情自动更新
- [ ] 转派后，原清洁员 `mine` 视图移除任务
- [ ] 转派后，新清洁员 `mine` 视图出现任务
- [ ] 管理者 `all` 视图正确反映转派结果
- [ ] 钥匙照片上传后，任务详情自动更新
- [ ] 钥匙照片删除后，任务详情自动更新
- [ ] 补品更新后，任务详情自动更新
- [ ] completion/inspection 媒体更新后，任务详情自动更新
- [ ] `orders.checkin/checkout/nights/status/keys_required` 变化能反映到任务展示
- [ ] `properties.code/type/region/address/access_guide_link/wifi/router` 变化能反映到任务展示
- [ ] `cleaner_name / inspector_name` 变化能反映到任务展示
- [ ] `membership` 类事件无法安全 patch 时会标记 dirty
- [ ] dirty bucket 会在规则触发时执行全量同步
- [ ] 超过全量同步阈值会执行兜底同步
- [ ] 手动下拉刷新仍然可用
- [ ] 不再依赖 20 秒轮询 `/mzapp/work-tasks`

## 当前实现范围

- [x] 已接入 `backend/src/modules/work_tasks.ts`
- [x] 已接入 `backend/src/modules/cleaning.ts` 的创建 / 取消 / 批量编辑主链路
- [x] 已接入 `backend/src/modules/cleaning_app.ts` 的开始、钥匙删除、问题上报、补品、补货、检查完成
- [x] 已接入 `backend/src/modules/mzapp.ts` 的 manager fields / order keys required
- [ ] 其余影响 `/mzapp/work-tasks` 的边缘写路径仍需继续补齐
