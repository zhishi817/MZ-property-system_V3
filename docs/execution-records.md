# Execution Records

## 清洁开始超时扫描默认关闭

- Date: 2026-10-04
- Task: 停止无业务作用的 15 分钟清洁开始超时诊断扫描持续唤醒生产数据库
- Status: implemented and locally verified in isolated Root worktree and fixed Preview; not released

### Confirmed Plan

- 只处理已核实的 `cleaning_tasks` 超时日志扫描，不改 Mobile SSE、通知 worker、清洁同步、重试、backfill 或其他生产任务。
- 把扫描改为独立开关控制且默认关闭；关闭时不得注册 cron、启动任务或查询数据库。
- 保留显式重新启用能力和原有 cron/阈值语义，不修改生产环境变量、数据库、服务或部署。

### Implementation Result

- 新增独立调度模块和 `CLEANING_START_TIMEOUT_ENABLED`，只有该值、`FEATURE_CLEANING_APP` 与 PostgreSQL 可用性门禁同时通过才注册扫描。
- 启动入口移除原先随清洁功能自动注册的内联任务；默认路径在调度注册前返回，因此不会发出原有当日清洁任务 SQL。
- 新增契约测试并接入 Root `check:backend` 与 `check:fast`，同时静态保护其他后台调度入口仍存在。

### Validation

- 新调度契约、清洁规则、清洁同步 v2 测试均通过。
- 后端 TypeScript no-emit 与输出到 `/tmp` 的隔离构建通过；未在候选工作树保留依赖链接或生成物。
- 固定 Preview 已先备份目标文件再合入窄范围源码/测试/治理记录；目标测试、TypeScript no-emit 与 Feature Registry 审计通过。
- 未连接生产数据库、未触发真实 cron、未改生产配置、未部署。

### Files / Areas

- `backend/src/services/cleaningStartTimeoutSchedule.ts`
- `backend/src/index.ts`
- `backend/scripts/tests/test_cleaning_start_timeout_schedule.ts`
- `backend/package.json`
- `package.json`
- `docs/feature-regression-registry.md`

### Open Issues / Follow-ups

- 代码只有在后端发布后才会改变生产行为；发布后需只读确认该 15 分钟 SQL/唤醒消失，同时避免把其他来源误判为本任务。
- 未 commit、push、PR、merge、deploy，也未修改 Render/Neon 或 Mobile。

## 合作方先提交、财务后核对的周结算闭环

- Date: 2026-09-22
- Task: 纠正周结算业务顺序，并联动 Root 网页、后端和移动端
- Status: implemented and locally verified in fixed Preview; not released

### Confirmed Plan

- 合作方先在移动端核实上一完整周工作量并提交，系统在提交时自动计算；财务不得先生成。
- 财务发现问题时填写原因并退回，系统按最新规则重算，合作方再次确认后重新交给财务。
- 无问题时财务先完成银行转账，再点击“确认已付款”，直接生成已付款清洁支出，不保留中间待付款步骤。
- 缺费用规则不阻止本人提交，但必须阻止付款；初次提交不发本人确认通知，退回再次确认只通知结算本人。

### Implementation Result

- 新增本人周预览和幂等提交 API，初次提交直接进入网页“待财务核对”。
- 网页移除生成、批量运行和发起确认，新增“退回再次确认”；付款前补齐待处理、未计入和计算阻断检查。
- 周任务停止自动生成/通知，旧财务先生成端点返回 410；历史状态与文件继续只读兼容。
- 配套移动端增加上一完整周预览、预计金额和“提交本周工作量”，并显示退回原因与“确认并重新提交”。

### Validation

- Root backend TypeScript、Phase 3/5 聚焦合同测试通过。
- Root frontend TypeScript 与 2 个聚焦 Vitest 文件共 8 tests 通过。
- Mobile TypeScript 与费用结算专项 Jest 1 suite / 13 tests 通过。
- 未执行数据库写入集成、真实通知、浏览器/模拟器、银行转账、生产或真机验证。

### Files / Areas

- `backend/src/lib/personnelSettlementWorkflow.ts`
- `backend/src/lib/personnelWorkloadClaims.ts`
- `backend/src/lib/personnelSettlementWeeklyJob.ts`
- `backend/src/modules/personnel_settlements.ts`
- `frontend/src/app/finance/settlements/`
- `docs/notification-registry.yaml`
- `docs/feature-regression-registry.md`
- paired mobile `src/lib/api.ts` and `src/screens/me/PersonnelSettlementScreen.tsx`

### Open Issues / Follow-ups

- 在明确可写的 Preview 数据库和隔离账号上补做一次“本人提交 → 财务退回 → 本人再次确认 → 财务确认已付款”的完整业务回归。
- 当前 fixed Preview 是混合开发工作区；未 commit、push、PR、merge、deploy、OTA 或真机验证。

## 周结算统一核对入口与合作式文案

- Date: 2026-09-13
- Task: 合并移动端文字问题与补充费用流程，同步根治后端半成功风险并优化网页文案
- Status: implemented and locally verified in fixed Preview; not released

### Confirmed Plan

- 周结算只保留一个“工作内容或金额有疑问”入口，分为有结构的“补充工作或费用”和纯文字“现有结算需要核对”。
- 有结构的补充内容必须先包含日期、金额、说明和照片/截图，再与结算重新核对一次性提交。
- 将系统中面向合作方的“申报/审核/批准/处理异议”优化为“反馈/核对/确认计入/重新核对”，保留内部技术状态兼容。

### Implementation Result

- 后端新增结算内 claim 原子提交端点，事务锁同时保护 claim 和本人周结算状态。
- 网页已统一人员反馈、核对动作、状态和通知文案；不改计算、权限、GST、PDF 或付款语义。
- 配套移动端已使用新端点，只在最终业务操作成功后清理本地草稿和证明文件。

### Validation

- Backend Phase 3 test and build passed。
- Frontend focused Vitest、lint and TypeScript no-emit passed；固定 Preview web 文案已热更新并只读检查。
- Feature Registry and `git diff --check` passed；Root ledger audit 仅被三个既有且与本轮无关的 `backend/dist/modules/*.js` 构建文件阻塞。
- 未执行新 API 的真实数据写入或数据库集成测试。

### Files / Areas

- `backend/src/lib/personnelWorkloadClaims.ts`
- `backend/src/lib/personnelSettlementWorkflow.ts`
- `backend/src/modules/personnel_settlements.ts`
- `frontend/src/app/finance/settlements/`
- `docs/feature-regression-registry.md`

### Open Issues / Follow-ups

- 发布前应在可清理的 Preview 数据上验证一次“上传证明 → 原子提交 → 财务核对 → 重新生成结算”。
- 未 commit、push、PR、merge、deploy、OTA、production 或真机验证。

## 周结算只显示当前最新版文件

- Date: 2026-09-12
- Task: 修复移动端同一周结算同时显示多个 PDF 版本
- Status: implemented in fixed Preview; not released

### Confirmed Plan

- 本人详情只展示与当前结算状态一致的最新一份 PDF；当前状态没有文件时不回退旧状态。
- 保留数据库不可变文件历史和财务管理端历史核对，不删除旧 PDF。
- 移动端再做同样的防御筛选，避免旧后端或缓存响应重新显示多个版本。

### Implementation Result

- 后端本人周详情响应从完整文件历史收窄为 0 或 1 个当前状态最新文件。
- 财务/管理接口、文件生成、下载鉴权和历史记录没有改变。
- 配套移动端已增加相同筛选和 UI 回归；同状态 v3/v2 只显示 v3，旧状态不会补位。

### Validation

- Backend Phase 5 focused test、TypeScript no-emit、隔离 production build和 Feature Registry 均通过。
- 配套 Mobile focused Jest、typecheck、lint和完整 `check:ci` 通过；完整 Jest 为 62 suites / 356 tests，lint 为 0 errors / 556 existing warnings。
- 固定 Preview 三端已重新启动，模拟器可连接本地 API；当前登录账号没有周结算单，因此未取得含 v3/v2 的账号级视觉证据。

### Files / Areas

- `backend/src/lib/personnelSettlementDocuments.ts`
- `backend/src/modules/personnel_settlements.ts`
- `backend/scripts/tests/test_personnel_settlement_phase5.ts`
- `docs/feature-regression-registry.md`
- paired mobile `src/screens/me/PersonnelSettlementScreen.tsx`
- paired mobile `src/screens/me/PersonnelSettlementScreen.test.tsx`

### Open Issues / Follow-ups

- 历史文件仍可供财务审计；本次没有删除数据库行或对象文件。
- 未 commit、push、PR、merge、deploy、OTA、production 或真机验证。

## ABN 取消数学校验和

- Date: 2026-09-11
- Task: ABN 取消数学校验和
- Status: implemented

### Confirmed Plan

- 网页、后端和移动端统一取消 ABN 数学校验和，只保留归一化后的 11 位数字检查。
- 保留 GST 三态与 ABN 必填关系；明确格式通过不代表 ABR、归属或 GST 官方验证。
- 不改 schema，不执行数据库写入，不扩大到费用规则、银行权限或结算状态机。

### Implementation Result

- 后端共享人员资料保存只拒绝非 11 位 ABN；校验和不通过但长度正确的号码可以保存。
- 网页提示改为只检查 11 位数字并明确不做数学或 ABR 验证；技术错误继续映射为中文。
- 配套移动端本人资料校验与中英文错误文案同步改为 11 位格式检查。

### Validation

- Backend Phase 1 focused contract passed；Frontend focused Vitest 1 file / 3 tests passed；Mobile focused Jest 2 suites / 5 tests and typecheck passed。
- Root backend/frontend no-emit TypeScript passed；frontend lint passed with unrelated existing warnings。首次普通 TypeScript/lint 仅因 sandbox 无权写本地构建缓存失败，改用不写 incremental/ESLint cache 的等价检查后通过。
- Mobile `npm run check:ci` passed: TypeScript、lint 0 errors / 110 existing warnings、strict button audit、62 suites / 352 tests and ledger audit。
- Root Feature Registry passed: 25 FRs / 195 mappings；获取最新 `origin/Dev` 后 Root ledger audit 57/57、Mobile ledger audit 23/23 均通过；两个仓库 `git diff --check` 均通过。

### Files / Areas

- `backend/src/lib/personnelSettlementProfiles.ts`
- `backend/scripts/tests/test_personnel_settlement_phase1.ts`
- `frontend/src/app/finance/settlements/page.tsx`
- `frontend/src/app/finance/settlements/personnelProfileUi.ts`
- `frontend/src/app/finance/settlements/personnelProfileUi.test.ts`
- paired mobile `src/lib/personnelSettlementProfile.ts`, `src/lib/i18n.tsx`

### Open Issues / Follow-ups

- 系统不验证号码是否存在、归属人员或已注册 GST；财务需按业务流程核对。
- 未执行数据库写入、外部 ABR 查询、commit、push、PR、merge、deployment 或生产/设备验证。

## 执行R5-2B

- Date: 2026-09-10
- Task: 执行R5-2B
- Status: implemented

### Confirmed Plan

- 仅将 Property Guide admin/public/link-sync 的 runtime DDL 迁移为正式 migration 与启动期 marker；保留任务列表 stored-link fallback 与历史空 `token_enc` 数据。
- 删除无调用者或固定 410 后的 Maintenance legacy DDL helper；不重定义已由正式 migration 覆盖的 Maintenance schema。
- 在干净 `origin/Dev@d3900127718e6f933ff6672573225eae5cba2ada` 候选中验证；不执行数据库 migration、Render 部署、提交、推送或移动端发布。

### Implementation Result

- 新增 `20260910_r5_2b_property_guides_schema` migration 与 `propertyGuideRuntimeSchema` startup marker。Guide admin/public/sync 现在读取内存 readiness，正常请求不再执行 Guide DDL。
- marker 未就绪时 Guide API 返回 `property_guide_runtime_schema_not_ready`；任务列表链接解析直接保留既有 stored link fallback，避免影响整个任务列表。
- 生产只读预检结果已保留为 source 约束：无重复 Guide property，3 条历史 public link 缺少不可逆 `token_enc`；本轮不修改这些记录。
- 已移除 Maintenance foundation/work-task/progress schema helper 与 legacy path 内 DDL；CMS、Deep Cleaning、Inventory、Finance、Orders、Invoices 和 Mobile UI 未改动。

### Validation

- Isolated `npm ci --prefix backend`、R5-2B static contract、Guide link utility、R5-1/R5-2A/Maintenance static contracts及 backend TypeScript build 均通过。
- 本轮未执行数据库 migration、Render 部署、生产 SQL 写入、真实 Web/Mobile smoke test、commit、push、PR 或 merge。

### Files / Areas

- `backend/scripts/migrations/20260910_r5_2b_property_guides_schema.sql`
- `backend/src/lib/propertyGuideRuntimeSchema.ts`
- `backend/src/modules/property_guides.ts`
- `backend/src/modules/property_guide_link_sync.ts`
- `backend/src/modules/public.ts`
- `backend/src/lib/maintenanceWorkflowSchema.ts`
- `backend/src/lib/maintenanceWorkflowStore.ts`

### Open Issues / Follow-ups

- 下一阶段需单独授权 production migration，并先确认 migration marker、canonical Guide schema 与 3 条历史 `token_enc` NULL 不变，再部署 Render。
- 提交前仍需运行最终 ledger/feature registry audit、精确 diff 审查和独立只读 release review。

## 维修任务中心与分享/PDF 请求时 schema 收口

- Date: 2026-09-04
- Task: 在不扩大 maintenance marker 含义的前提下，移除 task-center 维修投影以及维修分享/PDF 入口的请求时 DDL，并保证所有相关业务写入前先完成 readiness 检查。
- Status: implemented in clean candidate; final ledger gate and independent review pending

