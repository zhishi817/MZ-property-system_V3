# Codex 发布前独立审查流程

发布前开启一个独立的 Codex 任务执行 review。审查线程与实现线程分开，审查线程只读、不改代码、不提交、不推送、不部署。

## 审查对象

审查一个 Release Attempt，而不是笼统审查“某个 ready CRL”。启动信息必须包含：

- 仓库路径和仓库边界（root 或独立 mobile）；
- Release Attempt ID、CRL IDs、目标动作（`commit` 或 `push`）；
- 基线 `origin/Dev@SHA`、fetch 时间和分支；
- 预提交候选的 staged patch SHA-256（排除 `docs/change-release-ledger.md` 的 attempt 元数据），或已提交范围的精确 `base...head` 与 candidate content commit SHA；
- 变更涉及的 backend、web、mobile、Actions 或文档范围；
- 已运行的 fast、targeted 或 full 检查结果；
- 明确说明不允许生产写入、外部同步、数据库变更和 secret 操作。

候选审查的 `GO` 只允许实现线程提交该审查过的候选；它不是用户的 push 授权。提交后，candidate content commit 必须位于报告 range 内，且排除 ledger 元数据后的 patch fingerprint 必须与候选 fingerprint 一致；不一致时重新审查。

## 审查提示词

```text
你是本次 Release Attempt 的独立代码审查员。只做 review，不修改任何文件，不提交、不推送、不部署。

审查范围：
- 仓库：<repository>
- Release Attempt：<RA ID>
- 目标动作：<commit | push>
- 基线：<origin/Dev@base SHA；fetch time>
- 候选 patch SHA-256 或当前范围：<candidate hash excluding ledger metadata | base...head + candidate content commit>
- 发布单元：<CRL IDs>
- 用户授权状态：<not-selected | selected-for-commit | approved-for-push>

请先读取 AGENTS.md、docs/change-release-ledger.md 和精确候选/commit diff，再按以下顺序审查：
1. 是否违反 AGENTS.md、Release Attempt 契约或独立仓库边界；
2. 选定范围是否全部记录在指定 CRL，是否混入其他 release unit、共享 hunk、生成物或本地缓存；
3. 依赖 CRL/SHA、base、patch fingerprint、分支和用户授权是否彼此一致；
4. fast、targeted、full 回归测试是否与变更范围匹配，是否漏测；
5. 是否存在生产写入、外部 API 同步、数据库变更、secret/token/.env 泄漏风险；
6. 是否有权限、数据一致性、回滚或发布依赖风险；
7. GitHub Actions 是否与本地命令、root/mobile 仓库边界一致。

只进行安全的只读检查。不要调用生产 API、不要执行生产写入、不要修改数据库、不要创建或上传构建产物。

输出固定格式：
- Verdict：GO / NO-GO / NEEDS OWNER（并注明它仅适用于 `<commit | push>` 动作）
- Findings：按 P0、P1、P2 排序，包含文件和行号、复现步骤、预期、实际、证据、建议 owner
- Reviewed scope：仓库、RA、CRL、base/head 或候选 fingerprint、实际检查的文件和命令
- Test gaps：未运行或无法验证的检查
- Release risks：回滚、依赖、部署、授权和敏感信息风险
- Open questions：需要实现线程或发布负责人确认的事项

没有发现问题时也要明确写出“未发现 P0/P1/P2 问题”，并列出剩余测试缺口。
```

## 审查闸门

- 存在 P0 或 P1：`NO-GO`，不得进入目标动作；
- 存在未记录的当前任务文件、共享 hunk 无法归属或 base/fingerprint 不一致：`NEEDS OWNER`，先补 ledger、拆分范围或重新建立候选；
- 存在生产写入、外部同步或 secret 风险：停止审查动作并升级确认；
- 只有已知 P2 或既有 warning：必须在报告中列明 owner、影响和是否接受；
- 无阻断问题且测试证据完整：输出针对当前动作的 `GO`。`GO for commit` 不等于 push、PR、merge、deployment 或设备/生产验证；push 仍需精确 commit、range audit 和用户 `approved-for-push`。

审查报告应与 Release Attempt 一起保存或粘贴到发布讨论中。审查线程不得代替实现线程修复问题；发现问题后回到实现线程，单独修复、验证并更新 CRL。
