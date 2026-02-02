# 发票模板系统（A4/打印/PDF）

## 目标
- A4 纸张精确排版：210mm × 297mm
- 页边距：上下左右各 20mm
- 模板化：支持多套样式（classic/modern）
- 支持预览、打印（@media print）、导出 PDF（html2canvas + jsPDF）

## 目录结构
- 静态模板运行时（HTML/CSS/JS）
  - `public/invoice-templates/template.html`
  - `public/invoice-templates/invoice-template.css`
  - `public/invoice-templates/invoice-template.js`
- React 侧预览页（模板选择、打印、导出）
  - `src/app/finance/invoices/[id]/preview/page.tsx`
- HTML 拼装工具（把 invoice/company 数据注入模板）
  - `src/lib/invoiceTemplateHtml.ts`

## 模板说明
### classic（参考图）
- 左侧 Logo，右侧公司信息 + INVOICE
- 灰色信息带：Bill To + Invoice meta
- 明细表格：Item / Quantity / Price / Amount
- 底部：Payment Instructions + Summary + Amount Due
- 备注区 + 签章区

### modern（蓝色）
- 使用主色 #0052D9 强调标题与应付金额
- 结构与 classic 保持一致，便于财务审阅

## 打印与 PDF 导出
- 打印：预览页调用 iframe 的 `print()`，使用 `@media print` 保证版式与 A4 一致。
- PDF 导出：预览页对 iframe 的 body 做截图生成 PDF（html2canvas + jsPDF）。
  - 说明：不同浏览器对打印到 PDF 的渲染更接近“像素级一致”；截图导出在跨浏览器上也较一致，但依赖页面字体与图片可被 CORS 读取。

## 字体嵌入（重要）
当前模板已预留 `@font-face`，但默认使用系统字体回退（Noto Sans / PingFang SC / Microsoft YaHei 等）。

如需“字体嵌入”满足正式财务文档一致性要求：
1. 将 woff2 字体放到 `public/invoice-templates/fonts/`
2. 在 `invoice-template.css` 中把 `@font-face src` 改为指向 woff2：
   - `src: url('/invoice-templates/fonts/NotoSansSC-Regular.woff2') format('woff2');`

## 集成入口
- 编辑页底部按钮：`模板/打印` → 跳转到 `/finance/invoices/:id/preview`
- 预览页可切换模板、打印、导出 PDF

## 兼容性测试（手工用例）
- 浏览器：Chrome / Firefox / Safari / Edge
- 场景：
  1) 明细长文本：中英文混排、超长地址，检查自动换行不溢出表格
  2) 金额格式：千分位 + 两位小数、负数（折扣）显示
  3) 打印预览：A4 边距 20mm，页内元素不越界
  4) 导出 PDF：Logo/图片可见，表格对齐与屏幕一致
  5) 移动端：预览 iframe 自适应，无横向滚动