### Confirmed Plan

- 只读盘点确认 task-center 维修同步所需的 `property_maintenance` 工作流字段与完整 `work_tasks` 结构均已属于 `20260903_maintenance_runtime_schema`；因此这些维修投影路径可复用 maintenance marker。
- `task_center` 独立依赖的清洁、检查范围、看板行/项/标记表不属于 maintenance schema；本轮不修改这些 helper，也不把它们纳入 maintenance marker。
- 把 `maintenance_share_links` 表及其索引纳入尚未执行的 maintenance runtime migration；分享入口改用只读 marker/列断言，不在请求中建表或补列。
- 维修 PDF 同步/异步入口只断言 maintenance marker 与维修工作流 schema；既有独立 `pdf_jobs` readiness 继续保持独立，不扩大 maintenance marker。
- 所有 task-center 维修投影写入、维修分享访问/上传/写入及维修 PDF job 写入前先做 readiness；marker 缺失统一返回 `503 maintenance_runtime_schema_not_ready`，且不产生部分业务更新。
- 仅修改确认需要的 maintenance/task-center/share-link schema 与定向契约；不治理其他历史 runtime DDL，不运行数据库迁移、不改生产数据、不推送、不部署。

### Implementation Result

- `task_center` 已移除维修工作流与 `work_tasks` 请求时 DDL：`/day` 的维修投影在删除/写入前、`/save-board` 的工单读取与后续业务写入前，先检查 maintenance marker 与现有 workflow/work-task 列契约；失败统一返回 `503 maintenance_runtime_schema_not_ready`。
- `maintenance_share_links` 表和两个索引已纳入 `20260903_maintenance_runtime_schema` 且位于 marker 写入前；维护端创建分享链接和公开端读取/登录/上传路径改为只读 schema 断言，`public_access` 继续使用独立只读列检查且未纳入 maintenance marker。
- 同步维修 PDF、异步维修 PDF 排队与底层维修 PDF 记录读取均先检查 marker/所需列；底层不再为 `property_maintenance` 建表或补列。PDF worker 在 claim/reclaim 维修 PDF job 前先做只读就绪检查，未就绪时保留维修 job 原状态并继续允许其他 PDF 类型运行。
- 深清 PDF、清洁/检查 schema、task-center layout、`public_access` migration 和 `pdf_jobs` migration 均保持既有独立契约，没有加入本轮 migration。

### Validation

- 维修 schema 静态契约、PDF jobs runtime 契约、维修状态机、自动费用、财务 schema 兼容和年度报告定向脚本通过；房源营收/年度报告/维修前端 Vitest 通过（3 files / 21 tests）。
- CRL-009 变更 TypeScript 语法/transpile 检查通过；feature registry audit 通过（18 FRs / 149 mappings）。完整 backend/frontend TypeScript typecheck 因隔离候选无本地依赖而只得到模块解析失败，未能形成有效类型检查证据。
- Pending: final exact staged ledger gate, generated/sensitive review and independent release review.

### Files / Areas

- `backend/scripts/migrations/20260903_maintenance_runtime_schema.sql`
- `backend/src/lib/maintenanceRuntimeSchema.ts`
- `backend/src/lib/workRecordPdf.ts`
- `backend/src/modules/task_center.ts`
- `backend/src/modules/maintenance.ts`
- `backend/src/modules/public.ts`
- `backend/src/services/pdfJobsWorker.ts`
- `backend/scripts/tests/test_maintenance_workflow_schema_contract.ts`
- `docs/feature-regression-registry.md`
- `docs/change-release-ledger.md`

### Open Issues / Follow-ups

- `cleaning_*`、task-center layout、`public_access` 与 `pdf_jobs` 的独立 schema 契约不由 maintenance marker 所有；本轮保持原边界。

## 维修关闭发布阻塞修复（schema marker、实际维修人员与未完成原因）

- Date: 2026-09-03
- Task: 修复独立发布复审确认的六个 P1：正常关闭路径的 runtime DDL、API 可绕过实际维修人员（含审核通过关闭）、历史待审核无人员记录没有补录入口、普通编辑可改完成日期影响房东费用入账、未完成原因没有写回源维修记录/任务投影；恢复被误删的状态机回归断言。
- Status: implemented in clean candidate; local commit pending validation and independent review

### Confirmed Plan

- 以新的受控 migration `20260903_maintenance_runtime_schema` 统一拥有维修工作流、工单投影和自动费用所需结构；正常请求与启动过程不得执行该 DDL。
- 应用启动只读检查 `schema_migrations` marker。marker 缺失时，维修反馈、工作流关闭和自动费用关联 CRUD 以 `503 maintenance_runtime_schema_not_ready` 失败关闭。
- MZapp `work_tasks` 读取和排序在每个请求入口复用同一 marker 断言；启动预热失败后不得继续返回或更新维护类工单。
- 管理者完成维修或审核通过关闭必须采用已有分派人员或已校验的本次提交人员；执行人未完成必须保存照片、备注和原因，并投影到同一 `work_tasks` 来源任务。
- 普通维修记录编辑必须拒绝 `completed_at`；该会计日期只允许由 `manager_complete` 或内部 `review_approved` 工作流动作保存，避免普通写权限改变自动费用 `month_key`。
- 历史 `pending_review` 且无人员的记录在管理员审核关闭或填写扣款方式触发自动审核时显示实际维修人员，并把该人员随 `review_approved` 原子写入。
- 仅修改 root 后端/网页共用源码、迁移、回归登记和台账；不运行数据库迁移、不改生产数据、不部署、不推送。

### Implementation Result

- `manager_complete` 与 `review_approved` 现在在无 `assignee_id` 且无既有分派时返回 `400 maintenance_actual_repairer_required`；提交人员会先校验存在，再原子写入完成/关闭记录。
- 通用 `PATCH /crud/property_maintenance/:id` 现在把 `completed_at` 作为 workflow-only 字段，返回 `409 maintenance_workflow_action_required`，在进入自动费用同步前拒绝该写入。
- 前端 `approveInternalMaintenance` 支持受控的可选 `assignee_id` 与 `completed_at`；历史待审核记录不能走通用 PATCH，而是随审核通过工作流请求原子补录维修人员和实际完成日期。
- `executor_unfinished` 已恢复把备注与 `completion_reason` 写回内部/外部维修源记录，既有 `upsertMaintenanceWorkTask` 会同步到任务投影。
- `maintenance`、`mzapp`、维修 CRUD 列表/编辑/工单投影与自动费用写入路径移除了运行时 maintenance/expense schema ensure，改为 marker readiness 和只读 schema assertion；迁移标记只在所有 DDL（含历史 `photo_urls` 兼容转换）完成后插入。
- `assertWorkTasksSchemaReady` 现在先断言 maintenance runtime marker，再检查 `work_tasks` 列；因此 `/mzapp/work-tasks` 与 reorder 不会在 marker 缺失时绕过受控 `503`。所有复用此断言的 MZapp 工单路由在本地 catch 中也保留该 `503 maintenance_runtime_schema_not_ready`，不会再误转为通用 500；`/mzapp/property-feedbacks` 的维修读取也在查询前断言 marker，并在路由层保留同一 503。
- 恢复 cancelled 维修、项目创建/完成 `FOR UPDATE`、完成字段和未完成原因等既有状态机断言，并将三项维修契约接入 root 的 `check:backend` 与 `check:fast`。

### Validation

- 直接候选 `ts-node` 已通过：maintenance workflow schema contract、workflow actions、maintenance auto expense、finance reporting schema compatibility 和 annual property report。
- 前端 Vitest 已通过：maintenance workflow actions（8）、property revenue expense fields（3）和 annual report（8）；feature-registry audit 通过（18 FRs / 149 test mappings）。
- 第八次独立复审发现 MZapp `work_tasks` 的请求级检查漏掉 maintenance migration marker，启动预热失败后仍可能读/排序维修工单；现已在公共请求断言补 marker fail-closed 契约。第九次复审继而发现路由 catch 会将该受控错误误转为 500；现已统一保留 503 响应并用六个调用点的静态契约覆盖。第十次复审发现 `/mzapp/property-feedbacks` 的维修读取吞掉断言并继续查询；现已在读取前 fail-closed 并保留 503。第十一次独立复审、Git commit、迁移、部署与生产/设备验证尚未执行。

### Files / Areas

- `backend/scripts/migrations/20260903_maintenance_runtime_schema.sql`
- `backend/src/lib/maintenanceRuntimeSchema.ts`
- `backend/src/lib/maintenanceWorkflowSchema.ts`
- `backend/src/index.ts`
- `backend/src/modules/maintenance.ts`
- `backend/src/modules/mzapp.ts`
- `backend/src/modules/crud.ts`
- `backend/scripts/tests/test_maintenance_workflow_schema_contract.ts`
- `backend/scripts/tests/test_maintenance_workflow_actions.ts`
- `backend/scripts/tests/test_maintenance_auto_expense.ts`
- `backend/package.json`, `package.json`
- `docs/feature-regression-registry.md`, `docs/change-release-ledger.md`

### Open Issues / Follow-ups

- 部署必须遵循“先执行迁移并核对 marker，再部署后端”的顺序；本次不执行该生产步骤。
- `task_center` 中不属于本次候选范围的历史 runtime schema helper 仍保留，需作为独立后续清理单元处理，不能据此放宽本次维修关闭路径的无 DDL 契约。

## 关闭维修时登记实际维修人员

- Date: 2026-09-03
- Task: 修正关闭维修时“分配维修人员和修改状态请分两次保存”的错误语义；关闭代表已修完，应一次登记实际维修人员、完成日期、维修后照片和费用，而不是补填预计完成时间。
- Status: implemented (local source validation; release not prepared)

### Confirmed Plan

- 保留普通待办的“分配人员 + 预计完成时间”流程。
- 选择提交审核/审核关闭时，将同一人员字段转换为“实际维修人员”，不显示预计完成时间；通过既有 `manager_complete` 原子保存人员、完成日期、照片与备注。
- 不开放通用状态写入，不新增数据库字段/迁移，不改权限、移动端、任务中心、费用规则或生产数据。

### Implementation Result

- 后端 `manager_complete` 现在可选接收 `assignee_id`：先校验内部用户存在，再随 `completed_at`、照片、备注一起保存，并在 `manager_completed` 审计 payload 记录 `actual_repairer_id`。
- 网页关闭/提交审核时不再调用未来分派动作，因此不会写 `eta`、`assigned_at` 或 `assigned_by`，也不会出现要求分两次保存的错误；普通分派不受影响。
- 没有已记录人员的完工补登记会要求选择实际维修人员；已有人员的历史记录仍可按原流程完成。

### Validation

- 前端工作流封装测试 7/7 通过；后端维修工作流契约通过。
- 前端与后端 no-emit TypeScript 均通过；变更文件 `git diff --check` 通过。
- 前端 lint 通过，只有仓库既有 warning；功能回归登记审计通过（16 FRs / 191 test mappings）。
- 共享台账审计被既有远端谱系差异阻塞（17 条远端 CRL 缺失、5 条历史记录身份不一致）；没有修改这些历史记录。前端 production build、认证浏览器/API、非生产/生产数据、部署和设备验证均未运行。

### Files / Areas

- `frontend/src/app/maintenance/records/page.tsx`
- `frontend/src/lib/maintenanceWorkflowActions.ts`
- `frontend/src/lib/maintenanceWorkflowActions.test.ts`
- `backend/src/modules/maintenance.ts`
- `backend/scripts/tests/test_maintenance_workflow_actions.ts`
- `docs/feature-regression-registry.md`
- `docs/change-release-ledger.md`

### Open Issues / Follow-ups

- 发布前应在干净 `origin/Dev` 工作树提取 root/CRL-20260903-005 及依赖 001/002/003/004，运行前端 build、独立评审和授权浏览器回归；当前共享工作树不可直接暂存或发布。
- 浏览器回归应覆盖关闭补登记、待审核补登记、普通未来分派、已有维修人员和无流程权限账号；验证费用仍按实际完成日入账。

## 维修编辑页面流程型布局优化

- Date: 2026-09-03
- Task: 按已确认预览把网页维修编辑 Drawer 改为流程优先的操作界面，使管理员能清楚地登记维修结果、费用和扣款方式，并理解保存会执行的状态动作。
- Status: implemented (local source validation; release not prepared)

### Confirmed Plan

- 仅改 `/maintenance/records` 网页 Drawer 与局部样式，复用既有受约束状态机、单一保存入口、照片门槛和自动审核关闭逻辑。
- 顶部展示房号、工单、当前状态和四步流程；“本次处理”以合法动作替代技术性的“保存后状态”。
- 将工单分派、问题与维修前照片、维修结果、费用结算分区；移动端保持同一保存入口和可用的纵向布局。
- 不改数据库、接口、权限、迁移、移动端、任务中心或任何生产/非生产数据；不提交、推送或部署。

### Implementation Result

- 编辑 Drawer 现在在顶部显示流程进度与状态，并根据选择提示/标记本次动作；底部主按钮同步显示该动作。
- 问题摘要和维修前照片收为可展开区域；维修后照片、维修说明、实际完成日期与费用结算以独立卡片承接，提交审核时提示后照片必需。
- 保存仍调用原有 workflow action 映射；没有流程权限的账号只看到记录内容编辑和明确的权限提示，不能通过界面直接写入生命周期状态。

### Validation

