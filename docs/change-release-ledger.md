# Change Release Ledger

Shared cross-thread record of repository changes and selectable release units. Do not store secrets or raw sensitive values here.

## CRL-20260622-001 — 仓库管理员查看全部清洁及线下任务

- **Status:** ready
- **Updated:** 2026-06-22 Australia/Melbourne
- **Request:** 修复仓库管理员已获“查看全部”权限但仍无法查看所有清洁及线下任务的问题。
- **Outcome:** 具有 `cleaning_app.calendar.view.all` 权限的用户请求全部任务时，不再被限制为仅查看自己的任务。

### Implementation

- Previous behavior: `/mzapp/work-tasks?view=all` 仅按 `admin`、`offline_manager`、`customer_service` 角色放行全部任务，忽略权限配置。
- New behavior: 保留原有角色兼容，并额外通过 `cleaning_app.calendar.view.all` 判断全部任务读取范围。
- Key decisions: 只扩大读取范围，不授予任务管理、编辑、状态变更或派单能力。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: 增加全部任务权限判断并用于任务列表接口。

### Impact / Dependencies

- API: `/mzapp/work-tasks?view=all` 的授权范围修正，响应结构不变。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: none.

### Validation

- `git diff --check` — passed.
- `npm run build` in `backend` — passed; TypeScript compilation completed.
- Focused automated permission test — not run: repository has no targeted test for this route.

### Risks / Release Notes

- Risk: 用户拥有“查看全部”权限后可看到全部任务中的房源和排班信息；这是该权限目录声明的预期范围。
- Rollback: revert the permission-aware helper and restore the role-only `allowAll` check.
- Sensitive-information review: no secrets or environment values added.
- Git state: uncommitted.

## CRL-20260622-002 — 跨线程变更与选择性推送台账

- **Status:** ready
- **Updated:** 2026-06-22 Australia/Melbourne
- **Request:** 所有线程的任何更新都要详细记录，避免推送遗漏，并允许按功能选择推送内容。
- **Outcome:** 仓库拥有统一变更台账、强制跨线程记录规则、选择性发布流程和变更覆盖审计工具。

### Implementation

- Previous behavior: 只有按需使用的执行记录，没有覆盖所有文件修改的强制规则，也没有按功能选择推送的共享索引。
- New behavior: 每次仓库修改都必须登记为独立 release unit；推送前按 ID 展示并选择功能；审计脚本检查当前 Git 变更是否全部被台账覆盖。
- Key decisions: 使用仓库级技能和根目录 `AGENTS.md` 保证不同线程共享；审计脚本只读取 Git 和台账，不自动暂存、提交或推送。

### Files / Areas

- `.codex/skills/change-release-ledger/SKILL.md` — created: 变更记录、审计及选择性发布工作流。
- `scripts/audit_change_release_ledger.py` — created: Git 变更覆盖检查。
- `AGENTS.md` — created: 强制所有仓库线程使用共享台账。
- `docs/change-release-ledger.md` — created: 统一跨线程 release-unit 台账。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: 新增仓库级 Codex 指令和技能；不影响应用运行时。
- Dependencies: Python 3 and Git for the audit script; both are existing development tools.
- Related units: none.

### Validation

- `python3 /Users/zhishi/.codex/skills/.system/skill-creator/scripts/quick_validate.py .codex/skills/change-release-ledger` — passed: `Skill is valid!`.
- `python3 -m py_compile scripts/audit_change_release_ledger.py` — passed; generated local `__pycache__` was removed and not retained.
- `python3 scripts/audit_change_release_ledger.py` — passed after cache cleanup: all current Git changes are covered by release units.
- `git diff --check` — passed.
- Sensitive-information review — passed: no credentials, `.env` values, tokens, database URLs, or sensitive logs added.

### Risks / Release Notes

- Limitation: 技能不能后台监听未遵守 `AGENTS.md` 的外部工具；覆盖范围是使用该仓库指令的 Codex 线程及当前 Git 工作树。
- Concurrent edits: 多线程同时写同一文件仍可能冲突，开始任务时必须检查台账和 Git 状态。
- Rollback: remove the new skill, root instruction file, and ledger after preserving any required records elsewhere.
- Git state: uncommitted.

