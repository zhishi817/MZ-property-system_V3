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

## CRL-20260622-016 — App 通知权限页与独立策略重构

- **Status:** ready
- **Updated:** 2026-06-22 20:12 AEST
- **Request:** 按最终约束版方案，把 App 通知从旧 `event_type + selector` 规则中拆出，改成独立的业务 `policy_key + 模板优先` 策略页；同时拆开 `admin`、`offline_manager`、`customer_service`，其中“运营经理组”固定等于 `admin + 线下经理`，客服不再隐式并入 manager。
- **Outcome:** 后端新增独立 App 通知策略目录、存储、API 和运行时解析器；`emitNotificationEvent(...)` 现在支持显式 `policyKey` 分流，只有传了 `policyKey` 的 App 事件才走新策略，其余旧非 App / legacy 事件继续走原 `event_type` 规则。后台新增 `/rbac/app-notification-policies` 页面，左侧按业务事件展示，右侧只配置启用、模板、附加接收组、指定个人、备注和最终摘要，不再暴露底层 selector 概念。

### Implementation

- Previous behavior: 旧 `/rbac/notification-rules` 直接编辑 `role / audience / user` selectors，运行时的默认 `manager_users` 实际等于 `admin + offline_manager + customer_service`，App 与 legacy 共用一套 `event_type` 规则，无法在权限页里把客服和经理组语义真正拆开。
- New behavior: 新增 `app_notification_policies` 存储与 `/rbac/app-notification-policies` API，首批固定 22 个 `policy_key`，每个事件有固定默认模板、允许附加组和独立业务说明。运行时若调用方传入 `policyKey`，则只按新的业务组与模板解析，不再复用旧 `manager_users` 或 `resolveManagerUsersAudience()` 语义。
- Key decisions:
  - `ops_manager_users` 固定映射为 `admin + offline_manager`，`customer_service_users` 永远单独存在。
  - App 调用点里原来硬编码的“参与人 / 经理组” `recipientUserIds` 已从迁移范围内的业务通知移除，避免它们覆盖新页面配置。
  - `guest_luggage_deleted` 合并进 `guest_luggage_updated` 策略；`consumables_updated` 合并进 `consumables_submitted`；`key_upload_sla` 继续按 `level` 分流到 reminder / escalation。
  - 未显式打 `policyKey` 的旧通知维持 legacy 路径不变，例如旧通用 `CLEANING_TASK_UPDATED`、`day_end_handover_submitted` 等未纳入本轮 App 策略目录的事件暂不迁移。

### Files / Areas

- `backend/src/services/appNotificationPolicies.ts` — added: App 业务事件目录、组/模板定义、默认模板映射、`kind -> policy_key` 映射、PG 存储、App 收件人解析器。
- `backend/src/services/notificationEvents.ts` — modified: `EmitNotificationEventParams` 新增可选 `policyKey`；有 `policyKey` 时走新 App 策略，无 `policyKey` 时继续走 legacy `event_type` 规则；写入 payload 时附带 `policy_key`。
- `backend/src/modules/rbac.ts` — modified: 新增 `GET/PUT/POST /rbac/app-notification-policies...` 接口，并复用统一的 RBAC 用户读取逻辑。
- `backend/src/lib/dayEndHandoverReminderJob.ts` — modified: App 日终交接提醒与经理提醒显式携带新 `policyKey`。
- `backend/src/lib/keyUploadReminderJob.ts` — modified: 普通钥匙上传提醒显式走 `key_upload_reminder`。
- `backend/src/lib/keyUploadSlaJob.ts` — modified: SLA reminder / escalation 显式走新 `policyKey`；escalation 从“按 manager 单独显式发”改为“按新策略解析运营经理组”。
- `backend/src/modules/work_tasks.ts` — modified: `work_task_updated` / `work_task_completed` 改为显式走 App 新策略，不再把 assignee 作为硬编码 recipient 列表。
- `backend/src/modules/cleaning.ts` — modified: 线下任务完成与清洁任务管理字段更新显式走新 App 策略；经理字段更新不再硬编码 legacy recipients。
- `backend/src/modules/task_center.ts` — modified: `work_task_updated` 的 App 通知改为显式 `policyKey` 分流。
- `backend/src/modules/cleaning_app.ts` — modified: `warehouse_key_updated`、`key_photo_uploaded`、`key_photo_deleted`、`issue_reported`、`consumables_submitted` / `consumables_need_restock`、`restock_done`、`completion_photos_saved`、`keys_hung`、`restock_proof_saved`、`task_ready` 全部切到新 App 策略。
- `backend/src/modules/mzapp.ts` — modified: `guest_checked_out` / cancelled、`task_requirements_changed`、`guest_luggage_updated`、`work_task_completed`、`issue_reported`、移动端检查侧 `keys_hung` 与 `restock_proof_saved` 改为显式走新 App 策略；本文件同时保留了当前工作树里已有的房源问题反馈与移动端可见性相关未提交修改，需按共享文件做选择性发布。
- `backend/scripts/tests/test_app_notification_policies.ts` — added: 覆盖组角色拆分、模板展开、默认模板映射和 `kind -> policy_key` 映射。
- `backend/package.json` — modified: 新增 `test:app-notification-policies`。
- `frontend/src/app/rbac/app-notification-policies/page.tsx` — added: 新 App 通知权限页。
- `frontend/src/app/rbac/app-notification-policies/policyUi.ts` — added: 页面摘要、脏状态和模板展开的前端纯函数。
- `frontend/src/app/rbac/app-notification-policies/policyUi.test.ts` — added: 覆盖摘要去重、`explicit_only` 空接收人文案和 dirty 判断。
- `frontend/src/lib/adminNavigation.ts` — modified: RBAC 导航新增 `App通知规则`，旧页改标成 `通知规则（旧）`。
- `backend/dist/modules/rbac.js` — generated: 后端构建同步生成的新 RBAC 运行时代码。
- `backend/dist/modules/cleaning.js` — generated and shared: 本次后端构建再次更新；当前工作树同时带有 CRL-20260622-013 的统一任务状态相关改动。
- `docs/change-release-ledger.md` — modified: 记录本次 App 通知策略重构单元。

### 2026-06-22 Follow-up — 仓库钥匙参与人修正

- Previous behavior: `warehouse_key_updated` 默认模板按最终约束版初稿落成了 `ops_manager_only`，页面卡片只会显示“仅运营经理组”；运行时也把 Southbank 相关清洁/检查参与人压平进显式 `recipientUserIds`，无法和新 App 模板语义保持一致。
- New behavior: `warehouse_key_updated` 默认模板改为 `participants_plus_ops_manager`，其业务参与人不再复用通用 `cleaning_task_participants`，而是改成专门的 `warehouse_related_users`。运行时由仓库钥匙事件 payload 显式携带 `warehouse_related_user_ids`，用于解析 Southbank 相关清洁/检查任务参与人；运营经理组仍由新策略模板补入，不再在调用点硬编码。
- Files:
  - `backend/src/services/appNotificationPolicies.ts` — modified: `warehouse_key_updated` 默认模板改为 `participants_plus_ops_manager`，并新增 `warehouse_related_users` 参与人语义。
  - `backend/src/modules/cleaning_app.ts` — modified: 仓库钥匙事件改为只传 `policyKey + warehouse_related_user_ids`，不再把经理组硬塞进 `recipientUserIds`。
  - `frontend/src/app/rbac/app-notification-policies/policyUi.ts` — modified: 权限页摘要对 `warehouse_key_updated` 单独显示“相关任务参与人 + 运营经理组”。
  - `backend/scripts/tests/test_app_notification_policies.ts` — modified: 默认模板断言同步改为 `participants_plus_ops_manager`。
  - `frontend/src/app/rbac/app-notification-policies/policyUi.test.ts` — modified: 新增仓库钥匙摘要断言。