- `git diff --check -- frontend/src/app/maintenance/records/page.tsx frontend/src/app/maintenance/records/records.module.scss` — passed.
- `./frontend/node_modules/.bin/tsc --noEmit -p frontend/tsconfig.json` — passed.
- `npm run test --prefix frontend -- --coverage.enabled=false src/lib/maintenanceWorkflowActions.test.ts` — passed: 1 suite / 7 tests.
- `npm run lint --prefix frontend` — passed; only existing repository-wide warnings, and maintenance records page retains its pre-existing Hook dependency warnings.
- 未运行前端 production build：其 `prebuild` 会清理共享工作区的 Next 缓存；当前工作区含大量其他未提交改动。未启动认证网页或调用维护 API，因尚未确认安全测试账号/环境。

### Files / Areas

- `frontend/src/app/maintenance/records/page.tsx`
- `frontend/src/app/maintenance/records/records.module.scss`
- `docs/change-release-ledger.md`

### Open Issues / Follow-ups

- 发布前从干净 `origin/Dev` 基线提取 root/CRL-20260903-004 及其依赖的 001/002/003，完成独立评审、前端 build 和授权浏览器回归；当前共享工作树不能直接暂存或发布。
- 人工回归应覆盖待分派、待审核带扣款方式、关闭后重新打开、无流程权限编辑四种状态；无需也不应通过通用 CRUD 直改状态。

## 维修流程权限化与网页受约束状态编辑

- Date: 2026-09-03
- Task: 让管理员可以在维修记录中登记维修后照片、费用、扣款方式和实际完成日期，并按状态机变更状态；线下经理仅在 RBAC 按需授予后具备同等流程能力。
- Status: implemented (local source validation; release not prepared)

### Confirmed Plan

- 用动态权限 `property_maintenance.workflow.manage` 替代维修流程的角色名硬编码；不向 `offline_manager` 默认授予，保留 `admin` 的既有全权限语义。
- 保持通用 CRUD 不能直接更新生命周期字段；网页状态选择映射为专用工作流动作，并在管理者完工时强制至少一张维修后照片。
- 费用、支付方式与实际完成日可在未取消记录登记；保存维修后照片后将活动记录推进至待审核，已有支付方式时继续复用审核关闭和自动费用逻辑。
- 只改本地 source/docs 并运行无写入回归；不做迁移、历史回填、API/数据库写入、提交、推送或部署。

### Implementation Result

- 后端工作流、网页和 MZstay 响应共同使用 RBAC 权限判定，不再因 `offline_manager` / `customer_service` 角色名直接获得维修流程管理权。
- 新增管理者开始、管理者完成两个受审计动作；管理者完成会保存完成照片、`completed_at`、状态事件和任务投影，缺少照片会被拒绝。
- 维修记录抽屉保留一个保存按钮：管理者可选择合法下一状态、填写必要原因和实际完成日；状态不会直接 PATCH。新记录与进行中的记录已提供费用及扣款方式输入。

### Validation

- 后端维修工作流契约通过；前端工作流封装 7/7 通过；后端和前端 no-emit TypeScript 均通过；前端 lint 通过（仅仓库既有警告）；功能回归登记审计通过（16 FRs / 189 test mappings）。
- 共享变更台账审计被既有远端谱系差异阻塞（17 条远端 CRL 缺失、5 条旧记录身份不一致）；未修改这些历史记录。完整前端生产构建、认证浏览器、非生产 API/数据库、生产、部署和设备验证均未运行。

### Files / Areas

- `backend/src/lib/maintenanceWorkflow.ts`
- `backend/src/modules/maintenance.ts`
- `backend/src/modules/mzapp.ts`
- `backend/src/store.ts`
- `backend/src/permissionsCatalog.ts`
- `backend/scripts/tests/test_maintenance_workflow_actions.ts`
- `frontend/src/lib/maintenanceWorkflowActions.ts`
- `frontend/src/lib/maintenanceWorkflowActions.test.ts`
- `frontend/src/app/maintenance/records/page.tsx`
- `docs/feature-regression-registry.md`
- `docs/change-release-ledger.md`

### Open Issues / Follow-ups

- 发布前需从干净 `origin/Dev` 基线按 root/CRL-20260903-003 及其依赖单元提取精确补丁、独立评审并完成选择性发布流程；当前共享工作树不可直接暂存或发布。
- 线下经理如需该能力，应先在现有 RBAC 角色权限页同时按岗位授予维修写入和流程管理权限；本轮没有修改任何用户/角色或生产数据。

## 审核关闭维修按完成时间自动入账

- Date: 2026-09-03
- Task: 使审核关闭的房东支付内部维修自动进入房源费用，并以实际完成日入账。
- Status: implemented and integrated in fixed Preview; not released

### Confirmed Plan

- 保持正式工作流终态为 `closed`，不把 `completed` 恢复为可选状态；仅将其作为已审核历史数据的兼容输入。
- 执行人提交/完成时记录 `completed_at`；审核通过关闭时在同一数据库事务同步自动费用。
- 同一资格和日期规则用于即时同步、财务补账检查和月结对账；待审核、取消、重开与未审核关闭均不入账。
- 只修改本地 source/docs 并做无写入验证；不执行数据库迁移、历史回填、生产/非生产写入、提交、推送或部署。

### Implementation Result

- In progress: backend implementation and documentation are in place; final local validation remains pending.

### Validation

