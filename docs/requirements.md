# MZ Property System 需求文档

## 概述
- 目标：为短租/民宿物业提供一体化后台管理，包括房源、房东、订单、清洁、钥匙、财务、权限与审计。
- 使用者：
  - 管理员（admin）：全权限管理与配置
  - 运营（ops）：日常运营相关的增改（房源/订单/清洁/房东）
  - 外勤（field）：清洁任务分配与执行相关

## 系统架构
- 前端：Next.js App Router + React 18，UI 框架使用 Ant Design；全局主题通过 Client 侧 `ConfigProvider` 包装，避免 RSC 冲突。
- 后端：Node.js + Express，JWT 鉴权，Zod 校验，统一审计日志。
- 数据源策略：
  - 优先 Supabase REST（`SUPABASE_URL` + Key）
  - 次选 Postgres 直连（`DATABASE_URL`）
  - 都不可用则回退内存数据，保证功能可用

## 角色与权限（RBAC）
- 角色：`admin`、`ops`、`field`
- 权限码（部分）：
  - `property.write` 房源写操作
  - `order.manage` 订单管理
  - `order.sync` 订单同步
  - `keyset.manage`、`key.flow` 钥匙集合与流转
  - `cleaning.schedule.manage`、`cleaning.task.assign` 清洁排班与任务分配
  - `finance.payout` 财务结算
  - `inventory.move` 库存出入库
  - `landlord.manage` 房东管理
  - `rbac.manage` 角色权限维护
- 前端仅做 UI 级显示控制；后端中间件 `requirePerm` 做强校验（参考 `backend/src/auth.ts`）。

## 功能需求
### 登录与认证
- 用户使用用户名或邮箱 + 密码登录；后端优先从数据库 `users` 查找，回退静态用户。
- 成功登录返回 JWT 与角色；前端将 token/role 存储于 `localStorage/sessionStorage`。

### 房东管理
- 列表、搜索（按姓名/联系方式/邮箱）、详情弹窗、编辑、删除、创建。
- 字段集合：
  - 必填：`name`
  - 选填：`phone`、`email`、`management_fee_rate`（0–1，小数；前端显示/输入为百分比）、`payout_bsb`、`payout_account`、`property_ids`（房源 ID 数组）
- 删除：无需密码，二次确认；需 `landlord.manage` 权限。

### 房源管理
- 字段（示例，部分）：地址、类型、容量、区域、面积、楼栋信息、设施、门禁与停车等细项。
- CRUD，支持字典项（区域、类型等）供下拉选择。

### 订单管理
- 列表与创建，同步外部订单（`/orders/sync`）；生成清洁任务（按 `checkout`）。

### 清洁安排
- 任务列表（按日期筛选）、任务创建、分配人员（校验日容量）、补平衡、任务状态调整。
- 容量视图：按日期汇总每位清洁人员已分配/剩余容量。

### 钥匙管理
- 钥匙集合与物品上传图片、流转历史（借出/归还/遗失/替换）。

### 财务管理
- 交易与结算记录，必要权限方可操作。

### 权限管理（RBAC）
- 角色与权限码映射查看与维护；后端强制校验，前端按角色隐藏不允许操作。

### 审计日志
- 记录实体增删改与关键流转（含 actor、before/after、时间戳）。

## 接口规范（摘要）
- 认证
  - `POST /auth/login` 登录
  - `GET /auth/me` 当前用户信息
- 房东
  - `GET /landlords` 列表
  - `POST /landlords` 创建（需 `landlord.manage`）
  - `GET /landlords/:id` 详情
  - `PATCH /landlords/:id` 编辑（需 `landlord.manage`）
  - `DELETE /landlords/:id` 删除（需 `landlord.manage`，无密码，二次确认由前端实现）
- 房源：`/properties`（列表、创建、详情、编辑）
- 订单：`/orders`（列表）、`/orders/sync`（同步并生成清洁）
- 清洁：`/cleaning/tasks`（列表/创建/编辑）、`/cleaning/tasks/:id/assign`（分配）、`/cleaning/capacity`（容量）
- 钥匙：`/keys`（列表）、`/keys/sets`（创建集合）、`/keys/sets/:id/flows`（流转）、`/keys/sets/:id/items`（物品上传）
- 财务：`/finance`（交易与结算相关）
- 配置/字典：`/config/dictionaries`
- 审计：`/audits`
- RBAC：`/rbac/*`

## 数据库设计（摘要）
- `users`
  - `id text PK`、`username text UNIQUE`、`email text UNIQUE`、`password_hash text NOT NULL`、`role text NOT NULL`、`delete_password_hash text NULL`、`created_at timestamptz`
- `landlords`
  - `id text PK`、`name text`、`phone text`、`email text`、`management_fee_rate numeric`、`payout_bsb text`、`payout_account text`、`property_ids text[]`、`created_at timestamptz`
- `properties`
  - 详见 `backend/scripts/schema.sql`，包含地址/类型/容量/设施/门禁等
- `orders`
  - `id text PK`、`property_id text FK`、`guest_name`、`checkin/checkout`、`price/currency/status`、`idempotency_key UNIQUE`、`created_at`
- `cleaning_tasks`
  - `id text PK`、`property_id text`、`date`、`status`、`assignee_id`、`scheduled_at`、`created_at`

## 环境与配置
- 后端 `.env` 关键变量：
  - `JWT_SECRET`
  - `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` 或 `SUPABASE_ANON_KEY`
  - `DATABASE_URL`
- 文件上传目录：`/uploads`（本地磁盘）；可选迁移至 Supabase Storage。

## 安全与合规
- 不在前端暴露后端密钥；JWT 私钥妥善管理。
- 所有写操作后端做权限校验；前端仅用于隐藏不可用操作。

## 前端界面与交互
- 登录页：品牌 Logo、禁用必填星标、响应式装饰背景；`/login` 与后台布局分离。
- 房东管理：
  - 顶部操作：新增房东、搜索框
  - 列表：响应式列与横向滚动，自适应显示
  - 弹窗：新增/编辑/详情
  - 删除：二次确认，无需密码
- 其他页面：房源、订单、清洁安排、钥匙、财务、RBAC、审计均已联通对应接口。

## 非功能性需求
- 可用性：数据源优先 REST → 直连 → 内存，保证网络受限时仍可用。
- 性能：列表分页、选择性字段渲染；图片走静态资源或未来接入对象存储。
- 可维护性：统一校验与审计；模块化路由与服务函数。

## 部署与运行（开发）
- 后端：`npm run dev`（`backend` 目录），健康检查 `GET /health`
- 前端：`npm run dev`（`frontend` 目录），访问 `http://localhost:3000`

## 迭代计划与开放事项
- 将库存与财务模块完全切换为 Supabase/PG 数据源（当前部分为内存）。
- 房源与房东的关联扩展（可新增 `properties.landlord_id` 外键）；在房源页面提供房东选择。
- 图片上传迁移至 Supabase Storage（含权限策略与清理策略）。
- 报表与导出：财务结算报表、订单汇总、清洁任务统计。
- 更细化权限：为删除、编辑等动作引入更细的权限码分割。