## CRL-20260622-003 — 退房日房源待办与移动端派单

- **Status:** ready
- **Updated:** 2026-06-22 Australia/Melbourne
- **Request:** 已完成的深度清洁、维修和日用品更换记录不再形成任务；未完成记录仅在房源退房日显示，未派人则自动顺延至下次退房，派人后显示到执行人及管理员移动端；网页端保留清洁与普通线下任务混排，三类房源待办放在下方独立区域。
- **Outcome:** 任务中心现在按房源最近有效退房日批量投影未完成房源待办，未派人的待办不进入移动端，完成执行任务后同步关闭原始记录。

### Implementation

- Previous behavior: 维修和深清记录会立即生成未排日期的 `work_tasks`，因任务中心每天包含未排任务而长期堆积；日用品更换未完整接入派单链路；清洁和普通线下任务在页面内被分段显示。
- New behavior: 维修、深清及日用品待办按有效状态筛选，与所有未来退房任务按房源一次性汇总匹配；未派人时每日自动投影到最近退房日，无未来退房则不显示；已派人任务保留确认日期。
- Key decisions: 复用 `work_tasks` 作为唯一执行任务模型；移动端过滤三类未派人待办；移动端完成时在同一事务内更新执行任务和原始记录；不新增常驻 Worker 或定时轮询。

### Files / Areas

- `backend/src/modules/task_center.ts` — modified: 批量同步三类房源待办、匹配最近退房日、分离任务中心返回区域。
- `backend/src/modules/mzapp.ts` — modified: 未派人房源待办不进入移动端，移动完成同步原始记录；保留 CRL-20260622-001 的查看全部权限修复。
- `frontend/src/app/task-center/page.tsx` — modified: 清洁与普通线下任务保持同区混排，新增下方房源待办专区及执行人选择。
- `frontend/src/app/cleaning/cleaningSchedule.module.scss` — modified: 房源待办专区的明显边界、卡片网格和响应式布局。

### Impact / Dependencies

- API: `/task-center/day` 新增 `property_followups` 数组，原有 `rows` 不再包含三类房源待办；`/mzapp/work-tasks` 对未派人房源待办进行过滤。
- Database / migration: 无新表或强制迁移；复用现有 `work_tasks`、房源记录和清洁任务表。每次任务中心加载执行两次批量同步 SQL，退房日按房源一次聚合，只更新发生变化的任务。
- Config / environment: none.
- Dependencies: none.
- Related units: CRL-20260622-001.

### Validation

- `npm run build` in `backend` — passed; TypeScript compilation completed.
- `npm run build` in `frontend` — passed; Next.js production build generated all 91 pages. Existing repository lint/chart warnings remain, with no build error.
- `npm test -- --run` in `frontend` — passed: 32 files, 133 tests.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 16 suites, 46 tests.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 133 pre-existing warnings.
- `git diff --check` — passed.
- Browser QA at `http://localhost:3000/task-center` — blocked after redirect to `/login`; page identity and login render were confirmed, but no credentials were read or entered, so authenticated task-center layout and interaction were not visually verified.

### Risks / Release Notes

- Risk: 退房日投影 SQL 已通过类型检查，但未在本轮对真实数据库执行 `EXPLAIN ANALYZE`；上线后应观察 `/task-center/day` 耗时。
- Risk: 没有未来退房的待办保留原始记录但不显示，新退房任务出现后会自动投影。
- Rollback: revert the property-followup synchronization/filtering changes and the dedicated frontend section; existing source records remain intact.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted.

## CRL-20260622-004 — 移动端保留网页端已挂钥匙状态

- **Status:** ready
- **Updated:** 2026-06-22 Australia/Melbourne
- **Request:** 修复网页端选择“已挂钥匙”并保存后，移动端任务状态没有更新成“已挂钥匙”的问题。
- **Outcome:** `/mzapp/work-tasks` 现在会把底层清洁任务的 `keys_hung` 状态原样返回给移动端，不再映射或合并成 `todo`、`done` 或 `to_hang_keys`。

### Implementation