- `npm run test:maintenance-workflow-actions --prefix backend` — passed.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_maintenance_auto_expense.ts` (from `backend/`) — passed.

### Files / Areas

- `backend/src/lib/maintenanceAutoExpense.ts`
- `backend/src/modules/maintenance.ts`
- `backend/src/modules/crud.ts`
- `backend/src/modules/finance.ts`
- `backend/src/lib/monthlyStatementExpenseReconcile.ts`
- `backend/scripts/tests/test_maintenance_auto_expense.ts`
- `docs/feature-regression-registry.md`
- `docs/change-release-ledger.md`

### Open Issues / Follow-ups

- 需完成 no-emit TypeScript、功能回归登记审计和共享台账审计；共享台账已有远端谱系漂移，不能把当前混合工作区作为发布来源。
- 事务/API、实际房源费用、月结、认证网页、生产、部署和设备验证均未运行。

### Update - 2026-09-03 13:20

- Status: implemented (local source validation)
- Implementation Result:
  - 新增共享维修自动费用资格/日期 helper：正式 `closed + approved` 才入账；`completed`/`done`/`ready` 仅兼容已审核历史，待审核、取消、重开和未审核关闭不入账。
  - 内部维修执行人提交/完成写入 `completed_at`；审核关闭在同一事务同步费用，房东支付缺少物业、正金额或会计日期时整体回滚并保持待审核。
  - 财务补账检查和月结对账复用同一规则；本次不做历史回填或已出账单改写。
- Validation:
  - 后端维修状态机契约、自动费用新契约和 no-emit TypeScript 均通过；功能回归登记审计通过（16 FRs / 188 mappings）；CRL 文件的 `git diff --check` 通过。
  - 共享台账审计被既有远端谱系差异阻塞（17 条远端 CRL 缺失、5 条旧记录身份不一致）；未修改该历史问题，也未创建发布候选。
- Open Issues / Follow-ups:
  - 非生产事务/API 与实际财务/月结验证、认证网页、生产、部署和设备验证未运行；如需发布，必须从干净 `origin/Dev` 基线提取 selected CRLs，并先解决/隔离台账谱系问题。

## 管理员保存维修扣款方式自动审核关闭

- Date: 2026-09-03
- Task: 管理员保存维修扣款方式自动审核关闭
- Status: partially implemented

### Confirmed Plan

- 管理员在维修记录待审核状态保存已选择的扣款方式时，自动完成审核并关闭，不再额外点击审核通过。
- 复用既有维修状态机、权限校验、完工照片门槛、任务投影和审核事件；不开放通用 CRUD 的生命周期字段写入。
- 非管理角色、没有扣款方式或非待审核状态不自动关单；不改移动端、任务中心、数据库、生产数据或发布状态。

### Implementation Result

- In progress: source changes are pending local validation.

### Validation

- Not run yet.

### Files / Areas

- `frontend/src/app/maintenance/records/page.tsx`
- `frontend/src/lib/maintenanceWorkflowActions.ts`
- `frontend/src/lib/maintenanceWorkflowActions.test.ts`
- `docs/feature-regression-registry.md`
- `docs/change-release-ledger.md`

### Open Issues / Follow-ups

- 需完成前端单测、既有后端维修状态机回归、前端构建和台账/回归登记审计。
- 未执行认证网页、非生产 API、生产、部署或设备验证。

### Update - 2026-09-03 12:36

- Status: implemented
- Implementation Result:
  - 维修记录页在管理员保存待审核记录的非空扣款方式后，先保存既有费用/反馈字段，再调用带操作 ID 的 `review approved` 状态机动作，成功后显示“已保存费用并审核关闭”。
  - 后端仍负责管理角色、待审核状态和完工照片校验，并写入既有审核、关闭、任务投影和工作流事件；非管理角色、缺扣款方式或其他状态不会触发自动关单。
  - 第二个请求失败或超时会明确提示“费用已保存，但自动审核关闭失败”，保留操作 ID 以便安全重试，并后台刷新记录状态。
- Validation:
  - 前端单测 6/6、后端维修状态机契约、前端 lint/build 和功能回归登记审计均通过；前端 lint/build 只报告仓库既有警告。
  - 发布台账审计被共享工作区既有远端谱系漂移阻塞；认证网页、非生产 API、生产、部署和设备验证未运行。
- Open Issues / Follow-ups:
  - 如需发布，先在干净的 `origin/Dev` 基线工作树中提取 `root/CRL-20260903-001`，完成独立评审和选择性发布流程；本次没有提交、推送或部署。

## 入住检查替代延期检查与取消回滚

- Date: 2026-08-05
- Task: 入住检查替代延期检查与取消回滚
- Status: implemented

### Confirmed Plan

- 同房源现场入住检查仅在退房日到延期检查日的闭区间内替代延期检查；延期日及后续日期不再显示该延期任务。
- 自动替代保留来源入住任务和原延期日；入住取消、改期、改房源或改为仅改密码时，找不到替代入住则恢复原延期日，不自动顺延。
- 不物理删除退房任务、不修改生产历史数据、不自动结束无关清洁/钥匙流程；保留无法替代时的既有冲突提醒。

### Implementation Result

- 新增后端协调服务，统一处理订单同步、手动任务创建/编辑/取消、批量编辑与任务中心保存。合格入住使延期任务改为 `checked_done` 并清空 `inspection_due_date`；服务端工作任务事件负责刷新客户端。
- 为取消回滚新增来源入住任务 ID 与原延期日字段，并在来源失效时恢复 `deferred`；手动重新安排检查会清除自动来源，避免系统覆盖人工决定。
- 原冲突判断补齐“入住日不得早于退房任务日”的下界；仅改密码入住不自动替代，继续可提醒人工处理。
- 新增非生产端到端脚本，覆盖订单同步、手动创建、取消恢复、手动编辑、任务中心保存及延期日日历不投影；脚本必须显式开启非生产写入开关。

### Validation

- `npm run test:deferred-inspection-checkin-replacement --prefix backend` — passed.
- `./backend/node_modules/.bin/tsc -p backend/tsconfig.json --noEmit` — passed.
- `./backend/node_modules/.bin/tsc -p backend/tsconfig.json --outDir <temporary directory>` — passed without modifying shared `backend/dist` artifacts.
- `npm run test:app-notification-policies --prefix backend` — passed; expected mocked role-resolution diagnostic only.
- `npm run test --prefix frontend -- --coverage.enabled=false src/app/task-center/taskCenterDisplay.test.ts` — passed: 1 suite / 5 tests.
- `npm run check:feature-registry` and `python3 scripts/audit_change_release_ledger.py` — passed: 12 FRs / 125 mappings; 121 changed files / 121 recorded.
- 受控非生产数据库端到端、浏览器、移动端、部署和生产验证 — not run；当前未确认可写非生产数据库。

### Files / Areas

- `backend/src/services/deferredInspectionCheckinConflict.ts`
- `backend/src/services/cleaningSync.ts`
- `backend/src/modules/cleaning.ts`
- `backend/src/modules/task_center.ts`
- `backend/scripts/migrations/20260805_deferred_inspection_checkin_replacement.sql`
- `backend/scripts/tests/test_deferred_inspection_checkin_conflict.ts`
- `backend/scripts/tests/test_deferred_inspection_conflict_e2e.ts`
- `docs/feature-regression-registry.md`
- `docs/change-release-ledger.md`

### Open Issues / Follow-ups

- 上线前需在确认的非生产数据库运行端到端脚本，并在网页确认延期日及后续日期没有卡片、取消入住后恢复原延期日。
- 当前不包含历史遗留延期任务的生产回填；如需处理，必须先只读预览并取得单独的生产写入授权。

### Update - 2026-08-11 11:02

- Status: implemented
- Confirmed Plan:
  - 退房日保留“延期检查 + 原延期日”，合格入住只承接执行；承接日仅显示一张实际入住检查。
  - 真实检查提交前不得显示“已检查”；旧版误标记录先在服务端投影和移动端缓存显示层兼容，不进行本次生产数据写入。
- Implementation Result:
  - 协调服务不再把承接写为 `checked_done` 或清空延期日，改为 `deferred + inspection_replaced_*`；来源无效时按原关系重关联或清除关系。
  - 有效承接关系不再触发“入住冲突”提醒；关系失效后才恢复既有冲突告警路径。
  - `/mzapp/work-tasks` 与 `/cleaning/calendar-range` 归一化旧 `checked_done + 承接关系` 数据，并在承接日抑制旧退房任务的重复延期投影。
  - 移动端退房卡使用“延期检查 YYYY-MM-DD”，实际 `checkin_clean` 检查任务使用“入住检查”；网页能力标签不再把旧承接当成已检查。
- Validation:
  - `npm run test:deferred-inspection-checkin-replacement --prefix backend` — passed.
  - `npm run test:cleaning-inspection-merge --prefix backend` — passed.
  - `./backend/node_modules/.bin/ts-node-dev --transpile-only backend/scripts/tests/test_web_task_capabilities.ts` — passed.
  - `npm test --prefix mz-cleaning-app-frontend -- --runInBand src/lib/cleaningInspection.test.ts` — passed: 1 suite / 4 tests.
  - `npm run build --prefix backend` and `npm run typecheck --prefix mz-cleaning-app-frontend` — passed.
  - `npm run check:feature-registry` and `python3 scripts/audit_change_release_ledger.py` — passed: 13 FRs / 156 test mappings; 148 changed files / 148 recorded.
  - Targeted mobile ESLint — 0 errors; existing warnings in the two screen files remain and were not modified in this scope.
- Files / Areas:
  - `backend/src/services/deferredInspectionCheckinConflict.ts`
  - `backend/src/lib/cleaningInspection.ts`, `backend/src/modules/mzapp.ts`, `backend/src/modules/cleaning.ts`, `backend/src/lib/webTaskCapabilities.ts`
  - `mz-cleaning-app-frontend/src/lib/cleaningInspection.ts`, `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx`, `mz-cleaning-app-frontend/src/screens/tasks/ManagerDailyTaskScreen.tsx`
- Open Issues / Follow-ups:
  - 非生产端到端脚本、网页/真机、部署与生产验证未运行；脚本会写入数据库，需先确认可写非生产环境。
  - 本次未修改生产数据；后端部署后旧记录会先获得正确的 API/移动端显示，若要批量规范化历史行须另行授权。

## 维修分配原子保存与移动端维修媒体投影

- Date: 2026-08-04
- Task: 按已确认方案修复维修分配慢/重复保存、移动端原始摘要和维修前照片缺失
- Status: implemented (local source validation)

### Confirmed Plan

- 网页分配收敛为一次幂等状态机请求，去除“先分配、再通用 PATCH”的串行双写和动作热路径重复 DDL。
- 服务端规范维修摘要并安全投影维修前照片；移动端统一缓存/远端/实时摘要处理并显示只读照片区。
- 不触碰生产数据、外部同步、部署、提交或推送。

### Implementation Result

- `POST /maintenance/workflow/internal/:id/assign` 现在在一个事务中锁定记录、保存受限普通字段、执行分配状态转换、刷新 `work_tasks`、写事件和幂等回执；网页超时重试复用同一操作 ID，且不再发送第二个普通 PATCH。
- 工作流和 `work_tasks` 初始化改为连接前的进程内一次性准备，避免每次动作请求重复执行 DDL。
- 内部维修摘要从历史 JSON 规范为可读文本；`/mzapp/work-tasks` 仅为内部维修投影维修前照片引用。
- 私有图片代理以精确 `work_task_id`、维修来源 ID、房源 ID 和执行人/管理角色组合授权；移动端缩略图与全屏预览均携带该上下文。

### Validation

- `npm run test:maintenance-workflow-actions --prefix backend` — passed.
- `npx vitest run src/lib/maintenanceWorkflowActions.test.ts` in `frontend` — passed: 2 tests.
- `npx jest src/lib/workTasksStore.test.ts src/lib/cleaningMedia.test.ts --runInBand` in mobile — passed: 13 tests.
- `npm run build --prefix backend`, `npx tsc --noEmit` in frontend and `npm run check:ci` in mobile — passed. Mobile gate: 53 suites / 289 tests, zero lint errors and existing non-blocking warnings.
- Confirmed non-production HTTP/database path, web browser, iOS/Android device, weak-network, deployment and production verification — not run.

### Open Issues / Follow-ups

- Release root `CRL-20260804-013` and `CRL-20260804-014` together with mobile `CRL-20260804-007`; an older API or mobile bundle alone is insufficient.

## 床品管理模块优化方案（按现有床品管理模块升级）

- Date: 2026-04-05
- Task: 床品管理模块优化方案（按现有床品管理模块升级）
- Status: implemented

### Confirmed Plan
- 保留现有 `仓库管理 > 床品管理` 菜单结构，不新增独立一级模块，在现有床品页面下补齐业务闭环。
- 统一 Ewash / PSL 到 `SM 总仓` 收货，采购单支持固定周期补货、供应商人工选择、自动带出床品单价与金额。
- 床品库存调整为“总仓按件、分仓按套”的使用视图，并增加总仓 `压箱底安全库存` 跟踪。
- 床品配送从日常调拨视角升级为按周补仓视角，基于未来窗口需求、车容量、分仓容量生成配送建议与计划。
- 补齐脏床品回仓、返厂批次、退款核销、报损的链路，并在现有床品退货/报损页面内承载。

### Implementation Result
- `backend/src/modules/inventory.ts` 已新增床品升级所需 schema 与接口，包括：
- `supplier_item_prices` 供应商床品价格表，支持采购价、退款价、生效日、启停。
- `inventory_stock_policies` 安全库存策略，支持按总仓 + 床品设置保留件数。
- `linen_delivery_plans / linen_delivery_plan_lines` 配送计划与计划明细。
- `linen_supplier_return_batches / linen_supplier_return_batch_lines / linen_supplier_refunds` 返厂批次与退款核销台账。
- 已新增床品专用接口：`/inventory/linen/dashboard`、`/inventory/linen/delivery-suggestions`、`/inventory/linen/delivery-plans`、`/inventory/linen/return-intakes`、`/inventory/linen/supplier-return-batches`、`/inventory/linen/supplier-refunds`、`/inventory/supplier-item-prices`、`/inventory/linen/reserve-policies`、`/inventory/deliveries`。
- 采购单创建逻辑已修正为真正使用前端传入的 `warehouse_id / property_id / region`，并在有供应商价格时自动写入单价和明细金额，不再固定忽略页面输入。
- `frontend/src/app/inventory/category/[category]/stocks/page.tsx` 已切换床品分类到专用库存看板 `LinenStocksDashboard`。
- `frontend/src/app/inventory/category/[category]/deliveries/page.tsx` 已切换床品分类到专用配送页 `LinenTransfersView`。
- `frontend/src/app/inventory/category/[category]/returns/page.tsx` 已切换床品分类到专用退回页 `LinenReturnsDamageView`。
- `frontend/src/app/inventory/suppliers/page.tsx` 已扩展为“供应商列表 + 床品价格表”双 tab，支持维护采购价与退款价。
- `frontend/src/app/inventory/purchase-orders/new/page.tsx` 已支持按床品明细或按房型套数建单，并展示自动带出的单价与金额合计。
- `frontend/src/app/inventory/purchase-orders/[id]/page.tsx` 已补显示明细金额。
- `frontend/src/lib/api.ts` 已新增 `putJSON` 以支持安全库存策略更新。
- 已新增 migration：`backend/scripts/migrations/20260405_inventory_linen_upgrade.sql`。

### Validation
- `backend`: `npm run build` 通过。
- `frontend`: `npm run build` 通过。
- 前端构建过程中存在仓库内原有 ESLint warnings，但无新的阻塞型构建错误。

### Files / Areas
- `linen inventory`
- `linen purchasing`
- `linen delivery planning`
- `linen supplier pricing`
- `linen return / refund settlement`
- `backend/src/modules/inventory.ts`
- `backend/scripts/migrations/20260405_inventory_linen_upgrade.sql`
- `frontend/src/app/inventory/_components/LinenStocksDashboard.tsx`
- `frontend/src/app/inventory/_components/LinenTransfersView.tsx`
- `frontend/src/app/inventory/_components/LinenReturnsDamageView.tsx`
- `frontend/src/app/inventory/suppliers/page.tsx`
- `frontend/src/app/inventory/purchase-orders/new/page.tsx`

### Open Issues / Follow-ups
- 当前配送建议已优先读取 `properties.linen_service_warehouse_id`，若未维护则退回到按 `region` 粗匹配仓库；后续建议在房源页面补出该字段的可视化编辑入口。
- 分仓库存当前前端主视图已切成“按套”，但底层仍沿用件数换算；若后续需要更强的分仓套数独立审计，可继续补 dedicated 套数快照或盘点表。
- 返厂退款目前已支持应收、实收、差异、状态管理；若后续需要和财务交易流水自动联动，还可继续接入 `finance` 模块做到账凭证映射。
- 当前工作区仍有无关的 `backend/dist/modules/finance.js` 变更和 `.codex/environments/` 未跟踪内容，未包含在本次床品执行记录范围内。

## 房源月报链路优化方案 v2

- Date: 2026-04-05
- Task: 房源月报链路优化方案 v2
- Status: partially implemented

### Confirmed Plan
- 统一月报附件收集规则，合并 `expense_invoices` 与 `finance_transactions.invoice_url`，按统一月度规则归集并去重。
- 月报 job 在生成主报表前增加维修/深清到 `property_expenses` 的轻量 reconcile，避免刚创建记录时漏算支出。
- 无附件房源基于最终附件收集结果短路，不进入后续附件合并阶段。
- 附件预校验改为预算内快速探测，保留合并阶段的单文件失败容错。
- 照片记录查询改成带 TTL 的 schema 懒缓存，并将日期条件改成更可索引的写法。

### Implementation Result
- 新增共享库 `backend/src/lib/monthlyStatementInvoiceAttachments.ts`，统一月度附件收集、URL 归一化和去重键生成。
- 新增共享库 `backend/src/lib/monthlyStatementExpenseReconcile.ts`，提供房源+月份级 maintenance / deep_cleaning reconcile。
- `backend/src/services/pdfJobsWorker.ts` 已改为先 reconcile，再渲染主报表，再按统一附件收集结果决定是否短路附件。
- `backend/src/modules/finance.ts` 中 `/finance/expense-invoices/search` 已支持按 `month` 复用统一月度附件规则。
- `frontend/src/components/MonthlyStatement.tsx` 的月报发票查询已切换为按 `month` 调后端统一接口。
- `backend/src/lib/monthlyStatementPhotoRecords.ts` 已加入 schema TTL 缓存、索引兜底和更可索引的日期条件。

### Validation
- `backend`: `npm run -s build` 通过。
- `frontend`: `npx tsc -p tsconfig.json --noEmit` 通过。
- `frontend`: `npx vitest run src/lib/monthlyStatementSplitPdf.test.ts src/lib/monthlyStatementCompressedPhotos.test.ts src/lib/monthlyStatementPhotoSplit.test.ts --coverage=false`
- 其中 `monthlyStatementCompressedPhotos` 和 `monthlyStatementPhotoSplit` 通过。
- `monthlyStatementSplitPdf.test.ts` 仍有 1 条失败，失败原因为现有源码字符串断言期望 `shouldAutoFitCalendar` 相关文本，和本次附件/导出链路改动不直接对应。

### Files / Areas
- `monthly statement export`
- `backend/src/services/pdfJobsWorker.ts`
- `backend/src/modules/finance.ts`
- `backend/src/lib/monthlyStatementInvoiceAttachments.ts`
- `backend/src/lib/monthlyStatementExpenseReconcile.ts`
- `backend/src/lib/monthlyStatementPhotoRecords.ts`
- `frontend/src/components/MonthlyStatement.tsx`

### Open Issues / Follow-ups
- 月度导出主流程虽然已统一到后端 `merge-monthly-pack` 判断附件，但前端 `finance/properties-overview` 中仍保留旧的 `/finance/merge-pdf` fallback 代码，后续可继续收口。
- `monthlyStatementSplitPdf.test.ts` 的现有断言需要单独修复或调整，以免持续影响月报相关测试集。
- 当前记录文件已初始化，后续同任务的执行结果补充应在本条下追加 `Update` 小节，而不是新建重复任务标题。

## 维修/深清照片 PDF 根本性修复方案 v2

- Date: 2026-04-05
- Task: 维修/深清照片 PDF 根本性修复方案 v2
- Status: implemented

### Confirmed Plan
- 将照片分卷链路改为由 worker 先抓取图片、压缩后以内嵌资源形式交给 PDF 模板，避免继续依赖 Playwright 在渲染阶段远程拉图。
- 新建专用照片 PDF 模板，使用显式分页和固定网格布局，确保维修/深清记录头部、`Before`、`After` 与图片区不会跨页重叠。
- 对失败图片采用部分成功策略：失败图片不输出破图，整条记录全失败时输出缺图提示页，整单无可用图片时才失败。
- 保持现有照片分卷下载接口与 job API 不变，只升级 job stage、detail 和后端生成链路。

### Implementation Result
- `backend/src/lib/monthlyStatementPhotoPack.ts` 已改为先读取照片记录，再由 worker 拉取图片字节、压缩、转为内嵌图片资源后渲染 PDF。
- 新增 `backend/src/lib/monthlyStatementPhotoPackTemplate.ts`，为照片分卷提供独立模板与显式分页规则，不再复用旧月报 React 打印布局。
- `backend/src/services/pdfJobsWorker.ts` 的 `statement_photo_pack` 阶段映射已切换为 `collect_assets / fetch_assets / transform_assets / render_html / render_pdf / uploading`。
- 图片失败时会在结果 detail 中记录失败样本，并对整条记录无可用图片的场景输出缺图提示页。
- 现有下载入口与接口未改动，仍通过 `/finance/statement-photo-pack` 系列接口触发和下载。

### Validation
- `backend`: `npm run -s build` 通过。
- `frontend`: `npx tsc -p tsconfig.json --noEmit` 通过。
- 当前实现已从“远程 URL 渲染”切换为“worker 抓图后内嵌”，应消除生产环境中的整批破图问题。
- 当前实现已从“浏览器自由流排版”切换为“专用照片分页模板”，应消除维修记录照片页标题与图片区重叠问题。

### Files / Areas
- `statement photo pack`
- `backend/src/lib/monthlyStatementPhotoPack.ts`
- `backend/src/lib/monthlyStatementPhotoPackTemplate.ts`
- `backend/src/services/pdfJobsWorker.ts`

### Open Issues / Follow-ups
- 需要在 Dev 和 Production 用同一批真实维修/深清数据再做一次人工验收，重点确认多图、多页和缺图提示页的最终外观。
- 当前工作区仍有无关的 `backend/dist/modules/finance.js` 变更和 inventory 未跟踪文件，未包含在本任务范围内。

## MZ Property System Map skill 初始化与校验

- Date: 2026-04-07
- Task: MZ Property System Map skill 初始化与校验
- Status: implemented

### Confirmed Plan
- 在仓库内 `.codex/skills` 下初始化 `mz-property-system-map` skill。
- 创建 `SKILL.md` 与 `references/` 下的系统地图文档，覆盖资源归属、前端入口、后端模块、特殊动作与常见误判。
- 跑正式 skill 校验，并把本次执行结果记录到仓库执行记录中。

### Implementation Result
- 已创建 `.codex/skills/mz-property-system-map/` 目录与 `agents/openai.yaml`。
- 已完成 `SKILL.md`，包含系统地图定位、前置决策树、读取顺序、输出格式、版本锚定与维护说明。
- 已完成 `references/crud-map.md`，覆盖核心业务对象，并补充 inventory / finance 边角资源，包括：
- `finance_transactions`、`expense_invoices`、`property_revenue_status`、`payouts`、`company_payouts`、`statement_photo_pack_jobs`、`merge_monthly_pack_jobs`
- `inventory.warehouses`、`inventory.room-type.requirements`、`inventory.stocks`、`inventory.movements`、`inventory.transfers`、`inventory.daily-replacements`、`inventory.purchase-order-lines`、`inventory.linen.reserve-policies`、`inventory.linen.delivery-plans`、`inventory.linen.return-intakes`、`inventory.linen.supplier-return-batches`、`inventory.linen.supplier-refunds`
- 已完成 `references/frontend-entrypoints.md`，补充 `finance/transactions`、`finance/properties-overview`、`finance/monthly-statement`、`inventory/warehouses` 及分类库存/配送/退回页面。
- 已完成 `references/backend-route-patterns.md` 与 `references/anti-patterns.md`，明确 `/finance` 与 `/inventory` 的非纯 CRUD 特征，并记录了 `warehouses` 前后端写能力可能不一致的仓库现状。

### Validation
- `python3 /Users/zhishi/.codex/skills/.system/skill-creator/scripts/quick_validate.py '.codex/skills/mz-property-system-map'` 通过，结果为 `Skill is valid!`。
- 手工检查已确认 `SKILL.md` frontmatter、版本锚定、决策树与 references 结构完整。

### Files / Areas
- `.codex/skills/mz-property-system-map/SKILL.md`
- `.codex/skills/mz-property-system-map/agents/openai.yaml`
- `.codex/skills/mz-property-system-map/references/crud-map.md`
- `.codex/skills/mz-property-system-map/references/frontend-entrypoints.md`
- `.codex/skills/mz-property-system-map/references/backend-route-patterns.md`
- `.codex/skills/mz-property-system-map/references/anti-patterns.md`
- `docs/execution-records.md`

### Open Issues / Follow-ups
- `inventory/warehouses` 当前前端页面具备创建/编辑调用，但当前后端路由扫描只明确看到 `GET /inventory/warehouses`；后续若要改这个功能，应先核对真实后端实现或运行环境。
- 当前系统地图仍以 2026-04-07 附近的仓库快照为准，后续如 `backend/src/modules/crud.ts` 白名单、`backend/src/index.ts` 挂载点或 `frontend/src/app` 页面结构变化，应同步更新该 skill。

## 床品配送模块 v1 方案

- Date: 2026-04-08
- Task: 床品配送模块 v1 方案
- Status: implemented

### Confirmed Plan
- 将床品配送从“建议/计划工具”升级为正式的实际登记闭环，主形态为“每个分仓一笔配送单”。
- 一张配送单可录入多个房型明细，按房型套数保存，不由前端直接填写床品件数。
- 保存配送单时，后端根据 `inventory_room_type_requirements` 自动换算床品件数，并同步完成总仓到分仓的库存调拨。
- 支持配送单编辑与作废，要求在同一事务内完成旧库存影响回滚和新库存影响重算。
- 页面继续挂在 `/inventory/category/linen/deliveries`，但前端重心改为“配送单列表 + 新建/编辑 + 详情回看”，不再暴露原有配送建议/计划页签。

### Implementation Result
- `backend/src/modules/inventory.ts` 已新增正式配送单表：
- `linen_delivery_records`
- `linen_delivery_record_lines`
- 已新增配送单库存闭环 helper，包括：
- 按房型套数展开床品件数 `expandLinenDeliveryInputLines`
- 配送单库存正向/反向入账 `applyLinenDeliveryRecordStockInTx`
- 配送单详情聚合与回显 `loadLinenDeliveryRecordDetail`
- 已新增正式接口：
- `GET /inventory/linen/delivery-records`
- `GET /inventory/linen/delivery-records/:id`
- `POST /inventory/linen/delivery-records`
- `PATCH /inventory/linen/delivery-records/:id`
- `POST /inventory/linen/delivery-records/:id/cancel`
- 库存流水已统一写入 `ref_type = 'linen_delivery_record'`，用于和原有 `transfer` 调拨区分。
- `frontend/src/app/inventory/_components/LinenTransfersView.tsx` 已重做为单据式床品配送页面，支持：
- 顶部筛选：日期范围、来源仓、目标分仓、状态
- 配送单列表：总套数、房型数、状态、备注、创建时间
- 新建/编辑弹窗：多房型录入、套数录入、重复房型拦截
- 详情查看：按房型展开件数换算结果，并展示床品件数汇总
- 作废操作：前端确认后调用正式作废接口
- 原 `/inventory/category/linen/deliveries` 路由未变，但原来的“历史配送 / 配送建议 / 配送计划”标签页已被正式配送单页面替换。

### Validation
- `backend`: `npm run build` 通过。
- `frontend`: `npm run build` 通过。
- 前端构建过程中仍存在仓库内原有 ESLint warnings，但本次床品配送模块未新增阻塞型构建错误。

### Files / Areas
- `linen delivery records`
- `bed linen stock movement`
- `backend/src/modules/inventory.ts`
- `frontend/src/app/inventory/_components/LinenTransfersView.tsx`
- `docs/execution-records.md`

### Open Issues / Follow-ups
- 当前正式配送单未接入司机、车次、签收、审批等字段，仍按 v1 最小闭环实现。
- 原有 `linen_delivery_plans / linen_delivery_plan_lines` 及配送建议接口仍保留在后端，当前前端页面已不再暴露；后续如需完全收口，可再决定是否清理旧入口或迁移旧数据。
- `frontend/src/app/inventory/_components/LinenTransfersView.tsx` 目前仍有 1 条 `useEffect` 依赖 warning，属于非阻塞问题，后续可顺手收口。

## 床品出库统计改造方案 v3

- Date: 2026-04-08
- Task: 床品出库统计改造方案 v3
- Status: planned

### Confirmed Plan
- 床品分仓库存口径从“配送减清洁任务推算”切换为“最近一次已确认人工盘点值”，清洁任务只保留为辅助统计与异常对账来源。
- 在 `backend/src/modules/inventory.ts` 与对应 migration 中新增正式盘点实体：
- `linen_stocktake_records`
- `linen_stocktake_record_lines`
- 盘点主表至少包含 `warehouse_id`、`delivery_record_id`、`stocktake_date`、`dirty_bag_note`、`note`、`created_by / created_at / updated_at`，盘点明细表至少包含 `record_id`、`room_type_code`、`remaining_sets`。
- 改造 `POST /inventory/linen/delivery-records` 与 `PATCH /inventory/linen/delivery-records/:id`，要求入参新增 `stocktake_lines` 与 `dirty_bag_note`，并在同一事务内创建或替换与配送单绑定的盘点记录。
- 保留配送单的配送明细与库存流水作用，但分仓当前库存不再由配送累计直接决定；作废配送单时不再机械回滚盘点，库存修正必须通过新盘点单覆盖。
- 新增盘点接口：
- `POST /inventory/linen/stocktakes`
- `GET /inventory/linen/stocktakes`
- `GET /inventory/linen/stocktakes/:id`
- 改造 `/inventory/linen/dashboard`，让分仓维度同时返回累计配送、最近盘点值、正式可用套数、最近盘点时间，以及可选的清洁任务理论消耗参考值。
- 改造 `frontend/src/app/inventory/_components/LinenTransfersView.tsx` 为“配送 + 盘点”一体表单：配送明细、送后各房型剩余套数、脏床品袋备注同时提交，并对 `stocktake_lines` 非空、房型唯一、剩余套数非负做前端校验。
- 改造 `frontend/src/app/inventory/_components/LinenStocksDashboard.tsx`，主值显示最近盘点可用套数，辅助显示累计配送、最近盘点时间与“未盘点”状态，清洁任务理论消耗仅做参考提示。
- 继续沿用 `properties.linen_service_warehouse_id` 作为房源默认分仓映射；清洁任务与房源映射仍可参与建议与对账，但不再承担正式库存扣减职责。
- 按以下顺序实施：
- 1. migration 与 schema/helper 落地
- 2. 配送单事务与盘点接口改造
- 3. 看板查询口径改造
- 4. 前端配送页与看板联动改造
- 5. 场景测试与历史数据切换验证

### Implementation Result
- 已基于当前代码现状完成实施方案拆解，并确认本次改造的主要落点集中在：
- `backend/src/modules/inventory.ts`
- `frontend/src/app/inventory/_components/LinenTransfersView.tsx`
- `frontend/src/app/inventory/_components/LinenStocksDashboard.tsx`
- 已确认当前系统现状与本方案存在的关键差异：
- 当前 `/inventory/linen/dashboard` 对分仓 `available_sets_by_room_type` 仍主要取自累计配送结果，不满足“最近盘点值决定库存”的新口径。
- 当前配送单接口仅接受 `lines`，并在创建、编辑、作废时直接正反向调整库存流水，尚未绑定正式盘点实体。
- 当前前端配送页尚未采集 `stocktake_lines`、`dirty_bag_note`，看板也尚未展示 `stocktake_sets_by_room_type`、`last_stocktake_at`、“未盘点”标识等字段。
- 本次尚未开始代码实现；已先把可执行方案记录入仓库，作为后续开发与验收基线。

### Validation
- 已阅读并核对现有床品库存相关实现：
- `backend/src/modules/inventory.ts`
- `frontend/src/app/inventory/_components/LinenTransfersView.tsx`
- `frontend/src/app/inventory/_components/LinenStocksDashboard.tsx`
- 已核对仓库执行记录规范并按模板登记到 `docs/execution-records.md`。
- 本次未执行构建、测试或数据库迁移；当前记录仅对应实施计划确认，不代表功能已上线。

### Files / Areas
- `linen stocktake records`
- `linen delivery records`
- `linen dashboard`
- `linen transfer editor`
- `backend/src/modules/inventory.ts`
- `frontend/src/app/inventory/_components/LinenTransfersView.tsx`
- `frontend/src/app/inventory/_components/LinenStocksDashboard.tsx`
- `docs/execution-records.md`

### Open Issues / Follow-ups
- 需要单独设计 migration 的兼容策略，明确历史分仓库存在“没有盘点记录”时是否统一回落为 `0`，以及是否需要补一批初始化盘点。
- 需要在开发时同步收口现有配送单作废逻辑，避免继续把“回滚配送库存”误当作正式库存回滚。
- 如果后续仍保留配送建议或清洁任务对账提示，需要明确其文案，避免运营把辅助统计误读为正式库存。
- 当前方案默认“每次配送后必须盘点”；若现场存在漏填场景，后续需补充拦截、补录或异常提醒机制。

### Update - 2026-04-08 16:43
- Status: implemented
- Implementation Result:
  - `backend/src/modules/inventory.ts` 已新增正式盘点实体建表逻辑：`linen_stocktake_records`、`linen_stocktake_record_lines`，并补齐索引、配送单唯一绑定约束与盘点明细房型唯一约束。
  - 已新增盘点 helper：盘点明细规范化、配送单详情内联盘点读取、独立盘点详情读取、配送单绑定盘点 upsert。
  - 已新增正式接口：
  - `GET /inventory/linen/stocktakes`
  - `GET /inventory/linen/stocktakes/:id`
  - `POST /inventory/linen/stocktakes`
  - 已改造 `POST /inventory/linen/delivery-records` 与 `PATCH /inventory/linen/delivery-records/:id`，强制接收 `stocktake_lines` 与可选 `dirty_bag_note`，并在同一事务内写入或替换绑定盘点记录。
  - 已改造 `/inventory/linen/dashboard` 返回分仓新口径字段：
  - `delivered_sets_by_room_type`
  - `stocktake_sets_by_room_type`
  - `available_sets_by_room_type`
  - `last_stocktake_at`
  - `has_stocktake`
  - 可选 `task_estimated_consumed_sets_by_room_type`
  - 分仓当前可用套数已切换为“最近盘点值”；未盘点房型默认返回 `0`。
  - 已新增 migration：`backend/scripts/migrations/20260408_inventory_linen_stocktakes_v3.sql`。
  - `frontend/src/app/inventory/_components/LinenTransfersView.tsx` 已改为“配送 + 盘点”一体录入：
  - 新增 `dirty_bag_note`
  - 新增所有启用房型的 `stocktake_lines`
  - 前端拦截重复房型、负数盘点、空盘点
  - 详情弹窗可直接回看本次盘点明细
  - `frontend/src/app/inventory/_components/LinenStocksDashboard.tsx` 已改为主显示最近盘点可用套数，并辅显累计配送、最近盘点值及“未盘点”状态。
- Validation:
  - `backend`: `npm run build` 通过。
  - `frontend`: `npm run build` 通过。
  - 前端构建仍输出仓库内既有 ESLint warnings 与既有图表 SSR warning，本次床品库存改造未新增阻塞型构建错误。
- Open Issues / Follow-ups:
  - 当前配送单作废仍会回滚配送库存流水，但不会删除或回滚历史盘点记录；这与 v3 口径兼容，但后续若要彻底弱化“配送影响库存”的认知，还可以进一步优化作废文案与审计说明。
  - 看板目前将 `task_estimated_consumed_sets_by_room_type` 作为“累计配送 - 最近盘点”的辅助差异字段输出，尚未接入真实清洁任务理论消耗聚合；如果需要精确对账提示，后续还要补清洁任务汇总查询。

### Update - 2026-04-08 16:52
- Status: implemented
- Implementation Result:
  - `/inventory/linen/dashboard` 已接入真实清洁任务辅助对账数据源，不再使用“累计配送 - 盘点”的占位差异值。
  - 后端现按 `cleaning_tasks` 聚合截至当天、未取消的 `checkout_clean` 任务，并通过房源 `linen_service_warehouse_id` 与 `room_type_code` 映射到分仓和房型。
  - 对账口径已处理“盘点后理论消耗”场景：
  - 若分仓已有盘点，统计该分仓最近盘点日期之后的理论消耗套数。
  - 若分仓尚未盘点，回退为历史累计理论消耗套数。
  - `frontend/src/app/inventory/_components/LinenStocksDashboard.tsx` 已展示每个分仓房型的“清洁任务理论消耗”辅助信息，与累计配送和最近盘点并列显示。
- Validation:
  - `backend`: `npm run build` 通过。
  - `frontend`: `npm run build` 通过。
- Open Issues / Follow-ups:
  - 当前理论消耗按 `checkout_clean` 任务数量 = 房型套数消耗 1 次来估算，适合作为运营对账参考；若后续存在多次补换、深清或非标准任务耗用场景，需要再细化任务类型与耗用系数。

## MZ 后台 CRUD 页面规则 Skill 初始化与校验

- Date: 2026-04-09
- Task: MZ 后台 CRUD 页面规则 Skill 初始化与校验
- Status: implemented

### Confirmed Plan
- 在仓库内 `.codex/skills` 下新增独立的 `mz-crud-page-rules` skill，用于约束后续 `frontend/src/app` 下后台 CRUD 页面的统一 UI 与交互规则。
- skill 聚焦后台 CRUD 页的通用规则，不写系统地图，不强制每个页面都包含下载、PDF 或审批类动作。
- 轻量更新 `mz-property-system-map`，让其在“新建或改造后台 CRUD 页面”场景下引用 `mz-crud-page-rules`，保持职责分离。
- 跑正式 skill 校验，确认新 skill 和更新后的 map skill 均有效。

### Implementation Result
- 已创建 `.codex/skills/mz-crud-page-rules/` 目录。
- 已完成 `.codex/skills/mz-crud-page-rules/SKILL.md`，明确后台 CRUD 页面通用规则，包括：
- 单页列表 + 主操作优先，避免无意义 tabs
- 详情默认右侧 `Drawer`
- 编辑默认右侧 `Drawer`
- 新增优先复用编辑表单容器
- 行操作默认顺序 `详情 / 编辑 / 删除`
- 表单重复提交拦截与后端事务真实回滚
- 明细行优先使用紧凑表格式录入
- 业务编号优先使用可读单号，不直接暴露 UUID
- 列表、详情、导出中的金额与编号格式保持一致
- 下载、PDF、审批、作废等特殊动作仅在业务需要时加入，不作为 CRUD 页必备项
- 已完成 `.codex/skills/mz-crud-page-rules/agents/openai.yaml`，补齐 skill 列表显示名称、短描述与默认 prompt。
- 已更新 `.codex/skills/mz-property-system-map/SKILL.md`，增加“新建或改造后台 CRUD 页面时读取 `$mz-crud-page-rules`”的引用说明。

### Validation
- `python3 /Users/zhishi/.codex/skills/.system/skill-creator/scripts/quick_validate.py '.codex/skills/mz-crud-page-rules'` 通过，结果为 `Skill is valid!`。
- `python3 /Users/zhishi/.codex/skills/.system/skill-creator/scripts/quick_validate.py '.codex/skills/mz-property-system-map'` 通过，结果为 `Skill is valid!`。
- 手工检查已确认新 skill 的职责边界与 `mz-property-system-map` 区分清晰，未把 CRUD 页面规范硬塞进系统地图 skill。

### Files / Areas
- `.codex/skills/mz-crud-page-rules/SKILL.md`
- `.codex/skills/mz-crud-page-rules/agents/openai.yaml`
- `.codex/skills/mz-property-system-map/SKILL.md`
- `docs/execution-records.md`

### Open Issues / Follow-ups
- 当前新 skill 已覆盖后台 CRUD 页面通用规则，但尚未把具体模块示例拆到 `references/`；如果后续规则继续增多，可再按 inventory / finance 等场景补充细分参考文档。
- 后续新增后台 CRUD 页面时，需要在实际开发流程中显式使用该 skill，才能持续保持一致性。

## 晚退收入 SQL 回填

- Date: 2026-06-06
- Task: 晚退收入 SQL 回填
- Status: implemented

### Confirmed Plan
- 只读取 `late check out.xlsx` 当前可见的 458 条记录，隐藏行全部排除。
- 使用第一份 CSV 的 83 个唯一确认码作为排除清单；其中 58 个与 Excel 可见行重合。
- 最终回填来源固定为 400 个唯一确认码，金额合计 AUD 7,999.97。
- 按确认码精确匹配订单；订单缺失、匹配歧义、退房日期缺失或已有晚退收入时跳过并报告。
- 同时创建订单关联的 `finance_transactions` 晚退收入和 `company_incomes` 公司收入，不修改房东租金字段。
- 先提供只读预览 SQL，再提供事务化正式 SQL。

### Implementation Result
- 已生成 `late_checkout_income_2026_01_05_preview.sql`，执行后固定 `ROLLBACK`。
- 已生成 `late_checkout_income_2026_01_05_apply.sql`，包含来源硬校验、advisory lock、双表写入、镜像金额校验、审计日志和最终结果报告。
- 已补充 Neon SQL Editor 专用紧凑版本，将完整可执行 SQL 压缩为单行，避免复制预览内容时在第 100 行截断。
- 正式 SQL 使用确定性批次 ID，并在写入前检查已有订单关联晚退记录。
- 已增加操作说明，明确 Neon SQL Editor 中的预览和正式执行顺序。
- 未连接或修改正式数据库；本次完成的是可执行 SQL 产物。

### Validation
- 两份 SQL 均包含 400 个来源元组，金额均为 AUD 7,999.97。
- 来源确认码无重复，所有候选金额均为正数。
- 预览 SQL 以 `ROLLBACK` 结束，正式 SQL 以 `COMMIT` 结束。
- 静态检查确认两份 SQL 均不包含对 `orders` 表的写操作。
- 当前机器没有本地 PostgreSQL/`psql` 运行环境，因此未执行数据库级语法和事务测试。

### Files / Areas
- `backend/scripts/backfills/late_checkout_income_2026_01_05_preview.sql`
- `backend/scripts/backfills/late_checkout_income_2026_01_05_apply.sql`
- `backend/scripts/backfills/late_checkout_income_2026_01_05_preview_neon.sql`
- `backend/scripts/backfills/late_checkout_income_2026_01_05_apply_neon.sql`
- `backend/scripts/backfills/late_checkout_income_2026_01_05_README.md`
- `docs/execution-records.md`

### Open Issues / Follow-ups
- 必须先在正式 Neon SQL Editor 执行预览 SQL，并人工核对 `ready`、`missing_order`、`ambiguous_order` 和已有收入分类。
- 正式执行结果中的 `inserted_finance_count` 与 `inserted_company_count`、两侧金额必须一致。

## 自完成挂钥匙视频弱网同步与检查前置隔离

- Date: 2026-07-29
- Task: 自完成上传挂钥匙视频显示上传状态，支持弱网/重进恢复，并修复被普通检查前置错误阻断的问题。
- Status: implemented

### Confirmed Plan

- 复用检查人员现有 `inspectionMediaQueue`，不新建并行的视频同步系统。
- 将视频文件上传与任务业务保存拆分；保存成功前保留本地文件和远端 URL，重进/重试不重复上传已确认媒体。
- 将自完成视频与普通检查的权限和前置条件分开；保持普通检查和 password-only 既有规则。
- 覆盖移动端队列/页面状态和后端状态流转/路由契约，再执行类型与静态检查。

### Implementation Result

- 自完成页的视频拍摄改为入本机队列，进入页面和点击重试时复用同一个单 worker 恢复上传及任务记录保存。
- 页面显示未上传、待同步、上传中、等待保存、保存失败、需重拍和已同步；视频 URL 已上传但业务保存失败不会误显示完成。
- `self_complete_lockbox` 仅由后端按任务模式生成，用于跳过普通检查提交/检查照片前置；最终自完成接口的自身视频、完成照片和补品门槛未放宽。
- 两条视频保存路由将动作审计、媒体记录和上传时间放到同一事务，避免只写入部分状态。

### Validation

- `npm run test -- --runInBand --no-cache src/lib/inspectionMediaQueue.test.ts src/screens/tasks/CleaningSelfCompleteScreen.test.tsx`（mobile）通过：2 suites / 14 tests。
- `npm run test:cleaning-task-transition-guard`、`npm run test:idempotency-submit-id-contract`（backend）通过。
- mobile 的 `npm run typecheck`、`npm run lint`、`npm run check:buttons` 通过；lint 为 0 error / 111 条既有 warning。
- backend 的 `./node_modules/.bin/tsc -p . --noEmit` 通过；未运行会覆盖并发 `backend/dist` 的构建命令。
- `python3 scripts/audit_change_release_ledger.py`、`python3 scripts/audit_feature_regression_registry.py` 与 root/mobile 的 `git diff --check` 通过。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tasks/CleaningSelfCompleteScreen.tsx`
- `mz-cleaning-app-frontend/src/lib/inspectionMediaQueue.ts`
- `backend/src/modules/cleaning_app.ts`
- `backend/src/modules/mzapp.ts`
- `backend/src/lib/workTaskActionAudit.ts`

