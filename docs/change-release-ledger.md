# Change Release Ledger

Shared cross-thread record of repository changes and selectable release units. Do not store secrets or raw sensitive values here.

## CRL-20260622-001 — 仓库管理员查看全部清洁及线下任务

- **Status:** pushed
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
- Git state: pushed to `Dev` in root commit `30e6595`.

## CRL-20260622-002 — 跨线程变更与选择性推送台账

- **Status:** pushed
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
- Git state: pushed to `Dev` in root commit `30e6595`.

## CRL-20260622-003 — 退房日房源待办与移动端派单

- **Status:** pushed
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
- Git state: pushed to `Dev` in root commit `30e6595`; related mobile changes pushed in `mz-cleaning-app-frontend` commit `edd6bfd`.

## CRL-20260622-004 — 移动端保留网页端已挂钥匙状态

- **Status:** pushed
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
- Git state: pushed to `Dev` in root commit `30e6595`.

## CRL-20260622-005 — 当天任务临时通知照片可选

- **Status:** pushed
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
- Git state: pushed to `Dev` in root commit `30e6595`; related mobile changes pushed in `mz-cleaning-app-frontend` commit `edd6bfd`.

## CRL-20260622-006 — 移动端只显示已派执行任务并按本人显示 MSQ 钥匙卡

- **Status:** pushed
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
- Git state: pushed to `Dev` in root commit `30e6595`; related mobile changes pushed in `mz-cleaning-app-frontend` commit `edd6bfd`.

## CRL-20260622-007 — 移动端周月视图搜索框与 MSQ 钥匙卡显示修正

- **Status:** pushed
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
- Git state: pushed to `Dev` in root commit `30e6595`; related mobile changes pushed in `mz-cleaning-app-frontend` commit `edd6bfd`.

## CRL-20260622-008 — MSQ 钥匙卡恢复为当前执行人显示规则

- **Status:** pushed
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
- Git state: pushed to `Dev`; mobile changes pushed in `mz-cleaning-app-frontend` commit `edd6bfd`, ledger state recorded in root commit `30e6595`.

## CRL-20260622-009 — MSQ 仓库钥匙卡默认收起

- **Status:** pushed
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
- Git state: pushed to `Dev`; mobile changes pushed in `mz-cleaning-app-frontend` commit `edd6bfd`, ledger state recorded in root commit `30e6595`.

## CRL-20260622-010 — 网页已挂钥匙任务保留在移动端搜索

- **Status:** pushed
- **Updated:** 2026-06-22 12:09 AEST
- **Request:** 修复网页把任务标记为“已挂钥匙”后，移动端无法搜索到该任务的问题。
- **Outcome:** 已派检查员的纯入住任务标记“已挂钥匙”后，会保留执行人并作为已完成检查任务继续出现在原任务日期的移动端列表和搜索结果中。

### Implementation

- Previous behavior: 网页勾选“已挂钥匙”会同时设置 `self_complete` 并清空 `inspector_id`；移动端接口只投影 `same_day` / `deferred` 检查任务且只返回有执行人的任务，因此该任务在进入移动端搜索前已经消失。
- New behavior: 网页不再清空原检查员；后端保存时对 `keys_hung` 空检查员提交保留数据库原值；移动端任务接口将 `keys_hung + self_complete` 作为已完成记录投影到原任务日期。
- Key decisions: 保留“移动端只显示已派执行人的任务”规则；普通 `self_complete` 任务仍不生成检查任务，只有已派检查员且状态为 `keys_hung` 的完成记录进入移动端。

### Files / Areas

- `frontend/src/app/task-center/page.tsx` — modified: 勾选“已挂钥匙”时保留当前检查员。
- `backend/src/modules/task_center.ts` — modified: 保存 `keys_hung` 时防止旧客户端的空值清除现有检查员。
- `backend/src/lib/cleaningInspection.ts` — modified: 新增可复用、可测试的移动端检查任务投影日期规则。
- `backend/src/modules/mzapp.ts` — modified: `/mzapp/work-tasks` 使用统一投影规则返回已挂钥匙完成任务。
- `backend/scripts/tests/test_cleaning_inspection_merge.ts` — modified: 覆盖已挂钥匙自完成投影和普通自完成不投影两种情况。

