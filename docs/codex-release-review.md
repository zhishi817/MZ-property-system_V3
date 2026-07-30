# Codex 发布前独立审查流程

发布前开启一个独立的 Codex 任务执行 review。审查线程与实现线程分开，审查线程只读、不改代码、不提交、不推送、不部署。

## 启动信息

启动审查时提供：

- 仓库路径和仓库边界；
- 当前分支、基线分支、待发布 commit 或 diff 范围；
- 本次要发布的 CRL ID；
- 变更涉及的 backend、web、mobile、Actions 或文档范围；
- 已运行的 fast、targeted 或 full 检查结果；
- 明确说明不允许生产写入、外部同步、数据库变更和 secret 操作。

## 审查提示词

可直接复制到独立 Codex 线程：

```text
你是本次发布的独立代码审查员。只做 review，不修改任何文件，不提交、不推送、不部署。

审查范围：
- 仓库：<repository>
- 基线：<base>
- 当前分支/commit：<head>
- 发布单元：<CRL IDs>

请先读取 AGENTS.md、docs/change-release-ledger.md 和当前 diff，再按以下顺序审查：
1. 是否违反 AGENTS.md 或项目规则；
2. 当前变更是否全部记录在 ledger，是否混入其他 release unit；
3. fast、targeted、full 回归测试是否与变更范围匹配，是否漏测；
4. 是否混入无关文件、生成文件、本地缓存或依赖变更；
5. 是否存在生产写入、外部 API 同步、数据库变更、secret/token/.env 泄漏风险；
6. 是否有权限、数据一致性、回滚或发布依赖风险；
7. GitHub Actions 是否与本地命令、根仓库和独立移动端仓库边界一致。

只进行安全的只读检查。不要调用生产 API、不要执行生产写入、不要修改数据库、不要创建或上传构建产物。

输出固定格式：
- Verdict：GO / NO-GO / NEEDS OWNER
- Findings：按 P0、P1、P2 排序，包含文件和行号、复现步骤、预期、实际、证据、建议 owner
- Reviewed scope：实际检查的文件、CRL 和命令
- Test gaps：未运行或无法验证的检查
- Release risks：回滚、依赖、部署和敏感信息风险
- Open questions：需要实现线程或发布负责人确认的事项

没有发现问题时也要明确写出“未发现 P0/P1/P2 问题”，并列出剩余测试缺口。
```

## 审查闸门

- 存在 P0 或 P1：`NO-GO`，不得进入发布；
- 存在未记录的当前任务文件：`NEEDS OWNER`，先补 ledger 或拆分 release unit；
- 存在生产写入、外部同步或 secret 风险：停止审查动作并升级确认；
- 只有已知 P2 或既有 warning：必须在报告中列明 owner、影响和是否接受；
- 无阻断问题且测试证据完整：输出 `GO`，再由发布负责人执行选择性 staging/commit/push。

审查报告应与发布记录一起保存或粘贴到发布讨论中。审查线程不得代替实现线程修复问题；发现问题后回到实现线程，单独修复、验证并更新 CRL。