### Open Issues / Follow-ups

- 未做 Android/iOS 真机、EAS 构建、真实弱网与真实对象存储/接口验证；上线前建议用自完成周转任务实测“断网拍摄 → 重进 → 联网 → 仅业务保存重试”。

## Airbnb 邮件订单缺失年份跨年解析与受控修复

- Date: 2026-08-16
- Task: 修复 Airbnb 邮件在日期文本不带年份时，把次年预订写成邮件当年的问题；提供历史数据的受控修复工具。
- Status: partially implemented

### Confirmed Plan

- 只改后端 Airbnb 邮件日期解析、对应回归测试、历史数据受控工具和必要的防复发文档；不改管理端页面的日期渲染。
- 以 `Australia/Melbourne` 邮件头日历日为基准：无年份日期严格早于邮件当天时取下一年；显式四位年份优先；无效日期拒绝。
- 历史修复默认只读。任何写入都须固定候选数、确认住晚一致性/任务锁定/日期冲突，并只更新订单后投递现有清洁同步队列。

### Implementation Result

- 替换月份差值猜测为日期级、时区固定的解析函数，并让 HTML 解析同时接受可选的显式年份。
- 缺失年份的成功解析会标记 `year_inferred=true`，保留既有原始日期文本字段用于追踪。
- 月份猜测型旧修复脚本已 fail-closed；新增的受控工具默认 `BEGIN TRANSACTION READ ONLY`，应用模式还要求明确环境确认、精确候选数和清洁队列确认参数。
- 生产只读预检识别到 20 笔高置信候选；住晚异常、闰日滚动异常、已锁任务和目标日期冲突均为 0。未输出客户、确认码或连接信息，也未写生产数据。

