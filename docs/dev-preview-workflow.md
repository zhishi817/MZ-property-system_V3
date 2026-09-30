# MZ-Dev-Preview 固定开发测试环境

## 固定边界

- Root：`/Users/zhishi/Documents/trae_projects/MZ-Dev-Preview/root`
- Mobile：`/Users/zhishi/Documents/trae_projects/MZ-Dev-Preview/mobile`
- Web：`http://localhost:3000`
- Backend：`http://localhost:4002`
- Expo/Metro：`localhost:8081`
- 本工作区用于开发与验收，不作为发布候选或最终发布来源。
- 发布候选必须另从新获取的 `origin/Dev` 建立干净 worktree，并按 CRL 精确提取已验收范围。

## Git 防误提交保护

首次准备环境时会为 Root 和 Mobile 安装仅对这两个 Preview worktree 生效的本地 Git hooks：

```bash
npm run dev:preview:prepare
```

`pre-commit` 会拒绝从 Preview 创建提交，`pre-push` 会拒绝从 Preview 发起推送。所有 Preview 启动命令都会先验证两个 hook、worktree 专用 `core.hooksPath` 和 detached 状态；保护缺失时启动自动拒绝。可单独执行：

```bash
npm run dev:preview:verify-git-guard
```

该保护只防止误操作，不替代权限边界；有意删除 hook 或使用 Git 的绕过方式仍可能避开本地保护。正式提交必须在独立干净发布候选中执行。

## 数据库和外部副作用保护

首次建立或开发库配置变化后执行：

```bash
npm run dev:preview:prepare
npm run dev:preview:verify-db
```

`prepare` 只接受 `APP_ENV=dev`、`DATABASE_ROLE=dev`、非 production `NODE_ENV`，并要求当前数据库身份与已配置的生产数据库身份不同。它保存不含密码的数据库身份指纹；以后启动、验证和 migration 都必须匹配这个指纹。生产身份、缺少生产对照或指纹漂移都会 fail closed。

固定环境会生成本地且被 Git 忽略的 `backend/.env.local` 和 `.dev-preview/` 状态。生成配置会关闭邮件同步、通知 worker、清洁同步/回填、提醒、清理任务和 PDF worker，并移除 R2、邮件及第三方外部凭据。

只有数据库验证通过后，才允许显式执行 migration。若开发库还没有当前 `origin/Dev` 所需的 R5 markers，先按固定依赖顺序补齐当前基线：

```bash
npm run dev:preview:migrate:baseline -- --apply
```

需要测试某个新增 migration 时，必须显式指定仓库内的 SQL 文件：

```bash
npm run dev:preview:migrate -- --file=backend/scripts/migrations/<migration>.sql --apply
```

没有 `--apply`、没有显式 `--file`、数据库身份不匹配或识别为生产库时，命令自动拒绝。基线命令只包含当前 `origin/Dev` 已声明的 R5-1、R5-2A、Maintenance 和 Property Guide 迁移；每个 migration 仍由自己的前置断言和事务控制。

## 启动

网页与后端：

```bash
npm run dev:preview
```

网页、后端与移动端 Metro 一起启动：

```bash
npm run dev:preview:all
```

仅启动移动端 Metro：

```bash
npm run dev:preview:mobile
```

启动器只会停止来源工作区或 MZ-Dev-Preview 自己占用的 3000/4002/8081 监听进程；若端口属于其他程序则拒绝终止。后端通过 `/health/config` 确认 `app_env=dev`、`database_role=dev`，并在 readiness 通过后才启动网页。

## 功能同步边界

- 固定环境本身不预装或绑定任何未验收业务功能。
- 新功能只有在用户明确指定范围后，才从对应实现工作区精确同步到这里测试。
- 功能代码、migration、模拟数据和测试账号必须按各自任务单独登记与清理，不能写死在通用 Preview 启动入口中。

## 日常开发与发布

1. 在固定开发工作区中开发，或将已确认文件从临时实现工作区精确同步到这里。
2. 运行自动测试并在 3000/4002/8081 做实际操作。
3. 修复后继续在同一固定环境复测；不以 Git 提交代替测试。
4. 用户完成实际验收后，才创建独立发布候选。
5. 提交、推送、PR/合并、migration、部署、OTA 和真机/生产验证分别取得授权并分别记录证据。