### Impact / Dependencies

- API: `/mzapp/work-tasks` 会返回有检查员的 `keys_hung + self_complete` 任务；响应结构不变。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: CRL-20260622-004, CRL-20260622-006.

### Validation

- `npm run test:cleaning-inspection-merge` in `backend` — passed: targeted projection regression tests completed.
- `npm run build` in `backend` — passed; TypeScript compilation completed.
- `npm test -- --run` in `frontend` — passed: 32 files, 133 tests.
- `npm run build` in `frontend` — passed: Next.js production build generated 91 pages; existing lint/chart warnings remain without build errors.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 16 suites, 46 tests.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 130 existing warnings.
- `git diff --check` — passed after the final backend hardening and ledger update.
- `python3 scripts/audit_change_release_ledger.py` — passed: 6 changed files, all 6 recorded.

### Risks / Release Notes

- Risk: 已在旧版本中被清空检查员的历史任务无法从当前字段自动恢复原检查员；需要重新指定一次检查员后才符合“仅显示已派任务”的规则。
- Rollback: restore the webpage inspector clearing behavior, remove the backend preservation CASE, and restore the previous same-day/deferred-only projection expression.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: implementation pushed to `Dev` in root commit `b8a4200`.

## CRL-20260622-011 — 已挂钥匙保持完成语义但显示独立文案

- **Status:** pushed
- **Updated:** 2026-06-22 14:30 AEST
- **Request:** 修正网页标记“已挂钥匙”后检查安排自动变成“自完成”，并且界面和刷新后又显示“已完成”的问题；其中“已挂钥匙”仍属于完成语义。
- **Outcome:** “已挂钥匙”现在仍属于完成态，但保留独立的 `keys_hung` 展示文案：不再修改同日/延后检查安排、检查日期或检查人员；重新打开时开关保持选中；网页详情和列表刷新后继续显示“已挂钥匙”，同时仍按完成任务处理。

### Implementation

- Previous behavior: CRL-20260622-010 保留了检查员并兼容投影，但网页仍把 `keys_hung` 强制映射成 `self_complete`；重新打开 `keys_hung` 时会同时初始化普通完成开关，后续保存优先写成 `completed`；任务中心接口又把 `keys_hung` 规范化成 `done`，导致刷新后卡片和详情显示“已完成”。
- New behavior: 删除 `keys_hung -> self_complete` 映射；`keys_hung` 不再初始化普通完成开关，并在保存优先级中高于 `completed`；详情头部按当前草稿实时显示 `keys_hung`；任务中心前后端继续把 `keys_hung` 视为完成态归组，但保留 `keys_hung` 原始状态用于显示“已挂钥匙”而不是“已完成”。
- Key decisions: “已挂钥匙”与“检查安排”是两个独立维度；不自动猜测已丢失的历史检查员，只允许用户明确重新选择。

### Files / Areas

- `CHANGELOG.md` — modified: Dev build.1 发布说明补充已挂钥匙状态语义。
- `frontend/src/app/task-center/page.tsx` — modified: 保留检查模式、检查日期和检查员，显示并校验已挂钥匙任务的检查人员。
- `frontend/src/lib/cleaningTaskUi.ts` — modified: 新增旧错误检查模式归一化、普通完成开关判断和状态保存优先级函数。
- `frontend/src/lib/cleaningTaskUi.test.ts` — modified: 覆盖旧 `keys_hung + self_complete` 修复、正常检查安排保持不变，以及 `keys_hung` 不被 `completed` 覆盖。
- `backend/src/modules/task_center.ts` — modified: 任务中心接口保留 `keys_hung` 原始状态用于展示，但仍按完成态参与完成分组和完成判定。

### Impact / Dependencies