### Validation

- Clean-candidate validation pending.

### Files / Areas

- `backend/src/modules/jobs.ts`
- `backend/scripts/test_email_year_rule.ts`
- `backend/scripts/test_infer_year.ts`
- `backend/scripts/repair_airbnb_email_year_rollover.ts`
- `backend/scripts/fix_email_year_v3.ts`
- `backend/scripts/fix_email_orders_year_v2.ts`
- `docs/feature-regression-registry.md`
- `docs/change-release-ledger.md`
- `docs/execution-records.md`

### Open Issues / Follow-ups

- 生产数据修复只可在部署后重新只读预检、用户明确批准精确写入动作，并复核 20 个同步任务队列全部完成后执行。

### Update - 2026-08-16 23:16 AEST

- Status: partially implemented
- Implementation Result:
  - Clean candidate created from `origin/Dev@9a5149166ac5c372383a76ca2800b4d54679650d`; no mixed-worktree files were selected.
- Validation:
  - Date regressions, legacy helper check, repair-tool help, no-emit TypeScript, redirected backend build, Registry audit, Ledger audit, diff check and production read-only preflight passed.
  - The candidate has not been independently reviewed, committed, pushed, deployed, or applied to production data.
- Open Issues / Follow-ups:
  - Complete the independent release review and exact staged-scope audit before a content commit.

