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