- API: `/task-center/day` 继续返回原结构；`keys_hung` 任务保持 `keys_hung` 状态用于展示，同时仍按完成态参与现有完成分组和完成判定。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: CRL-20260622-010.

### Validation

- `npm run test:cleaning-inspection-merge` in `backend` — passed again during combined Dev release validation.
- `npm test -- --run` in `frontend` — passed: 32 files, 135 tests.
- `npm run build` in `frontend` — passed: Next.js production build generated 91 pages; existing lint/chart warnings remain without build errors.
- `npm run build` in `backend` — passed; TypeScript compilation completed.
- `git diff --check` — passed after ledger update.
- `python3 scripts/audit_change_release_ledger.py` — passed: 5 changed files, all 5 recorded.

### Risks / Release Notes

- Risk: 旧版本已经清空检查员的具体历史任务无法自动推断原人员；重新打开该任务后会恢复“同日检查”并显示检查员选择，必须重新选择一次再保存。
- Rollback: restore the `keys_hung -> self_complete` mapping and the old `keys_hung -> done` normalization in task-center responses.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: pushed to `Dev` in root commit `c39c40c`.

## CRL-20260622-012 — 移动端任务与反馈通知链路修复

- **Status:** pushed
- **Updated:** 2026-06-22 14:30 AEST
- **Request:** 同时修复入住任务安排时执行人和经理组收不到通知、新版问题反馈提交后无通知、线下任务完成通知重复横幅推送三个问题，并推送 Dev。
- **Outcome:** 任务中心更新入住/清洁安排后会通知当前执行人及经理组；新版维修、深清和日用品反馈会生成信息中心记录并入 Push 队列；已完成的线下任务重复提交不再创建新完成通知。

### Implementation

- Previous behavior: `save-board` 对 `cleaning_tasks` 只发 SSE 刷新事件，不进入通知系统；`/mzapp/property-feedbacks` 只写业务记录后直接返回；`/mzapp/work-tasks/:id/mark` 对已完成任务仍重新生成带新时间戳的完成事件。
- New behavior: 清洁安排修改调用统一 `CLEANING_TASK_UPDATED` 通知入口，显式包含新执行人并复用经理组规则；新版反馈创建调用 `ISSUE_REPORTED`；完成接口使用快速状态检查加数据库条件更新保证幂等。
- Key decisions: 复用现有 `user_notifications` / `event_queue` / 角色受众规则，不新增第二套推送系统；完成任务只在状态真正迁移到 `done` 时通知。

### Files / Areas

- `backend/src/modules/task_center.ts` — modified: 入住/清洁任务安排修改进入统一通知队列。
- `backend/src/modules/mzapp.ts` — modified: 新版房源反馈创建通知，以及线下任务完成幂等保护。
- `backend/src/services/notificationEvents.ts` — modified: 允许房源反馈作为通知实体类型。
- `VERSION` — modified: Dev 版本更新为 `0.2.13-notification-delivery.20260622+build.1`。
- `CHANGELOG.md` — modified: 记录三项通知修复的 Dev 发布内容。
- `backend/package.json` — modified: 同步后端包版本。
- `backend/package-lock.json` — modified: 同步后端锁文件版本。
- `frontend/package.json` — modified: 同步网页端包版本。
- `frontend/package-lock.json` — modified: 同步网页端锁文件版本。

### Impact / Dependencies

- API: `/task-center/save-board` 在清洁安排真正变更时产生通知；`POST /mzapp/property-feedbacks` 成功创建后产生通知；`POST /mzapp/work-tasks/:id/mark` 对已完成任务返回 `already_done: true`。
- Database / migration: none; 复用现有通知表和队列。
- Config / environment: none.
- Dependencies: none.
- Related units: none; `backend/src/modules/task_center.ts` 与未发布的 CRL-20260622-011 共享文件，本单元需按 hunk 选择性暂存。

### Validation