## Airbnb 邮件订单入住日期漏解析修复

- Date: 2026-08-20
- Task: Airbnb 邮件订单入住日期漏解析修复
- Status: partially implemented

### Confirmed Plan

- 先修复后端 Airbnb 邮件解析器并补回归测试，防止新的缺入住/退房订单进入 `confirmed`。
- 保持邮件导入运行；不重跑旧邮件同步、不改生产订单、不直接改 `cleaning_tasks`，也不投递生产清洁同步队列。
- 代码发布后才进行 77 笔历史订单的只读预演、队列能力补强和经单独授权的数据修复。

### Implementation Result

- 日期解析改为优先读取实际订单日期卡片；当页面较早出现不含日期的 `Check-in details` 时，继续遍历后续候选标签。
- 只有唯一、入住早于退房且与已解析住晚一致的日期组合才会同时作为订单入住/退房日期；重复的相同日期标签保持幂等。
- 缺入住、缺退房、日期非法或住晚冲突会在写订单前返回稳定错误码，并由既有 `email_sync_items` 失败审计记录，不会创建 `confirmed` 订单或清洁同步任务。

### Validation

- 待执行：`npm run test:email-year-rule --prefix backend`、后端 TypeScript 编译、feature registry/ledger audit 与 diff 检查。
- 未执行：部署、生产邮件导入、生产数据库写入、清洁队列投递和历史 77 笔修复。

### Files / Areas

- `backend/src/modules/jobs.ts`
- `backend/scripts/test_email_year_rule.ts`
- `docs/feature-regression-registry.md`
- `docs/change-release-ledger.md`
- `docs/execution-records.md`

### Open Issues / Follow-ups

- 本地验证和独立发布审查通过后，仍需用户分别授权提交、推送/合并、部署及生产历史数据修复。
- 历史修复前必须完成 77 笔只读预演，并先补齐只影响入住任务、不会覆盖已指派/人工任务的队列处理边界。

### Update - 2026-08-20 00:17 AEST

- Status: partially implemented
- Implementation Result:
  - 后端解析器与写入前日期校验已在干净候选工作区完成；没有执行任何生产写入、队列投递或旧邮件重跑。
- Validation:
  - 日期规则/日期卡片回归和既有邮件金额解析回归通过；后端 no-emit TypeScript 编译、feature registry audit、ledger audit 和 diff 检查通过。
  - 初始直接编译因干净工作区没有依赖目录而无法解析依赖；随后只读复用既有本地依赖完成编译，未安装任何包。
- Open Issues / Follow-ups:
  - 仍需独立只读发布审查和用户对提交、推送/合并及部署的逐项授权；部署后才能进入 77 笔只读预演和后续历史修复。

## Release Attempt 依赖 SHA 门禁

- Date: 2026-08-25
- Task: 根仓库与移动端 Release Attempt 依赖证据硬化
- Status: implemented locally; not released

### Confirmed Plan

- 在各自基于最新 `origin/Dev` 的干净候选 worktree 实施，保留原开发 worktree 的所有未提交内容。
- 将同仓库依赖收紧为可解析的完整 SHA，并同时验证真实 CRL、该 CRL 的已记录内容提交及候选 `head` 祖先关系。
- 对跨仓库依赖 fail-closed：自由文本 `PASS` 不可单独作为证明，必须通过配对仓库的独立精确核验。

### Implementation Result

- Root 与 mobile 的 `scripts/audit_change_release_ledger.py` 都新增 canonical dependency reference 解析和门禁：`none`，或 `root|mobile/CRL-YYYYMMDD-NNN@<40-character commit SHA>`。
- 初始独立审查发现 P1：不存在的 CRL 或任意祖先 SHA 仍可能被错误放行；已在 root/mobile 同步修复为 CRL 存在、内容提交绑定和 ancestry 三项均必需。
- 同仓库依赖不可解析、不存在、未绑定到声明 CRL 的已记录内容提交，或不在精确 `base...head` 祖先链时均为 `BLOCKED`；跨仓库自由文本一律不能将报告提升到 GO。
- 两个仓库分别登记 `root/CRL-20260825-001` 与 `mobile/CRL-20260825-001`；编号相同但仓库身份独立。

### Validation

- Root: `PYTHONDONTWRITEBYTECODE=1 python3 scripts/tests/test_audit_change_release_ledger.py` — passed, 31 tests.
- Mobile: `PYTHONDONTWRITEBYTECODE=1 python3 scripts/tests/test_audit_change_release_ledger.py` — passed, 31 tests.
- 初始独立审查为 NO-GO（仅 commit）：发现并阻断上述 P1；修复后仍需重跑提交前门禁与独立审查。已暂存候选范围，但尚未提交、推送、创建 PR、合并、部署、OTA 或进行设备/生产验证。

### Files / Areas

- `scripts/audit_change_release_ledger.py` in root and mobile.
- `scripts/tests/test_audit_change_release_ledger.py` in root and mobile.
- `docs/change-release-ledger.md` in root and mobile.
- `docs/execution-records.md` in root.

### Open Issues / Follow-ups

- Historical Release Attempts with free-form dependency prose require a new evidence receipt before a future exact release report can give GO；现有自由文本会被精确审计判为 BLOCKED；no historical CRL identity was modified here.
- Commit, push, PR/merge, deployment/OTA and device/production proof remain separate authorizations and evidence gates.

## 费用结算阶段 5

- Date: 2026-09-11
- Task: 费用结算阶段 5
- Status: implemented and integrated in fixed Preview; not released

### Confirmed Plan

- 每周结束后，按 Australia/Melbourne 周期自动生成上一完整周的人员结算草稿，并保留手工执行入口。
- 发起确认前锁定并校验工作量；只通知结算本人确认“工作量及金额正确”。
- 待确认阶段显示结算草稿；确认后按 GST 状态生成 `Tax Invoice` 或普通 `Invoice`，财务批准和付款后保留对应历史版本。
- 继续复用阶段 3 的公司费用和线下转账登记，不连接银行 API。

### Implementation Result

- 新增 Phase 5 migration、独立 readiness、事务级数据库 advisory lock、周任务运行记录、幂等人工/定时入口和默认关闭的周一 00:05 scheduler。
- 新增精确本人通知、稳定去重键和移动端费用结算跳转；不通过角色或群组扩大收件人。
- 新增私有 A4 PDF、认证下载和不可变状态版本；待确认文件不是税务发票，GST 未注册文件 GST 为 0，财务调整作为 GST 外明细显示，不包含银行账号或对象 key。
- 网页增加手工运行、运行历史和文件历史；移动端增加认证下载与系统查看/分享。

### Validation

- 后端 TypeScript、Phase 1–5 合同和 isolated build 通过。
- synthetic PDF 生成、`pdfinfo` 和人工视觉检查通过；单页 A4，无 JavaScript，内容无裁切。
- 网页 TypeScript、focused tests、full Vitest 51 files / 230 tests、lint 和 isolated Next build 通过；移动端 TypeScript、focused Jest、full Jest 62 suites / 352 tests、strict button audit、lint 和 iOS Expo export 通过。
- 固定 Preview 开发数据库身份闸门通过，已按用户明确授权执行 `20260911_personnel_settlement_phase5.sql`；marker、文件表和 job run 表 readiness 通过。
- 合成集成通过：2 人结算、2 条本人 Inbox/Queue 通知、pending claim 门禁、幂等重跑、事务锁 `skipped`、GST/非 GST、8 个不可变文件版本、owner/admin 文件下载、non-owner 404、银行权限脱敏、2 条已付款公司费用；合成数据、会话和私有源文件已清理且零计数复核通过。
- port 3000 真实 Chromium 页面通过：现有后台 Card/Tabs/Table 风格、两名人员金额/状态和 `partial/succeeded/skipped` 运行历史正确，无费用结算 HTTP 错误。最终 Tax Invoice 为单页 A4、无 JavaScript/加密/裁切。
- 本轮后端 no-emit TypeScript、Phase 1–5 合同和隔离构建通过；网页 TypeScript、3 files / 7 tests 和 lint 通过；移动端 TypeScript、62 suites / 352 tests 和 strict button audit 通过。

### Files / Areas

- `backend/src/lib/personnelSettlementWeeklyJob.ts`
- `backend/scripts/tests/test_personnel_settlement_phase5_integration.ts`
- `backend/scripts/tests/test_personnel_settlement_phase5.ts`
- `backend/package.json`
- `backend/src/lib/personnelSettlementDocuments.ts`
- `backend/src/lib/personnelSettlementDocumentTemplate.ts`
- `backend/src/lib/personnelSettlementWorkflow.ts`
- `backend/src/modules/personnel_settlements.ts`
- `frontend/src/app/finance/settlements/WeeklySettlementsPanel.tsx`
- `docs/notification-registry.yaml`
- paired mobile settlement screen, notice navigation and API client

### Open Issues / Follow-ups

- scheduler 仍默认关闭；任何目标环境启用前仍需 migration marker、部署配置和运行日志证据。
- R2、真实 push、真机 PDF Share、生产 migration/data、commit/push/PR/merge/deployment/OTA 未执行，分别需要后续证据和授权。
- `invoice_companies` 默认记录上线前需由财务确认是 Homixa 的正确法定名称、ABN 和地址。

## 费用结算阶段 6：清洁按房型计价

- Date: 2026-09-11
- Task: 将清洁人员费用从统一任务单价改为六档房型单价
- Status: source implemented and locally regressed in fixed Preview; not released

### Confirmed Plan

- 清洁规则固定使用 `一房一卫`、`两房一卫`、`两房两卫`、`三房两卫`、`三房三卫`、`4房3.5卫` 六种房型，每位清洁人员必须完整填写六档单价。
- 周结算通过 `cleaning_tasks.property_id -> properties.type` 精确匹配房型；旧统一清洁单价不再作为新结算回退值。
- 房型缺失、超出支持范围或缺少对应单价时阻止该人员自动生成并交由财务人工复核；已锁定历史结算保持不变。
- 复用现有规则明细 `conditions` JSONB，不新增 migration 或平行表结构。

### Implementation Result

- 后端建立唯一六档房型合同，规则保存校验完整性、唯一性和合法范围，并为六档生成互不冲突的稳定优先级；历史规则查询和写入保留房型条件。
- 预览从房源读取 `properties.type`，只允许清洁规则按精确房型命中；缺房型、未知房型和缺价格生成明确人工复核代码，不采用旧统一单价。
- 周结算计算快照保存房型；手工/自动生成将上述异常带入批次或任务运行结果，避免页面显示成功但遗漏人员。
- 网页费用规则抽屉改为紧凑表格，清洁人员直接显示六档房型与单价；旧统一单价只作提示参考，不能自动复制或继续参与计算。周结算页面显示需财务处理的人员与原因。
- 已有 Phase 3/5 合成集成 fixture 同步为六档规则和明确房型，保持后续获授权的数据库集成测试可运行。

### Validation

- 后端 no-emit TypeScript、Phase 1–5 合同测试和隔离 production build 通过。
- 网页 no-emit TypeScript、费用规则/Phase 5 focused tests、完整 Vitest（51 files / 233 tests）、lint 和隔离 Next production build 通过；lint 仅有现有非本功能 warning。
- 固定 Preview 端口 3000/4002 的进程目录、网页 200、backend readiness 200 和无认证 API 401 边界通过。
- 使用现有登录 Chrome 会话只读确认：费用规则抽屉按“计算方式 / 房型 / 单价”显示六行，最高为 `4房3.5卫`；没有点击保存、没有数据库写入。控制台没有本功能运行错误，仅见浏览器扩展 hydration 属性提示和现有 Ant Design `addonAfter` 弃用警告。
- 未执行数据库集成或真实生成：本轮没有获授权写固定 Preview 开发数据库；也未执行生产数据、通知、PDF、付款或 scheduler。

### Files / Areas

- `backend/src/lib/personnelSettlement.ts`
- `backend/src/lib/personnelSettlementRules.ts`
- `backend/src/lib/personnelSettlementPreview.ts`
- `backend/src/lib/personnelSettlementWorkflow.ts`
- `backend/src/lib/personnelSettlementWeeklyJob.ts`
- `backend/src/modules/personnel_settlements.ts`
- `backend/scripts/tests/test_personnel_settlement_phase1.ts`
- `backend/scripts/tests/test_personnel_settlement_phase2.ts`
- `backend/scripts/tests/test_personnel_settlement_phase3_integration.ts`
- `backend/scripts/tests/test_personnel_settlement_phase5_integration.ts`
- `frontend/src/app/finance/settlements/FeeRuleDrawer.tsx`
- `frontend/src/app/finance/settlements/feeRuleUi.ts`
- `frontend/src/app/finance/settlements/feeRuleUi.test.ts`
- `frontend/src/app/finance/settlements/WeeklySettlementsPanel.tsx`
- `docs/feature-regression-registry.md`
- `docs/change-release-ledger.md`
- `docs/execution-records.md`

### Open Issues / Follow-ups

- 财务需要先为每位清洁人员填写并保存全部六档单价；在此之前，该人员的新周结算会进入人工复核，这是有意的 fail-closed 行为。
- 固定 Preview 开发数据库的真实规则保存、房型任务生成和异常运行记录仍需另行授权写入后再做集成验证；本轮只完成源码、自动化与登录页面只读验证。
- Commit、push、PR/merge、deployment、production migration/data 和设备/生产验证均未执行，需要后续分别授权。

### Update - 2026-09-11 14:01