### 2026-06-22 Follow-up 2 — 排除 handover 目标人

- Previous behavior: `warehouse_related_user_ids` 在 handover 场景里会额外拼入 `to_user_id`，导致“相关任务参与人”被放宽成“Southbank cleaner / inspector + handover 目标人”。
- New behavior: `warehouse_related_user_ids` 现在只保留 Southbank 相关任务里的 `cleaner + inspector`，不再把 handover 目标人并入这条通知的参与人集合。
- Files:
  - `backend/src/modules/cleaning_app.ts` — modified: 删除 handover `to_user_id` 对 `warehouse_related_user_ids` 的追加，只保留 Southbank cleaner / inspector。

### Impact / Dependencies

- API:
  - new `GET /rbac/app-notification-policies`
  - new `GET /rbac/app-notification-policies/:policyKey`
  - new `PUT /rbac/app-notification-policies/:policyKey`
  - new `POST /rbac/app-notification-policies/:policyKey/reset`
  - legacy `/rbac/notification-rules` untouched
- Database / migration: no standalone migration file; runtime now ensures `app_notification_policies` exists on demand with `template_key` / `extra_group_keys` / `extra_user_ids` / `version`.
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Shares `backend/src/modules/mzapp.ts` with CRL-20260622-014 and CRL-20260622-015; selective release requires verified hunk-level staging or combining units.
  - Shares `backend/dist/modules/cleaning.js` with CRL-20260622-013 generated backend build output.

### Validation

- `npm run test:app-notification-policies` in `backend` — passed (`ok`).
- `npm run build` in `backend` — passed after tightening new App policy service return types.
- `npx vitest run src/app/rbac/app-notification-policies/policyUi.test.ts --coverage.enabled=false` in `frontend` — passed (4 tests).
- `npm run build` in `frontend` — passed.
- `npm run lint` in `frontend` — passed with existing repo warnings only; no new errors from this unit.
- `git diff --check` — passed.
- `python3 scripts/audit_change_release_ledger.py` — pending rerun after this ledger entry.
- Follow-up validation after仓库钥匙规则修正:
  - `npm run test:app-notification-policies` in `backend` — passed (`ok`).
  - `npm run build` in `backend` — passed.
  - `npx vitest run src/app/rbac/app-notification-policies/policyUi.test.ts --coverage.enabled=false` in `frontend` — passed (5 tests).
  - `npm run build` in `frontend` — passed with existing repo-wide warnings only.
  - `npm run lint` in `frontend` — passed with existing repo-wide warnings only.
- Follow-up validation after排除 handover 目标人:
  - `npm run test:app-notification-policies` in `backend` — passed (`ok`).
  - `npm run build` in `backend` — passed.
  - `npx vitest run src/app/rbac/app-notification-policies/policyUi.test.ts --coverage.enabled=false` in `frontend` — passed (5 tests).
  - `npm run build` in `frontend` — passed with existing repo-wide warnings only.
  - `npm run lint` in `frontend` — passed with existing repo-wide warnings only.
  - `git diff --check` — passed.
  - `python3 scripts/audit_change_release_ledger.py` — passed.

### Risks / Release Notes

- Risk: 本轮只迁移了明确列入 App 新策略目录的业务事件。仍未显式传 `policyKey` 的 legacy 通知继续沿用旧 `event_type` 规则，后续若继续收口 App 事件，需要补齐剩余调用点。
- Risk: 新页面不支持“从模板里减人”，只支持附加组和指定个人；如果业务后续需要更细粒度减法配置，需要另起设计。
- Risk: 未用真实移动端账号做端到端通知投递验证；当前验证覆盖后端规则脚本、后端编译、前端单测、前端构建和 lint。
- Rollback: remove `appNotificationPolicies` service and RBAC page/API, drop `policyKey` wiring from migrated App emitters, and restore those emitters’ original explicit recipient lists.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted in root repo with this new App notification policy unit plus pre-existing shared-file changes in `backend/src/modules/mzapp.ts` and generated `backend/dist/modules/cleaning.js`.

## CRL-20260622-017 — 检查页与钥匙视频页离线上传队列加固

- **Status:** ready
- **Updated:** 2026-06-22 21:06 AEST
- **Request:** 解决检查人员在“检查房源页面”和“上传钥匙视频页面”因网络不稳定导致拍照/视频上传失败、卡死和提交流程混乱的问题；要求拍摄后先复制到 App 私有目录，再后台上传，并严格区分 uploaded 与 business saved。
- **Outcome:** 检查员拍完照片或钥匙视频后，媒体会立即复制到 App 私有目录并进入后台上传队列；页面会明确显示“已保存到本机”“已上传待同步/待提交”“已过期需重拍”等状态。检查页只有在业务记录真正同步完成后才允许进入“标记已完成”，钥匙视频页则改为“先上传，后点击完成提交”。

### Implementation

- Previous behavior: 检查页和钥匙视频页直接依赖当次网络上传；网络波动时拍照/录视频后的流程容易卡在当前页面，上传状态和业务提交状态混在一起，用户难以判断是否需要重试、等待还是重新拍摄。
- New behavior: 新增本地检查媒体队列，照片/视频拍完后先复制到 App 私有目录并记录 `local_uri`、`uploaded_url`、`business_saved`、`retain_until` 等状态。网络恢复、App 回到前台或重新登录后会自动继续上传；401/403 不自动重试；视频在队列中低优先级；未完成业务保存的本地文件保留 7 天，超期自动清理本地副本但保留元数据状态。
- Key decisions:
  - 上传成功不等于业务保存成功；只有 `saveInspectionPhotos`、`saveRestockProof` 或 `uploadLockboxVideo` 成功后才清理本地文件。
  - 检查页把“上传中/待同步/已过期”状态直接展示给检查员，并在存在待同步内容时禁止进入最终完成页，避免误以为已经提交。
  - 钥匙视频页拆成两个动作：`拍视频并上传` 和 `点击完成`；文案不再把视频上传成功误导成任务已完成。

### Files / Areas

