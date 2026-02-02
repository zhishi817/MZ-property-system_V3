# 发票模板系统测试报告（摘要）

## 测试范围
- A4 排版与页边距（210mm×297mm；四边 20mm）
- 模板渲染：classic / modern
- 中英文混排与长文本换行（描述、地址、备注）
- 金额展示规范（千分位分隔、两位小数、折扣负数）
- 打印（@media print）与导出 PDF
- 响应式预览（PC / 移动）

## 自动化测试
### 单元测试（Vitest）
- `src/lib/invoiceTemplateHtml.test.ts`
  - HTML 注入安全（避免 `<` 破坏脚本）
  - 资源 URL 归一化策略
- `src/lib/invoiceEditorModel.test.ts`
  - 明细/税费/汇总计算
  - 折扣行处理与 hash 稳定性

结果：测试全部通过（本地 `vitest run`）。

## 手工兼容性测试清单（建议执行）
| 项目 | Chrome | Firefox | Safari | Edge |
|---|---|---|---|---|
| classic 模板预览 | 待测 | 待测 | 待测 | 待测 |
| modern 模板预览 | 待测 | 待测 | 待测 | 待测 |
| 打印预览（A4/20mm） | 待测 | 待测 | 待测 | 待测 |
| 导出 PDF | 待测 | 待测 | 待测 | 待测 |
| 长文本换行（中英文） | 待测 | 待测 | 待测 | 待测 |

## 已知限制/注意事项
- 若需要严格“字体嵌入”，需将 woff2 字体文件放入 `public/invoice-templates/fonts/` 并在 CSS 中引用；否则将使用系统字体回退，不同设备可能存在轻微字形差异。
- 导出 PDF 依赖 `html2canvas` 读取图片，若 Logo 使用跨域图片且无 CORS 头，可能导致图片在导出 PDF 时缺失；建议使用同域或 R2 公网 URL。