- Previous behavior: 任务中心保存会把 `cleaning_tasks.status` 写成 `keys_hung`，但移动端接口的状态映射没有识别该值；无挂钥匙视频时合并逻辑还可能把它降级成其他状态。
- New behavior: 移动端接口的基础状态映射显式返回 `keys_hung`；清洁员和检查员任务合并时，如果原始状态为 `keys_hung`，优先输出 `keys_hung`。
- Key decisions: 只修后端接口状态语义；移动端已有“已挂钥匙”显示逻辑，不新增客户端分支；不改变数据库结构。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: `/mzapp/work-tasks` 的清洁任务状态映射和合并输出保留 `keys_hung`。

### Impact / Dependencies

- API: `/mzapp/work-tasks` 对已挂钥匙清洁任务的 `status` 可返回 `keys_hung`；响应结构不变。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: CRL-20260622-001 and CRL-20260622-003 share `backend/src/modules/mzapp.ts`.

### Validation

- `npm run build` in `backend` — passed; TypeScript compilation completed.

### Risks / Release Notes

- Risk: 当前未连接真实移动端账号做端到端刷新验证；判断基于接口代码路径和后端类型检查。
- Rollback: remove the `keys_hung` branches from `mapCleaningTaskStatus` and the work-task merge status output.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted.

## CRL-20260622-005 — 当天任务临时通知照片可选

- **Status:** ready
- **Updated:** 2026-06-22 Australia/Melbourne
- **Request:** 当天临时任务通知可以不用一定要传照片。
- **Outcome:** 移动端“当天任务临时通知”现在允许只填写文字说明并保存通知；照片仍可上传，最多 3 张。空说明且无照片的空通知仍会被阻止。

### Implementation

- Previous behavior: 移动端保存前强制至少 1 张照片；后端 `/mzapp/cleaning-tasks/guest-luggage` 也要求 `photo_urls` 至少 1 张，并在通知正文中固定显示照片数量。
- New behavior: 前端保存按钮在有说明或有照片时可用；后端允许 `photo_urls` 为空或省略；通知正文只在存在照片时显示照片数量。
- Key decisions: 不允许发布完全空白通知；接收端卡片文案改为“说明或照片”，无照片时不渲染空照片区域。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: 当天临时通知接口放开照片必填，增加“说明或照片至少一项”的服务端校验，通知正文按照片是否存在动态生成。
- `mz-cleaning-app-frontend/src/screens/tasks/ManagerDailyTaskScreen.tsx` — modified: 保存校验和按钮禁用条件改为“说明或照片至少一项”，提示文案改为照片可选。
- `mz-cleaning-app-frontend/src/components/GuestLuggageCard.tsx` — modified: 接收端提示改为“说明或照片”，无照片时不显示空图片区域。

### Impact / Dependencies

- API: `/mzapp/cleaning-tasks/guest-luggage` 的 `photo_urls` 从必填 1-3 张变为可选 0-3 张；仍要求 `note` 或 `photo_urls` 至少一项有内容。
- Database / migration: none; existing `guest_luggage_notices.photo_urls` keeps storing JSON array, including empty array.
- Config / environment: none.
- Dependencies: none.
- Related units: none.

### Validation

- `npm run build` in `backend` — passed; TypeScript compilation completed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 16 suites, 46 tests.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 133 existing warnings.
- `git diff --check` and `git -C mz-cleaning-app-frontend diff --check` — passed.

### Risks / Release Notes

- Risk: 未用真实账号在移动端手工点保存；验证覆盖到类型检查、测试和 lint。
- Rollback: restore the frontend photo-required guard and backend schema `.min(1)` plus original notification body.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted.

## CRL-20260622-006 — 移动端只显示已派执行任务并按本人显示 MSQ 钥匙卡

- **Status:** ready
- **Updated:** 2026-06-22 Australia/Melbourne
- **Request:** 移动端任务显示只有安排了执行人的任务才显示；如果清洁是 Simon 的任务，Miranda 的移动端不用显示 MSQ 仓库钥匙交接卡片。
- **Outcome:** `/mzapp/work-tasks` 不再返回未分配执行人的线下/房源待办任务，也不会把未派清洁任务带入管理员移动端；移动端本地列表会过滤旧缓存中的未派任务；MSQ 仓库钥匙卡片只在当前登录人本人有当天 Southbank 清洁/检查任务时显示。