- `mz-cleaning-app-frontend/src/lib/inspectionMediaQueue.ts` — added: 本地媒体复制、上传队列、401/403 终止、视频低优先级、7 天保留与过期清理、同一 `local_uri` 并发保护。
- `mz-cleaning-app-frontend/src/lib/auth.tsx` — modified: 接入 `@react-native-community/netinfo`，在网络恢复和 App 回到前台时自动继续处理检查媒体队列并执行过期清理。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: 统一上传错误为 `ApiError`，补充 retryable / terminal 区分，供队列判定是否自动重试。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — modified: 检查照片、清洁问题照片、补货照片全部改为先入本地队列；页面显示“等待自动上传 / 已上传待同步 / 过期需重拍”；只有业务同步完成后才允许进入“标记已完成”。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.tsx` — modified: 钥匙视频改为先本地保存并后台上传，再由用户点击完成提交；提示文案改为“上传完成后请回到本页点击完成提交”。
- `mz-cleaning-app-frontend/package.json` — modified: 新增 `@react-native-community/netinfo` 依赖。
- `mz-cleaning-app-frontend/package-lock.json` — modified: 锁文件同步依赖变更。

### Impact / Dependencies

- API: 复用现有 `uploadCleaningMedia`、`uploadCleaningVideo`、`saveInspectionPhotos`、`saveRestockProof`、`uploadLockboxVideo`；无新接口。
- Database / migration: none.
- Config / environment: none.
- Dependencies: `@react-native-community/netinfo` added in `mz-cleaning-app-frontend`.
- Related units: none.

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 128 pre-existing warnings and 0 errors.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 16 suites, 47 tests.
- `npm run build` in `mz-cleaning-app-frontend` — not run: this package has no `build` script.
- `git -C mz-cleaning-app-frontend diff --check` — pending.
- `python3 scripts/audit_change_release_ledger.py` — passed.

### Risks / Release Notes

- Risk: 这轮没有在真实弱网环境和真机上做端到端手工回归，当前结论基于代码路径、类型检查、lint 和 Jest。
- Risk: 7 天后只自动清理本地副本；如果媒体当时尚未上传成功，页面会保留“已过期需重拍”状态，检查员仍需重新拍摄该内容。
- Rollback: remove the local inspection media queue, restore direct upload behavior in the two inspection screens, and remove the NetInfo-triggered queue processing.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted in nested repo `mz-cleaning-app-frontend`; root repo change limited to this ledger entry alongside pre-existing unrelated root worktree changes.

### 2026-06-22 Follow-up — 恢复网络后的本地文件缺失保护

- Previous behavior: 队列恢复上传时只校验 `local_uri` 非空，不校验该文件是否仍存在；React Native 原生 `RCTNetworking` 在拼 multipart body 时遇到丢失文件，会先抛 `NSCocoaErrorDomain Code=260` 红屏，来不及回到 JS 队列错误处理。
- New behavior: 入队复制后立即校验私有目录文件是否实际落盘；上传前再次校验本地文件存在；删除本地文件时若该 `local_uri` 正在上传则跳过删除，避免把进行中的 multipart 文件句柄删掉。
- Files:
  - `mz-cleaning-app-frontend/src/lib/inspectionMediaQueue.ts` — modified: 新增 `fileExists` 校验，入队/上传前检查文件存在，上传中禁止本地删除。
  - `mz-cleaning-app-frontend/src/lib/api.ts` — modified: `uploadCleaningMedia` 和 `uploadCleaningVideo` 在构造 `FormData` 前校验文件存在，缺失时直接抛 `ApiError`，不再把坏路径交给原生网络层。
- Validation:
  - `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
  - `npm run lint` in `mz-cleaning-app-frontend` — passed with 129 pre-existing warnings and 0 errors.

## CRL-20260622-019 — 延后检查任务文案去歧义

- **Status:** ready
- **Updated:** 2026-06-22 21:43 AEST
- **Request:** 延迟检查任务在延后到后续日期后，不应继续把任务显示成“退房”；应明确表达这只是安排了检查任务。
- **Outcome:** 网页任务中心和移动端任务列表/详情对 deferred inspection 统一显示“延后检查”，不再把这类任务标题或副标题继续拼成“退房”；原始退房时间仍保留在详情信息中。

### Implementation

- Previous behavior: 网页任务中心里处于 `inspection_mode=deferred` 的清洁任务虽然带有“延后检查”标签，但卡片副标题仍复用 `退房/入住` 展示；移动端 inspection 任务在 `inspection_mode=deferred` 时，标题仍按 `start_time/end_time` 拼成“退房/入住”。
- New behavior: 只要任务进入 deferred inspection 展示语义，网页卡片副标题和移动端标题统一切换为“延后检查”；普通退房/入住任务保持原样。
- Key decisions:
  - 只改展示文案，不改任务投影、排序、检查模式、状态流转或接口结构。
  - 网页端新增纯展示 helper，用于识别 deferred inspection 展示态并输出 inspection-oriented 文案。
  - 移动端新增纯函数 helper，统一 `TasksScreen` 与 `TaskDetailScreen` 的标题后缀，避免两处各自重复拼接“退房/入住”。

### Files / Areas

- `frontend/src/app/task-center/page.tsx` — modified: 复用 deferred inspection 展示 helper，卡片副标题不再在延后检查场景下显示 `退房/入住`。
- `frontend/src/app/task-center/taskCenterDisplay.ts` — added: 任务中心 deferred inspection 展示判断和文案 helper。
- `frontend/src/app/task-center/taskCenterDisplay.test.ts` — added: 覆盖 deferred inspection 文案与普通退房/入住文案的展示测试。
- `mz-cleaning-app-frontend/src/lib/cleaningInspection.ts` — modified: 新增移动端延后检查标题判断与标题后缀 helper。
- `mz-cleaning-app-frontend/src/lib/cleaningInspection.test.ts` — added: 覆盖 deferred inspection 与普通 checkout/checkin 的标题后缀测试。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 任务列表标题改用统一 helper，在 deferred inspection 场景显示 `延后检查`。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` — modified: 任务详情标题改用统一 helper，在 deferred inspection 场景显示 `延后检查`。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` — modified: 增加 deferred inspection 标题断言，确保不再显示 `退房`。

### Impact / Dependencies

- API: none; existing `inspection_mode` / `task_kind` / `start_time` / `end_time` fields are reused as-is.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: `CRL-20260622-018` placeholder attribution is superseded by this unit.

### Validation

- `npx vitest run src/app/task-center/taskCenterDisplay.test.ts --coverage=false` in `frontend` — passed: 1 file, 2 tests.
- `npm run build` in `frontend` — passed with existing repo-wide warnings and existing chart-size console warnings only.
- `npm run lint` in `frontend` — passed with existing repo-wide warnings only.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 17 suites, 50 tests.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 128 existing warnings and 0 errors.
- `git diff --check` — passed.
- `git -C mz-cleaning-app-frontend diff --check` — passed.
- `python3 scripts/audit_change_release_ledger.py` — passed.

### Risks / Release Notes

- Risk: 本次没有做真实账号的手工 UI 回归；验证以纯函数测试、详情测试、构建和 lint 为主。
- Rollback: remove the new display helpers and restore the previous `退房/入住` title and summary suffix logic in task-center and mobile task screens.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted in both root repo and nested repo `mz-cleaning-app-frontend`; this unit coexists with pre-existing unrelated worktree changes.

### 2026-06-22 Follow-up 2 — 补充项缓存与检查页本地 draft

- Previous behavior: “添加补充项”每次打开都必须实时请求 `/mzapp/checklist-items`，离线时直接报错；清洁问题反馈的照片虽然会本地排队上传，但检查页的补充项选择、补货状态、备注和清洁问题备注只存在当前页面内存里，弱网或离开页面后不会可靠保留，也不会在网络恢复时自动重试业务保存。
- New behavior: 补充项列表先读本地缓存再尝试联网刷新，离线时可继续使用最近缓存的 consumable 清单；检查页会把补充项选择、补货状态、备注和清洁问题备注写入本地 draft，页面重新打开后自动恢复；网络恢复时如果检查照片/清洁问题的业务记录尚未同步，会自动重试 `saveInspectionPhotos`。
- Files:
  - `mz-cleaning-app-frontend/src/lib/inspectionPanelDraft.ts` — added: 检查页 draft 与补充项缓存存储。
  - `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — modified: 补充项弹窗优先读缓存、显示离线提示；检查页持久化本地 draft，重开页面自动恢复，并在网络恢复时自动重试检查照片/清洁问题业务同步。
- Validation:
  - `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
  - `npm run lint` in `mz-cleaning-app-frontend` — passed with 128 pre-existing warnings and 0 errors.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 17 suites, 50 tests.

