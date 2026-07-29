# 第五阶段发布前检查

## 不变量

- 补品页面只入队；队列是唯一提交执行者。
- 草稿是上传进度和业务提交进度的唯一事实来源。
- 同一 `task_id` 只有一个稳定队列项、草稿 ID 和 `submit_id`，不会并发启动两个 worker。
- 已上传媒体不重复上传；业务提交重试不重新上传照片。
- 400/401/403/409 和本地文件丢失进入 blocked；网络、超时和 5xx 保留草稿并按退避重试。
- 后端补品记录、媒体、任务状态和幂等回执在一个事务内提交，事件、SSE 和通知只在提交成功后触发。

## 自动检查

```bash
npm run test:phase5-release-contract --prefix backend
```

该契约依赖根与移动端两个仓库，不能在根仓库的独立 `check:fast` 或 `check:full` 中运行。通过 GitHub Actions 的 `Cross-Repository Phase 5 Contract` 手动 workflow 提交 `root_ref` 和 `mobile_ref`（分支、tag 或 commit SHA）；workflow 会 checkout 两个指定 ref、执行上述命令，并上传实际解析后的两个 commit SHA 作为 artifact。发布组合必须记录这两个 resolved SHA，不能以浮动 `Dev` 名称代替。

`check:fast` 和 `check:full` 不执行数据库写入型 E2E。涉及真实数据库的验收脚本必须先确认目标是非生产数据库，并同时提供非生产标签和显式写入开关：

```bash
PHASE5_ALLOW_DB_WRITES=1 PHASE5_DATABASE_LABEL=staging-nonprod \
  npm run test:phase5-e2e --prefix backend
```

脚本会拒绝 `NODE_ENV=production`、`APP_ENV=production` 或包含 `prod` 的数据库标签；未设置显式开关时直接跳过。

## 需要记录的验收结果

- 首张照片成功、第二张失败：首张远端引用和本地清理已持久化，重试只处理第二张。
- 照片上传成功、业务提交超时：重试只调用业务提交。
- 连续点击提交：只有一个 active queue item 和一个 worker。
- App 重启：已上传照片不重复上传，待上传照片继续处理。
- 400/401/403：不无限重试，保留真实错误码和 blocked 状态。
- 5xx/网络超时：保留草稿并写入 `next_retry_at`。
- 本地文件丢失：不提交空 URL，指出具体照片 slot。
- 后台同步完成：页面和任务卡从队列/草稿状态刷新为已同步。

真机、EAS/TestFlight 和真实 R2 覆盖测试仍需单独执行；自动化通过不等于完成这些环境验证。
