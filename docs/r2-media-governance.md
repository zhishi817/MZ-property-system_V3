# R2 媒体治理

## 目标

在不按年龄误删业务证据的前提下，盘点 R2 对象、扫描数据库引用，并只对经过明确批准的临时前缀提供回收入口。

## 当前策略

- `cleaning/`、`mzapp/`、`maintenance/`、`deep-cleaning/`、`expenses/`、`invoice-files/`、`guest-site/`、`property-guides/`、`inventory/`、`key-items/`、`onboarding/`、`pdf-jobs/` 和 `landlord-documents/` 默认视为业务媒体前缀。
- 默认没有可自动删除的临时前缀；孤儿对象首先只生成 dry-run 报告。
- 引用扫描读取公开表中名称包含 URL、照片、媒体、文件、图片、视频、附件、证明或文档语义的文本/JSON/JSONB 字段，并过滤密码、token、secret、auth 等敏感字段。
- “孤儿”只表示在本次扫描范围内没有发现数据库引用，不等于可以直接删除。

## 盘点命令

```bash
npm run r2:orphan-audit --prefix backend -- --prefix=cleaning/ --older-than-days=30
```

默认是 dry-run，不会删除 R2 对象，也不会写数据库。应按业务前缀分别运行，并保存报告中的对象数量、引用数量、孤儿数量和字节数。

## 回收闸门

只有同时满足以下条件才允许执行删除：

1. 前缀已完成业务确认，并通过 `R2_ORPHAN_DELETE_ALLOWED_PREFIXES` 精确列出；
2. 对象超过保留期，且本次数据库引用扫描没有发现引用；
3. 使用 `--apply --confirm=DELETE_R2_ORPHANS` 显式确认；
4. 已在非生产或小范围样本上复核报告。

当前没有任何默认前缀满足第 1 条，因此生产回收仍需单独审批和配置。删除接口按最多 1000 个对象分批，并在报告中记录失败对象 key 和错误码。