## CRL-20260622-020 — 入住检查任务区分仅改密码与检查后挂钥匙

- **Status:** ready
- **Updated:** 2026-06-22 23:23 AEST
- **Request:** 让已经安排给检查员的入住检查任务可以明确区分“只要改密码”还是“需要检查以后挂钥匙”，并允许直接修改代码实现，不再只靠人工备注。
- **Outcome:** 网页任务中心现在可以为 `checkin_clean` 检查任务明确设置“仅改密码”或“检查后挂钥匙”；该字段会保存到后端并同步到移动端。检查员在任务列表、详情、检查页和完成页都能直接看到执行方式；当任务是“仅改密码”时，移动端不再强制先补拍检查照片或补货确认才允许进入改密码完成流程。

### Implementation

- Previous behavior: 入住检查任务只有 `inspection_mode`，没有单独表达“只改密码”这类执行范围。网页端无法直接配置这类区别，移动端检查员也不知道当前任务到底是只改密码还是要完整检查后挂钥匙；若只是改密码，现有完成流程仍会卡在检查照片、补货确认等前置条件上。
- New behavior: 新增 `inspection_scope`，在 `checkin_clean` 检查任务上区分 `password_only` 与 `inspect_and_hang`。网页任务中心详情支持直接设置并显示标签；后端保存、投影和移动端 `work-tasks` 都会返回该字段；移动端检查任务列表、详情、检查页和完成页会显示明确文案，并在 `password_only` 场景下放宽检查照片/补货前置校验，只要求改密码与钥匙视频留存。
- Key decisions:
  - 只给入住检查任务开放这项区分；其他任务类型继续保持现有语义，避免引入新的并行状态系统。
  - 数据库不单独做离线 migration 文件，而是在任务中心和移动端读取路径上用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS inspection_scope` 运行时兜底，降低上线阻力。
  - `inspection_scope=password_only` 只放宽检查员完成流程，不改变现有派单、状态机、排序或通知大类。

### Files / Areas

- `backend/src/modules/task_center.ts` — modified: 新增 `inspection_scope` schema/runtime normalize/save logic，读取任务中心板块时带出该字段，保存 `cleaning_assignments` 时写回 `cleaning_tasks`，并把字段纳入事件变更集。
- `backend/src/modules/mzapp.ts` — modified: 运行时确保 `cleaning_tasks.inspection_scope` 列存在，`/mzapp/work-tasks` 查询和任务投影返回该字段。
- `frontend/src/lib/cleaningTaskUi.ts` — modified: 新增 `inspection_scope` 标准化与标签 helper。
- `frontend/src/lib/cleaningTaskUi.test.ts` — modified: 覆盖 scope normalize / label 测试。
- `frontend/src/app/task-center/page.tsx` — modified: 任务中心详情新增“检查执行方式”下拉、卡片/详情标签、保存 payload 字段以及 password-only 必须有检查员的校验；构建中补齐 `cleaning_assignments` 类型。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: `WorkTask` 类型补充 `inspection_scope`。
- `mz-cleaning-app-frontend/src/lib/workTasksStore.ts` — modified: 将 `inspection_scope` 纳入允许的安全 patch 字段。
- `mz-cleaning-app-frontend/src/lib/cleaningInspection.ts` — modified: 新增移动端 scope normalize / label / password-only 判断 helper。
- `mz-cleaning-app-frontend/src/lib/cleaningInspection.test.ts` — added: 覆盖 password-only helper 与标签测试。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 检查任务列表显示执行方式标签，并把按钮文案区分为“查看说明 / 改密码并完成”等语义。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` — modified: 详情页显示“检查执行方式”说明。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` — modified: 新增 password-only 详情展示断言。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — modified: password-only 场景下不再阻塞检查照片/补货前置，显示只需改密码与拍视频的说明，并允许进入完成页。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.tsx` — modified: password-only 场景下跳过重复检查/补货校验，完成文案改为改密码完成。

### Impact / Dependencies

- API: `/api/task-center/save-board` 的 `cleaning_assignments` 与 `/mzapp/work-tasks` 返回值新增 `inspection_scope` 字段。
- Database / migration: runtime schema ensure adds `cleaning_tasks.inspection_scope` when missing; no standalone migration file added.
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Shares mobile inspection screens with `CRL-20260622-017`; selective release needs verified hunk staging if both are not released together.
  - Shares task title/detail helpers and task-center page with `CRL-20260622-019`.
  - Shares `backend/src/modules/mzapp.ts` and `backend/src/modules/task_center.ts` with other uncommitted root-repo units in the current worktree; do not whole-file stage without hunk review.

### Validation

- `npx vitest run src/lib/cleaningTaskUi.test.ts src/app/task-center/taskCenterDisplay.test.ts --coverage.enabled=false` in `frontend` — passed: 2 files, 7 tests.
- `npm run build` in `backend` — passed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm test -- --runInBand src/lib/cleaningInspection.test.ts src/screens/tasks/TaskDetailScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 2 suites, 8 tests.
- `npm run lint` in `frontend` — passed with existing repo-wide warnings only.
- `npm run build` in `frontend` — passed after补齐 `cleaning_assignments` 的 `inspection_scope` 类型；仍有既有 repo-wide warnings 和既有 chart-size console warnings。
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 127 existing warnings and 0 errors.
- `git diff --check` — passed.
- `git -C mz-cleaning-app-frontend diff --check` — passed.
- `python3 scripts/audit_change_release_ledger.py` — passed.

### Risks / Release Notes

- Risk: 这次没有做真机手工回归；结论基于后端构建、网页构建、类型检查、lint 和针对性测试。
- Risk: `inspection_scope` 默认会归一到 `inspect_and_hang`；如果历史数据本来靠备注表达“仅改密码”，需要人工重新在任务中心设置一次才会变成显式字段。
- Rollback: remove `inspection_scope` reads/writes and restore the previous unified inspection flow in task-center, `/mzapp/work-tasks`, and mobile inspection screens.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted in both root repo and nested repo `mz-cleaning-app-frontend`; this unit coexists with pre-existing unrelated worktree changes.

### 2026-06-22 Follow-up — 检查标签换行分组优化

- Previous behavior: 任务中心紧凑卡片把状态、同步、检查模式和“检查后挂钥匙/仅改密码”都平铺在同一个换行容器里；卡片宽度较窄时，“同日检查”可能留在第一排，而“检查后挂钥匙”单独掉到下一排偏右位置，视觉上像错位。
- New behavior: 检查模式和检查执行方式现在作为同一个标签组一起参与换行；空间不足时整组一起换到下一行，不再拆成前后两段。标签容器同时改为顶部对齐并增加行间距，第二行标签的起点更稳定。
- Files:
  - `frontend/src/app/task-center/page.tsx` — modified: 把 inspection mode / inspection scope 标签组合并成一个渲染分组。
  - `frontend/src/app/cleaning/cleaningSchedule.module.scss` — modified: 调整紧凑卡片标签容器的 `align-items`、`row-gap`，并新增 inspection 标签分组样式。