### Implementation

- Previous behavior: 管理员或查看全部模式下，移动端可能看到未派执行人的 work task / 房源待办 / 未派清洁任务；MSQ 仓库钥匙卡片对 admin、offline_manager 或当前列表中任意 Southbank 任务都会显示，即使任务执行人是别人。
- New behavior: work task SQL 强制要求 `assignee_id` 非空；清洁任务分组只收有清洁执行人的任务；接口最终输出再次按清洁/检查/线下任务的执行人字段过滤；管理员合并清洁卡保留清洁员/检查员 ID 以便判断已派状态。
- Key decisions: 保留管理模式查看“已派给他人”的任务能力，但不显示未派任务；MSQ 仓库钥匙卡片按当前用户本人是否关联 Southbank 任务判断，不再按管理员角色直接显示。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: `/mzapp/work-tasks` 过滤未派任务，清洁合并卡保留执行人字段。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 本地任务列表过滤无执行人任务；MSQ 仓库钥匙卡片改为仅当前用户本人有 Southbank 清洁/检查任务时显示。

### Impact / Dependencies

- API: `/mzapp/work-tasks?view=all` 仍允许有权限用户查看全部已派任务，但不返回未派执行人任务。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: CRL-20260622-001, CRL-20260622-003, CRL-20260622-004, CRL-20260622-005 share `backend/src/modules/mzapp.ts` or `TasksScreen.tsx`.

### Validation

- `npm run build` in `backend` — passed; TypeScript compilation completed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 16 suites, 46 tests.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 131 existing warnings.
- `git diff --check` and `git -C mz-cleaning-app-frontend diff --check` — passed.

### Risks / Release Notes

- Risk: 未用 Miranda/Simon 真实账号做端到端移动端验证；验证基于接口过滤逻辑、移动端显示条件和自动检查。
- Rollback: remove the added `/mzapp/work-tasks` assignee filters and restore the previous `showWarehouseKeyCard` role/Southbank-list condition.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted.

## CRL-20260622-007 — 移动端周月视图搜索框与 MSQ 钥匙卡显示修正

- **Status:** ready
- **Updated:** 2026-06-22 10:54 AEST
- **Request:** 移动端切换到本周或本月视图时，当天任务搜索框也要保留；如果清洁任务是 Simon 的，Simon 的移动端不再显示 MSQ 仓库钥匙交接卡片。
- **Outcome:** 管理模式下今日/本周/本月视图都会显示任务搜索框，并按当前选中日期的任务搜索；MSQ 仓库钥匙卡片不再因为执行人本人有 Southbank 清洁任务而显示，只在 admin/offline_manager 管理模式且当天列表包含 Southbank 清洁/检查任务时显示。

### Implementation

- Previous behavior: 搜索框只在 `today` 周期显示，切到本周或本月后消失，并且切换周期会清空搜索；上一版 MSQ 卡片按“当前登录人本人有 Southbank 清洁/检查任务”显示，会让 Simon 这类执行人看到交接卡片。
- New behavior: 搜索框条件改为管理模式通用，placeholder 根据今日/本周/本月变化；搜索仍只过滤当前选中日期任务，不扩展到整周或整月；MSQ 卡片改为 admin/offline_manager 管理模式下的 Southbank 当天任务辅助卡，不对普通清洁/检查执行人显示。
- Key decisions: 不改后端接口和数据库；不新增配置项；保留“本周/本月中选中某一天”的现有任务列表语义。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 管理模式搜索框跨周期显示，搜索状态不因周/月切换而清空，MSQ 仓库钥匙卡片限制为 admin/offline_manager 管理模式。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: CRL-20260622-006 corrects the MSQ card semantics introduced there.

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 16 suites, 46 tests.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 130 existing warnings.
- `npm run build` in `mz-cleaning-app-frontend` — not run: this Expo mobile package has no `build` script; available scripts are `start`, `android`, `ios`, `web`, `lint`, `test`, and `typecheck`.
- `git diff --check` and `git -C mz-cleaning-app-frontend diff --check` — passed.

