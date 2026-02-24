## 表格标题不截断检查清单（Table + Pagination）

### 样式与布局
- 表头（thead/th）必须允许换行：white-space 为 normal（禁止全局对 .ant-table-cell 强制 nowrap 影响到 th）
- 表头文本必须可断词：overflow-wrap/word-break 至少其一生效，长中英混排也能换行
- 避免对表头单元格设置 overflow:hidden 导致垂直裁剪；如必须隐藏溢出，需确保行高/内边距足够
- 表格布局优先 tableLayout="auto"，如使用 fixed，需为长标题列提供合理 width/minWidth 或允许换行
- 有分页时，分页容器需允许换行（避免小屏下 pagination 挤压表格宽度）：.ant-table-pagination flex-wrap: wrap

### 组件与复用
- 公共表格封装（如 CrudTable）必须：
  - 自动对列标题启用“溢出时 tooltip”
  - 开启 scroll.x（max-content）或为多列场景提供横向滚动兜底
- 页面级 CSS module 禁止使用 :global(.ant-table-cell){nowrap/ellipsis} 这种会影响 th 的写法；若需要省略号仅作用于 tbody

### 验证范围（必须覆盖）
- 分辨率：1920x1080、1366x768、768x1024、375x812
- 数据量：空数据、50条、200条
- 标题内容：纯中文、纯英文、中文+英文混排、超长标题

### 自动化验证
- 运行 `npm run ui:table-header:check` 必须 PASS
- 若新增/改动全局表格样式，需同步更新静态用例并确保覆盖新增场景