- Validation:
  - `npm run build` in `frontend` — passed with existing repo-wide warnings and existing chart-size console warnings only.
- Risks:
  - 这次是样式级调整，未做浏览器手工截图回归；如果后续还要更强的布局约束，可以再补固定优先级或双行栅格方案。

### 2026-06-22 Follow-up — 移动端检查后挂钥匙标签改色

- Previous behavior: 移动端 `TasksScreen` 里，“检查后挂钥匙”和普通蓝色标签共用 `styles.tag`，而“仅改密码”使用黄色 `styles.tagWarn`，两者区分度不够。
- New behavior: “检查后挂钥匙”改为独立绿色标签；“仅改密码”继续保留黄色提醒色，两个执行方式现在一眼可分。
- Files:
  - `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 为 inspection scope 标签新增 `tagInspectHang` / `tagInspectHangText`，并只在非 `password_only` 场景使用。
- Validation:
  - `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- Risks:
  - 这次仅改列表标签颜色，没有同步改详情页说明文字颜色；如果你希望整套移动端视觉完全一致，可以下一步再统一检查页/详情页的色系。

### 2026-06-22 Follow-up — 移动端业务标签改成语义色板

- Previous behavior: 列表卡片的业务标签长期沿用“有什么就先塞进蓝色/黄色/红色”的方式，蓝色同时承载了普通任务、特殊任务、同日检查、延后检查等多种语义；用户需要靠文案逐个读，不容易一眼判断“正常任务 / 特殊任务 / 待确认 / 风险 / 已完成 / 入住特殊安排”。
- New behavior: `TasksScreen` 里的业务标签改成固定六类语义色板，并用映射函数统一分配颜色：
  - `normal` 蓝色：`入住中清洁`、`清洁`、`检查`、`同日检查`
  - `special` 紫色：`维修`、`深清`、`线下`、`自完成`
  - `pending` 黄色：`需挂N套钥匙`、`待确认检查安排`、`仅改密码`、`延后检查`
  - `danger` 红色：`请确认已退N套钥匙`、`晚退房`
  - `success` 绿色：`检查后挂钥匙`
  - `info` 青色：`早入住`
- Key decisions:
  - 颜色由业务语义决定，不再由“这个标签之前恰好用了哪套样式”决定。
  - 这次只重构移动端任务列表卡片的业务标签，不改左上角状态胶囊和紧急程度胶囊。
  - 前一条“检查后挂钥匙标签改色”作为临时修补仍保留记录，但其效果现在已被这条语义色板重构覆盖。
- Files:
  - `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 新增 `TASK_TAG_COLORS`、`taskKindTagTone`、`inspectionModeTagTone`、`inspectionScopeTagTone`、`taskTagStylePair`，并把任务类型、检查计划、钥匙提醒、入住时间和检查执行方式标签全部切到语义色板。
- Validation:
  - `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- Risks:
  - 这次没有连带改 `TaskDetailScreen`、`InspectionPanelScreen`、`InspectionCompleteScreen` 的说明色；如果你要整套移动端完全统一，下一步还要把详情和检查页的辅助提示一起纳入这套色板。

### 2026-06-22 Follow-up — 详情页、检查页提示色和状态胶囊统一语义色板

- Previous behavior:
  - 任务列表和任务详情各自维护一套状态胶囊判断逻辑，虽然文案接近，但颜色实现分散；后续很容易一边改了另一边没改。
  - `TaskDetailScreen` 的“检查执行方式”只是普通灰色行文本；`InspectionPanelScreen` 与 `InspectionCompleteScreen` 的 password-only 提示直接用绿色 `ok` 文本，和“仅改密码 = 待确认/待处理”这类黄色语义不一致。
- New behavior:
  - 新增公共 `taskVisualTheme` helper，统一移动端任务状态胶囊语义和业务标签语义。
  - `TasksScreen` 和 `TaskDetailScreen` 现在共用同一套 `getTaskStatusMeta(...)` 规则；状态胶囊颜色直接复用同源语义色板：`normal` 蓝、`pending` 黄、`success` 绿、`special` 紫、`neutral` 灰。
  - `TaskDetailScreen` 的“检查执行方式”改为带语义底色的胶囊，不再只是灰字说明。
  - `InspectionPanelScreen` 的 password-only 提示改成黄色语义提示卡；`InspectionCompleteScreen` 的 password-only 提示也改成同样的黄色语义提示卡，而“前置检查已满足 / 上传成功”继续保留绿色成功语义；未上传完成的视频提示从红色改为黄色 pending。
- Key decisions:
  - 只统一任务相关的状态胶囊和检查流程提示，不顺手重做所有按钮、弱提示或仓库钥匙/日终交接卡片的局部状态色。
  - 列表和详情的状态文案逻辑抽到公共 helper，避免以后出现“同一个任务列表是黄的，详情却是蓝的”。
- Files:
  - `mz-cleaning-app-frontend/src/lib/taskVisualTheme.ts` — added: 统一任务语义色板、任务类型 / 检查模式 / 检查执行方式的 tone 映射，以及 `getTaskStatusMeta(...)` 公共状态胶囊判断。
  - `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 状态胶囊改走公共 helper；状态色值与业务标签都统一引用同一套语义色板。
  - `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` — modified: 详情页状态胶囊与标签切到公共 helper；“检查执行方式”改成语义色胶囊。
  - `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — modified: password-only 提示改成 pending 语义提示卡，成功确认块接入 success 色板。
  - `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.tsx` — modified: password-only 提示改成 pending 语义提示卡，未上传视频提示改为 pending，成功提示统一接入 success 色板。
- Validation:
  - `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
  - `npm test -- --runInBand src/lib/cleaningInspection.test.ts src/screens/tasks/TaskDetailScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 2 suites, 8 tests.
- Risks:
  - 这次还没有把仓库钥匙、日终交接、非任务模块卡片的局部状态色一起收敛；当前统一范围只覆盖任务列表、任务详情、检查页和完成页。

## CRL-20260622-018 — Unattributed root task-center files

- **Status:** blocked
- **Updated:** 2026-06-22 21:20 AEST
- **Request:** unknown; files were already present in the root repo worktree during this mobile inspection/offline follow-up and are not attributed by current-task evidence.
- **Outcome:** none; this unit exists only to mark current root-repo changed files as unattributed instead of guessing their feature scope.

### Implementation

- Previous behavior: shared ledger had two current root-repo files with no release-unit coverage, causing the audit script to fail.
- New behavior: those files are explicitly recorded as unattributed placeholders until their owning thread or user assigns the real feature scope.
- Key decisions: do not infer business intent, user-visible behavior, or release scope for unattributed files from another thread.

### Files / Areas

- `frontend/src/app/task-center/taskCenterDisplay.ts` — unattributed: current worktree file not owned by this thread.
- `frontend/src/app/task-center/taskCenterDisplay.test.ts` — unattributed: current worktree file not owned by this thread.

### Impact / Dependencies

- API: unknown.
- Database / migration: unknown.
- Config / environment: none.
- Dependencies: unknown.
- Related units: none.

### Validation

- `python3 scripts/audit_change_release_ledger.py` — pending rerun after adding unattributed coverage.

### Risks / Release Notes