### Risks / Release Notes

- Risk: 未用 Simon / Miranda 真实账号做移动端手工验证；判断基于角色条件和自动检查。
- Rollback: restore the search rendering guard to `period === 'today'` and restore the prior `showWarehouseKeyCard` condition.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted.

## CRL-20260622-008 — MSQ 钥匙卡恢复为当前执行人显示规则

- **Status:** ready
- **Updated:** 2026-06-22 AEST
- **Request:** 先恢复成 Simon 之前的 MSQ 仓库钥匙交接卡片显示规则。
- **Outcome:** MSQ 仓库钥匙交接卡片恢复为：当前登录人本人有当天 Southbank 清洁/检查任务时显示；不再限制为 admin/offline_manager 管理模式。

### Implementation

- Previous behavior: CRL-20260622-007 将 MSQ 卡片限制为 admin/offline_manager 管理模式，Simon 这类执行人不会显示。
- New behavior: 加回当前用户执行人判断；当天任务列表中只要存在 Southbank cleaning/inspection 且该任务的 cleaner_id/inspector_id/assignee_id 匹配当前登录用户 id，就显示 MSQ 卡片。
- Key decisions: 只恢复 MSQ 卡片显示规则；保留本周/本月搜索框修正；不改后端接口、数据库或钥匙状态 API。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 恢复 `isCleaningTaskAssignedToUser` 判断，并用当前登录人是否为 Southbank 清洁/检查任务执行人控制 MSQ 卡片显示。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: CRL-20260622-006, CRL-20260622-007.

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 16 suites, 46 tests.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 130 existing warnings.
- `npm run build` in `mz-cleaning-app-frontend` — not run: this Expo mobile package has no `build` script; available scripts are `start`, `android`, `ios`, `web`, `lint`, `test`, and `typecheck`.
- `git diff --check` and `git -C mz-cleaning-app-frontend diff --check` — passed.

### Risks / Release Notes

- Risk: 未用 Simon 真实账号手工验证；验证基于当前用户 id 与执行人字段匹配逻辑和自动检查。
- Rollback: restore the CRL-20260622-007 `admin/offline_manager` based `showWarehouseKeyCard` condition.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted.

## CRL-20260622-009 — MSQ 仓库钥匙卡默认收起

- **Status:** ready
- **Updated:** 2026-06-22 AEST
- **Request:** MSQ 仓库钥匙卡片可以收起来，不主动打开的话不要自动展开。
- **Outcome:** 移动端 MSQ 仓库钥匙卡片现在默认只显示收起入口和提示；用户点击入口后才展开钥匙状态、当前持有人、电话、借钥匙、还钥匙、转交同事和刷新操作。

### Implementation

- Previous behavior: 只要满足 MSQ 卡片显示条件，移动端会直接展开整张钥匙卡，并自动加载钥匙状态。
- New behavior: 增加 `warehouseKeyExpanded` 状态；卡片默认收起，点击标题行切换展开/收起；只有展开时才加载钥匙状态、监听 app focus / notice refresh，并显示操作按钮；切换日期或视图时自动恢复收起。
- Key decisions: 保留当前 MSQ 卡片入口显示规则，不在本次改钥匙权限；只降低默认视觉干扰和自动展开行为。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: MSQ 卡片新增折叠状态、展开触发加载、收起 UI、日期/视图切换重置和 header 样式。

### Impact / Dependencies

- API: none; existing warehouse key APIs still only在展开后调用。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: CRL-20260622-006, CRL-20260622-007, CRL-20260622-008.

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 16 suites, 46 tests.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 130 existing warnings.
- `npm run build` in `mz-cleaning-app-frontend` — not run: this Expo mobile package has no `build` script; available scripts are `start`, `android`, `ios`, `web`, `lint`, `test`, and `typecheck`.
- `git diff --check` and `git -C mz-cleaning-app-frontend diff --check` — passed.

### Risks / Release Notes

- Risk: 未用真实移动端手工点击展开验证；验证覆盖到 TypeScript、Jest、lint 和 diff check。
- Rollback: remove `warehouseKeyExpanded` and restore the always-expanded warehouse key card rendering/effects.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted.