- `npm run build` in `backend` — passed; TypeScript compilation completed with version `0.2.13-notification-delivery.20260622+build.1`.
- `npm test -- --run` in `frontend` — passed again during combined Dev release validation: 32 files, 135 tests.
- `npm run build` in `frontend` — passed again during combined Dev release validation; Next.js production build generated 91 pages. Existing lint and chart-size warnings remain without build errors.
- `git diff --check` — passed before ledger update.
- `python3 scripts/audit_change_release_ledger.py` — passed: 13 changed files, all 13 recorded across the shared release ledger.

### Risks / Release Notes

- Risk: 本轮未使用真实移动端账号完成端到端 Push 验证；验证覆盖类型检查、生产构建和通知入队代码路径。
- Risk: 房源反馈通知失败不会回滚已保存的反馈，但现在会写入服务端错误日志。
- Rollback: remove the three notification/idempotency changes and restore the previous version files; no data migration rollback is required.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: pushed to `Dev` in root commit `c39c40c`.

## CRL-20260622-013 — 线下任务状态统一到 work_tasks

- **Status:** pushed
- **Updated:** 2026-06-22 14:30 AEST
- **Request:** 修复移动端“线下其他任务”完成后状态回退，并明确一个状态权威来源，另一张表不再独立维护状态。
- **Outcome:** `work_tasks.status` 成为线下任务唯一运行时状态来源；移动端、任务中心和清洁管理页面均从该表读取或修改状态，旧版 `cleaning_offline_tasks.status` 不再参与日常状态同步或筛选。

### Implementation

- Previous behavior: `work_tasks` 和 `cleaning_offline_tasks` 都维护状态，任一入口同步旧表内容时都可能把旧状态重新写回统一任务；本单元早期曾采用双表同事务更新，仍保留了两个状态事实来源。
- New behavior: 移动端完成只更新 `work_tasks`；清洁管理 API 保持原有 `status` 请求/响应结构，但内部状态读写转到 `work_tasks`；任务中心和通用工作任务更新旧表内容时不再回写旧表状态；旧表 upsert 冲突时始终保留已有统一任务状态。
- Key decisions: 保留 `cleaning_offline_tasks.status` 列作为旧 schema 的非空兼容占位，不执行破坏性删列；仅当历史记录尚无对应 `work_tasks` 行时，使用旧状态进行一次性引导，创建后只认 `work_tasks.status`。
- Superseded approach: 2026-06-22 14:11 AEST 记录的“双表同事务完成和状态自愈”方案已由本次单一权威方案取代，未作为最终实现保留。

### Files / Areas

- `CHANGELOG.md` — modified: Dev build.1 发布说明补充线下任务单一状态权威来源。
- `backend/src/modules/cleaning.ts` — modified: 线下任务 API 的状态创建、修改、列表、逾期筛选和日历范围统一使用 `work_tasks`，并为缺失统一任务的历史数据提供一次性引导。
- `backend/dist/modules/cleaning.js` — generated: 后端 TypeScript 构建同步生成的 `cleaning.ts` 运行时代码。
- `backend/src/modules/mzapp.ts` — modified: 移除完成线下任务时对旧表状态的双写和重复完成时的旧表自愈，只保留统一任务幂等完成。
- `backend/src/modules/task_center.ts` — modified: 历史任务引导后只从统一任务加载，保存看板时不再把状态回写旧表。
- `backend/src/modules/work_tasks.ts` — modified: 通用工作任务编辑仅向旧表传播日期和执行人，不传播状态。

### Impact / Dependencies

- API: `/cleaning/offline-tasks` 和 `POST /mzapp/work-tasks/:id/mark` 请求及响应结构不变；状态字段的内部权威来源变为 `work_tasks`。
- Database / migration: no schema migration; `cleaning_offline_tasks.status` 暂时保留但不再作为运行时状态来源。
- Config / environment: none.
- Dependencies: none.
- Related units: CRL-20260622-012 shares `backend/src/modules/mzapp.ts` and `backend/src/modules/task_center.ts`; selective release requires verified hunk-level staging or combining both units. CRL-20260622-011 also shares `backend/src/modules/task_center.ts`.

### Validation