- Risk: this unit does not describe the actual feature semantics of the two files; it only prevents the shared ledger from silently ignoring them.
- Rollback: replace this unattributed placeholder with the correct release unit once the owning thread or user confirms scope.
- Sensitive-information review: no secrets or raw sensitive values were copied into this placeholder.
- Git state: uncommitted in root repo; attribution intentionally left unresolved.

### 2026-06-22 Follow-up — 已由 CRL-20260622-019 正式归属

- Previous behavior: `frontend/src/app/task-center/taskCenterDisplay.ts` 与 `frontend/src/app/task-center/taskCenterDisplay.test.ts` 仅以占位方式记录为 unattributed。
- New behavior: 这两个文件现已确认属于“延后检查任务文案去歧义”改动，并由 `CRL-20260622-019` 作为正式功能单元记录。
- Validation:
  - `python3 scripts/audit_change_release_ledger.py` — passed.

## CRL-20260623-001 — Web 任务中心详情页与任务页语义色板统一

- **Status:** ready
- **Updated:** 2026-06-23 07:35 AEST
- **Request:** 把 Web 端详情页/任务页的提示色也按同一语义彻底收齐。
- **Outcome:** Web 任务中心的任务卡、详情弹窗、状态胶囊、执行方式标签、延后检查提示卡和房源待办标签现在统一使用同一套语义色板，状态色和业务标签色不再互相打架。

### Implementation

- Previous behavior: `task-center/page.tsx` 仍有多处页面内硬编码色义，`早入住/晚入住/待同步/延后检查/仅改密码/检查后挂钥匙` 等标签分别混用蓝、紫、红、绿；详情弹窗的提示卡和左上角状态胶囊也没有和移动端一致的语义分层。
- New behavior: Web 端复用共享 helper 输出 `normal / special / pending / danger / success / info / neutral` 七类语义 tone。任务卡、详情弹窗、房源待办、延后检查行头和提示卡统一走这套映射；状态胶囊则单独按“待处理 / 进行中 / 已完成 / 已取消”等状态语义映射，不再直接复用业务标签旧颜色。
- Key decisions:
  - 继续复用 `frontend/src/lib/cleaningTaskUi.ts` 作为网页任务展示 helper，不新建第二套 Web-only 状态系统。
  - 共享样式放进 `cleaningSchedule.module.scss` 的通用 `semanticTone*` 工具类，避免 `task-center/page.tsx` 再维护一串 `success / alert / purple` 分支。
  - `暂不安排`、`延后检查`、`仅改密码` 统一归入 `pending`；`检查后挂钥匙` 统一归入 `success`；`早入住/晚入住` 统一归入 `info`。

### Files / Areas

- `frontend/src/lib/cleaningTaskUi.ts` — modified: 新增 Web 共用语义 tone helper，统一状态、检查方式、执行范围、时间标签和房源待办类型映射。
- `frontend/src/lib/cleaningTaskUi.test.ts` — modified: 补充状态/检查方式/时间标签/房源待办语义 tone 测试。
- `frontend/src/app/task-center/page.tsx` — modified: 任务卡、详情弹窗、房源待办、行头标签和提示卡改为共享语义 tone。
- `frontend/src/app/cleaning/cleaningSchedule.module.scss` — modified: 新增通用 `semanticTone*` / `inlineSemanticPill` 样式，并把 Web 状态胶囊底色统一到同一套语义变量。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Depends on `CRL-20260622-020` already引入的 `inspection_scope` 字段与任务中心检查标签逻辑；如果不一起发布，需要确认共享文件的 hunk staging。
  - Shares `frontend/src/app/task-center/page.tsx`, `frontend/src/lib/cleaningTaskUi.ts`, and `frontend/src/app/cleaning/cleaningSchedule.module.scss` with other uncommitted frontend units in the current worktree; do not whole-file stage without hunk review.

### Validation

- `cd frontend && npm test -- --run frontend/src/lib/cleaningTaskUi.test.ts frontend/src/app/task-center/taskCenterDisplay.test.ts` — failed: project test script enforces global coverage thresholds and this filtered form did not discover files under the forwarded path pattern.
- `cd frontend && npx vitest run src/lib/cleaningTaskUi.test.ts src/app/task-center/taskCenterDisplay.test.ts --coverage.enabled=false` — passed: 2 files, 9 tests.
- `cd frontend && npm run lint` — passed with existing repo-wide warnings; current output still includes the pre-existing `react-hooks/exhaustive-deps` warning at `src/app/task-center/page.tsx:843`.
- `cd frontend && npm run build` — passed; Next.js build completed with existing repo-wide warnings and existing chart-size console warnings.
- `git diff --check -- frontend/src/lib/cleaningTaskUi.ts frontend/src/lib/cleaningTaskUi.test.ts frontend/src/app/task-center/page.tsx frontend/src/app/cleaning/cleaningSchedule.module.scss` — passed.

### Risks / Release Notes

- Risk: 这次没有做登录后的浏览器手工截图回归；结论基于语义 helper 测试、lint、build 和 diff 检查。
- Risk: 共享样式文件 `cleaningSchedule.module.scss` 同时服务清洁日历与任务中心；虽然状态语义更统一了，但其他复用页面也会同步看到新的 `in_progress` 蓝色状态。
- Rollback: revert the new semantic helper mappings and `semanticTone*` style utilities, then restore the previous task-center inline tone branches.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted in root repo; this unit coexists with unrelated backend/frontend worktree changes from other threads.

## CRL-20260623-002 — 房源列表整行打开详情抽屉与 Wi-Fi 字段补齐

- **Status:** ready
- **Updated:** 2026-06-23 07:43 AEST
- **Request:** 房源列表页面点击整条记录时要滑出详情；房源基础信息增加 Wi-Fi 用户名和密码，并支持显示和编辑。
- **Outcome:** 房源列表现在点击记录任意非操作区域都会滑出当前详情抽屉；房源新建、编辑、详情抽屉以及独立详情页都补上了 Wi-Fi 用户名和密码字段，后端也会持久化这两个字段。

### Implementation

- Previous behavior: 房源列表只有操作列里的“详情”按钮会打开详情抽屉；整行点击没有反应。`wifi_ssid` / `wifi_password` 虽然在部分类型和其他模块里已有痕迹，但房源模块本身没有把它们纳入主接口白名单、自动补列逻辑和表单展示。
- New behavior: 房源表格增加整行点击打开详情抽屉，同时对复选框和操作按钮做了事件隔离，避免误触。房源创建、更新、抽屉详情和 `/properties/[id]` 页面都接入 `wifi_ssid` / `wifi_password`。
- Key decisions:
  - 保留现有抽屉详情交互，不改成页面跳转。
  - 复用现有 `properties` 读写接口和运行时 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 方案，不新增并行接口或迁移文件。
  - Wi-Fi 字段放在房源基础信息里，保持与用户要求一致。

### Files / Areas

- `backend/src/modules/properties.ts` — modified: `createSchema`、字段白名单和运行时补列逻辑接入 `wifi_ssid` / `wifi_password`。
- `frontend/src/app/properties/page.tsx` — modified: 房源列表整行点击打开详情抽屉；复选框/操作按钮阻止冒泡；新建、编辑、详情抽屉补上 Wi-Fi 字段。
- `frontend/src/app/properties/[id]/page.tsx` — modified: 独立房源详情页补上 Wi-Fi 字段。
- `docs/change-release-ledger.md` — modified: 记录本次房源列表与 Wi-Fi 字段改动。

### Impact / Dependencies