- Status: implemented
- Implementation Result:
  - 确认 `invalid_abn` 来自后端澳洲 ABN 11 位校验和验证；网页原先只检查位数，因此错误显示过晚且暴露技术码。
  - 网页新增同口径提交前校验和中文错误映射，并说明系统会自动验证 ABN。
  - 将两个容易混淆的“生效日期”分别改为“结算资料生效日期”和“费用规则生效日期”，并显示各自影响范围；“修改原因”同步明确为“资料修改原因”。
- Validation:
  - frontend no-emit TypeScript passed；focused Vitest 2 files / 9 tests and full Vitest 52 files / 236 tests with coverage thresholds passed；frontend lint passed with unrelated existing warnings。
  - `npm run check:fast` passed workflow/ledger tests, Preview guard, audits, backend build and backend contracts until the pre-existing Phase 5 release contract looked for a mobile subdirectory that does not exist in the fixed Preview root/sibling-mobile topology；the frontend checks it had not reached were run separately and passed。
  - 固定 Preview 管理员页面只读验证通过：两类日期名称和说明正确；合成无效 ABN 在本地显示中文错误，随后取消表单，未保存或写数据库。
- Open Issues / Follow-ups:
  - 已有不符合校验和的开发测试 ABN 在下一次编辑时仍会被阻止；需要测试人员使用有效 ABN，后端校验不会放宽。
  - 本次没有执行资料保存、开发/生产数据库写入、commit、push、PR、merge 或部署。
## 费用结算供应方发票按日期汇总

- Date: 2026-09-11
- Task: 将费用结算 PDF 改为正式发票三列布局并按日期汇总
- Status: source implemented and visually regressed in fixed Preview; not released

### Confirmed Plan

- 保留既有 Draft / Tax Invoice / Invoice、双方资料、服务期间及周 Subtotal/GST/Total。
- 主表只显示 Date、Description、Total；一个完整周按周一至周日最多七行。
- 同日清洁显示 `Cleaning - 房号 / 房号`，补贴、加班、仓管、上新房、试工、编外或其他工作追加在当天 Description；右侧显示当天所有项目总价。
- 不改费用计算、GST、数据库、付款、通知、网页/移动端下载入口或历史结算锁定逻辑。

### Implementation Result

- 后端模板新增纯内存日期汇总，同日清洁房号取自已锁定 `calculation_snapshot.property_label`，不读取可变化的当前房源名称；其他类型保留类型标签和申报说明。
- 逐项数量、单价、房型、税额和来源继续存在 `personnel_settlement_lines` 与 API；PDF 仅改展示密度。
- PDF 来源哈希加入模板版本，使旧 PDF 不被覆盖，新生成文件使用新布局并继续保持不可变版本历史。
- 财务调整合并到周日 Description 和当日总额，但仍保持 GST 为 0。

### Validation

- Phase 5 backend contract passed；Backend TypeScript no-emit passed。
- Phase 1–4 backend contracts and isolated backend production build passed；build output written outside the repository。
- 使用 20 条虚构清洁/补贴/仓管/加班/上新房/试工/其他行生成真实 PDF，成功汇总为 7 个日期。
- PDF 为 A4 单页、无 JavaScript、未加密；文本检查确认三列表头、7 行、所有混合类型、周总额 `$1,126.00`，且没有页面外文字。
- PNG 视觉检查确认表格、周总额与页脚均完整，无裁切。
- Fixed Preview backend remained ready on port 4002 from the registered root backend directory；Feature Registry passed 25 FRs / 196 mappings and Root ledger audit passed 57/57。
- Tracked and directly changed untracked source/test whitespace checks passed；no generated build output was added to the repository。

### Files / Areas

- `backend/src/lib/personnelSettlementDocumentTemplate.ts`
- `backend/src/lib/personnelSettlementDocuments.ts`
- `backend/scripts/tests/test_personnel_settlement_phase5.ts`
- `docs/feature-regression-registry.md`
- `docs/change-release-ledger.md`
- `docs/execution-records.md`

### Open Issues / Follow-ups

- 已存在的旧格式文档按不可变历史保留；需由既有生成入口创建新版本后，移动端才能看到新布局。
- 未执行数据库写入、真实人员结算再生成、真机查看/分享、commit、push、PR、merge、deployment 或 production verification。

### Update - 2026-09-11 20:30 Australia/Melbourne

- Status: fixed Preview development data regenerated and cross-client integration passed; not released
- Implementation Result:
  - 盘点固定 Preview 开发库的全部 3 笔周结算，仅 1 笔处于允许生成文件的 `awaiting_confirmation`；为该笔新增不可变 `v2`，保留旧 `v1`，两笔 `draft` 未改状态。
  - 调整 Phase 5 浏览器集成测试，使其与当前 Ant Design 只读周选择器一致；不再用程序直接填写只读输入，也不再要求当前周页面显示 2010 年隔离运行记录。
  - 固定 Preview 的网页、后端和移动端服务已通过统一启动器恢复至 3000、4002 和 8081。
- Validation:
  - Phase 5 contract、backend TypeScript、mobile focused Jest 2/2、mobile TypeScript 均通过。
  - Phase 5 database/web/API/PDF integration passed：2 个虚拟供应方、GST/非 GST、4 个文档阶段、8 份 PDF、通知、权限、付款费用和自动清理全部验证。
  - 实际开发 `v2` 与隔离 Tax Invoice 均经 pdfplumber 结构检查和 PNG 视觉检查：A4 单页、三列、无 Qty/Rate、无页面外内容；实际 `v2` 同日两个房源合并为一个 Cleaning 行。
  - 结尾只读核对：真实开发结算仍为 3 笔，最新文档版本顺序 `[2,1]`；隔离 users、batches、notifications 和 queue 全部为 0。
- Open Issues / Follow-ups:
  - 移动端需要关闭当前详情再重新打开（必要时在列表刷新），才能重新请求后端并显示最新 `v2`；尚未执行真机点击查看/分享验证。
  - 未 commit、push、创建 PR、merge、部署或发布 OTA；生产环境未访问、未写入。

### Update - 2026-09-11 20:37 Australia/Melbourne

- Status: implemented
- Implementation Result:
  - 按用户要求仅在 fixed Preview 开发环境删除旧文档版本；未改变正式环境不可变文件历史规则。
  - 删除 `2026-08-17 至 2026-08-23` 的旧 `awaiting_confirmation v1` 数据库记录及对应本地私有 PDF，保留最新 `v2`。
- Validation:
  - 删除前重新通过 `npm run dev:preview:verify-db` 确认 `app=dev`、`database=dev`。
  - 删除前确认目标数为 1、不是当前 `invoice_media_id`、本地文件名符合安全白名单且文件存在。
  - 删除后只读核对该结算 `document_count=1`、`versions=[2]`、唯一文档为当前引用，本地目录也只剩 1 个费用结算 PDF。
  - Metro reload 后移动端本人结算列表、详情和保留 PDF 请求均返回 200。
- Open Issues / Follow-ups:
  - 删除的开发 `v1` 不可从当前 Preview 恢复；本次未删除或修改任何生产文件。
  - 正式环境是否也改为只保留最新文件仍未决定；当前生产级源码规则保持不可变历史。

## 费用结算异议财务闭环

- Date: 2026-09-12
- Task: 财务或管理人员直接确认原金额或编辑总额，处理人员提出的周结算异议
- Status: source implemented and database-integrated in fixed Preview; not released

### Confirmed Plan

- “有异议”不再要求财务填写处理结果；财务端只提供“确认原金额”和“编辑金额”两种处理方式。
- 两种处理都自动记录操作人、处理时间和处理前后金额，并把结算重新发给本人确认“工作量及金额正确”。
- 编辑金额时只填写调整后的应付总额；财务调整保持 GST 外金额，不重算已经锁定的 GST 明细。
- 自动生成该确认轮次的新版待确认 PDF，并向结算本人发送新一轮通知；同一轮重试不得重复通知或重复文件。
- 复用现有结算表、规则快照、审计、文档和通知系统，不新增 migration，不改移动端源码，不触碰生产数据或真实转账。

### Implementation Result

- 后端新增 `resolve_dispute` 状态动作和受 `personnel_settlements.rules.manage` 或 `finance.payout` 保护的处理接口；只有 `disputed` 状态可首次处理。
- “确认原金额”保留当前总额；“编辑金额”按输入的最终总额计算财务调整，保持原锁定 GST，最终总额不能低于 GST。
- 处理、金额更新、异议清除、确认轮次快照和审计在同一数据库事务与行锁中完成；完成后状态回到 `awaiting_confirmation`。
- 初次确认与异议处理后的再次确认共用一个服务端通知/文件发布入口。事件去重键加入确认轮次版本；同一请求重试复用版本，新的异议处理轮次使用新版本。
- 网页周结算表的异议行显示“处理异议”，弹窗展示人员原始异议、当前总额和两种处理按钮；没有财务处理说明字段。成功后自动刷新列表并提示已重新发起个人确认。
- 移动端继续使用既有本人结算、PDF 和通知入口，不需要客户端改动即可读取新金额、新文件和新一轮确认状态。

### Validation

- Backend Phase 3 contract passed：状态机、管理/财务权限、确认原金额、编辑总额及 GST 下限覆盖。
- Backend Phase 3 fixed Preview integration passed：合成异议经财务编辑金额后重新确认，并继续完成公司费用与付款闭环；测试数据精确清理。
- Backend Phase 5 contract passed：确认轮次事件键、唯一收件人、统一文件/通知发布入口覆盖。
- Backend Phase 5 fixed Preview database/API/PDF/notification integration passed：GST 人员经历初次确认、提出异议、编辑到 AUD 115.00、重试、再次确认；生成两轮待确认文件且每轮只产生一份本人通知/queue，最终完整完成财务批准和付款。两人共 9 份状态文件、3 轮通知、2 条付款费用，测试清理断言通过。
- Backend TypeScript no-emit passed；frontend focused Vitest 2 files / 6 tests passed；费用结算相关 ESLint passed。
- Backend isolated production build passed；frontend full Vitest 52 files / 237 tests and isolated production build passed，费用结算路由成功生成。构建只报告仓库既有跨页面 lint、chart SSR 与 Browserslist warnings。
- Existing backend notification policy、Phase 1/2/4 settlement contracts and paired mobile notification focused Jest passed。
- Fixed Preview 开发数据库身份闸门 passed；没有执行 migration、生产数据写入、真实推送或银行调用。
- Fixed Preview web `3000`、backend `4002` 和 Metro `8081` 健康检查通过；Feature Registry 25 FRs / 197 mappings、Root ledger 58/58 paths、tracked `git diff --check` 与 9 个本候选 untracked 文件的逐项 whitespace check 均通过。隔离构建及集成生成的临时文件已清理。

### Files / Areas

- `backend/src/lib/personnelSettlementWorkflow.ts`
- `backend/src/modules/personnel_settlements.ts`
- `backend/scripts/tests/test_personnel_settlement_phase3.ts`
- `backend/scripts/tests/test_personnel_settlement_phase3_integration.ts`
- `backend/scripts/tests/test_personnel_settlement_phase5.ts`
- `backend/scripts/tests/test_personnel_settlement_phase5_integration.ts`
- `frontend/src/app/finance/settlements/WeeklySettlementsPanel.tsx`
- `frontend/src/app/finance/settlements/settlementWorkflowUi.ts`
- `docs/notification-registry.yaml`
- `docs/feature-regression-registry.md`
- `docs/change-release-ledger.md`
- `docs/execution-records.md`

### Open Issues / Follow-ups

- 当前证据证明源码和固定 Preview 合成闭环通过；尚未在用户当前那条真实开发异议上点击“确认原金额”或“编辑金额”，避免未经明确选择改动其金额和状态。
- Commit、push、PR/merge、backend deployment、production verification 和移动端真机验证均未执行；需要分别授权和证据。

## 移动端费用结算周提交预览容错修复

- Date: 2026-09-24
- Task: 移动端费用结算周提交预览容错修复
- Status: implemented

### Confirmed Plan

- 周提交预览 GET 兼容 React Native 自动附加的受限 `_` 缓存参数。
- 周提交 POST 保持独立严格 Body Schema，只接受 `week_start`。
- 配套移动端将预览失败与工作量/结算列表解耦，并提供局部手动重试。

### Implementation Result

- 新增 `myWeeklySubmissionQuerySchema` 和 `myWeeklySubmissionBodySchema`，分别用于预览 GET 与本人提交 POST。
- GET 继续 strict 校验，仅额外接受受长度/数量限制的 `_`；POST 明确拒绝 `_` 和其他未知字段。
- 未改变认证、本人范围、金额计算、数据库或结算状态机。

### Validation

- Phase 3 contract passed；覆盖 GET `_`、未知查询字段拒绝和 POST Body 拒绝 `_`。
- Backend TypeScript no-emit 与隔离生产 emit passed。
- Feature Registry audit passed：25 FRs / 203 mappings；paired mobile focused/full Jest、TypeScript、lint 与按钮审计 passed。
- Root ledger audit 已覆盖本任务路径，但整个混合工作区仍因 3 个先前未归属 `backend/dist` 文件为 78/81；tracked diff whitespace check passed。
- 未调用真实 API、数据库、通知、付款、模拟器、真机或生产环境。

### Files / Areas

- `backend/src/modules/personnel_settlements.ts`
- `backend/scripts/tests/test_personnel_settlement_phase3.ts`
- `docs/feature-regression-registry.md`
- `docs/change-release-ledger.md`

### Open Issues / Follow-ups

- 仍需后续获授权后在干净 `origin/Dev` 候选中选择 `root/CRL-20260924-001` 与 `mobile/CRL-20260924-001` 进行提交准备。
- 未 commit、push、PR、merge、deploy、OTA 或 production/device verification。
