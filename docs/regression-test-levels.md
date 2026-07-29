# 回归测试分层

回归检查分为 fast、targeted、full 三层。所有入口复用各模块现有的 build、lint 和 test，不新增测试框架或依赖。

> **Phase 1 基线说明（2026-07-29）：** 本文件和审计工具先作为可复用治理基线固化。当前 `check:full` 尚未直接调用 `check:fast`；Phase 2 会修正为严格继承关系。完成前，发布审查必须同时检查 Fast 所列的关键契约测试，不能仅因 Full 通过就声称全部覆盖。

## Fast Regression

命令：

```bash
npm run check:fast
```

每次修改、提交前和交给审查线程前运行。它覆盖：

- release ledger 覆盖审计；
- backend TypeScript build；
- frontend Vitest；
- 移动端 typecheck（存在独立移动端 checkout 时）。

Fast 检查用于尽早发现语法、类型、核心纯函数回归，不替代完整 build 或模块专项检查。

## Targeted Regression

按变更模块运行：

```bash
npm run check:targeted:backend
npm run check:targeted:frontend
npm run check:targeted:mobile
```

需要更窄范围时，直接运行模块已有测试，例如：

```bash
npm run test:cleaning-rules --prefix backend
npm run test --prefix frontend -- src/lib/<target>.test.ts
npm run test --prefix mz-cleaning-app-frontend -- <target>.test.ts
```

Targeted 检查用于修改某个模块、业务流程或共享规则后。任务中心、清洁、通知和移动端可见性变更必须同时核对后端 payload/action 与客户端渲染/缓存行为。

## Full Regression

命令：

```bash
npm run check:full
```

发布前运行，覆盖 ledger、backend build 和 targeted tests、frontend lint/test/build，以及移动端 typecheck/lint/test。原有 `npm run check` 保留为兼容入口，并转发到 `check:full`。

## CI 对应关系

- Pull Request：运行 fast regression；
- push 到 `main` 或 `Dev`：运行 fast regression 和 full regression；
- `workflow_dispatch`：运行 fast regression 和 full regression；
- 根 Actions 会先 checkout 独立移动端仓库，再安装三套 lockfile 依赖；
- 本地根仓库没有移动端 checkout 时，移动端脚本明确 skip；CI 中移动端 checkout 失败则应直接失败，不得静默跳过。

## 失败处理

- 任一命令退出码非 0，不能以 warning 代替修复或确认；
- 已知 warning 必须记录在 review 或 CRL 中，不得伪装成全绿；
- 测试环境缺依赖、数据库或权限时，标记为未验证并说明原因；
- full regression 未完成前，不输出可发布结论。