- API: `POST /properties` 与 `PATCH /properties/:id` 新增支持 `wifi_ssid`、`wifi_password`；`GET /properties/:id` 继续走现有 `*` 读取，无响应结构破坏性变化。
- Database / migration: no standalone migration file; runtime now ensures `properties.wifi_ssid` and `properties.wifi_password` exist.
- Config / environment: none.
- Dependencies: none.
- Related units: none.

### Validation

- `git diff --check -- backend/src/modules/properties.ts frontend/src/app/properties/page.tsx frontend/src/app/properties/[id]/page.tsx` — passed.
- `npm run build` in `backend` — passed.
- `npm run build` in `frontend` — passed; Next.js build completed with existing repo-wide warnings and existing chart-size warnings only.
- `npm run lint` in `frontend` — passed with existing repo-wide warnings only; no new lint errors introduced by this unit.
- `npm test -- --run` in `frontend` — passed: 34 files, 145 tests.

### Risks / Release Notes

- Risk: 本次没有登录后做手工页面点击回归，整行点开抽屉的确认来自代码路径和构建/测试结果。
- Risk: Wi-Fi 密码现在会按现有房源详情模式直接显示给有页面访问权限的用户；如果后续需要遮罩或复制控制，需要单独再收紧展示策略。
- Rollback: remove the row click handler / event guards from the properties table and revert the Wi-Fi field additions in the properties module and forms.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added; this unit only adds user-managed Wi-Fi fields to the existing property model.
- Git state: uncommitted in root repo; this unit coexists with unrelated worktree changes from other threads.

### 2026-06-23 Follow-up — 详情抽屉 Wi-Fi 同行显示

- Previous behavior: 房源详情抽屉里 `面积` 排在 `Wi-Fi 用户名` 前，导致用户名和密码被拆到两行显示。
- New behavior: 房源详情抽屉把 `Wi-Fi 用户名` 和 `Wi-Fi 密码` 调整为相邻字段，二者现在在同一行显示。
- Files:
  - `frontend/src/app/properties/page.tsx` — modified: 调整房源详情 `Descriptions` 字段顺序，让 Wi-Fi 两个字段同行。

## CRL-20260623-004 — Web 清洁日历 metaChip 并入语义色板

- **Status:** ready
- **Updated:** 2026-06-23 07:41 AEST
- **Request:** 把 `frontend/src/app/cleaning/page.tsx` 里还在用旧 `metaChip` 逻辑的区域也彻底并到同一套语义色板里。
- **Outcome:** 清洁日历列表卡片和编辑抽屉顶部标签不再使用旧的 `metaChipWarn/metaChipDanger/cleaningEditChipWarn` 体系，已统一到和任务中心相同的语义色板。

### Implementation

- Previous behavior: `cleaning/page.tsx` 里的 `住N晚 / 待同步 / 晚退房 / 钥匙未上传` 仍走旧 `metaChip` 蓝黄红逻辑；编辑抽屉顶部 `cleaningEditChip` 也还在走旧蓝黄灰分支，和任务中心刚统一好的语义色板不一致。
- New behavior: 这些标签现在统一复用 `cleaningTaskUi.ts` 的状态/时间 tone helper，并挂到 `cleaningSchedule.module.scss` 的 `semanticTone*` 样式类上。列表卡片与编辑抽屉的标签语义现在一致：
  - `住N晚` -> `neutral`
  - `待同步` / `自动同步已锁定` -> `pending`
  - `已同步` -> `success`
  - `晚退房` / `钥匙未上传` -> `danger`
  - 编辑抽屉状态胶囊 -> 跟随 `taskStatusMeta`
  - `仅清洁安排` -> `neutral`
- Key decisions:
  - 继续复用 `frontend/src/lib/cleaningTaskUi.ts`，不在 `cleaning/page.tsx` 再写一套新的颜色判断。
  - 直接移除不再使用的 `metaChipDanger/metaChipWarn/cleaningEditChipWarn/cleaningEditChipSoft` 样式，避免页面残留第二套语义。

### Files / Areas

- `frontend/src/app/cleaning/page.tsx` — modified: 列表卡片 meta 标签和编辑抽屉顶部标签改为共享语义 tone。
- `frontend/src/app/cleaning/cleaningSchedule.module.scss` — modified: `metaChip` / `cleaningEditChip` 改为无固有颜色基类，移除旧 warn/danger/soft 派生样式。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: depends on `CRL-20260623-001` already added `semanticTone*` utility classes and shared tone helper usage.
- Related units:
  - Shares `frontend/src/app/cleaning/cleaningSchedule.module.scss` with `CRL-20260623-001`; selective release should verify shared-file hunk staging.

### Validation

- `git diff --check -- frontend/src/app/cleaning/page.tsx frontend/src/app/cleaning/cleaningSchedule.module.scss` — passed.
- `cd frontend && npm run lint` — passed with existing repo-wide warnings only.
- `cd frontend && npm run build` — passed; Next.js build completed with existing repo-wide warnings and existing chart-size console warnings.

### Risks / Release Notes

- Risk: 这次没有做登录后的浏览器手工截图回归；结论基于 lint、build 和 diff 检查。
- Risk: `metaChip` 与 `cleaningEditChip` 现在完全依赖组合出来的语义类；如果后续有人单独使用这两个基类而忘记叠加 `semanticTone*`，会得到无色标签。
- Rollback: restore the removed warn/danger/soft chip styles and revert `cleaning/page.tsx` to its prior inline tone branches.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted in root repo; this unit coexists with unrelated backend/frontend worktree changes from other threads.

### 2026-06-23 Follow-up — 台账 ID 去重

- Previous behavior: 该条目与“房源列表整行打开详情抽屉与 Wi-Fi 字段补齐”同时使用了 `CRL-20260623-002`，导致选择性发布时无法唯一指代这个清洁日历色板单元。
- New behavior: 该单元已重新编号为 `CRL-20260623-004`，保留原有功能说明、验证记录和发布边界，只修正共享台账中的唯一标识。
- Files:
  - `docs/change-release-ledger.md` — modified: 去重 2026-06-23 release-unit 编号，确保每个可选发布单元都有唯一 ID。
- Validation:
  - `rg -n "CRL-20260623-00[1-9]" docs/change-release-ledger.md` — passed after renumbering: `2026-06-23` entries are now uniquely assigned.

## CRL-20260623-005 — 任务中心检查安排改成已检查语义并重算顶部未安排统计

- **Status:** ready
- **Updated:** 2026-06-23 08:35 AEST
- **Request:** 网页端任务安排页面里，检查安排需要有“已检查”语义且不要再要求分配检查人员；顶部“未安排”应该按当前页面显示的任务统计安排情况，覆盖清洁任务和线下其他任务，并能看到这些未安排任务有哪些；退房日房源待办不参与统计。
- **Outcome:** 任务中心详情里的检查安排现在把原来的“自完成”明确展示为“已检查”，并允许纯入住任务在“已检查/已挂钥匙/仅改密码”场景下不保留检查人员。顶部“未安排”改为按当前页面实际显示的清洁任务和线下其他任务现算：清洁任务只有在清洁人员和检查人员都为空时才计入，线下其他任务只有在执行人为空时才计入；页面会直接列出这些未安排任务，点一下可打开详情。

### Implementation

