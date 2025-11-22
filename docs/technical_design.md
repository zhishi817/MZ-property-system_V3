# MZ 短租房源后台系统 — 技术设计文档

## 架构总览
- 前端 Web：React/Next.js（服务端渲染与权限控制，后台工作台）。
- 移动 App：React Native（清洁/维护/仓库执行端，离线与拍照上传）。
- 后端 API：Node.js + Express + TypeScript（REST/JSON，OpenAPI 规范）。
- 数据库：PostgreSQL（主从与只读副本），Redis（缓存/会话/任务队列）。
- 对象存储：S3（照片、附件、发票留存），CDN 分发。
- 监控与日志：OpenTelemetry + Loki/ELK，Prometheus + Grafana 看板。
- 身份认证：JWT（服务端会话）+ OAuth2（外部系统接入），RBAC 授权。
- 部署：Docker + K8s（EKS），CI/CD（GitHub Actions），分环境（dev/staging/prod）。

## 后端分层与模块
- 接入层（API 路由）：`/landlords`、`/properties`、`/keys`、`/orders`、`/inventory`、`/finance`。
- 领域层（Service）：业务规则、流程编排、幂等与一致性策略。
- 资源层（Repository）：PostgreSQL/Redis/S3 读写，事务边界与锁策略。
- 基础设施层：配置、日志、审计、权限、任务队列、事件总线。
 - 调度层（Scheduling）：清洁任务生成、人员分配、冲突检测与路线优化。

## 数据模型（摘要）
- Landlord(id, name, contact, share_ratio, payout_account, tax_no, status)
- Property(id, landlord_id, address, type, capacity, rules, devices, channel_cfg, status, area_sqm, region, guide_link, garage_link)
- KeySet(id, property_id, set_type, status, created_at, updated_at)
- KeyItem(id, key_set_id, item_type, code, photo_url, status)
- KeyFlow(id, key_set_id, action, handler_id, timestamp, note, old_code, new_code)
- Order(id, source, external_id, property_id, guest_name, checkin, checkout, price, currency, status, idempotency_key)
- WorkOrder(id, type, property_id, assignee_id, earliest_start, latest_finish, scheduled_at, started_at, finished_at, photos[], result, status)
- InventoryItem(id, name, sku, unit, threshold, bin_location, quantity)
- StockMovement(id, item_id, type, quantity, ref_type, ref_id, handler_id, timestamp)
- FinanceTransaction(id, kind, amount, currency, ref_type, ref_id, occurred_at)
- Payout(id, landlord_id, period_from, period_to, amount, invoice_no, status)
- User(id, name, role_id, phone, email, status)
- Role(id, name)
- Permission(id, code)
- RolePermission(role_id, permission_id)
- AuditLog(id, actor_id, action, entity, entity_id, before, after, ip, ua, created_at)

## API 设计（示例）
- Landlords
  - GET `/landlords` 列表，POST `/landlords` 创建，GET `/landlords/:id` 详情，PATCH `/landlords/:id` 更新。
- Properties
  - GET `/properties`，POST 创建，PATCH 更新，GET 详情，GET `/:id/keys` 钥匙列表。
- Keys
  - GET `/keys/sets` 列表，POST `/keys/sets` 创建套件（`set_type`: `guest`|`spare_1`|`spare_2`|`other`）。
  - GET `/keys/sets/:id` 套件详情，PATCH 更新状态与备注。
  - POST `/keys/sets/:id/items` 新增钥匙或 Fob（含 `code` 与 `photo_url`）。
  - POST `/keys/sets/:id/flows` 流转记录（`borrow`|`return`|`lost`|`replace`）。
  - GET `/keys/sets/:id/history` 生命周期追踪。
- Orders
  - GET `/orders` 列表与过滤，POST 创建（手动录入），PATCH 更新状态。
  - POST `/orders/sync` 平台刷新同步（使用 `external_id` + `idempotency_key` 去重）。
  - POST `/orders/:id/generate-cleaning` 根据订单生成清洁工单。
- Inventory
  - GET `/inventory/items`，POST 创建；POST `/inventory/movements` 出入库记录；GET 低库存预警。
- Finance
  - GET `/finance/transactions` 收支流水；POST 记账；GET `/finance/payouts` 房东结算；POST 生成结算。
 - Cleaning
  - GET `/cleaning/tasks` 清洁任务列表（日/周视图通过 `view` 与 `date` 参数）。
  - POST `/cleaning/tasks` 手动创建任务，PATCH `/cleaning/tasks/:id` 更新。
  - POST `/cleaning/tasks/:id/assign` 分配/调整负责人与时段。
  - POST `/cleaning/schedule/rebalance` 基于容量与冲突自动重排。

