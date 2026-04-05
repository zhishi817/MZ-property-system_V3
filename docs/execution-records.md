# Execution Records

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