- `npm run build` in `backend` — passed again during combined Dev release validation; TypeScript compilation completed.
- `npm run test:cleaning-rules` in `backend` — passed again during combined Dev release validation; existing cleaning rule checks returned `ok`.
- `git diff --check` — passed after the final source and ledger changes.
- `python3 scripts/audit_change_release_ledger.py` — passed after recording the tracked backend build output: 16 changed files, all 16 recorded across the shared ledger.
- Focused database integration test — not run: current workspace has no isolated PostgreSQL fixture covering the legacy source table and canonical work-task table.

### Risks / Release Notes

- Risk: 旧表状态列仍存在，未来确认所有旧版本和脚本停用后可另做删列迁移；当前保留可避免破坏旧 schema 约束。
- Risk: 未连接真实数据库和移动端账号执行端到端完成操作；验证覆盖 TypeScript 构建、现有清洁规则测试和静态状态链路复查。
- Rollback: restore legacy status propagation in the four backend modules; no schema rollback is required.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: pushed to `Dev` in root commit `c39c40c`; combined with related CRL-20260622-011 and CRL-20260622-012 shared-file changes as requested.

## CRL-20260622-014 — 移动端三类任务可见性重构

- **Status:** pushed
- **Updated:** 2026-06-22 19:12 AEST
- **Request:** 清洁任务和线下其他任务要让 `customer_service`、`admin`、`offline_manager` 在移动端管理模式 `全部` 视图无论状态都可见；房源维修、深度清洁、日用品补货任务只有有执行人时才在移动端显示给执行人和上述管理角色。
- **Outcome:** 移动端现在按三类任务分流可见性：管理角色的 `全部` 视图会看到所有清洁任务和线下其他任务，即使未分配、未开始也可见；房源维修 / 深清 / 日用品补货任务若无执行人则对所有移动端角色隐藏，指派后才对执行人和管理角色可见。

### Implementation

- Previous behavior: `/mzapp/work-tasks` 用统一的“必须有执行人”逻辑过滤所有移动端任务，导致管理角色即使用 `view=all` 也看不到未分配的清洁任务和线下其他任务。
- New behavior: 后端按任务来源区分可见性。管理角色的 `view=all` 会放开未分配清洁任务和未分配线下其他任务，但继续拦截未分配的 `property_maintenance`、`property_deep_cleaning`、`property_daily_necessities`。移动端 `TasksScreen` 用同一规则过滤当前日期列表，保持前后端一致。
- Key decisions: “所有清洁任务和线下其他任务可见”只作用于 `customer_service` / `admin` / `offline_manager` 的管理模式 `全部` 视图；`我的` 视图仍只看当前登录人。房源待办仍以执行人字段作为唯一移动端可见门槛。
- Superseded local direction: 当前工作树里这条单元先前曾记录过“管理角色也可看到所有未分配待处理任务”的更宽规则；在用户补充三类任务口径后，该方向已被本次实现取代，不作为最终行为保留。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: `/mzapp/work-tasks` 按 `source_type` 区分 manager `view=all` 的移动端可见性，放开未分配清洁/线下其他任务，保留房源待办的执行人门槛。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 当前日期任务列表按同样的三类规则过滤，管理模式 `全部` 放开清洁/线下其他任务，但继续隐藏未分配房源待办。
- `docs/change-release-ledger.md` — modified: 记录本次最终可见性口径及验证结果。

### Impact / Dependencies

- API: `/mzapp/work-tasks?view=all` 对 `customer_service` / `admin` / `offline_manager` 会新增返回未分配的清洁任务和线下其他任务；未分配的房源维修 / 深清 / 日用品补货任务仍不会返回。响应字段结构不变。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: CRL-20260622-001, CRL-20260622-006 share `backend/src/modules/mzapp.ts` or the same mobile task visibility path.

### Validation

- `npm run build` in `backend` — passed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 16 suites, 46 tests.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 130 pre-existing warnings.
- `git diff --check` — passed.
- `python3 scripts/audit_change_release_ledger.py` — passed: current changed files are fully recorded in the shared ledger.