## 权限模型（RBAC）
- 角色：`admin`、`ops`、`support`、`finance`、`warehouse`、`field`、`landlord`。
- 权限编码（示例）：`property.read`、`property.write`、`order.manage`、`order.sync`、`keyset.manage`、`key.flow`、`cleaning.schedule.manage`、`cleaning.task.assign`、`inventory.move`、`finance.payout`。
- 校验：路由中间件校验 JWT → 解析角色 → 权限表匹配 → 拒绝或放行。

## 审计与合规
- 审计范围：创建/更新/删除、结算生成、出入库、权限与配置变更。
- 留存策略：关键实体变更前后快照，保存至审计表与对象存储。
- 合规：隐私数据最小化、脱敏与访问控制，备份与灾备演练。
 - 媒体留存：钥匙与清洁现场照片保存在 S3，命名包含实体与时间戳，引用 `photo_url`。

## 幂等与一致性
- 幂等键：对订单状态变更、结算生成、出入库操作定义请求幂等键。
- 订单同步：`idempotency_key = hash(external_id + checkout)`，避免重复订单；清洁工单生成使用 `order_id` 作为幂等键。
- 事务边界：PostgreSQL 事务 + 行级锁；跨资源用消息队列保证最终一致性。
- 重试与去重：失败重试策略与重复消息过滤。

## 调度与执行
- 清洁排班：根据订单退房生成工单，结合人员日程与地理位置优化。
- 人员容量：为清洁人员配置每日最大任务/时长与技能标签，调度时校验。
- 时间窗口：每个任务包含 `earliest_start`/`latest_finish`，支持拖拽调整。
- 路线与时长：估算路程与任务耗时，提供路线建议与缓冲时间。
- 冲突检测：识别人员超载、任务重叠、钥匙不可用等，给出自动重排建议。
- 移动端：签到（地理围栏）/拍照上传/提交结果；离线队列自动回传。

## 编码规范与基础库
- TypeScript 严格模式，单元测试（Jest），接口校验（Zod）。
- 错误处理：统一错误码与错误中间件，日志打点与追踪 ID。
- 配置管理：`.env` 注入，分环境配置，敏感信息使用密钥管理服务。
 - 校验字典：房型、区域、设施、床型枚举在配置表维护，Zod 校验引用枚举。

## 部署与运维
- 环境：`dev`、`staging`、`prod`；蓝绿部署或滚动更新。
- 监控：请求延迟、错误率、库存阈值触发数、工单 SLA、结算任务成功率。
- 备份：数据库每日快照，对象存储版本化，审计日志长期留存。
 - 运行指标：清洁任务及时率、钥匙遗失/更换次数、订单同步成功率、幂等冲突比率。

## 测试策略
- 单元测试：Service 与 Repository 层。
- 集成测试：主要业务流程与幂等场景。
- 端到端测试：关键页面与移动端执行流程。
 - 调度仿真测试：生成多订单场景，验证容量约束与冲突重排正确性。

## 风险与待决事项
- OTA 深度对接的复杂度与平台政策变化。
- 价格与日历的动态策略算法与数据质量。
- 财务合规（GST、发票）与第三方服务费用控制。
- 移动端离线与断点续传的稳定性。
 - 钥匙套件编号规范与现场执行一致性需要落地培训。

## 状态机定义（关键模块）
- 订单（Order）：`draft` → `confirmed` → `checked_in` → `in_house` → `checked_out` → `cleaned` → `sellable` → `cancelled`
- 清洁工单（WorkOrder[type=cleaning]）：`pending` → `scheduled` → `in_progress` → `done` → `verified` → `cancelled`
- 钥匙套件（KeySet）：`available` → `in_transit` → `lost` → `replaced` → `retired`

## 示例数据结构（简化）
- `POST /keys/sets`
  - `{ property_id, set_type, items: [{ item_type: "key", code, photo_url }, { item_type: "fob", code, photo_url }] }`
- `POST /orders/sync`
  - `{ external_id, source: "airbnb", property_id, guest_name, checkin, checkout, price, currency, idempotency_key }`
- `POST /orders/:id/generate-cleaning`
  - `{ earliest_start, latest_finish }`
- `POST /cleaning/tasks/:id/assign`
  - `{ assignee_id, scheduled_at }`