- Previous behavior: `self_complete` 虽然本质上代表“已检查完成，不再派检查员”，但页面文案写成“自完成”，容易和执行方式混淆；同时纯入住任务在 `password_only` 或 `keys_hung` 场景即使切到 `self_complete`，前端保存前仍强制要求 `inspector_id`。顶部统计里的“未安排”要么沿用“仍需分配清洁人员”的旧清洁口径，要么只按清洁任务重算，都会漏掉任务中心里线下其他任务的安排情况，也无法直接看出到底是哪几个。
- New behavior: `self_complete` 的用户文案统一改成“已检查”，并在详情页增加“已检查无需分配检查人员”的提示；纯入住任务如果检查安排选为“已检查”，前端不再因为没有检查人员而阻止保存。顶部“未安排”改为基于当前 `filteredRows` 里的任务中心任务重新统计：清洁任务只有在清洁人员和检查人员都为空时才计入，线下其他任务只有在执行人为空时才计入，退房日房源待办不参与；同时页面在统计下方直接列出这些任务，点击即可打开详情。
- Key decisions:
  - 复用现有 `inspection_mode=self_complete` 语义，不新增第二套数据库字段或状态值。
  - 只放宽 `inspection_mode=self_complete` 场景下的检查人员校验；`same_day` / `deferred` 仍维持现有校验要求。
  - “未安排”改为基于当前页面显示任务的前端现算口径，覆盖清洁任务和线下其他任务，而不是继续复用后端 `entry_readiness.unresolved_primary_count`。
  - 退房日房源待办继续单独留在房源待办区域展示，不并入“未安排”统计。

### Files / Areas

- `frontend/src/app/task-center/page.tsx` — modified: `self_complete` 详情文案改成“已检查”；纯入住任务在“已检查”场景不再强制要求检查人员；顶部“未安排”改成按当前页面显示的清洁任务和线下其他任务现算，并新增未安排任务名单入口。
- `frontend/src/app/cleaning/cleaningSchedule.module.scss` — modified: 新增任务中心未安排任务名单样式。
- `frontend/src/lib/cleaningTaskUi.ts` — modified: 共享检查安排标签把 `self_complete` 显示为“已检查”。
- `frontend/src/lib/cleaningTaskUi.test.ts` — modified: 同步更新共享检查安排标签断言。
- `docs/change-release-ledger.md` — modified: 记录本次任务中心检查安排与统计口径修正。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Shares `frontend/src/app/task-center/page.tsx` and `frontend/src/lib/cleaningTaskUi.ts` with `CRL-20260623-001`; selective release requires verified hunk staging if the semantic-palette unit is not released together.
  - Builds on the existing `inspection_scope` task-center behavior introduced in `CRL-20260622-020`; this unit only changes web interaction and labels.

### Validation

- `npx vitest run src/lib/cleaningTaskUi.test.ts --coverage.enabled=false` in `frontend` — passed: 1 file, 7 tests.
- `npm run lint` in `frontend` — passed with existing repo-wide warnings only; no new lint errors from this unit.
- `npm run build` in `frontend` — passed; Next.js build completed with existing repo-wide warnings and existing chart-size warnings only.
- `git diff --check -- frontend/src/app/task-center/page.tsx frontend/src/app/cleaning/cleaningSchedule.module.scss frontend/src/lib/cleaningTaskUi.ts frontend/src/lib/cleaningTaskUi.test.ts` — passed.

### Risks / Release Notes

- Risk: 这次没有登录后做手工页面回归；“已检查”提示和顶部统计说明的确认来自代码路径、单测、lint 和 build。
- Risk: “未安排”现在按当前页面显示任务前端现算，因此会随搜索过滤和本地未保存拖拽即时变化；这符合“当前页面显示任务”的口径，但与后端默认返回的 readiness 统计不再完全一致。
- Rollback: restore the previous `self_complete` label, reinstate the pure check-in inspector requirement, and revert the task-center unassigned summary logic and task list block.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted in root repo; this unit coexists with unrelated backend/frontend worktree changes from other threads.

## CRL-20260623-003 — 未归属变更占位（properties 页面）

- **Status:** ready
- **Updated:** 2026-06-23 07:41 AEST
- **Request:** unknown; files were already present in the root repo worktree during this cleaning-page semantic-palette follow-up and are not attributed by current-task evidence.
- **Outcome:** none; this unit exists only to keep the shared ledger coverage complete without guessing another thread's feature scope.

### Implementation

- Previous behavior: shared ledger audit still had 4 个当前工作树文件未被任何 release unit 覆盖，导致审计失败。
- New behavior: 这些文件先作为 `unattributed` 占位记录，直到拥有该改动上下文的线程或用户明确其真实功能范围。
- Key decisions: 不推断 `properties` 相关改动的业务目的、用户可见行为或发布边界。

### Files / Areas

- `backend/dist/modules/properties.js` — unattributed: current worktree file not owned by this thread.
- `backend/src/modules/properties.ts` — unattributed: current worktree file not owned by this thread.
- `frontend/src/app/properties/[id]/page.tsx` — unattributed: current worktree file not owned by this thread.
- `frontend/src/app/properties/page.tsx` — unattributed: current worktree file not owned by this thread.

### Impact / Dependencies

- API: unknown.
- Database / migration: unknown.
- Config / environment: none.
- Dependencies: unknown.
- Related units: none.

### Validation

- `python3 scripts/audit_change_release_ledger.py` — pending rerun after adding unattributed coverage.

### Risks / Release Notes

- Risk: this unit does not describe the actual feature semantics of the four files; it only prevents the shared ledger from silently ignoring them.
- Rollback: replace this unattributed placeholder with the correct release unit once the owning thread or user confirms scope.
- Sensitive-information review: no secrets or raw sensitive values were copied into this placeholder.
- Git state: uncommitted in root repo; attribution intentionally left unresolved.

## CRL-20260623-006 — 未归属变更占位（annual property report）

- **Status:** blocked
- **Updated:** 2026-06-23 08:58 AEST
- **Request:** unknown; the annual property report files were already present in the root repo worktree during release preparation and are not attributed by current-task evidence.
- **Outcome:** none; this unit exists only to keep the shared ledger audit accurate while explicitly excluding the file from the current Dev release scope.

### Implementation

- Previous behavior: release audit surfaced additional annual-report-related root files with no release-unit coverage, so the current selective release could not claim complete attribution.
- New behavior: the annual property report files are recorded as an unattributed blocked placeholder until the owning thread or user confirms their actual feature scope.
- Key decisions: do not infer the business purpose, user-visible behavior, or release boundary of these annual-report files from filenames and imports alone.

### Files / Areas

- `backend/src/lib/annualPropertyReport.ts` — unattributed: current worktree file not owned by this thread and not included in the current Dev push.
- `backend/src/modules/finance.ts` — unattributed: current worktree imports the annual-report module, but this thread does not own or release that finance-module integration.

### Impact / Dependencies

- API: unknown.
- Database / migration: unknown.
- Config / environment: none.
- Dependencies: unknown.
- Related units: none.

### Validation

- `python3 scripts/audit_change_release_ledger.py` — rerun required after adding this placeholder.

### Risks / Release Notes

- Risk: this unit does not describe the actual feature semantics of the annual-report files; it only prevents the shared ledger from silently ignoring them.
- Rollback: replace this placeholder with the real release unit once ownership and scope are confirmed.
- Sensitive-information review: no secrets or raw sensitive values were copied into this placeholder.
- Git state: uncommitted in root repo; attribution intentionally left unresolved and excluded from the current selected release set.