### Risks / Release Notes

- Risk: 本轮未用真实 `customer_service` / `admin` / `offline_manager` 账号在移动端手工登录验证，只验证了后端返回路径和移动端本地过滤逻辑。
- Rollback: restore the previous uniform `hasMobileAssignee` filtering in `/mzapp/work-tasks` and `TasksScreen.selectedTasks`, and remove the property-followup source-type split.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: pushed to `Dev` in root commit `e6ea838` and nested repo `mz-cleaning-app-frontend` commit `eb535af`.

## CRL-20260622-015 — 房源问题反馈通知补齐房号和照片

- **Status:** pushed
- **Updated:** 2026-06-22 19:12 AEST
- **Request:** 修复移动端“问题反馈”的信息中心通知，当前没有房号也没有照片，无法判断对应房源。
- **Outcome:** 新创建的房源维修 / 深度清洁 / 日用品反馈通知现在会携带 `property_code` 和反馈照片，移动端信息中心列表与详情页会显示房号标题、房源字段和照片缩略图。

### Implementation

- Previous behavior: `POST /mzapp/property-feedbacks` 创建 `ISSUE_REPORTED` 通知时只带问题类型和详情文本，未把房号或反馈图片写入通知数据；移动端详情页因此只能显示“发现房源问题”和文本字段。
- New behavior: 后端在问题反馈通知 payload 中补充 `property_code`、`photo_url`、`photo_urls`；移动端继续复用现有结构化通知呈现逻辑，并在 `issue_reported` 明细中显式展示 `房源` 字段。
- Key decisions: 不新增新通知类型或新接口，沿用现有 `issue_reported` 和 `notice.data` 结构补字段；只修复新生成通知的数据完整性，不对历史已写入但缺字段的旧通知做回填。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: `notifyPropertyFeedbackCreated` 解析房号并把反馈照片数组写入 `ISSUE_REPORTED` 通知数据，覆盖维修 / 深清 / 日用品三个创建分支。
- `mz-cleaning-app-frontend/src/lib/noticePresentation.ts` — modified: `issue_reported` 明细增加 `房源` 字段，并继续从通知 payload 解析图片。
- `mz-cleaning-app-frontend/src/lib/noticePresentation.test.ts` — modified: 覆盖问题反馈通知标题、房源字段和图片数组展示。
- `mz-cleaning-app-frontend/src/screens/notices/NoticeDetailScreen.test.tsx` — modified: 覆盖信息中心详情页对房号和照片的渲染。
- `docs/change-release-ledger.md` — modified: 记录本次通知数据修复。

### Impact / Dependencies

- API: `POST /mzapp/property-feedbacks` 响应结构不变，但其触发的通知事件 `data` 会新增 `property_code`、`photo_url`、`photo_urls`。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: CRL-20260622-012 shares `backend/src/modules/mzapp.ts` and the same property-feedback notification path. CRL-20260622-014 remains uncommitted in the same worktree but is functionally independent.

### Validation

- `npm run build` in `backend` — passed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 16 suites, 47 tests.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 130 pre-existing warnings.
- `git diff --check` in root repo — passed.
- `git diff --check` in `mz-cleaning-app-frontend` — passed.
- `python3 scripts/audit_change_release_ledger.py` — passed: root repo current changed files are fully recorded in the shared ledger.

### Risks / Release Notes

- Risk: 历史上已经写入通知中心、但 payload 缺少房号/照片的旧问题反馈不会自动补齐，只有本次修复后新创建的通知会完整显示。
- Risk: 本轮未用真实移动端账号提交一条问题反馈做端到端手工验证；验证覆盖后端构建、移动端类型检查、Jest 和 lint。
- Rollback: remove the new `property_code` / `photo_urls` fields from `ISSUE_REPORTED` payloads and revert the `issue_reported` presentation tweak.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: pushed to `Dev` in root commit `e6ea838` and nested repo `mz-cleaning-app-frontend` commit `eb535af`.
