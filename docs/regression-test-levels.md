# 回归测试分层

回归检查分为 fast、targeted、full、ci、release 五个入口。所有入口复用各模块现有的 build、lint 和 test，不新增测试框架或依赖。

> **Phase 2 命令层级（2026-07-29）：** `check:full` 必须直接调用 `check:fast`，禁止复制 Fast 的命令清单。根与独立移动端均以 `check:ci` 作为非交互 CI 入口；`check:release` 只复用 Full 的自动检查，迁移与远端只读 smoke 必须在发布审查中按本次变更显式确认，不能由通用 npm script 猜测环境或访问生产。

## Fast Regression

命令：

```bash
npm run check:fast
```

每次修改、提交前和交给审查线程前运行。它覆盖：

- release ledger 覆盖审计；
- FR Registry 结构与测试路径审计；
- backend TypeScript build，以及权限/action、状态流转、幂等提交与 R2 媒体治理契约；
- frontend lint 与 Vitest；
- 独立移动端存在时的移动端 Fast（Ledger、typecheck、lint、按钮审计和高价值 action/store/status Jest）。

Fast 检查用于尽早发现语法、类型、权限/状态、幂等和核心纯函数回归，不替代完整 build、全量移动端 Jest 或模块专项检查。

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

发布前运行。它先运行完整 Fast，再增加剩余 backend 回归、frontend build，以及独立移动端 Full（Fast 后的全量 Jest）。原有 `npm run check` 保留为兼容入口，并转发到 `check:full`。

## CI Regression

命令：

```bash
npm run check:ci
```

CI 入口必须非交互、无需 production secret，并在失败时返回非零退出码。根仓库当前将它定义为 Fast；移动端当前将它定义为 Full。CI workflow 只调用这个语义入口，不复制其底层命令。

## Release Regression

命令：

```bash
npm run check:release
```

Release 入口运行 Full。若本次 CRL 涉及 migration、版本一致性或环境 smoke，发布审查必须额外记录目标环境、只读边界和实际结果；没有安全的通用迁移或远端 smoke 命令时，`check:release` 不得伪造这些验证。

## CI 对应关系

- Pull Request：运行根 `check:ci`（当前为 Fast）；
- push 到 `main` 或 `Dev`：运行 fast regression 和 full regression；
- `workflow_dispatch`：运行 fast regression 和 full regression；
- 根 Actions 会先 checkout 独立移动端仓库，再安装三套 lockfile 依赖；
- 本地根仓库没有移动端 checkout 时，移动端脚本明确 skip；CI 中移动端 checkout 失败则应直接失败，不得静默跳过。

## 跨仓库集成（Phase 4）

`npm run test:phase5-release-contract --prefix backend` 会静态核对根后端与独立移动端的共享队列/事务契约，因此不属于可独立执行的根 `check:fast` 或 `check:full`。只能由 `Cross-Repository Phase 5 Contract` workflow 在指定 `root_ref` 与 `mobile_ref` 均已 checkout 后显式运行；workflow 会上传实际解析得到的两个 commit SHA。

## 失败处理

- 任一命令退出码非 0，不能以 warning 代替修复或确认；
- 已知 warning 必须记录在 review 或 CRL 中，不得伪装成全绿；
- 测试环境缺依赖、数据库或权限时，标记为未验证并说明原因；
- full regression 未完成前，不输出可发布结论。
