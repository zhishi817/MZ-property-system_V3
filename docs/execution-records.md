# Execution Records

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
