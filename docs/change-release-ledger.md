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

### 2026-06-24 Deferred Inspection Follow-up

- Follow-up request:
  - 延期检查任务在检查员移动端完成后仍要留在“今日任务”，不要完成后消失。
  - admin 页“今日工作情况”里，延期检查完成后统计没有变化。
  - 清洁“进行中 1905”不能被误解成检查人员也在“进行中 1905”。
- Follow-up behavior change:
  - 延期检查完成后，仍按其 `inspection_due_date` 继续投影到当天任务列表，检查员在移动端标记完成后不会立刻从“今日任务”消失。
  - manager 端“今日工作情况”重新按 `work_tasks` 的角色化清洁/检查任务统计，不再从一条混合任务行同时推断两种角色状态。
  - 因此清洁和检查的“已完成/进行中/待处理”房号会分别计算；清洁的进行中房号不会再错误显示到检查员名下，延期检查完成数也会随检查任务状态同步更新。

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

## CRL-20260624-001 — 移动端补齐晚入住标签

- **Status:** pushed
- **Updated:** 2026-06-24 10:44 AEST
- **Request:** 移动端修改入住时间，不出现晚入住的标签为什么。
- **Outcome:** 移动端任务列表和详情页在入住时间晚于默认 `3pm` 时，现可显示 `晚入住` 标签；根因是原逻辑只处理了 `早入住`，没有实现 `晚入住` 分支。

### Implementation

- Previous behavior: `mz-cleaning-app-frontend` 仅在入住时间早于 `3pm` 时显示 `早入住`，入住时间晚于 `3pm` 不会显示任何对应标签。
- New behavior: 复用共享时间解析逻辑，新增 `晚入住` 判断；任务列表和详情页统一在 `checkin_time/end_time > 3pm` 时显示 `晚入住`。
- Key decisions: 不改后端接口、不改数据结构，只修移动端展示层并补测试，保持和网页端时间标签语义一致。

### Files / Areas

- `mz-cleaning-app-frontend/src/lib/taskTime.ts` — modified: 新增 `isLateCheckinTime` 和可复用的 `isLateCheckoutTime` 判断。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 列表页补充 `晚入住` 标签渲染。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` — modified: 详情页补充 `晚入住` 标签渲染。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx` — modified: 新增列表页晚入住标签测试。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` — modified: 新增详情页晚入住标签测试。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: `CRL-20260622-004` and earlier mobile timing-tag work touch the same task surfaces but do not require joint release.

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with existing warnings only; no new lint errors introduced by this fix.
- `npm test -- --runInBand src/screens/tabs/TasksScreen.test.tsx src/screens/tasks/TaskDetailScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 2 suites, 8 tests.
- `git -C mz-cleaning-app-frontend diff --check` — passed.
- `npm run build` in `mz-cleaning-app-frontend` — not run: this package has no `build` script.

### Risks / Release Notes

- Risk: `TasksScreen.tsx` and `TaskDetailScreen.tsx` already contain unrelated in-progress changes in the current worktree; releasing this fix selectively from the nested repo still requires careful staging.
- Rollback: remove the `isLateCheckinTime` usage and the two `晚入住` render branches.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted in nested repo `mz-cleaning-app-frontend`; root repo ledger updated but not committed.

## CRL-20260624-002 — 将线下任务新建入口迁到每日清洁页

- **Status:** pushed
- **Updated:** 2026-06-24 10:55 AEST
- **Request:** 把任务安排的新增线下任务挪去每日清洁页面里。
- **Outcome:** 任务安排页不再提供“新增线下任务”；每日清洁页在“当日任务”的“线下任务”标签下新增同功能入口和创建弹窗。

### Implementation

- Previous behavior: 线下任务只能从任务安排页创建；每日清洁页虽然能查看、编辑、删除线下任务，但没有新建入口。
- New behavior: 每日清洁页复用现有 `/cleaning/offline-tasks` 创建接口，在 `taskListTab === 'offline'` 时显示“新增线下任务”按钮；任务安排页移除对应按钮和弹窗。
- Key decisions: 只迁移前端入口，不改后端接口、不改数据模型；继续复用每日清洁页已有的 `propertyOptions`、`allStaffOptions`、`urgencyOptions` 和线下任务样式。

### Files / Areas

- `frontend/src/app/cleaning/page.tsx` — modified: 新增线下任务创建状态、提交逻辑、按钮和弹窗；入口放在每日清洁页的线下任务 tab 内。
- `frontend/src/app/task-center/page.tsx` — modified: 移除任务安排页的线下任务新建入口和弹窗，保留原有安排/保存逻辑。

### Impact / Dependencies

- API: 继续使用现有 `POST /cleaning/offline-tasks`；请求结构不变。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: `CRL-20260622-003` and task-scheduling related work share task-center / cleaning surfaces, but this次只迁移入口，不依赖后端联动改动。

### Validation

- `npm run build` in `frontend` — passed; Next.js build completed all 93 pages. Existing chart width warnings remain.
- `npm run lint` in `frontend` — passed with existing repository warnings only; no lint errors remain after this change.
- `npm test -- src/lib/cleaningTaskUi.test.ts src/app/task-center/taskCenterDisplay.test.ts` in `frontend` — passed: 2 files, 10 tests.
- `git diff --check -- frontend/src/app/task-center/page.tsx frontend/src/app/cleaning/page.tsx docs/change-release-ledger.md` — passed.

### Risks / Release Notes

- Risk: `frontend/src/app/task-center/page.tsx` and `frontend/src/app/cleaning/page.tsx` already had unrelated in-progress edits in the worktree before this request; selective staging must use verified hunks.
- UX note: 新建按钮只在每日清洁页切到“线下任务”标签时显示，避免和清洁任务操作混在一起。
- Rollback: restore the task-center create button/modal and remove the new create button/modal from the cleaning page.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted in root repo; shared ledger updated.

## CRL-20260624-003 — 每日清洁页线下任务按钮位置与编辑回填修复

- **Status:** pushed
- **Updated:** 2026-06-24 11:04 AEST
- **Request:** 线下任务创建按钮和顶部“新增清洁任务”按钮放在一起，去掉 `+` 图标；每日清洁编辑清洁任务时保留已有后续内容，并修复入住天数 `6晚` 未回填到编辑框的问题。
- **Outcome:** 每日清洁页顶部按钮区现在并排显示“新增清洁任务 / 新增线下任务”，两个按钮都不再显示 `+` 图标；编辑清洁任务时会优先保留当前卡片的备注/特殊要求文本，并在入住排期缺少 `checkinRows.nights_override` 时回退使用任务卡上的晚数，避免 `6晚` 这类值在编辑框里丢失。

### Implementation

- Previous behavior: 线下任务创建按钮只在线下任务 tab 的次级区域显示，并带有 `+` 图标；编辑抽屉回填备注时会从同组任务里取第一个非空值，可能覆盖当前卡片自身内容；入住天数只读 `checkinRows[].nights_override`，当卡片展示有 `6晚` 但该字段为空时，编辑框会显示为空。
- New behavior: 线下任务创建入口移到页面顶部主按钮区，和“新增清洁任务”“Backfill”同级显示，且不再渲染图标；编辑抽屉回填时优先使用当前点击任务的 `guest_special_request/note`，其次才回退到卡片级别或同组选中行；入住天数优先取排期明细值，缺失时回退到任务卡的 `it.nights`。
- Key decisions: 不改接口、不改数据结构，只修正前端入口摆放和编辑态回填逻辑，保持创建流程与现有每日清洁页实现一致。

### Files / Areas

- `frontend/src/app/cleaning/page.tsx` — modified: 调整顶部按钮布局，移除 `PlusOutlined` 图标；修正编辑抽屉备注/特殊要求与入住天数回填逻辑。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: `CRL-20260624-002` 先把线下任务创建入口迁到每日清洁页；本次在同一页面上继续修正入口位置和编辑回填，不依赖后端改动。

### Validation

- `npm run build` in `frontend` — passed; Next.js build completed all 93 pages. Existing repository lint warnings and chart width warnings remain.
- `npm run lint` in `frontend` — passed with existing repository warnings only; no new lint errors introduced by this fix.
- `npm test -- src/lib/cleaningTaskUi.test.ts src/app/task-center/taskCenterDisplay.test.ts` in `frontend` — passed: 2 files, 10 tests.
- `git diff --check -- frontend/src/app/cleaning/page.tsx docs/change-release-ledger.md` — passed after ledger update.

### Risks / Release Notes

- Risk: `frontend/src/app/cleaning/page.tsx` already contained unrelated in-progress edits before this request; selective staging still needs verified hunks.
- UX note: 线下任务按钮现在固定显示在顶部主按钮区，不再要求先切到“线下任务”标签再点击。
- Rollback: move the offline-task button back to the tab area, restore the icon, and remove the edit-form fallback logic.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted in root repo; shared ledger updated.
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

- **Status:** pushed
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

- **Status:** pushed
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
- `python3 scripts/audit_change_release_ledger.py` — passed after the merged-record staff-summary fix: 60 changed files recorded, coverage PASS.

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

- **Status:** pushed
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

- **Status:** pushed
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

- **Status:** pushed
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

- **Status:** pushed
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

- **Status:** pushed
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

- **Status:** pushed
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

- **Status:** pushed
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

## CRL-20260623-006 — 房源年度报告模块（FY2026）

- **Status:** pushed
- **Updated:** 2026-06-23 09:07 AEST
- **Request:** 实现房源年度报告模块：在 `财务管理 > 房源表现` 下新增 `/finance/performance/annual` 页面，FY2026 固定为 `2025-07` 到 `2026-06`；`2025-07` 到 `2026-01` 为只认手工数据的月份，`2026-02` 到 `2026-06` 为系统计算月份；预览和 PDF 必须共享同一个后端 `AnnualPropertyReport` 对象，并满足手工月不回落、缺数据不等于 `0`、历史管理费规则、Draft / Incomplete 标识等硬规则。
- **Outcome:** 系统新增了年度报告后端聚合接口、手工月存储表和 FY2026 年报页面。手工月份删除后会稳定显示 `missing_manual`，系统月缺可信数据时显示 `missing_system_data`，PDF 文件名和页面状态统一，旧 `/finance/annual-statement` 已重定向到新入口。

### Implementation

- Previous behavior: 年报相关展示主要依赖旧的 fiscal-year statement 原型，前端自行用 `orders + txs` 计算；没有独立的年度报告聚合接口、没有手工月存储表，也没有针对 FY2026 手工/系统混合区间的后端硬规则。
- New behavior: 后端统一生成 `AnnualPropertyReport`，固定返回 `months[]`、`totals`、`owner_current`、`report_owner_snapshot`、`report_status` 和 `warnings[]`；前端页面、旧财年预览弹窗和 PDF 导出只消费同一个报告对象，不再各自拼 totals 或重算管理费。
- Key decisions:
  - 手工区间固化在后端：FY2026 的 `2025-07` 到 `2026-01` 永远只认 `manual`，删除手工月后返回 `missing_manual`，即使系统存在订单也绝不回落。
  - `0` 与缺失严格分离：可信 0 值继续返回数值 `0`，缺数据返回 `null + missing_* + is_complete=false`，不再静默渲染成 `$0.00`。
  - 系统月管理费只按该月生效的历史规则计算；缺规则时返回 warning，并把当月标记为不完整，不用当前费率反推历史。
  - `report_owner_snapshot` 在 v1 明确等于生成时的当前房东信息，仅把语义固化到返回结构，不做历史房东快照迁移。

### Files / Areas

- `backend/src/lib/annualPropertyReport.ts` — created: 年度报告核心聚合、FY2026 月份定义、manual/system 判定、历史管理费规则匹配、owner snapshot 语义和 totals 汇总。
- `backend/src/modules/finance.ts` — modified: 新增年度报告读取、手工月列表、手工月保存、手工月删除接口，并对写操作要求 `finance.payout`。
- `backend/scripts/schema.sql` — modified: 增加 `property_annual_report_manual_months` 表和索引。
- `backend/scripts/schema_neon.sql` — modified: 同步 Neon schema 的年度报告手工月表定义。
- `backend/scripts/migrations/20260623_property_annual_report_manual_months.sql` — created: 年度报告手工月表迁移。
- `backend/scripts/tests/test_annual_property_report.ts` — created: 覆盖 FY2026 月份边界、manual 优先、删除后不回落、system 缺数据、管理费规则缺失和历史费率切换。
- `backend/dist/modules/finance.js` — modified: `backend` 构建产物，反映年度报告接口变更。
- `frontend/src/lib/annualReport.ts` — created: 前端共享年度报告类型、月份工具、Draft / Incomplete 判断、PDF 文件名和金额格式化。
- `frontend/src/lib/annualReport.test.ts` — created: 覆盖年份月份定义、下载按钮禁用条件、Draft 判断、手工/月系统月可编辑性和路由常量。
- `frontend/src/lib/api.ts` — modified: 补充 `putJSON`、`deleteJSON` 供手工月保存/删除复用，并清理重复定义。
- `frontend/src/components/FiscalYearStatement.tsx` — modified: 改成纯展示组件，只渲染 `AnnualPropertyReport`，不再自行用原始订单和流水重算。
- `frontend/src/app/finance/performance/annual/page.tsx` — created: 新年度报告页面，包含财年/房源选择、手工月录入、状态提示、预览和 PDF 下载。
- `frontend/src/app/finance/annual-statement/page.tsx` — modified: 旧地址重定向到 `/finance/performance/annual`，避免两套系统并存。
- `frontend/src/app/finance/properties-overview/page.tsx` — modified: 旧财年预览弹窗切换为读取后端年度报告对象，和新模块保持同一数据口径。
- `frontend/src/lib/adminNavigation.ts` — modified: 在 `财务管理 > 房源表现` 下新增“年度报告”子菜单入口。

### Impact / Dependencies

- API:
  - `GET /finance/annual-report?property_id=<id>&fy=2026`
  - `GET /finance/annual-report/manual-months?property_id=<id>&fy=2026`
  - `PUT /finance/annual-report/manual-months/:propertyId/:monthKey`
  - `DELETE /finance/annual-report/manual-months/:propertyId/:monthKey`
- Database / migration: 新增 `property_annual_report_manual_months` 表，唯一键为 `property_id + month_key`，并记录 `currency`、`is_complete`、`created_by`、`updated_by` 等字段。
- Config / environment: none.
- Dependencies: 复用现有 `exportElementToPdfBlob`、房源/房东关系、历史管理费规则和现有财务导航结构；不新增独立发送系统。
- Related units: none.

### Validation

- `git diff --check` — passed.
- `npm run build` in `backend` — passed; TypeScript build completed after annual-report service and finance routes were added.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_annual_property_report.ts` in `backend` — passed; focused annual-report assertions completed with exit code `0`.
- `npx vitest run src/lib/annualReport.test.ts` in `frontend` — passed.
- `npm run lint` in `frontend` — passed with existing repository warnings only; no new lint errors from the annual-report unit.
- `npm run build` in `frontend` — passed; Next.js production build generated `/finance/performance/annual` and `/finance/annual-statement` redirect output. Existing chart-size warnings remain pre-existing noise.

### Risks / Release Notes

- Risk: 年报页面和 PDF 已共享同一报告对象与同一展示组件，但本轮没有接入真实登录态做完整浏览器端手工录入回归，主要依赖 build、单测和聚合规则测试。
- Risk: 当前支持范围固定为 FY2026，且手工区间固定为 `2025-07` 到 `2026-01`；后续若要支持更多财年，需要同步扩展后端月份规则和测试。
- Rollback: revert the annual-report backend routes/service, remove the manual-month migration/table, and restore the old fiscal-year statement route behavior.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted in root repo; this unit coexists with unrelated worktree changes from other threads.

### 2026-06-23 Follow-up — 年报零支出行隐藏与英文/双语版

- Previous behavior: 年报预览和 PDF 会无条件显示全部支出行，即使整年某个支出项始终为 `0`；同时虽然已有中英混排版，但没有正式的英文版/中英双语版切换，英文模式下 warning/status 也没有统一前端翻译。
- New behavior:
  - 年报现在只在“全年总额为 `0` 且所有月份都已确认没有该支出”时隐藏该支出行；只要某个月缺数据或值未知，就继续显示，避免 Draft/Incomplete 报告误判“全年无此支出”。
  - `/finance/performance/annual` 新增报告语言选择，支持 `English` 和 `English + 中文` 两种版本；页面预览与 PDF 仍共用同一 DOM，因此下载内容和当前显示完全一致。
  - 年报展示层补充了行名、月份状态和 warning 的英文/双语前端映射，英文版不再混杂原始中文 warning 文案。
- Files:
  - `frontend/src/lib/annualReport.ts` — modified: 新增语言类型、英文行名、warning/status 文案映射，以及“可见支出行”判断 helper。
  - `frontend/src/components/FiscalYearStatement.tsx` — modified: 按全年确认结果隐藏零支出行，并根据语言模式切换行名、状态和 warning 文案。
  - `frontend/src/app/finance/performance/annual/page.tsx` — modified: 增加 English / English + 中文 选择器，并让 PDF 继续复用当前预览语言版本。
  - `frontend/src/lib/annualReport.test.ts` — modified: 增加零支出行隐藏和英文文案 helper 的断言。
- Validation:
  - `npx vitest run src/lib/annualReport.test.ts` in `frontend` — passed: 1 file, 8 tests.
  - `npm run lint` in `frontend` — passed with existing repository warnings only; no new lint errors from this follow-up.
  - `npm run build` in `frontend` — passed; annual report page rebuilt successfully. Existing repo-wide lint warnings and chart-size warnings remain.
  - `git diff --check` — passed.

## CRL-20260623-007 — 移动端弱网任务页缓存保活与统一消耗品目录 Store

- **Status:** pushed
- **Updated:** 2026-06-23 13:28 AEST
- **Request:** 修复清洁 App 在弱网或无网时，任务页和消耗品补充项明明已有本地数据却仍显示整页错误或空白的问题；任务页要求“有缓存不被失败覆盖”，消耗品列表要求统一走同一个本地缓存 store，并且消耗品拍照的照片也要可以离线缓存。
- **Outcome:** 任务页现在会先 hydrate 本地任务缓存，再后台刷新；刷新失败但已有缓存时继续展示列表并提示弱网，不再整页报错。消耗品相关页面统一改为共享 `useSuppliesCatalogStore`，有缓存时离线仍显示上次目录，无缓存且拉取失败时才显示重试错误态。消耗品照片改为先保存到 App 私有目录并写入任务级 draft，弱网下退出重进后仍可继续，真正提交时再补上传远程 URL。

### Implementation

- Previous behavior:
  - `TasksScreen` 首次进入虽然已有 `workTasksStore` 缓存能力，但初始化与刷新失败时仍可能走整页 `loadError`，把已缓存任务的可见性盖掉。
  - `InspectionPanelScreen`、`SuppliesFormScreen`、`CleaningSelfCompleteScreen` 分别使用各自的 checklist 获取/缓存策略，其中 `CleaningSelfCompleteScreen` 仍直接依赖实时 `listChecklistItems`。
  - `SuppliesFormScreen` 既要拉目录又要拉已填记录，但目录缓存和记录缓存是分离且页面私有的，弱网下容易出现“有历史数据但目录为空”的空白状态。
  - 消耗品拍照仍是“拍完立即上传，页面只保留远程 URL”；一旦拍照当下网络失败，本地不会留下可继续提交的照片草稿。
- New behavior:
  - `TasksScreen` 初始化先 hydrate `workTasksStore`，如果已有缓存则立即展示，并在顶部显示“本地缓存/正在同步”提示；网络刷新失败时仅在“无缓存 + 首次失败”场景展示整页错误。
  - 新增共享 `useSuppliesCatalogStore`，统一负责消耗品目录的本地缓存、legacy key 迁移、后台刷新、失败保留旧缓存和 `lastSyncedAt/isFromCache` 状态输出。
  - `InspectionPanelScreen`、`SuppliesFormScreen`、`CleaningSelfCompleteScreen` 全部改为消费共享目录 store；有缓存但接口失败时继续显示缓存目录并提示弱网，无缓存且失败时显示局部重试卡片。
  - `SuppliesFormScreen` 继续保留每个任务自己的 consumables record 缓存，但目录来源统一到共享 store，不再维护第二套目录 cache key。
  - `SuppliesFormScreen` 与 `CleaningSelfCompleteScreen` 新增共享任务级 consumables draft：拍照后先复制到 App 私有目录、将本地 `file://` URI 持久化到 draft，并在提交前逐张补上传；提交成功后清理 draft 和本地文件。
- Key decisions:
  - 复用现有 `workTasksStore` 和 `storage.ts`，不新增第二套任务缓存系统。
  - 目录缓存与任务级已填记录缓存分层：共享 store 负责“补充项目录”，页面继续负责各任务自己的填报内容。
  - 照片离线保活采用“任务级 draft + 本地私有文件”方案，不新增独立后台上传队列；只有正式提交时才要求把本地照片转成远程 URL。
  - 错误展示按页面粒度收敛：有缓存时只做轻量提示，无缓存才给出阻断式重试 UI。

### Files / Areas

- `mz-cleaning-app-frontend/src/lib/useSuppliesCatalogStore.ts` — created: 共享消耗品目录 store，负责 hydrate、refresh、legacy cache 迁移、失败保留旧缓存和 `lastSyncedAt/isFromCache` 输出。
- `mz-cleaning-app-frontend/src/lib/useSuppliesCatalogStore.test.ts` — created: 覆盖主缓存 hydrate、legacy 迁移、刷新成功落缓存、失败保留缓存、无缓存失败错误态。
- `mz-cleaning-app-frontend/src/lib/cleaningConsumablesDraft.ts` — created: 任务级消耗品 draft 与本地照片私有目录 helper，负责本地 `file://` 持久化、draft 读写与本地文件清理。
- `mz-cleaning-app-frontend/src/lib/inspectionPanelDraft.ts` — modified: 移除页面私有 checklist cache 逻辑，只保留检查页 draft 持久化职责。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 任务页改成缓存优先初始化、刷新失败保留列表、顶部缓存提示、仅“无缓存 + 首次失败”显示整页错误。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — modified: 改用共享消耗品目录 store，离线时显示缓存目录与重试提示。
- `mz-cleaning-app-frontend/src/screens/tasks/SuppliesFormScreen.tsx` — modified: 去掉页面私有目录 cache key，复用共享目录 store，并把补品照片改为先存本地 draft、提交前补上传。
- `mz-cleaning-app-frontend/src/screens/tasks/CleaningSelfCompleteScreen.tsx` — modified: 不再直接依赖实时目录接口，统一改为共享目录 store，并把消耗品照片接入同一份本地 draft。
- `docs/change-release-ledger.md` — modified: 记录本次弱网容错单元，确保跨线程审计覆盖。

### Impact / Dependencies

- API: 仍使用现有 `listChecklistItems` 与 `getCleaningConsumables`；本次只调整前端缓存与展示策略，不改接口结构。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Shares `InspectionPanelScreen` / `inspectionPanelDraft.ts` with `CRL-20260622-017`; 如果后续要选择性发布，需要按 hunk 校验这些共享文件。
  - Shares `TasksScreen.tsx` with多个尚未发布的移动端任务页改动；当前工作树不可整文件暂存。

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 124 existing warnings and 0 errors; warnings remain pre-existing style/hook issues and no new lint errors were introduced by this unit.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 19 suites, 58 tests. Jest still reports the existing open-handle notice after completion.
- `git -C mz-cleaning-app-frontend diff --check` — passed.
- `python3 scripts/audit_change_release_ledger.py` — passed after adding this ledger entry and the required unattributed annual-report placeholder coverage.
- `build` — not run: `mz-cleaning-app-frontend/package.json` has no `build` script.

### Risks / Release Notes

- Risk: 本轮没有做真机/模拟器断网手工回归，结论来自缓存初始化路径、共享 store/draft 代码路径和全量 Jest/typecheck/lint 结果。
- Risk: 消耗品照片现在默认先落本地、提交时再上传，因此照片水印的 `captured_at` 取自本地 draft 记录；如果旧 draft 缺少该元数据，会回退到提交时刻。
- Risk: `TasksScreen.tsx` 与多条并行移动端任务改动共享同一文件；若后续选择性发布，需要按 hunk 复核，不可整文件 stage。
- Rollback: remove `useSuppliesCatalogStore` adoption and `cleaningConsumablesDraft` usage from the consumables screens, then restore the previous task-page error gating while keeping any unrelated shared-file changes untouched.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted in root repo and nested `mz-cleaning-app-frontend`; this unit coexists with unrelated worktree changes from other threads.

### 2026-06-23 Follow-up — 下水口按钮不再停在“拍照中…”

- Previous behavior: `SuppliesFormScreen` 的浴室下水口按钮会进入批量连拍流程，`batchUploadingGroup='bathroom'` 一直维持到整组流程结束。用户拍完第一张后即使页面已恢复，也会感觉仍卡在“拍照中…”，在弱网场景下尤其容易被误认为是上传卡住。
- New behavior: 浴室下水口改为“每点一次只拍一张，自动填下一个空位”，不再进入整组连拍状态，也不再把 `拍照中…` 持续挂在按钮上。文案同步改成“每点一次拍 1 张”。
- Files:
  - `mz-cleaning-app-frontend/src/screens/tasks/SuppliesFormScreen.tsx` — modified: 浴室下水口按钮从整组连拍改为单张逐次拍摄，避免长时间维持 `batchUploadingGroup='bathroom'`。
- Validation:
  - `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
  - `npm run lint` in `mz-cleaning-app-frontend` — passed with 124 existing warnings and 0 errors.
  - `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 19 suites, 58 tests. Existing Jest open-handle notice remains.
  - `git -C mz-cleaning-app-frontend diff --check` — passed.

### 2026-06-23 Follow-up — 清洁任务补品填报整链路离线提交队列

- Previous behavior: 补品照片虽然已经可以本地保留，但 `SuppliesFormScreen` 和 `CleaningSelfCompleteScreen` 的补品保存仍主要依赖当次在线提交。弱网下点击“保存修改/提交”时，用户会直接看到网络错误；即使图片还在本地，也没有一条统一的后台业务提交队列在联网后自动把整份补品填报补交上去。
- New behavior: 清洁人员任务里的补品填报现在统一接入离线提交队列，而不是只兜底单次按钮报错。`SuppliesFormScreen` 与 `CleaningSelfCompleteScreen` 在遇到可重试网络错误时，会把整份补品草稿连同本地照片 URI、`property_code`、水印元数据和 `pending_submit` 状态写入同一个任务级 draft，并把任务加入 `cleaningConsumablesSubmitQueue`；登录态恢复、App 回到前台或网络恢复时，会自动尝试补传本地照片并重放 `submitCleaningConsumables`，成功后再清理 draft/队列。页面有缓存草稿时只提示“已离线保存，待联网自动同步”，不再把弱网提交直接表现成最终失败。
- Key decisions:
  - 复用已有的任务级 consumables draft 作为离线提交载体，不新增第三套离线业务存储。
  - 把“照片上传”和“补品业务提交”合并到同一条恢复链路里，避免恢复网络后只上传图片但业务单仍未提交。
  - 队列执行挂在现有 `AuthProvider` 的联网/前台维护周期里，沿用检查媒体队列的触发时机，避免每个页面各自实现后台轮询。
- Files:
  - `mz-cleaning-app-frontend/src/lib/cleaningConsumablesDraft.ts` — modified: draft 增加 `property_code`、`pending_submit` 和 `watermark_text`，让离线补交时能恢复完整补品提交上下文。
  - `mz-cleaning-app-frontend/src/lib/cleaningConsumablesSubmitQueue.ts` — created: 新增清洁任务补品填报离线提交队列，负责任务入队、去重、按需补传本地照片并自动重放 `submitCleaningConsumables`。
  - `mz-cleaning-app-frontend/src/lib/cleaningConsumablesSubmitQueue.test.ts` — created: 覆盖成功补交和可重试失败保留队列两条主路径。
  - `mz-cleaning-app-frontend/src/lib/auth.tsx` — modified: 在已登录状态的网络恢复 / 前台维护中自动处理补品离线提交队列。
  - `mz-cleaning-app-frontend/src/screens/tasks/SuppliesFormScreen.tsx` — modified: “保存修改/提交”遇到可重试网络错误时改为入队并提示待同步，同时修正 `styles.ok` 以承接离线同步状态提示。
  - `mz-cleaning-app-frontend/src/screens/tasks/CleaningSelfCompleteScreen.tsx` — modified: 自完成流程内的补品提交同样接入统一离线提交队列，并在页面内展示待同步状态。
- Validation:
  - `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
  - `npm run lint` in `mz-cleaning-app-frontend` — passed with 124 existing warnings and 0 errors; warnings remain pre-existing and no new lint errors were introduced by this follow-up.
  - `npm test -- --runInBand src/lib/cleaningConsumablesSubmitQueue.test.ts` in `mz-cleaning-app-frontend` — passed: 1 suite, 2 tests.
  - `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 20 suites, 60 tests. Existing Jest open-handle notice remains.
  - `git -C mz-cleaning-app-frontend diff --check` — passed.
- Risks:
  - 这条离线提交队列目前只覆盖“清洁任务补品填报”业务，不包括清洁任务其他非补品提交动作；这是按本次用户范围刻意收敛的结果。
  - 若服务端返回非重试型业务错误，队列会保留当前 draft 供后续人工处理，但当前实现不会主动弹出新的后台错误提示。

## CRL-20260623-008 — 未归属变更占位（annual property report 扩展）

- **Status:** blocked
- **Updated:** 2026-06-23 09:08 AEST
- **Request:** unknown; the annual property report related files below were already present in the root repo worktree during the weak-network mobile task and are not attributed by current-thread evidence.
- **Outcome:** none; this placeholder exists only to keep the shared ledger audit complete without guessing the real business scope of another thread's annual-report work.

### Implementation

- Previous behavior: shared ledger audit still reported an uncovered annual-report-related file set after `CRL-20260623-006`, so current work could not claim full worktree coverage.
- New behavior: these files are now explicitly recorded as unattributed and blocked until the owning thread or user confirms their real feature boundary.
- Key decisions: do not infer UI/API semantics from filenames; do not merge these files into the mobile weak-network release unit.

### Files / Areas

- `backend/dist/modules/finance.js` — unattributed: current worktree file not owned by this thread.
- `backend/scripts/migrations/20260623_property_annual_report_manual_months.sql` — unattributed: current worktree file not owned by this thread.
- `backend/scripts/schema.sql` — unattributed: current worktree file not owned by this thread.
- `backend/scripts/schema_neon.sql` — unattributed: current worktree file not owned by this thread.
- `backend/scripts/tests/test_annual_property_report.ts` — unattributed: current worktree file not owned by this thread.
- `frontend/src/app/finance/annual-statement/page.tsx` — unattributed: current worktree file not owned by this thread.
- `frontend/src/app/finance/performance/annual/page.tsx` — unattributed: current worktree file not owned by this thread.
- `frontend/src/app/finance/properties-overview/page.tsx` — unattributed: current worktree file not owned by this thread.
- `frontend/src/components/FiscalYearStatement.tsx` — unattributed: current worktree file not owned by this thread.
- `frontend/src/lib/annualReport.test.ts` — unattributed: current worktree file not owned by this thread.
- `frontend/src/lib/annualReport.ts` — unattributed: current worktree file not owned by this thread.
- `frontend/src/lib/api.ts` — unattributed: current worktree file not owned by this thread.

### Impact / Dependencies

- API: unknown.
- Database / migration: unknown.
- Config / environment: none.
- Dependencies: unknown.
- Related units: this placeholder expands the same annual-report ownership gap previously noted in `CRL-20260623-006`; neither placeholder should be released as a functional unit.

### Validation

- `python3 scripts/audit_change_release_ledger.py` — passed after adding this placeholder.

### Risks / Release Notes

- Risk: this unit intentionally does not describe actual feature semantics; it only prevents the shared ledger from silently ignoring unrelated changed files.
- Rollback: replace this placeholder with the real release unit once the owning thread or user confirms scope.
- Sensitive-information review: no secrets or raw sensitive values were copied into this placeholder.
- Git state: uncommitted in root repo; attribution intentionally left unresolved and excluded from the current task scope.

## CRL-20260623-009 — 移动端任务列表补充 Wi-Fi 信息与密码复制

- **Status:** pushed
- **Updated:** 2026-06-23 11:44 AEST
- **Request:** 移动端任务页面需要增加 Wi-Fi 信息，Wi-Fi 密码可以直接复制，Wi-Fi 信息从房源列表里获取。
- **Outcome:** 移动端任务列表卡片现在会直接显示房源 Wi-Fi 名称和密码；有密码时点按整行即可复制，现场人员不用再先进入详情页查 Wi-Fi。

### Implementation

- Previous behavior: `TaskDetailScreen` 已经能显示 Wi-Fi 并复制密码，但 `TasksScreen` 的任务列表卡片只显示地址、时间、门锁密码等信息，Wi-Fi 仍被埋在详情页里。
- New behavior: 清洁/检查任务卡片在地址下方新增 Wi-Fi 信息块，复用现有 `task.property.wifi_ssid` 和 `task.property.wifi_password`；有密码时显示复制入口并直接复制密码，没有密码时仍显示 SSID 但不触发复制。
- Key decisions:
  - 只复用现有 work-task payload 里的房源字段，不新增接口、缓存键或第二套房源查询。
  - 列表页只在存在 Wi-Fi 信息时渲染该区块，避免对没有 Wi-Fi 数据的任务卡片增加空白噪音。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 任务列表卡片新增 Wi-Fi 信息块和密码复制交互。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx` — created: 覆盖 Wi-Fi 信息显示和复制密码动作。
- `docs/change-release-ledger.md` — modified: 记录本次移动端 Wi-Fi 列表增强。

### Impact / Dependencies

- API: none; 继续复用现有 `/mzapp/work-tasks` 已返回的 `property.wifi_ssid` / `property.wifi_password`。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Depends on the existing property Wi-Fi payload support already present in the mobile task data path.
  - Shares `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` with `CRL-20260623-007` and other in-flight mobile task-page work; selective release still requires hunk-level staging.

### Validation

- `git -C mz-cleaning-app-frontend diff --check` — passed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm run lint -- src/screens/tabs/TasksScreen.tsx src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed with 126 existing warnings and 0 errors; warnings are pre-existing repo noise outside this Wi-Fi change.
- `npm test -- --runInBand src/screens/tabs/TasksScreen.test.tsx src/screens/tasks/TaskDetailScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 2 suites, 6 tests. Jest reported a non-failing open-handle notice after completion and a `SafeAreaView` deprecation warning during render.
- `build` — not run: `mz-cleaning-app-frontend/package.json` has no `build` script.

### Risks / Release Notes

- Risk: `TasksScreen.tsx` 当前工作树还承载其他未发布的移动端任务页改动；如果后续做选择性发布，不能整文件 stage。
- Risk: 当前复制动作只复制 Wi-Fi 密码，不复制 SSID；这是按本次需求收敛的最小实现。
- Rollback: remove the Wi-Fi info card and copy handler from `TasksScreen`, keeping unrelated shared-file changes untouched.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added; displayed Wi-Fi values are existing business data from the property model.
- Git state: uncommitted in root repo and nested `mz-cleaning-app-frontend`; this unit coexists with unrelated worktree changes from other threads.

## CRL-20260623-010 — 任务中心恢复“自完成”检查安排文案

- **Status:** pushed
- **Updated:** 2026-06-23 11:55 AEST
- **Request:** 自完成怎么没了，已检查是已检查，不是把自完成改成已检查。
- **Outcome:** 任务中心的“检查安排”下拉和相关模式标签重新显示为“自完成”，不再把 `self_complete` 模式误写成“已检查”；真正表示结果的“已检查”说明卡仍保留。

### Implementation

- Previous behavior: 任务中心近期语义色板整理后，把 `inspection_mode=self_complete` 的模式标签和下拉选项都改成了“已检查”，导致“检查安排模式”与“检查结果状态”混淆。
- New behavior: `self_complete` 在任务中心恢复成“自完成”文案，用于表达“不再派检查员的安排模式”；详情里的特殊提示仍用“已检查”解释该模式代表的结果。
- Key decisions:
  - 只修正文案语义，不改后端枚举值 `self_complete`，避免影响现有数据和移动端逻辑。
  - 保留详情提示里的“已检查”，因为那块表达的是结果说明，不是下拉模式名。

### Files / Areas

- `frontend/src/lib/cleaningTaskUi.ts` — modified: 将 `taskInspectionModeMeta('self_complete')` 标签改回“自完成”。
- `frontend/src/app/task-center/page.tsx` — modified: 任务详情“检查安排”下拉选项把 `self_complete` 文案改回“自完成”。
- `frontend/src/lib/cleaningTaskUi.test.ts` — modified: 更新 `self_complete` 标签断言，覆盖本次语义修复。
- `docs/change-release-ledger.md` — modified: 记录本次任务中心文案回归修复。

### Impact / Dependencies

- API: none; 仅修改前端展示文案，不改接口字段和值。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Shares `frontend/src/app/task-center/page.tsx` with `CRL-20260623-005`; this unit is a follow-up semantic correction on the same task-center inspection-arrangement surface.

### Validation

- `git diff --check -- frontend/src/app/task-center/page.tsx frontend/src/lib/cleaningTaskUi.ts frontend/src/lib/cleaningTaskUi.test.ts` — passed.
- `npx tsc --noEmit` in `frontend` — passed.
- `npx vitest run src/lib/cleaningTaskUi.test.ts` in `frontend` — passed: 1 file, 7 tests.
- `npm run lint` in `frontend` — passed with existing repository warnings only; no new lint errors from this change.
- `npm run build` in `frontend` — passed; Next.js production build completed successfully. Existing repo-wide lint warnings and pre-existing chart container warnings remained non-blocking.

### Risks / Release Notes

- Risk: `frontend/src/app/task-center/page.tsx` 当前与其他未发布任务中心改动共享同一文件，后续若选择性发布仍需按 hunk 暂存。
- Rollback: change the `self_complete` labels back to the prior wording in the helper and task-center select options.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted in root repo; this unit coexists with unrelated worktree changes from other threads.

## CRL-20260623-011 — 移动端任务卡片信息对齐与单卡折叠

- **Status:** pushed
- **Updated:** 2026-06-23 12:03 AEST
- **Request:** 这些图标也不对齐啊，排列很乱，要优化一下，另外每个任务可以选择收起或者展开，可以只显示图二部分，这样能看到当天更多的任务。
- **Outcome:** 移动端 `TasksScreen` 的清洁/检查任务卡片现在支持逐卡收起/展开；收起后只保留标题、状态和标签区，便于同一天查看更多任务。展开后的地址、Wi-Fi、时间、晚数、密码、客需、入住指南等信息统一采用同一套图标轨道和内容栅格，图标与文本对齐明显更稳定。

### Implementation

- Previous behavior: 任务卡片详情区的地址、Wi-Fi、时间、晚数、密码等信息行分别使用不同的图标尺寸、对齐方式和容器结构；长地址、双列信息和单列信息混排时容易出现视觉参差。任务卡片也始终完全展开，占用较高列表高度。
- New behavior: 每条任务新增本地 UI 折叠按钮，默认保持现有展开态，但可单独收起为“标题 + 状态 + 标签”紧凑视图；展开态下的信息行重构为统一的详情卡片布局，使用固定图标圆点、统一标签层级和双列内容栅格。
- Key decisions:
  - 折叠状态只保存在 `TasksScreen` 本地组件状态，不写入接口、缓存或 store，避免引入第二套任务持久化语义。
  - 不改任务跳转、复制密码、复制地址、操作按钮的数据流，只收敛展示层布局和显示密度。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 新增逐卡折叠按钮，并统一任务详情信息块的布局与图标对齐。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx` — modified: 增加折叠后隐藏 Wi-Fi 详情、再次展开恢复显示并保留复制密码行为的测试覆盖。
- `docs/change-release-ledger.md` — modified: 记录本次移动端任务卡片展示优化。

### Impact / Dependencies

- API: none; 继续复用现有 `/mzapp/work-tasks` 任务数据，不新增字段。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Shares `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` with `CRL-20260623-007` and `CRL-20260623-009`; 选择性发布时仍需按 hunk 暂存，不能整文件 stage。

### Validation

- `git -C mz-cleaning-app-frontend diff --check -- src/screens/tabs/TasksScreen.tsx src/screens/tabs/TasksScreen.test.tsx` — passed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm run lint -- src/screens/tabs/TasksScreen.tsx src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed with 126 existing warnings and 0 errors; warnings are pre-existing repo noise.
- `npm test -- --runInBand src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 1 suite, 1 test. Jest emitted a non-failing open-handle notice after completion and a `SafeAreaView` deprecation warning during render.
- `build` — not run: `mz-cleaning-app-frontend/package.json` has no `build` script.

### Risks / Release Notes

- Risk: 当前折叠状态是会话内本地状态，刷新列表或重进页面后不会记忆用户上次的收起/展开选择。
- Risk: `TasksScreen.tsx` 当前同时承载其他未发布的移动端任务页改动，后续如要单独发这项 UI 优化，必须按 hunk 暂存。
- Rollback: remove the collapse toggle and restore the previous per-row detail layout in `TasksScreen`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added.
- Git state: uncommitted in root repo and nested `mz-cleaning-app-frontend`; this unit coexists with unrelated worktree changes from other threads.

### 2026-06-23 Follow-up — 复制成功改为卡片内即时反馈

- Previous behavior: 地址和 Wi-Fi 行虽然已经支持复制，但成功反馈只依赖顶部 banner；用户如果正盯着右侧复制图标，几乎感知不到点击是否生效。
- New behavior: 右侧复制 affordance 现在改成带边框的操作胶囊；复制成功后会在当前卡片内立刻切换成绿色勾号和“已复制”，约 1.6 秒后恢复默认图标。地址行和 Wi-Fi 行都使用同一套即时反馈。
- Files:
  - `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 新增复制反馈状态、定时清理、地址/Wi-Fi 行右侧“已复制”视觉反馈。
  - `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx` — modified: 断言 Wi-Fi 复制后出现 `wifi-copied-*` 可访问标识和“已复制”文本。
- Validation:
  - `git -C mz-cleaning-app-frontend diff --check -- src/screens/tabs/TasksScreen.tsx src/screens/tabs/TasksScreen.test.tsx` — passed.
  - `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
  - `npm run lint -- src/screens/tabs/TasksScreen.tsx src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed with 126 existing warnings and 0 errors.
  - `npm test -- --runInBand src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 1 suite, 1 test. Jest still emitted the existing non-failing open-handle notice and `SafeAreaView` deprecation warning.

## CRL-20260623-012 — 检查安排模式与执行结果状态拆层

- **Status:** pushed
- **Updated:** 2026-06-23 13:39 AEST
- **Request:** 按确认后的业务语义把任务中心检查模式拆成独立的 `inspection_mode` / `inspection_scope` / `status` 三层；新增 `checked_done`，并限制 `password_only` 任务不能使用 `self_complete` / `checked_done`。
- **Outcome:** 任务中心现在把“检查安排模式”“执行方式”“真实完成结果”分开表达：`self_complete` 恢复为现场自完成流程，`checked_done` 成为新的独立安排模式；`password_only` 任务在 Web 端只保留“待确认 / 同日 / 延期”安排，不再显示安排类标签，真实完成结果继续只通过移动端落成 `keys_hung` / “已挂钥匙”。

### Implementation

- Previous behavior: `self_complete` 先前被网页端同时拿来表达“不派检查员的安排模式”和“已检查结果”，导致下拉、提示文案、移动端执行流和 `password_only` 语义互相污染；部分旧数据如果把 `password_only` 任务存成 `self_complete`，移动端还会误走自完成流程。
- New behavior: 共享 helper、后端校验、Web 任务中心和移动端兼容层都扩展到 5 个 `inspection_mode` 值，并把 `checked_done` 仅作为“已检查完毕、不再安排检查员”的模式值处理；`password_only` 任务遇到非法的 `self_complete` / `checked_done` 组合会回退成 `same_day`，Web 保存会被后端拒绝，移动端则只做兼容显示，不触发自完成流程。
- Key decisions:
  - 不复用 `self_complete` 表示“已检查”，而是新增独立 `checked_done`，避免继续混淆安排模式和结果状态。
  - `password_only` 的最终完成仍只认移动端视频上传后的 `keys_hung`，不在 Web 上通过手工选择“已检查”模拟完成。
  - 把旧“延后检查”文案统一成“延期检查”，避免同一个模式在不同界面双写。

### Files / Areas

- `backend/src/lib/cleaningInspection.ts` — modified: 扩展 `InspectionMode` / `InspectionScope`，新增 `checked_done`、`password_only` 合法性检查、非法组合回退和新的聚合优先级。
- `backend/src/modules/task_center.ts` — modified: 任务中心保存 schema 接受 `checked_done`，并在保存前拒绝 `password_only + self_complete/checked_done`；待确认检查统计与延期行标题同步复用新 helper。
- `backend/src/modules/cleaning.ts` — modified: 清洁任务创建/更新 schema 接受 `checked_done`，并把相关提示文案统一为“延期检查”。
- `backend/src/modules/cleaning_app.ts` — modified: `inspection_mode` 解析 SQL 接受 `checked_done`，避免清洁 app 视图丢值。
- `backend/scripts/tests/test_cleaning_inspection_merge.ts` — modified: 覆盖 `checked_done` 聚合优先级和 `password_only` 非法模式拒绝/回退。
- `frontend/src/lib/cleaningTaskUi.ts` — modified: Web 共享 helper 新增 `checked_done` 标签、`password_only` 模式过滤、标签隐藏规则和回退逻辑。
- `frontend/src/lib/cleaningTaskUi.test.ts` — modified: 覆盖 `checked_done` 标签、下拉过滤、非法组合回退与标签隐藏规则。
- `frontend/src/app/task-center/page.tsx` — modified: 详情下拉改成 5 个模式；`password_only` 下只保留 3 个合法选项；新增 `checked_done` 说明块；顶部 chip / 卡片标签不再给 `password_only` 叠加安排类标签；脏数据加载时自动回退并提示。
- `frontend/src/app/task-center/taskCenterDisplay.ts` — modified: 任务中心显示文案统一改成“延期检查”。
- `frontend/src/app/task-center/taskCenterDisplay.test.ts` — modified: 更新延期显示断言。
- `mz-cleaning-app-frontend/src/lib/cleaningInspection.ts` — modified: 移动端共享解析支持 `checked_done`，并把 `password_only` 下发的非法模式回退为 `same_day`。
- `mz-cleaning-app-frontend/src/lib/cleaningInspection.test.ts` — modified: 覆盖 `checked_done` 标签与 `password_only` 非法模式兼容。
- `mz-cleaning-app-frontend/src/lib/taskVisualTheme.ts` — modified: 为 `checked_done` 提供成功态 tone。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: 接口类型补齐 `checked_done`。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` — modified: `password_only` 详情顶部只显示“仅改密码”和真实状态，不再叠加安排模式标签。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` — modified: 覆盖 `password_only` 详情不再显示“同日检查 / 自完成 / 已检查”等安排标签。
- `docs/change-release-ledger.md` — modified: 记录本次三层语义拆分。

### Impact / Dependencies

- API: none; 继续复用现有 `inspection_mode` / `inspection_scope` / `status` 字段，只扩展合法值与前端解释逻辑。
- Database / migration: none; 复用现有 `cleaning_tasks.inspection_mode` / `inspection_scope` 列，不新增迁移。
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Supersedes the semantic shortcut introduced in `CRL-20260623-005`; `checked_done` now replaces the earlier “把 `self_complete` 解释成已检查”的做法。
  - Builds on `CRL-20260623-010` restoring the `self_complete` label and finishes the full model split.
  - Shares `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` and `frontend/src/app/task-center/page.tsx` with other in-flight task-page work; selective release still requires hunk-level staging.

### Validation

- `git diff --check -- backend/src/lib/cleaningInspection.ts backend/src/modules/task_center.ts backend/src/modules/cleaning.ts backend/src/modules/cleaning_app.ts frontend/src/lib/cleaningTaskUi.ts frontend/src/lib/cleaningTaskUi.test.ts frontend/src/app/task-center/page.tsx frontend/src/app/task-center/taskCenterDisplay.ts frontend/src/app/task-center/taskCenterDisplay.test.ts mz-cleaning-app-frontend/src/lib/cleaningInspection.ts mz-cleaning-app-frontend/src/lib/cleaningInspection.test.ts mz-cleaning-app-frontend/src/lib/taskVisualTheme.ts mz-cleaning-app-frontend/src/lib/api.ts mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` — passed.
- `npm --prefix backend run test:cleaning-inspection-merge` — passed.
- `./node_modules/.bin/tsc -p tsconfig.json --noEmit --pretty false` in `frontend` — passed.
- `./node_modules/.bin/vitest run src/lib/cleaningTaskUi.test.ts src/app/task-center/taskCenterDisplay.test.ts --coverage=false` in `frontend` — passed: 2 files, 10 tests.
- `npm --prefix frontend test -- src/lib/cleaningTaskUi.test.ts src/app/task-center/taskCenterDisplay.test.ts` — failed on repository-wide coverage threshold only; the targeted test files themselves passed before coverage gating stopped the script.
- `npm --prefix frontend run lint` — passed with existing repository warnings only; no new lint errors from this unit.
- `npm --prefix frontend run build` — passed; Next.js build completed successfully and includes its own type/lint phase. Existing repo-wide lint warnings and pre-existing chart container warnings remained non-blocking.
- `npm --prefix mz-cleaning-app-frontend run typecheck` — passed.
- `npm --prefix mz-cleaning-app-frontend test -- --runInBand src/lib/cleaningInspection.test.ts src/screens/tasks/TaskDetailScreen.test.tsx src/screens/tabs/TasksScreen.test.tsx` — passed: 3 suites, 9 tests. Jest still emitted the existing non-failing open-handle notice and `SafeAreaView` deprecation warning.
- `npm --prefix mz-cleaning-app-frontend run lint` — passed with existing repository warnings only; no new lint errors from this unit.

### Risks / Release Notes

- Risk: `frontend/src/app/task-center/page.tsx`、`backend/src/modules/task_center.ts` 和 `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` 都是当前工作树里的共享热点文件；如果要和其他未发布任务中心/移动端变更拆开发版，必须按 hunk 暂存。
- Risk: 这次只做了移动端类型兼容和展示兼容，没有新增“已检查”交互入口；如果后续需要在移动端真正操作 `checked_done`，还要单独设计入口和权限。
- Rollback: revert the `checked_done` mode additions plus the `password_only` compatibility/filter logic, while preserving unrelated shared-file edits from other units.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added or recorded.
- Git state: uncommitted in root repo and nested `mz-cleaning-app-frontend`; this unit coexists with unrelated worktree changes from other threads.

## CRL-20260623-013 — 移动端线下任务支持选择任务类型

- **Status:** pushed
- **Updated:** 2026-06-23 14:23 AEST
- **Request:** 移动端客服新增任务时，线下任务要可以选择任务类型。
- **Outcome:** 移动端“新增任务”弹窗在选择“线下任务”后，现可直接选择“房源任务 / 公司任务 / 其他任务”；提交时会把所选 `task_type` 发给后端，不再固定写成 `other`。

### Implementation

- Previous behavior: `TasksScreen` 的线下任务创建分支把 `task_type` 硬编码为 `other`，客服在移动端无法区分房源任务、公司任务和其他任务；即使后端已支持该枚举，移动端也没有输入入口。
- New behavior: 线下任务表单新增任务类型选择按钮组，默认仍为 `other`；若选择“房源任务”，房号标签改为必填语义并在提交前校验必须从房号提示中选中有效房源。
- Key decisions:
  - 复用后端和网页端已存在的 `property / company / other` 枚举，不新增第二套字段或转换层。
  - 保持现有“入住 / 退房 / 线下任务”快速创建模式结构不变，只在 `offline` 分支补齐缺失输入和校验。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 新增线下任务类型状态、任务类型选择 UI、房源任务房号校验，并把所选 `task_type` 传给 `createCleaningOfflineTask`。
- `docs/change-release-ledger.md` — modified: 记录本次移动端线下任务类型选择补齐。

### Impact / Dependencies

- API: 继续调用现有 `POST /cleaning/offline-tasks`；请求体中的 `task_type` 从固定 `other` 改为用户所选的 `property | company | other`。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Shares `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` with `CRL-20260623-007`、`CRL-20260623-009` and `CRL-20260623-011`; 若后续要选择性发布，必须按 hunk 暂存。

### Validation

- `git -C mz-cleaning-app-frontend diff --check` — passed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 124 existing warnings and 0 errors; warnings are pre-existing repo noise.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 20 suites, 60 tests. Jest still emitted the existing non-failing open-handle notice and `SafeAreaView` deprecation warning during `TasksScreen` render.
- `build` — not run: `mz-cleaning-app-frontend/package.json` has no `build` script.

### Risks / Release Notes

- Risk: 该改动与同文件中的其他未发布移动端任务页工作共存；如果后续只发布这一个功能，必须核对 `TasksScreen.tsx` 的 hunk 归属。
- Risk: 本轮没有新增专门覆盖“线下任务类型选择”的单测，验证依赖现有整包测试、类型检查和 lint。
- Rollback: remove the offline task-type selector and restore the fixed `task_type: 'other'` request in `TasksScreen`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added or recorded.
- Git state: uncommitted in root repo and nested `mz-cleaning-app-frontend`; this unit coexists with unrelated worktree changes from other threads.

## CRL-20260623-014 — 删除退房/入住/线下任务时通知执行人和经理组

- **Status:** pushed
- **Updated:** 2026-06-23 14:47 AEST
- **Request:** 通知事件还需要补一类：如果退房、入住或线下任务被删除，也要通知相关执行人和经理组。
- **Outcome:** 手工删除退房/入住/入住中清洁任务，或删除线下任务时，现在都会通过现有通知队列给相关执行人和运营经理组发出删除通知；线下任务删除还会同步发出 `TASK_REMOVED` 实时事件，避免前端只看到记录消失却收不到通知。

### Implementation

- Previous behavior: 清洁任务删除只做 `status='cancelled'` 和实时 `TASK_REMOVED`，没有 App 删除通知；线下任务删除直接删 `cleaning_offline_tasks` / `work_tasks`，既没有删除通知，也没有 `work_tasks` 实时移除事件。
- New behavior: 清洁任务单删和批量删都会补发 `CLEANING_TASK_UPDATED` 删除通知，并用新的 `task_deleted` App 策略把接收人限制在当前任务参与人和运营经理组；线下任务删除会在事务内先读取 canonical `work_tasks` 行，写入 `WORK_TASK_UPDATED` 删除通知和 `TASK_REMOVED` 实时事件，再删除 `work_tasks` 与原始 `cleaning_offline_tasks` 记录。
- Key decisions:
  - 复用 `emitNotificationEvent -> user_notifications/event_queue` 现有链路，不增加第二套删除通知发送系统。
  - 清洁任务删除不复用 `task_requirements_changed`，因为它默认还会带上客服；本次单独增加 `task_deleted`，严格匹配“执行人 + 经理组”。
  - 删除通知使用 `action: 'open_notice'` 的通用 notice 打开方式，避免移动端去打开已经被删除的任务详情。

### Files / Areas

- `backend/src/modules/cleaning.ts` — modified: 新增清洁任务/线下任务删除通知文案 helper；清洁任务单删/批量删补发删除通知；线下任务删除补 `TASK_REMOVED` 和删除通知，并把通知写入放在删除事务内。
- `backend/src/services/appNotificationPolicies.ts` — modified: 新增 `task_deleted` 策略，默认模板为“参与人 + 运营经理组”。
- `backend/scripts/tests/test_app_notification_policies.ts` — modified: 断言 `task_deleted` 默认模板配置。
- `docs/change-release-ledger.md` — modified: 记录本次删除通知补齐。

### Impact / Dependencies

- API: 删除接口响应结构不变；`DELETE /cleaning/tasks/:id`、`POST /cleaning/tasks/bulk-delete` 和 `DELETE /cleaning/offline-tasks/:id` 在成功后会额外写入通知 inbox / push 队列。
- Database / migration: none. 复用现有 `user_notifications`、`event_queue`、`app_notification_policies` 和 `work_tasks`；没有新增表或迁移脚本。
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Shares `backend/src/modules/cleaning.ts` with `CRL-20260623-012` and older in-flight cleaning/task-center work; selective release still requires verified hunk staging.

### Validation

- `git diff --check -- backend/src/modules/cleaning.ts backend/src/services/appNotificationPolicies.ts backend/scripts/tests/test_app_notification_policies.ts` — passed.
- `npm run build` in `backend` — passed.
- `npm run test:app-notification-policies` in `backend` — passed.

### Risks / Release Notes

- Risk: 线下任务删除通知依赖删除前存在 canonical `work_tasks` 行来解析默认执行人；如果历史脏数据缺这行，本次实现仍会完成删除，但不会自动补发该条删除通知。
- Risk: `backend/src/modules/cleaning.ts` 当前在工作树里与其它未发布清洁/任务中心改动共存；若后续只发布本单元，必须按 hunk 暂存，不能整文件 stage。
- Rollback: remove the new deletion-notice helper calls and `task_deleted` policy entry, while preserving unrelated in-flight changes in shared files.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added or recorded.
- Git state: uncommitted in root repo; this unit coexists with unrelated worktree changes from other threads.

## CRL-20260623-015 — 移动端“补充与完成”页面重排

- **Status:** pushed
- **Updated:** 2026-06-23 16:06 AEST
- **Request:** 重新优化一下自完成的“补充与完成”页面，当前信息混乱、排版有问题。
- **Outcome:** 自完成页现在先展示顶部总览，再按“消耗品补充 / 房源问题反馈 / 房间完成照片 / 标记已完成”分区；每个分区增加明确状态标签、小节卡片和更清晰的拍照/提交入口，减少原先说明、状态、操作堆在一起的混乱感。

### Implementation

- Previous behavior: `CleaningSelfCompleteScreen` 把房源信息、说明文案、状态文本、拍照按钮和照片预览混在同一层级里；消耗品项和完成照片项主要靠长列表和平铺按钮区分，用户很难快速判断当前缺什么、下一步做什么。
- New behavior: 顶部新增摘要卡，汇总消耗品、完成照片和挂钥匙视频状态；消耗品步骤拆成规则说明、客厅照片、消耗品检查、遥控器拍照四个视觉分组；完成照片步骤改成按区域卡片展示；最终完成步骤复用相同摘要状态并单独突出挂钥匙视频与完成按钮。
- Key decisions:
  - 保留现有离线草稿、弱网缓存、提交流程和业务校验逻辑，只重排页面结构与样式，不新增第二套数据流。
  - 继续复用当前页面内部状态，不把这次 UI 优化扩展成跨文件组件抽象，避免和正在进行的弱网/任务页改动互相干扰。

### 2026-06-23 Follow-up Update

- 用户进一步锁定自完成规则：`客厅 / 电视遥控器 / 空调遥控器` 不是补品提交必需照片；`房间完成照片` 已包含 `客厅`，不能重复拍；`stayover_clean` 只展示适用步骤且不出现空卡片。
- 已按该范围重做：
  - `CleaningSelfCompleteScreen` 改为动态步骤数组。普通自完成显示 `消耗品补充 -> 房源问题反馈 -> 房间完成照片 -> 标记已完成`；`stayover_clean` 只显示 `房源问题反馈 -> 房间完成照片 -> 标记已完成`。
  - 顶部 hero 改成按任务类型汇总状态；`stayover_clean` 不再显示补品状态或挂钥匙视频状态。
  - `1. 消耗品补充` 只保留补品检查、数量、库存照片、备注、其他项、弱网缓存和离线待同步提示；移除了原先夹在其中的客厅/遥控器照片入口与相关文案。
  - `3. 房间完成照片` 只保留 6 个完成区域（浴室、客厅、沙发、卧室、厨房、吸尘器使用后）的统一照片卡片，不再额外出现“客厅照片”补品分组，也不再出现遥控器卡片。
  - `4. 标记已完成` 继续复用原完成逻辑，但按任务类型动态展示前置状态；普通自完成仍要求挂钥匙视频，`stayover_clean` 只看完成照片。
  - 后端 `POST /cleaning-app/tasks/:id/consumables` 将 `living_room_photo_url` 改为可选；未传时不再报错，也不再写入 `consumable_living_room_photo` 媒体记录；清洁员 `SuppliesFormScreen` 本轮未改，仍可继续沿用它自己的前端要求。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tasks/CleaningSelfCompleteScreen.tsx` — modified: 按任务类型动态重组自完成步骤，移除补品提交流程中的客厅/遥控器照片要求，保留弱网草稿和离线待同步逻辑，并把完成照片区统一成 inspection-style 卡片布局。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: 放宽自完成补品提交参数类型，允许不传 `living_room_photo_url`。
- `backend/src/modules/cleaning_app.ts` — modified: 放宽补品提交接口对 `living_room_photo_url` 的校验，只在传值时写入 `consumable_living_room_photo` 媒体记录。
- `docs/change-release-ledger.md` — modified: 记录本次移动端自完成页面重排。

### Impact / Dependencies

- API: `POST /cleaning-app/tasks/:id/consumables` 不再要求 `living_room_photo_url` 必填；其余自完成接口保持不变。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Shares `mz-cleaning-app-frontend/src/screens/tasks/CleaningSelfCompleteScreen.tsx` with `CRL-20260623-007` 的弱网/离线草稿改动；如果后续选择性发布，必须按 hunk 暂存，不能整文件 stage。

### Validation

- `git -C mz-cleaning-app-frontend diff --check` — passed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npx eslint src/screens/tasks/CleaningSelfCompleteScreen.tsx` in `mz-cleaning-app-frontend` — passed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 125 existing warnings and 0 errors; this page did not add new lint warnings after cleanup.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 20 suites, 60 tests. Jest still emitted the existing non-failing open-handle notice and `SafeAreaView` deprecation warning during `TasksScreen` test render.
- `build` — not run: `mz-cleaning-app-frontend/package.json` has no `build` script.
- Follow-up validation on 2026-06-23 15:35 AEST:
  - `git -C mz-cleaning-app-frontend diff --check` — passed.
  - `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
  - `npx eslint src/screens/tasks/CleaningSelfCompleteScreen.tsx` in `mz-cleaning-app-frontend` — passed.
- Final validation on 2026-06-23 16:06 AEST:
  - `git -C mz-cleaning-app-frontend diff --check` — passed.
  - `git diff --check -- backend/src/modules/cleaning_app.ts` — passed.
  - `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
  - `npx eslint src/screens/tasks/CleaningSelfCompleteScreen.tsx` in `mz-cleaning-app-frontend` — passed.
  - `npm run build` in `backend` — passed.
  - `python3 scripts/audit_change_release_ledger.py` — still failing because the worktree already contains unrelated uncovered root-frontend files (`frontend/src/components/AdminLayout.tsx`, `ClientThemeProvider.tsx`, `CrudTable.tsx`, several `frontend/src/components/ui/*` files, and `frontend/src/lib/uiTokens.ts`). This unit itself is recorded, but repo-wide audit remains red until those separate changes are ledgered.

### Risks / Release Notes

- Risk: 这次没有在真机或模拟器上做视觉回归，只通过静态检查和后端编译验证；若要继续调间距、按钮尺寸或长文案换行，仍建议结合实际设备截图做一轮 UI QA。
- Risk: 自完成入口与清洁员 `SuppliesFormScreen` 现在故意存在前端行为差异：后端已允许无 `living_room_photo_url` 提交，但清洁员入口本轮仍可能继续要求客厅/遥控器照片，这是已确认的暂时分叉，不是遗漏。
- Risk: `CleaningSelfCompleteScreen.tsx` 当前还承载前一轮弱网/离线提交流程改动，若后续单独发布 UI 重排，必须核对 hunk 归属。
- Rollback: revert the `CleaningSelfCompleteScreen.tsx`, `src/lib/api.ts`, and `backend/src/modules/cleaning_app.ts` hunks for dynamic self-complete steps plus optional `living_room_photo_url`, while preserving unrelated in-flight weak-network and notification-policy changes in the same files.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added or recorded.
- Git state: uncommitted in root repo and nested `mz-cleaning-app-frontend`; this unit coexists with unrelated worktree changes from other threads.

## CRL-20260623-016 — InspectionPanel 统一提交队列与钥匙照片统一排队

- **Status:** pushed
- **Updated:** 2026-06-24 14:25 AEST
- **Request:** 按明确执行方案实现检查端真正的单一提交模型：`InspectionPanel` 永远先写本地 submit queue，再按 step 续跑；拍照阶段只落本地私有文件；`InspectionComplete` 不并入 batch；钥匙照片也改成统一“先入本地 queue，在线立即消费，离线等待恢复”。
- **Outcome:** 当前已完成统一提交队列的第一阶段止血、第二阶段核心断点续跑、第三阶段钥匙 queue 自动化覆盖；后续跟进继续修复真机暴露的问题：`InspectionComplete` 提交锁盒视频时不再被后端旧消耗品 gate 拦截，InspectionPanel 新拍照片写本地 draft 前会先转成可预览 JPEG，失败批次现在有明确的底部“放弃并重建草稿”入口。

### Implementation

- Previous behavior:
  - `InspectionPanelScreen` 拍照后立即通过旧 `inspectionMediaQueue` 上传图片，并在照片/补货变化时直接调用 `saveInspectionPhotos`、`saveRestockProof`。
  - `FeedbackFormScreen` 在检查页场景下也会即时上传媒体并直接创建远端反馈。
  - `InspectionCompleteScreen` 必须重新读远端检查照片/补货记录来决定是否可进入。
  - `TaskDetailScreen` 的钥匙照片优先在线直传，只有网络失败时才降级进队列；`TasksScreen` 也只把本地 pending 当失败兜底。
- New behavior:
  - 新增 `inspectionPanelSubmitQueue`，固定 step 为 `upload_media -> save_restock_proof -> save_inspection_photos -> create_feedback_batch -> complete_feedback_projects`；已成功 step 和已上传 `remote_url` 会持久化，重试时跳过。
  - `InspectionPanelScreen` 改成只写本地 draft/batch snapshot；正式提交只会 `saveInspectionPanelDraftBatch -> submitInspectionPanelBatch -> processInspectionPanelSubmitQueue`。`pending_submit / syncing / partial_failed / failed / synced` 全部冻结 snapshot；失败后只能显式放弃 batch 重建 draft。
  - `FeedbackFormScreen` 在 `source=inspection_panel_batch` 模式下只把照片复制到 app 私有目录，并把 maintenance / deep cleaning / daily feedback 暂存到 `inspectionPanelFeedbackDraft`，正式提交时由 batch processor 统一上传和写库。
  - `InspectionCompleteScreen` 只检查当前任务是否存在非 `draft` batch，并显示同步状态提示，不再要求检查照片/补货已经远端同步完成。
  - `keyUploadQueue` 升级为两步队列：`upload_media`、`start_cleaning_task`；`TaskDetailScreen` 和 `TasksScreen` 都通过远端 `key_photo_url` + 本地 queue 派生“未上传 / 待同步 / 已记录”，避免重复拍照。
  - 后端 `POST /cleaning-app/tasks/:id/inspection-photos`、`POST /mzapp/cleaning-tasks/:id/restock-proof`、`POST /mzapp/property-feedbacks` 新增 `submit_id / step_key / client_item_id` 幂等语义；相同幂等键且 payload hash 一致时直接返回既有结果，不重复写库和通知；payload hash 冲突则返回 `idempotency_conflict`。
- 2026-06-23 第一阶段更新:
  - `InspectionPanelScreen` 的 `persistDraft` 不再在编辑期调用 `saveInspectionPanelDraftBatch`；拍照、补货勾选、清洁问题和反馈摘要变化时只更新本地 `inspectionPanelDraft`。
  - 页面恢复逻辑只会在 batch 非 `draft` 时使用冻结 snapshot；若本地仍是编辑期，即使存在旧 draft batch，也优先恢复本地 draft，避免旧 snapshot 覆盖刚拍好的本地照片。
  - queue 订阅刷新改成无 loading spinner 的轻量恢复；正式提交时才把当前本地 snapshot 写入 queue 并继续后续 `submitInspectionPanelBatch -> processInspectionPanelSubmitQueue`。
- 2026-06-23 第一阶段跟进修正:
  - 用户弱网实测发现“房间检查照片在恢复网络后消失，但消耗品照片仍在”。根因不是媒体复制失败，而是 `InspectionPanelScreen` 在编辑期仍可能因为 queue emit 或任务刷新去重读较旧的本地 draft，并把内存里较新的 `roomPhotos` 覆盖掉。
  - 本轮把编辑期恢复策略进一步收紧：当前任务若仍处于 `draft`，queue 订阅只更新 `batchItem`，不再重载整页草稿；只有 batch 已正式进入非 `draft` 状态时才允许用冻结 snapshot 回填页面。
  - 同时把 `inspectionPanelDraft` 写盘改成串行 promise 链，避免较早的一次异步 `setInspectionPanelDraft` 晚于较新的写入完成，从而把新拍的房间照片回滚成旧草稿。
  - `roomPhotos` 的新增也改为函数式 state 更新，减少弱网恢复或外部状态刷新期间的闭包旧值覆盖。
- 2026-06-23 第一阶段缩略图修正:
  - 用户截图显示“房间检查照片计数已变成 1/x，但缩略图仍是空白占位”。这说明页面 state 里已有媒体项，但本地图片文件的预览解析失败。
  - 本轮把本地草稿媒体扩展名和 mime 推断统一收口到 `localMediaDrafts.ts`：优先使用 `fileName` 或 `sourceUri` 的真实扩展名，再 fallback 到 mime，而不是缺省直接强制 `.jpg` / `image/jpeg`。
  - 对 `InspectionPanel`、检查页 `FeedbackForm` 草稿、钥匙照片 queue 三个入口都去掉了“文件名缺失时默认补 `.jpg`”的做法，避免 iPhone 相机实际产出 `HEIC/HEIF` 时被错误重命名成 `.jpg`，进而出现“数量存在但缩略图不显示”的假象。
- 2026-06-23 第二阶段核心补齐:
  - `inspectionPanelSubmitQueue` 现在会在 batch 处理失败时，把当前正在执行的 step 从 `syncing` 明确落成 `failed`，并记录 `finished_at` 与 `error`，不再停留在模糊的“整个 batch failed 但具体 step 还是 syncing”状态。
  - `create_feedback_batch` 改成“每成功一个 `client_item_id` 就立即持久化映射”。如果同一批里前几条成功、后几条失败，queue item 会保留已成功的 `client_item_id -> feedback_id`，下次重试只补未完成项。
  - 新增 `inspectionPanelSubmitQueue.test.ts` 覆盖两条第二阶段关键路径：
    - `create_feedback_batch` 部分成功时，batch 进入 `partial_failed`，并且重试只重新提交缺失 `client_item_id`
    - `upload_media` 成功后 `save_restock_proof` 失败时，重试不会重复上传媒体
- 2026-06-23 第三阶段自动化补齐:
  - 新增 `keyUploadQueue.test.ts`，覆盖“`upload_media` 成功、`start_cleaning_task` 失败后，重试从第二步继续且不重复上传图片”的正式语义。
  - 同时校验 `selectKeyPhotoEffectiveState` 的三值派生：远端有 `key_photo_url` 时为 `recorded`；无远端但有本地 active queue item 时为 `pending_sync`；两者都无时为 `missing`。
- 2026-06-23 完成页 gate 与本地缩略图跟进:
  - 用户截图显示 `InspectionComplete` 已提示“检查与补充已正式提交 / 已同步完成”，但点击完成仍弹出“请先确认消耗品是否充足，或完成消耗品补充提交”。复查确认这是后端 `POST /mzapp/cleaning-tasks/:id/lockbox-video` 仍保留旧的消耗品 proof 查询 gate，和新规则“InspectionComplete 只要求 InspectionPanel 已正式提交过”冲突。
  - 本轮删除该旧 gate；锁盒视频提交只保留任务存在、角色归属和 `media_url` 校验，不再要求旧 `restock_proof:*` 或 `inspection_consumables_confirmed` 媒体先存在。
  - 用户继续反馈房间检查照片重进页面后仍有计数/占位但不显示具体缩略图。本轮在 `InspectionPanelScreen` 的房间照片/补货/清洁问题入口，以及检查页 batch 模式的 `FeedbackFormScreen` 图片入口，写入私有 draft 前统一调用现有 `compressImageForUpload` 转成 JPEG，再保存为本地 draft media。
  - 这能修复新拍照片的本地预览格式稳定性；如果旧草稿里已经保存的是不可读或已失效的本地文件，旧占位本身可能无法恢复，需要重新拍该张照片。
- 2026-06-23 失败批次重建入口跟进:
  - 用户反馈“怎么放弃失败批次并重建草稿？都没地方选择”。复查确认原入口只在顶部状态卡内，且底部主操作区仍优先显示“进入标记已完成”，现场很容易看不到。
  - 本轮在 `failed / partial_failed` 状态下，把底部固定操作区扩展为：主按钮仍可进入完成页，下面新增“重试同步”和红色“放弃并重建草稿”两个明确操作。
  - 点击“放弃并重建草稿”会先弹确认，说明会清除当前失败批次的冻结 snapshot、同步进度和本地草稿，但不会回滚已写入后台的内容。
  - 同时修正 `discardInspectionPanelBatch`：此前 queue item 存在时会提前 return，导致本地 `inspectionPanelDraft` / `inspectionPanelFeedbackDraft` 没被清理；现在删除 queue item 后会统一清掉两个 draft，确保“重建草稿”是真正干净的新草稿。
- 2026-06-24 状态校正:
  - 本单元此前顶部状态仍停在 `in-progress`，但代码落地、阶段性 follow-up 和自动验证均已记录完成。
  - 后续 `CRL-20260623-018` 至 `CRL-20260623-024` 已作为独立 ready follow-up 覆盖图片读取、缩略图、失败入口、保存确认、按钮位置、必拍验证和缺项定位等剩余问题。
  - 因此本单元状态更新为 `ready`；保留真机弱网回归建议作为发布风险，而不是继续阻塞功能选择。
- Key decisions:
  - 保留现有 `InspectionComplete` 挂钥匙视频链路和旧 `inspectionMediaQueue` 的视频用途，不把锁盒视频并入 `InspectionPanel` batch。
  - `FeedbackForm` 本轮只统一检查页“新建反馈”入口，不扩展历史编辑的离线化，避免把旧编辑流和新建队列混在一起。
  - 钥匙照片本地 pending 不再被 UI 当成“未上传”，也不假装“已正式上传”；两个页面统一按 remote + local queue 派生状态。

### Files / Areas

- `mz-cleaning-app-frontend/src/lib/localMediaDrafts.ts` — added: 私有目录媒体复制、存在性检查、清理 helper。
- `mz-cleaning-app-frontend/src/lib/inspectionPanelDraft.ts` — added/expanded: 本地 draft 持久化检查照片、清洁问题、补货草稿。
- `mz-cleaning-app-frontend/src/lib/inspectionPanelFeedbackDraft.ts` — added: 检查页专用 feedback draft 和 `client_item_id` / 本地照片 metadata 持久化。
- `mz-cleaning-app-frontend/src/lib/inspectionPanelSubmitQueue.ts` — added/modified: 检查页 batch queue、step 续跑、成功结果持久化、同步完成后清理本地文件；失败批次放弃时同步清理 panel draft 与 feedback draft。
- `mz-cleaning-app-frontend/src/lib/keyUploadQueue.ts` — modified: 改成两步 step queue，统一在线/离线都先入队。
- `mz-cleaning-app-frontend/src/lib/auth.tsx` — modified: 登录后、回前台、网络恢复时统一消费 `inspectionPanelSubmitQueue` 与 `keyUploadQueue`。
- `mz-cleaning-app-frontend/src/navigation/RootNavigator.tsx` — modified: `FeedbackForm` 增加 `source='inspection_panel_batch'` 入口参数。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — rewritten: 页面只读/冻结规则、正式提交流程、失败批次放弃重建、检查页本地照片/补货/反馈汇总。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — modified: 真机跟进中新增本地 draft 入库前 JPEG 规范化，避免弱网/回前台后计数存在但缩略图无法渲染；失败/部分失败批次下新增底部“重试同步 / 放弃并重建草稿”入口和确认弹窗。
- `mz-cleaning-app-frontend/src/screens/tasks/FeedbackFormScreen.tsx` — modified: 检查页模式下只暂存本地 draft，不再即时远端上传/写库；真机跟进中同样对 batch feedback 图片先转 JPEG 再保存到私有目录。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.tsx` — modified: 进入条件改为“检查页已正式提交过”，并展示 batch 同步提示。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` — modified: 钥匙照片统一先入本地 queue，再尝试消费；详情页显示待同步/已记录状态。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 列表页钥匙按钮和状态也改成 remote + local queue 派生。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: 检查照片、补货凭证、房源反馈 API 增加 `submit_id / step_key / client_item_id` 输入。
- `backend/src/lib/idempotentStepReceipts.ts` — added: 轻量 receipt 存储和 payload hash helper。
- `backend/src/modules/cleaning_app.ts` — modified: 检查照片保存接口增加最小幂等。
- `backend/src/modules/mzapp.ts` — modified: 补货凭证与房源反馈创建接口增加最小幂等；真机跟进中删除锁盒视频提交的旧消耗品 proof gate，避免 InspectionComplete 被旧检查逻辑误挡。
- `docs/change-release-ledger.md` — modified: 记录本次统一提交队列改动。

### Impact / Dependencies

- API:
  - `POST /cleaning-app/tasks/:id/inspection-photos` 新增可选 `submit_id` / `step_key`。
  - `POST /mzapp/cleaning-tasks/:id/restock-proof` 新增可选 `submit_id` / `step_key`。
  - `POST /mzapp/property-feedbacks` 新增可选 `submit_id` / `step_key` / `client_item_id`。
- Database / migration:
  - 新增轻量幂等 receipt 表 `app_submit_receipts`（运行时按需 `CREATE TABLE IF NOT EXISTS`）。
- Config / environment: none.
- Dependencies: none.
- Related units:
  - 与 `CRL-20260623-007` 的弱网/离线提交方向一致，但本单元把检查页和钥匙照片进一步统一成“所有正式提交都先入队”的模型。
  - `InspectionPanelScreen.tsx`、`FeedbackFormScreen.tsx`、`TaskDetailScreen.tsx`、`TasksScreen.tsx` 当前在 nested repo 工作树里还与其他线程改动共存；若只选择性发布本单元，必须按 hunk 暂存。

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with existing warnings only, 0 errors.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 22 suites, 63 tests. 新增 `inspectionPanelSubmitQueue.test.ts` 与 `keyUploadQueue.test.ts` 覆盖第二、三阶段的关键续跑语义；Jest 仍有现存 open-handle 提示，`TasksScreen` 测试仍会打印 `SafeAreaView` deprecation warning。
- `git -C mz-cleaning-app-frontend diff --check` — passed.
- `npm run build` in `backend` — passed.
- `build` in `mz-cleaning-app-frontend` — not run: this repo has no `build` script.
- 2026-06-23 21:15 AEST follow-up rerun:
  - `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
  - `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 125 existing warnings.
  - `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 22 suites, 63 tests; existing `SafeAreaView` deprecation warning and Jest open-handle notice remain.
  - `git -C mz-cleaning-app-frontend diff --check -- src/screens/tasks/InspectionPanelScreen.tsx src/screens/tasks/FeedbackFormScreen.tsx` — passed.
  - `npm run build` in `backend` — passed.
  - `git diff --check -- backend/src/modules/mzapp.ts` — passed.
- 2026-06-23 21:22 AEST failed-batch rebuild follow-up:
  - `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
  - `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 125 existing warnings.
  - `npm test -- --runInBand src/lib/inspectionPanelSubmitQueue.test.ts` in `mz-cleaning-app-frontend` — passed: 1 suite, 2 tests.
  - `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 22 suites, 63 tests; existing `SafeAreaView` deprecation warning and Jest open-handle notice remain.
  - `git -C mz-cleaning-app-frontend diff --check -- src/lib/inspectionPanelSubmitQueue.ts src/screens/tasks/InspectionPanelScreen.tsx` — passed.

### Risks / Release Notes

- Runtime note: 该单元此前因弱网实测暴露的问题被回调为 `in-progress`；后续阶段和 follow-up 已完成并通过自动验证，因此状态已校正为 `ready`。
- Runtime risk: 仍建议真机弱网回归“断网拍房间照片 -> 恢复网络 -> 留在页面/切后台再回来”这条路径，确认现场体验与自动验证一致。
- Runtime risk: 当前“空白占位”修正基于 iOS 本地媒体扩展名/预览推断风险做了收口，仍建议真机确认 `HEIC/HEIF` 拍照场景的缩略图显示。
- Follow-up runtime risk: 这次 JPEG 规范化只保证新拍照片后续保存为可预览格式；已经处于旧草稿中的空白占位，如果底层本地文件已不可读、已被系统回收或 metadata 指向旧路径，可能不能自动修复，需要重拍该照片。
- Follow-up runtime risk: 后端已删除锁盒视频旧消耗品 gate，但如果生产环境仍运行旧 backend build，App 端会继续看到同一弹窗；需要发布后端后才能在真机完全消失。
- Follow-up runtime risk: “放弃并重建草稿”只在 `failed / partial_failed` 出现；`pending_submit / syncing / synced` 仍保持冻结，不提供原地编辑入口，这是按当前单一提交模型保留的约束。
- Remaining phase-two risk: 后端幂等 receipt 已在前一轮接入，本轮未再调整后端接口行为；第二阶段剩余风险主要在真机下验证“在线先入 queue 再立即消费”和“断网 pending_submit 恢复后自动继续”两条端到端链路。
- Remaining phase-three risk: 第三阶段这次补的是本地 queue 续跑和状态派生测试，列表页/详情页的“待同步/已记录”文案和真机刷新节奏仍需联网/断网切换实测。
- Risk: `InspectionPanelScreen` 这次是按单一模型重写页面提交流程，虽然 typecheck / lint / 测试都过了，但还没有做真机弱网回归；尤其建议实测 `pending_submit -> upload_media 成功 -> 业务 step 失败 -> 重试续跑` 和“放弃失败批次重建 draft”这两条链路。
- Risk: 现有 `FeedbackFormScreen` 的历史编辑流仍是老模型；本次只把检查页新建入口统一到 batch queue，没有把历史编辑一起离线化，这是有意保留的范围边界。
- Risk: `InspectionCompleteScreen` 现在允许在检查页 batch 还未完全同步时继续完成；这符合要求，但后台查看时可能暂时只看到锁盒视频、还没看到检查页业务记录，需要和运营预期对齐。
- Rollback: revert the `inspectionPanel*` queue/draft files plus the `FeedbackFormScreen` / `InspectionPanelScreen` / `InspectionCompleteScreen` / `TaskDetailScreen` / `TasksScreen` hunks and the three backend idempotency changes, while preserving unrelated in-flight work in the same files.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added or recorded.
- Git state: uncommitted in root repo and nested `mz-cleaning-app-frontend`; this unit coexists with unrelated worktree changes from other threads.

## CRL-20260623-017 — 移动端与后台统一自适应展示层

- **Status:** pushed
- **Updated:** 2026-06-23 21:00 AEST
- **Request:** 按统一方案改造移动端 App 和后台页面的自适应显示，重点解决不同设备尺寸、系统字体放大、按钮遮挡、文字截断、图片网格溢出，并优先覆盖 `TasksScreen`、`InspectionPanelScreen`、`SuppliesFormScreen`、`CleaningSelfCompleteScreen`、`InspectionCompleteScreen`。
- **Outcome:** 新增一套共享的响应式 token 与基础组件，移动端和后台的按钮、文本、输入框、卡片、图片网格都切到统一展示约束；5 个优先移动端页面和后台通用容器已改成支持字体放大、可滚动完成、底部安全区、键盘避让、窄容器图片网格和移动端 card 化展示。

### Implementation

- Previous behavior: 移动端多个任务页仍依赖固定高度按钮、局部固定图片宽度和裸 `Text`/`TextInput`；系统字体放大后容易出现按钮文案挤压、任务卡片换行失控、底部提交按钮被手势条或键盘遮挡。后台通用布局和 `CrudTable` 也缺少统一 token，移动端窄屏仍主要依赖表格横向压缩。
- New behavior: 展示层统一改为 token 驱动。`Text`/`TextInput` 默认允许系统字体放大并限制最大倍率；按钮使用 `minHeight + padding`；图片网格按父容器宽度算列数；带底部提交按钮的输入页统一加 `SafeArea` + `KeyboardAvoidingView`；后台 `CrudTable` 新增 `mobileCardRender` 并支持移动端 card 模式。
- Key decisions:
  - 不改 API、缓存 key、draft 结构、提交状态机、上传队列和离线同步逻辑，只收口 theme、layout 和基础 UI 组件。
  - `ResponsiveImageGrid` 一律基于父容器宽度计算，不直接用 `window width`，避免 iPad 分屏、Modal 和后台窄容器溢出。
  - 重要业务文案优先允许换行或展开，而不是只靠 ellipsis。

### 2026-06-23 iPhone 7 Follow-up

- 用户补充了 iPhone 7 实机截图，问题集中在 `TasksScreen` 任务卡片头部：房号标题、状态标签和“展开”按钮仍挤在同一行，导致 `PA4303 退房` 被硬拆成两行。
- 本次 follow-up 把任务卡片头部拆成窄屏双层布局：
  - 第一层只放排序圆点和房号标题，让标题拿到完整宽度。
  - 第二层再放状态标签和“展开/收起”按钮。
  - 当屏宽 `<= 375pt` 或字体倍率较高时，标题最大行数放宽到 3 行，避免关键业务信息被压缩成异常断行。

### 2026-06-23 Restore Previous TasksScreen UI

- 用户要求恢复到上一版 `TasksScreen` 任务卡片 UI。
- 本次回退只撤销了最后一轮卡片视觉重排，保留之前已经接入的响应式基础能力：
  - 标题恢复成上一版的一体式显示，不再拆成“房号主标题 + 任务后缀副标题”。
  - 状态与“展开/收起”按钮恢复为上一版视觉关系，折叠按钮重新带文字。
  - 任务类型标签恢复到标签区，不再并入标题下方 meta 行。
  - 执行人员区恢复为上一版的双列卡片布局。
- 用户随后要求把 `待检查`、`未分配`、`已退房` 这些状态标签恢复到右上角位置；本次仅调整 `TasksScreen` 任务卡片头部，把状态 pill 从标题下方移回右上角，和折叠按钮一起放回头部右侧。
- 用户随后继续 уточнить（并排要求）：`收起/展开` 按钮和 `待检查`、`未分配`、`已退房` 等状态标签不要上下堆叠，而要在头部右上角并排显示；本次把头部右侧容器改回横向排列。
- 用户继续反馈“标签大小都不一样，也没有水平对齐”；本次进一步统一头部右上角控件规则：状态标签和 `收起/展开` 按钮改成同高度、同圆角、同纵向居中，并禁止右侧容器随意换行。

### 2026-06-23 Restore Previous Web UI

- 用户要求网页端恢复成原来的样子。
- 本次只回退网页端通用展示入口，不动后台业务页逻辑和数据：
  - `AdminLayout` 恢复原来的内容区容器和头部按钮，不再套 `ResponsivePageSection`。
  - `ClientThemeProvider` 恢复原来的 antd token 配置，不再把网页全局尺寸改成响应式 token 体系。
  - `CrudTable` 恢复原来的桌面表格渲染，不再强制走移动端 card 视图包装。

### 2026-06-23 InspectionPanel Small-screen Follow-up

- 用户补充了 `InspectionPanelScreen` 的真机截图，`2. 清洁问题反馈` 区域的 `拍照上传 / 相册上传` 按钮在 iPhone 小屏下仍会把卡片底部撑穿。
- 本次 follow-up 只修展示层：
  - 把这组按钮从通用横排改成专用上传操作区。
  - 两个按钮默认等宽分栏，空间不足时自动换行，不再硬挤在一排。
  - 按钮文案允许在按钮内收缩，继续保留 `minHeight` 点击区，不改上传逻辑、草稿结构或提交链路。

### 2026-06-23 InspectionPanel Frozen-state Follow-up

- 用户继续反馈“按钮都被挡住了”。复查后确认不是被下一张卡片盖住，而是页面已进入正式提交后的 `hasFormalSubmission / isFrozen` 状态，底部按钮已切成“进入标记已完成”，因此清洁问题反馈区的两颗上传按钮被条件渲染整块隐藏。
- 本次 follow-up 继续只修展示层，不改状态机：
  - `拍照上传 / 相册上传` 在冻结态下不再整块消失，而是保留原位显示为禁用态。
  - 冻结态下补一行说明文案，明确当前需要先放弃提交批次再重建草稿，避免用户误以为按钮被遮挡或页面爆版。

### 2026-06-23 InspectionPanel Upload-action Placement Follow-up

- 用户再次提供截图，显示按钮虽然可见，但仍和已上传照片的备注输入框边框重叠。
- 本次 follow-up 修正按钮所在层级和输入框尺寸：
  - 把 `拍照上传 / 相册上传` 从已上传问题列表之后移动到列表之前，作为清洁问题反馈区的独立新增操作区。
  - 已有照片和备注现在排在新增操作区下面，避免按钮和单条问题备注框互相覆盖。
  - 备注输入框从固定 `height` 改为 `minHeight`，大字号或多行内容时由内容撑开，不再压住后续元素。

### Files / Areas

- `mz-cleaning-app-frontend/src/lib/scale.ts` — modified: 默认最大字体放大倍率从 `1.15` 提到 `1.35`。
- `mz-cleaning-app-frontend/src/lib/theme.ts` — added: 统一移动端 spacing / font / radius / breakpoints / touch target / max font multiplier token。
- `mz-cleaning-app-frontend/src/lib/responsive.ts` — added: 窄屏断点与图片网格列数 helper。
- `mz-cleaning-app-frontend/src/components/ui/AppText.tsx` — added: 支持 `allowFontScaling`、`maxFontSizeMultiplier`、可展开文案。
- `mz-cleaning-app-frontend/src/components/ui/AppTextInput.tsx` — added: 输入框统一字体放大、`minHeight`、`lineHeight`、`paddingVertical`。
- `mz-cleaning-app-frontend/src/components/ui/AppButton.tsx` — added: 按钮统一最小点击高度和 padding。
- `mz-cleaning-app-frontend/src/components/ui/ResponsiveCard.tsx` — added: 移动端通用响应式卡片容器。
- `mz-cleaning-app-frontend/src/components/ui/ResponsiveImageGrid.tsx` — added: 基于父容器 `onLayout` 的图片网格。
- `mz-cleaning-app-frontend/src/components/ui/SafeAreaBottomBar.tsx` — added: 底部固定操作条统一处理 safe area。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 顶部 segment、任务卡片标题行、按钮和操作入口改为可换行/最小点击区；适配窄屏和字体放大。2026-06-23 follow-up 先做 iPhone 7 窄屏双层头部，随后按用户要求撤回最后一轮卡片视觉重排，恢复到上一版任务卡片 UI，并把状态标签重新放回头部右上角，最终再改成与 `展开/收起` 按钮并排显示；最新一轮继续统一两者的尺寸和对齐规则。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — modified: 输入框与底部完成按钮接入统一组件；房间照片网格改成父容器自适应；底部按钮处理 safe area + keyboard。2026-06-23 follow-up 进一步把清洁问题反馈区上传按钮改成可换行等宽布局，修复 iPhone 小屏下按钮出框；随后又补上冻结态禁用显示，避免正式提交后按钮整块消失；最新一轮把新增上传按钮移到已上传问题列表上方，并把备注框改为 `minHeight`，避免按钮与备注输入框边框重叠。
- `mz-cleaning-app-frontend/src/screens/tasks/SuppliesFormScreen.tsx` — modified: 输入、提交条、上传图片区和遥控器/必拍照片区改成统一响应式组件与底部安全区方案。
- `mz-cleaning-app-frontend/src/screens/tasks/CleaningSelfCompleteScreen.tsx` — modified: 输入/照片区/提交条统一接入响应式组件，房间完成照片与消耗品图片区改成自适应网格。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.tsx` — modified: 顶部关键文案支持换行/展开，底部双按钮改成 safe-area 固定条。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` — modified: 仅补 `useCallback` import，修复现有 `typecheck` 阻塞。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx` — modified: 补齐 `keyUploadQueue` mock，恢复现有任务页测试稳定性。
- `frontend/src/lib/uiTokens.ts` — added: Web 统一 spacing / font / radius / breakpoints / touch target token。
- `frontend/src/components/ui/AppText.tsx` — added: 后台统一长文本换行/展开组件。
- `frontend/src/components/ui/AppButton.tsx` — added: 后台按钮统一最小点击高度与自动换行。
- `frontend/src/components/ui/ResponsiveCard.tsx` — added: 后台 mobile card 容器。
- `frontend/src/components/ui/ResponsiveImageGrid.tsx` — added: 基于父容器宽度与 `ResizeObserver` 的后台图片网格。
- `frontend/src/components/ui/ResponsivePageSection.tsx` — added: 后台内容区统一页边距与窄屏约束。
- `frontend/src/components/ui/ResponsiveDataView.tsx` — added: 后台列表在移动端切到 card 模式的通用容器。
- `frontend/src/components/ClientThemeProvider.tsx` — modified: 先前接入统一 `uiTokens`；本次已恢复到原来的 antd token 配置。
- `frontend/src/components/AdminLayout.tsx` — modified: 先前内容区域接入 `ResponsivePageSection`、头部按钮接入统一 button；本次已恢复原来的网页端壳子布局。
- `frontend/src/components/CrudTable.tsx` — modified: 先前新增 `mobileCardRender` 并优先渲染 card；本次已恢复原来的桌面表格渲染。
- `docs/change-release-ledger.md` — modified: 记录本次自适应展示层改造。

### Impact / Dependencies

- API: none. 仅展示层和基础组件重构，请求参数、接口调用链未改。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Shares `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` with `CRL-20260623-007`、`CRL-20260623-009`、`CRL-20260623-011`、`CRL-20260623-013`; 若选择性发布，必须按 hunk 暂存。
  - Shares `mz-cleaning-app-frontend/src/screens/tasks/CleaningSelfCompleteScreen.tsx` with `CRL-20260623-015`; 不能整文件 stage。
  - Shares `frontend/src/components/AdminLayout.tsx`、`frontend/src/components/CrudTable.tsx` and `frontend/src/components/ClientThemeProvider.tsx` with other in-flight root-frontend work; selective release requires verified hunk staging.

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed again after the latest `InspectionPanelScreen` upload-action placement follow-up.
- `npm run lint` in `mz-cleaning-app-frontend` — passed again after the latest `InspectionPanelScreen` follow-up, with existing repository warnings only; 0 errors.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed again after the latest `InspectionPanelScreen` follow-up: 22 suites, 63 tests. Jest still prints the existing `SafeAreaView` deprecation warning and open-handle notice.
- `build` in `mz-cleaning-app-frontend` — not run: `package.json` has no `build` script.
- `npm run lint` in `frontend` — passed with existing repository warnings only; 0 errors.
- `npm test` in `frontend` — passed: 35 files, 154 tests.
- `typecheck` in `frontend` — no standalone script; `npm run build` includes Next.js lint + type validation phase.
- `npm run build` in `frontend` — passed. Build still emitted existing repository warnings and pre-existing chart container width warnings during static generation, but completed successfully.
- `npm run lint` in `frontend` — passed again after restoring the previous web UI; still only existing repository warnings.
- `npm test` in `frontend` — passed again after restoring the previous web UI: 35 files, 154 tests.
- `npm run build` in `frontend` — passed again after restoring the previous web UI. Build still emitted existing repository warnings and pre-existing chart container width warnings during static generation, but completed successfully.
- `npx jest --runInBand src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed after the iPhone 7 follow-up and passed again after restoring the previous `TasksScreen` card UI. Test still prints the existing `SafeAreaView` deprecation warning and open-handle notice.
- `npx jest --runInBand src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed again after moving the status tag back to the top-right position. Test still prints the existing `SafeAreaView` deprecation warning and open-handle notice.
- `npx jest --runInBand src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed again after changing the top-right status tag and collapse button to a side-by-side layout. Test still prints the existing `SafeAreaView` deprecation warning and open-handle notice.
- `npx jest --runInBand src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed again after normalizing the top-right controls to the same size and alignment. Test still prints the existing `SafeAreaView` deprecation warning and open-handle notice.
- `python3 scripts/audit_change_release_ledger.py` — passed after the latest ledger update; current changed files are fully covered.

### Risks / Release Notes

- Risk: 这轮以组件级展示重构为主，没有在真机上逐项完成 `iOS 135% 字体`、`Android Display size / Font size`、`iPad 分屏`、`浏览器 125%/150% zoom`、`键盘弹出` 的人工回归；代码路径已按规范改造，但设备矩阵仍建议补一轮手测。
- Risk: `TasksScreen.tsx`、`InspectionPanelScreen.tsx`、`CleaningSelfCompleteScreen.tsx` 和后台通用容器都属于当前工作树热点文件；如需拆分发布，必须按 hunk 核对归属。
- Rollback: revert the shared responsive token/component files plus the related screen/layout usage hunks, while preserving unrelated in-flight logic changes in the same files.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches added or recorded.
- Git state: uncommitted in root repo and nested `mz-cleaning-app-frontend`; this unit coexists with unrelated worktree changes from other threads.

## CRL-20260623-018 — Cleaning 图片稳定对象 key 与鉴权代理读取

- **Status:** pushed
- **Updated:** 2026-06-23 21:51 AEST
- **Request:** 先修远端读取根因：让 `cleaning/` 图片通过受控、鉴权的代理读取，页面保存稳定对象 key，不再直接依赖可能返回 403 的 R2 endpoint URL。
- **Outcome:** `InspectionPanel` 上传后会同时保存稳定的 `cleaning/...` 对象 key 和兼容 URL；同步完成后缩略图及大图优先用对象 key 通过 Bearer 鉴权代理读取，恢复网络后不再直接访问私有 R2 endpoint。

### Implementation

- Previous behavior:
  - `POST /cleaning-app/upload` 只返回 R2 URL；没有公开地址配置时，该 URL 可能是 App 无权读取的 R2/S3 endpoint。
  - `InspectionPanel` 在本地文件不可用后把 `uploaded_url` 直接交给 React Native `<Image>`，即使网络恢复也可能持续得到 403。
  - 现有 `/public/r2-image` 不允许 `cleaning/` 前缀；在公开代理上直接放开该前缀会绕过移动端账号权限。
- New behavior:
  - 上传接口增加兼容字段 `key`，返回稳定的 `cleaning/...` 对象 key，同时保留原 `url`。
  - `/cleaning-app/media/image` 接收首选 `key` 或历史 `url`，经过现有移动端 JWT/权限校验后才从 R2 读取；只允许安全的 `cleaning/` key。
  - InspectionPanel queue/draft 新增 `uploaded_key`，上传断点结果同时持久化 `remote_key` 与 `remote_url`；页面预览优先使用 key。
  - React Native `<Image>` 通过带 `Authorization: Bearer ...` header 的代理 source 读取远端图片；本地 `file://` 图片仍直接读取。
  - 为兼容现有数据库和后台图片字段，业务保存 payload 本轮仍优先提交原 URL；稳定 key 用于移动端 queue/page 的正式远端读取，不改变既有 API 字段语义。
- Key decisions:
  - 不把 `cleaning/` 加入无鉴权的 `/public/r2-image` allowlist。
  - 不新增第二套上传接口；复用现有 `/cleaning-app/upload` 和 `cleaning-app` 鉴权 router。
  - 历史 R2 URL 仍可通过代理转换成 key，旧批次无需迁移即可读取。

### Files / Areas

- `backend/src/modules/cleaning_app.ts` — modified: 鉴权图片读取接口支持稳定 key；上传响应增加 key。
- `mz-cleaning-app-frontend/src/lib/cleaningMedia.ts` — added: cleaning key 校验、历史 R2 URL 兼容、鉴权 Image source 构造。
- `mz-cleaning-app-frontend/src/lib/cleaningMedia.test.ts` — added: stable key 优先、Bearer 代理 source、本地文件直读和不安全 key 拒绝测试。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: `uploadCleaningMedia` 读取上传响应中的可选 key。
- `mz-cleaning-app-frontend/src/lib/inspectionPanelDraft.ts` — modified: draft 持久化/恢复 `uploaded_key`。
- `mz-cleaning-app-frontend/src/lib/inspectionPanelSubmitQueue.ts` — modified: queue 持久化 remote key、重试复用 key/url、页面 snapshot 恢复 key。
- `mz-cleaning-app-frontend/src/lib/inspectionPanelSubmitQueue.test.ts` — modified: 覆盖 key 持久化及业务 URL 兼容。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — modified: 缩略图和查看大图统一通过鉴权 cleaning media source。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API:
  - `POST /cleaning-app/upload` 响应从 `{ url }` 扩展为 `{ url, key }`；旧客户端兼容。
  - `GET /cleaning-app/media/image?key=cleaning/...` 新增稳定 key 读取方式；保留 `?url=...` 兼容历史数据。
- Database / migration: none.
- Config / environment: none; 继续使用现有 R2 和 JWT 配置。
- Dependencies: none.
- Related units:
  - Builds on `CRL-20260623-016` 的 InspectionPanel submit queue。
  - Shares `backend/src/modules/cleaning_app.ts`, `mz-cleaning-app-frontend/src/lib/api.ts`, `inspectionPanelDraft.ts`, `inspectionPanelSubmitQueue.ts`, `inspectionPanelSubmitQueue.test.ts`, and `InspectionPanelScreen.tsx` with in-flight units; selective release requires verified hunk-level staging.

### Validation

- `npm run build` in `backend` — passed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm test -- --runInBand src/lib/cleaningMedia.test.ts src/lib/inspectionPanelSubmitQueue.test.ts` in `mz-cleaning-app-frontend` — passed: 2 suites, 5 tests.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 23 suites, 66 tests; existing SafeAreaView deprecation warning and Jest open-handle notice remain.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 126 existing warnings.
- `npx eslint src/lib/cleaningMedia.ts src/lib/cleaningMedia.test.ts src/lib/inspectionPanelDraft.ts src/lib/inspectionPanelSubmitQueue.ts src/lib/inspectionPanelSubmitQueue.test.ts src/screens/tasks/InspectionPanelScreen.tsx` — passed with 0 errors and 4 existing `Array<T>` warnings in `inspectionPanelSubmitQueue.ts`.
- `git diff --check -- backend/src/modules/cleaning_app.ts` and nested focused `git diff --check` — passed.
- `build` in `mz-cleaning-app-frontend` — not run: this repo has no `build` script.

### Risks / Release Notes

- Runtime risk: 未连接真实 R2 和真机执行“同步成功 -> 断网 -> 恢复网络”端到端回归；当前验证覆盖代码路径、鉴权 source 构造、queue key 持久化、类型检查和自动测试。
- Release dependency: 后端与移动端必须一起发布；只发移动端时生产后端不会返回 key/提供 key 代理，只发后端时旧 App 仍直接读取 URL。
- Security: `cleaning/` 未加入公开代理；读取接口要求现有 JWT 权限，并拒绝非 `cleaning/`、含 `..` 或反斜杠的 key。
- Rollback: remove upload `key`, authenticated media route/key handling, and restore InspectionPanel previews to the prior URL-only source while retaining unrelated submit-queue changes.
- Sensitive-information review: no secrets, tokens, `.env` values, credentials, database URLs, sensitive logs, or local caches added; Authorization is constructed at runtime and not persisted.
- Git state: uncommitted in root repo and nested `mz-cleaning-app-frontend`; current files coexist with unrelated worktree changes from other threads.

## CRL-20260623-019 — InspectionPanel 同步后离线缩略图缓存

- **Status:** pushed
- **Updated:** 2026-06-23 21:58 AEST
- **Request:** 同步成功后删除原图，但保留受容量限制的本地压缩缩略图；断网时显示缩略图，联网时优先显示远端图片。
- **Outcome:** InspectionPanel 照片同步成功后会生成受限容量的 JPEG 缩略图，再持久化缓存路径并删除原图；联网优先显示鉴权远端图片，断网或远端加载失败时自动显示本地缩略图。

### Implementation

- Previous behavior:
  - synced batch 只保留远端 key/URL；本地原图清理与离线回看没有形成完整收尾步骤。
  - 图片组件只选择一个 URI，没有“远端优先、离线或远端失败回退缩略图”的明确策略。
- New behavior:
  - 新增 InspectionPanel 缩略图目录，图片按最大宽度 480、JPEG 质量 0.55 生成。
  - 缓存同时限制最多 96 张和 24 MB，超限按修改时间从旧到新淘汰；当前刚生成的 batch 缩略图会在本轮清理中受保护。
  - `InspectionPanelBatchMedia` 增加 `thumbnail_uri`，draft/queue 归一化和恢复路径均保留该字段。
  - 正式同步所有业务步骤成功后，先生成缩略图，再把 `thumbnail_uri` 和 `local_uri=null` 持久化到 synced snapshot，最后删除原图并执行容量清理。
  - 如果缩略图生成失败，原图继续保留，不执行破坏性清理。
  - 新增共享图片组件：草稿阶段优先本地原图；同步后联网优先远端；明确离线或远端加载失败时回退缩略图；缩略图失效后仍可回退尝试远端。
- Key decisions:
  - 缩略图只属于本地缓存，不上传、不写后台、不作为正式事实来源。
  - 缩略图存放在 App document 目录而不是系统临时缓存目录，容量由应用主动限制，避免系统随时回收导致离线保障失效。
  - 本轮只覆盖 InspectionPanel batch 中可回看的房间检查、清洁问题和补货凭证照片，不扩展其他独立上传队列。

### Files / Areas

- `mz-cleaning-app-frontend/src/lib/inspectionThumbnailCache.ts` — added: 缩略图生成、存在检查、文件数/字节双上限和最旧优先淘汰。
- `mz-cleaning-app-frontend/src/lib/inspectionThumbnailCache.test.ts` — added: 文件数及容量淘汰测试。
- `mz-cleaning-app-frontend/src/components/CleaningMediaImage.tsx` — added: 本地原图、鉴权远端图和缩略图的统一选择及加载失败回退组件。
- `mz-cleaning-app-frontend/src/lib/cleaningMedia.ts` — modified: 增加可测试的在线远端优先、离线/失败缩略图回退选择函数。
- `mz-cleaning-app-frontend/src/lib/cleaningMedia.test.ts` — modified: 覆盖在线、离线和远端失败三种选择。
- `mz-cleaning-app-frontend/src/lib/inspectionPanelDraft.ts` — modified: 持久化及恢复 `thumbnail_uri`。
- `mz-cleaning-app-frontend/src/lib/inspectionPanelSubmitQueue.ts` — modified: synced 收尾生成缩略图、先持久化后删原图、容量清理和失败保留原图。
- `mz-cleaning-app-frontend/src/lib/inspectionPanelSubmitQueue.test.ts` — modified: 覆盖成功生成缩略图后删原图，以及生成失败保留原图。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — modified: 缩略图、小图和大图查看统一使用远端优先/离线回退组件及 NetInfo 状态。
- `docs/change-release-ledger.md` — modified: 记录本离线缩略图单元。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none; 缓存限制为代码内固定安全上限，不新增运行时配置。
- Dependencies: 使用项目现有 `expo-image-manipulator`、`expo-file-system` 和 `@react-native-community/netinfo`，无新增 package。
- Related units:
  - Depends on `CRL-20260623-018` 的远端对象 key 与鉴权代理。
  - Builds on `CRL-20260623-016` 的 InspectionPanel submit queue。
  - Shares `cleaningMedia.ts`, `cleaningMedia.test.ts`, `inspectionPanelDraft.ts`, `inspectionPanelSubmitQueue.ts`, `inspectionPanelSubmitQueue.test.ts`, and `InspectionPanelScreen.tsx` with those in-flight units; selective release requires verified hunk-level staging.

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm test -- --runInBand src/lib/inspectionThumbnailCache.test.ts src/lib/cleaningMedia.test.ts src/lib/inspectionPanelSubmitQueue.test.ts` — passed: 3 suites, 9 tests.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 24 suites, 70 tests; existing SafeAreaView deprecation warning and Jest open-handle notice remain.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 125 existing warnings.
- Focused `npx eslint` for thumbnail/cache/queue/InspectionPanel files — passed with 0 errors and 4 existing `Array<T>` warnings in `inspectionPanelSubmitQueue.ts`.
- Focused nested `git diff --check` — passed.
- `build` in `mz-cleaning-app-frontend` — not run: this repo has no `build` script.

### Risks / Release Notes

- Runtime risk: 未在真机实际测量缩略图文件大小和执行“同步完成 -> 断网退出重进 -> 联网恢复”完整流程；自动测试覆盖状态选择、容量淘汰、成功清理和失败保护。
- Cache behavior: 达到 96 张或 24 MB 后，最旧缩略图会被删除；对应较旧照片断网时可能无法显示，但联网仍通过远端读取。这是受容量限制缓存的预期行为。
- Performance: 缩略图在所有业务同步步骤成功后串行生成，避免并发处理多张大图造成内存峰值；大量照片的 batch 最终收尾时间会略有增加。
- Rollback: remove `thumbnail_uri`, thumbnail cache/helper/component, and restore InspectionPanel images to direct local/remote source selection while preserving remote key/proxy behavior.
- Sensitive-information review: 缩略图是现有清洁照片的本地派生缓存，不包含新增凭证或配置；未记录或提交 token、`.env`、数据库 URL、日志或其他敏感值。
- Git state: uncommitted in nested `mz-cleaning-app-frontend`; files coexist with other in-flight mobile changes.

## CRL-20260623-020 — InspectionPanel 失败批次操作入口去重

- **Status:** pushed
- **Updated:** 2026-06-23 22:11 AEST
- **Request:** 优化检查与补充页面中重复出现的“重试同步”和“放弃并重建草稿”操作。
- **Outcome:** 失败批次的两个操作只保留在底部固定操作栏；顶部状态卡只显示一段失败说明，不再重复按钮或重复冻结提示。

### Implementation

- Previous behavior: `failed / partial_failed` 时，顶部状态卡和底部固定栏各显示一组“重试同步 / 放弃并重建草稿”；顶部还额外重复说明失败批次已冻结。
- New behavior: 顶部状态卡只保留现有 `batchStatusHint` 完整说明；失败操作统一由底部固定栏承载，每个操作在页面中只出现一次。
- Key decisions: 保留底部操作栏作为唯一入口，因为它在小屏滚动页面中始终可见；不改变失败批次状态机、重试逻辑、放弃确认弹窗或“进入标记已完成”主按钮。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — modified: 删除顶部重复失败操作和重复冻结提示。
- `docs/change-release-ledger.md` — modified: 记录本 UI 去重单元。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Follow-up to `CRL-20260623-016` 的失败批次操作。
  - Shares `InspectionPanelScreen.tsx` with `CRL-20260623-017`, `CRL-20260623-018`, and `CRL-20260623-019`; selective release requires verified hunk-level staging.

### Validation

- `rg -n "继续重试同步|重试同步|放弃并重建草稿|当前失败批次已冻结" src/screens/tasks/InspectionPanelScreen.tsx` — passed: only the bottom `重试同步` and `放弃并重建草稿` labels remain; the alert error fallback is not a rendered action.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npx eslint src/screens/tasks/InspectionPanelScreen.tsx` — passed with 0 errors and 0 warnings.
- `npm test -- --runInBand src/lib/inspectionPanelSubmitQueue.test.ts src/lib/cleaningMedia.test.ts` — passed: 2 suites, 7 tests.
- Focused nested `git diff --check` — passed.
- `build` in `mz-cleaning-app-frontend` — not run: this repo has no `build` script.

### Risks / Release Notes

- Risk: 未在真机重新截图验证底部安全区，但本轮只删除顶部 JSX，不调整底部栏布局和尺寸。
- Rollback: restore the removed top status-card action row and duplicate warning text.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, logs, or caches added.
- Git state: uncommitted in nested `mz-cleaning-app-frontend`; file shares other in-flight InspectionPanel changes.

## CRL-20260623-021 — 房间检查照片本机保存确认

- **Status:** pushed
- **Updated:** 2026-06-23 22:17 AEST
- **Request:** 房间检查照片增加保存按钮，避免检查人员忘记进入标记完成而担心本地照片消失。
- **Outcome:** 房间检查照片区新增“保存照片到本机”按钮；拍照后仍会立即自动写入本地草稿，用户也可手动再次确认，并看到最近保存时间和未上传提示。

### Implementation

- Previous behavior: 照片已经自动复制到 App 私有目录并由 effect 写入草稿，但页面只有“添加”和正式提交入口，没有明确的保存确认或保存时间反馈。
- New behavior:
  - 每次拍摄房间照片后立即用更新后的照片列表显式等待本地草稿写入，不再只依赖后续 effect。
  - 房间检查照片区域新增“保存照片到本机”按钮，点击后等待当前草稿持久化完成并显示成功提示。
  - 成功保存后显示本机保存时间，并明确“尚未上传，正式提交后上传”。
  - 自动保存失败时提示用户点击保存按钮重试。
  - 正式提交冻结后隐藏本机保存按钮，并说明进入完成页不会导致照片不可回看。
- Key decisions:
  - 保存按钮只保存本地草稿，不触发上传、业务提交或任务完成，避免第二套提交语义。
  - 保留自动保存作为主保障，按钮是可见的人工确认和重试入口。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — modified: 拍照后立即持久化、保存按钮、保存时间和状态提示。
- `docs/change-release-ledger.md` — modified: 记录本机保存确认单元。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Builds on `CRL-20260623-016` 的本地 InspectionPanel draft。
  - Complements `CRL-20260623-019` 的同步后缩略图离线回看。
  - Shares `InspectionPanelScreen.tsx` with CRL-20260623-017 through CRL-20260623-020; selective release requires verified hunk-level staging.

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npx eslint src/screens/tasks/InspectionPanelScreen.tsx` — passed with 0 errors and 0 warnings.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 24 suites, 70 tests; existing SafeAreaView deprecation warning and Jest open-handle notice remain.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 125 existing warnings.
- `rg` verification for save button, save success message, saved timestamp, and frozen-state guidance — passed.
- Focused nested `git diff --check` — passed.
- `build` in `mz-cleaning-app-frontend` — not run: this repo has no `build` script.

### Risks / Release Notes

- Runtime risk: 未在真机截图确认按钮在不同字体倍率下的最终视觉位置；按钮使用现有全宽 `AppButton` 和响应式容器。
- Behavior boundary: “保存照片到本机”不代表已经上传；页面文案和成功提示已明确区分。
- Rollback: remove the explicit room-photo save state/button and restore photo capture to state update plus effect-only draft persistence.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, logs, or local caches were added to Git.
- Git state: uncommitted in nested `mz-cleaning-app-frontend`; file shares other in-flight InspectionPanel changes.

## CRL-20260623-022 — InspectionPanel 主提交按钮取消底部固定

- **Status:** pushed
- **Updated:** 2026-06-23 22:29 AEST
- **Request:** 检查人员的“提交本页检查与补充”不固定在页尾；房间检查照片按钮显示“保存照片”，不要显示“到本机”。
- **Outcome:** 正常检查流程的主提交/完成按钮移入“5. 标记已完成”区域并随页面滚动；只有同步失败批次的恢复操作继续固定在底部；照片保存按钮及失败提示统一简化为“保存照片”。

### Implementation

- Previous behavior:
  - “提交本页检查与补充”“进入标记已完成”等正常主操作始终固定在页面底部，并占用较大的滚动区底部留白。
  - 房间照片保存按钮显示“保存照片到本机”，自动保存失败提示也使用相同长文案。
- New behavior:
  - 正常主操作完整移入“5. 标记已完成”卡片，不再冻结在页尾。
  - `failed / partial_failed` 批次仍在底部固定显示“重试同步 / 放弃并重建草稿”，避免异常恢复入口随长页面滚走。
  - 非失败状态减少底部滚动留白；失败状态继续为固定恢复栏预留安全区。
  - 房间照片按钮显示“保存照片”，自动保存失败提示同步改为“请点击保存照片”。
- Key decisions:
  - 只调整操作位置和展示文案，不改变本地草稿保存、正式提交、同步重试或放弃重建的业务逻辑。
  - 保留失败恢复栏固定展示，避免取消正常主按钮固定时降低异常状态的可恢复性。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — modified: 主操作移入第 5 区、失败恢复栏条件展示、滚动底部留白调整和照片保存文案简化。
- `docs/change-release-ledger.md` — modified: 记录本 UI 调整单元。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Follow-up to `CRL-20260623-020` 的失败操作入口去重。
  - Follow-up to `CRL-20260623-021` 的房间照片保存确认。
  - Shares `InspectionPanelScreen.tsx` with `CRL-20260623-016` through `CRL-20260623-021`; selective release requires verified hunk-level staging.

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npx eslint src/screens/tasks/InspectionPanelScreen.tsx` — passed with 0 errors and 0 warnings.
- `npm test -- --runInBand src/lib/inspectionPanelSubmitQueue.test.ts src/lib/cleaningMedia.test.ts` — passed: 2 suites, 7 tests.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 24 suites, 70 tests; existing SafeAreaView deprecation warning and Jest open-handle notice remain.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 125 existing warnings.
- Focused nested `git diff --check` — passed.
- `build` in `mz-cleaning-app-frontend` — not run: this repo has no `build` script.

### Risks / Release Notes

- Runtime risk: 未在真机截图验证主按钮进入第 5 区后的最终滚动位置和不同字体倍率表现。
- Behavior boundary: 失败批次的“重试同步 / 放弃并重建草稿”仍固定在底部，这是异常恢复入口的有意保留。
- Rollback: move the normal primary action back into the unconditional bottom safe-area bar and restore the longer room-photo save label.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, logs, or local caches were added.
- Git state: uncommitted in nested `mz-cleaning-app-frontend`; file shares other in-flight InspectionPanel changes.

## CRL-20260623-023 — InspectionPanel 必拍验证与联网队列鉴权隔离

- **Status:** pushed
- **Updated:** 2026-06-23 22:42 AEST
- **Request:** 修复断网拍照不完整但联网后仍可提交成功的问题，并检查重新联网提交后 App 重启、要求重新登录的问题。
- **Outcome:** 入住时间不再自动绕过房间照片必拍验证；只有检查人员明确确认“客人已到达并急需入住”才可跳过。草稿冻结和后台队列都会重新验证 snapshot，旧的不完整批次不能同步或进入完成页。InspectionPanel 后台队列的 401 会保留失败状态，不再直接广播全局登出。

### Implementation

- Previous behavior:
  - `canSkipInspectionPhotosForGuestArrival(checkinTime)` 只要入住时间为 15:00 或以后就返回 true，页面没有“客人确实已经到达”的确认状态，因此正常任务可无条件跳过客厅、沙发、卧室和厨房照片。
  - 必填验证只在首次草稿提交前执行；已有 `pending_submit / failed / synced` 批次重试时直接运行队列，冻结 snapshot 没有第二层完整性验证。
  - 队列使用的上传、补货和检查照片接口收到 401 时，`fetchWithTimeout` 会立即触发全局 auth invalidation；重新联网自动跑队列时可能直接进入静默重登/退出流程，表现为页面重启并要求重新登录。
- New behavior:
  - 新增 `room_photo_requirement`：`required`、`password_only`、`guest_arrival_confirmed`。缺失字段的旧数据按最安全的 `required` 处理。
  - 下午入住任务只显示明确确认项；未勾选时四个区域仍全部必拍，勾选后才把跳过原因写入本地草稿和冻结 snapshot。
  - 新增共享 `validateInspectionPanelSnapshot`，同时用于页面提交、`submitInspectionPanelBatch` 冻结和后台队列执行前检查。
  - 旧的已冻结不完整批次会在任何上传/API 调用前标记失败，页面禁止进入完成页，并提供“放弃并重建草稿”。
  - 上传、补货和检查照片 API 增加可选 `skipAuthInvalidation`；InspectionPanel 后台队列使用该选项。401/403 仍会停止队列且不会自动重试，但单个后台步骤不再直接清空全局登录状态。
- Key decisions:
  - 保留“客人已到达且急需入住”的业务例外，但必须由检查人员明确确认，不能仅根据计划入住时间推断。
  - 不屏蔽正常前台鉴权检查；只有可恢复后台队列请求隔离全局登出副作用。
  - 不自动修补已同步到后台的旧不完整内容；用户需要放弃本地坏批次、补齐照片后重新提交。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — modified: 显式客人到达确认、冻结批次验证、禁止不完整批次进入完成页和重建入口。
- `mz-cleaning-app-frontend/src/lib/inspectionPanelDraft.ts` — modified: 本地草稿持久化照片要求。
- `mz-cleaning-app-frontend/src/lib/inspectionPanelSubmitQueue.ts` — modified: snapshot 照片要求、共享验证、冻结/队列双重拦截和后台 API 鉴权隔离。
- `mz-cleaning-app-frontend/src/lib/inspectionPanelSubmitQueue.test.ts` — modified: 覆盖必拍拒绝、明确跳过和旧坏批次在 API 前失败。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: 认证请求可选择跳过全局 auth invalidation，并为队列保存接口返回类型化 401/403。
- `mz-cleaning-app-frontend/src/lib/api.test.ts` — added: 覆盖队列 401 不广播全局登录失效。
- `docs/change-release-ledger.md` — modified: 记录本验证与队列恢复修复单元。

### Impact / Dependencies

- API: request payload 增加仅本地使用的 snapshot 字段；服务端 API 契约不变。后台队列请求增加内部 `X-Skip-Auth-Invalidation` 客户端控制 header，后端无需处理。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Corrective follow-up to `CRL-20260623-016` 的 InspectionPanel submit queue。
  - Shares `InspectionPanelScreen.tsx`, `inspectionPanelDraft.ts`, `inspectionPanelSubmitQueue.ts`, and `api.ts` with `CRL-20260623-017` through `CRL-20260623-022`; selective release requires verified hunk-level staging.

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm test -- --runInBand src/lib/inspectionPanelSubmitQueue.test.ts src/lib/api.test.ts` — passed: 2 suites, 7 tests.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 25 suites, 73 tests; existing SafeAreaView deprecation warning and Jest open-handle notice remain.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 125 existing warnings.
- Focused `npx eslint` — passed with 0 errors; existing `Array<T>` warnings remain in shared files.
- Focused nested `git diff --check` — passed.
- `build` in `mz-cleaning-app-frontend` — not run: this repo has no `build` script.

### Risks / Release Notes

- Runtime evidence: 没有获取用户真机崩溃日志，因此“重新联网后要求登录”的直接触发点是根据代码中后台队列 401 -> auth invalidation 链路确认的最可能原因；修复已用请求级测试覆盖，但仍需真机断网/联网回归。
- Existing bad batches: 已经冻结且照片不完整的本地批次会显示验证失败，只能放弃并重建；已成功写入后台的旧内容不会自动回滚。
- Authentication boundary: 真正过期的 token 仍会由正常前台 `/auth/me` 或其他非队列请求触发标准静默重登/退出，修复不会让无效会话永久保留。
- Rollback: remove `room_photo_requirement` and snapshot validation, restore time-only photo skipping, and remove queue-specific `skipAuthInvalidation` options.
- Sensitive-information review: tests use synthetic tokens only; no real secrets, `.env` values, credentials, database URLs, sensitive logs, or local caches were added.
- Git state: uncommitted in nested `mz-cleaning-app-frontend`; files coexist with other in-flight mobile changes.

## CRL-20260623-024 — 移动端补品/检查缺项定位、下次退房补提示与挂钥匙视频自动补保存

- **Status:** pushed
- **Updated:** 2026-06-23 23:18 AEST
- **Request:** 修复三点：1）清洁或检查人员提交“补品填报 / 检查与补充”失败时不要只弹错误，要自动跳到未完成区域并高亮提示缺什么、是不是照片没传；2）检查员需要能把未补的消耗品记成“下次退房补”，并在该房源下一次退房任务页面提醒显示；3）检查端挂钥匙视频要支持离线先存本地，联网后自动保存。
- **Outcome:** 补品页和检查页的校验失败改成页内提示、自动滚动和区块高亮；检查页新增“下次退房补”状态并把提醒投影到后续退房任务；挂钥匙视频在本地队列上传后会继续自动补业务保存，不再要求回到页面再点一次才能落库。

### Implementation

- Previous behavior:
  - `SuppliesFormScreen` 和 `InspectionPanelScreen` 在缺项时直接 `Alert.alert(...)`，用户只知道失败，不知道该回到哪一段补内容。
  - 检查页补货只有“已补充 / 无需补充”两态，无法表达“这次来不及补，留到下次退房补”。
  - `/mzapp/work-tasks` 的 `restock_items` 只读取当前任务的 `cleaning_consumable_usages low`，不会把检查端留给下一次退房的补货提醒带到未来任务。
  - 挂钥匙视频虽然已接入本地媒体队列，但上传成功后仍需要人工回到完成页再点一次提交，弱网恢复后不能自动补业务保存。
- New behavior:
  - 补品页和检查页在点击提交时会先做结构化校验；如果缺项，页面内显示提示卡、自动滚动到对应区块，并对缺失的条目/照片组高亮。
  - 检查页补货项扩成三态：`已补充`、`下次退房补`、`现场够用`。只有 `已补充` 仍要求补货照片；“下次退房补”直接记录为下一次任务提醒。
  - 检查端保存补货证明时把 `carry_forward` 元数据与标签一并落到现有 `restock_proof` 媒体记录里；`/mzapp/work-tasks` 会按房源把最新的 `carry_forward` 项合并进后续 checkout / turnover 清洁任务，但如果当前任务已经提交过该耗材检查，就不重复提醒。
  - 任务详情页和补品填报页会把这些重点补货项明确展示出来，说明“上次检查要求下次退房补”。
  - 挂钥匙视频队列在视频上传成功后会自动调用 `/mzapp/cleaning-tasks/:id/lockbox-video` 完成业务保存；如果业务保存失败，下次联网重跑队列时只重试保存步骤，不重复上传视频。
- Key decisions:
  - 复用现有 `restock_proof` / `cleaning_task_media` 和移动端 inspection media queue，不新增第二套离线系统或单独的 follow-up 表。
  - 保留 `现场够用`，避免把清洁员误报的低库存强行转成“下次退房补”。
  - “下次退房补”提醒只投影到下一类 checkout / turnover 清洁任务，不把提醒泛化到所有检查或入住任务。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tasks/SuppliesFormScreen.tsx` — modified: 补品页改为页内校验提示、滚动定位、高亮缺项，并显示本次重点补充提醒。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — modified: 检查页改为页内校验提示，新增“下次退房补 / 现场够用”状态和对应文案。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.tsx` — modified: 挂钥匙视频文案改成“本地保存后自动上传并保存”，并在手动提交成功时标记队列业务已保存。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` — modified: 任务详情新增待补消耗品区块，明确显示“上次检查要求下次退房补”。
- `mz-cleaning-app-frontend/src/lib/inspectionPanelSubmitQueue.ts` — modified: restock 状态加入 `carry_forward`，校验输出结构化 issue，提交 payload 带 `label` 和新状态。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: `saveRestockProof` 类型允许 `carry_forward` 与 `label`。
- `mz-cleaning-app-frontend/src/lib/inspectionMediaQueue.ts` — modified: lockbox 视频上传完成后自动补业务保存；失败后只重试保存，不重传视频。
- `mz-cleaning-app-frontend/src/lib/inspectionPanelSubmitQueue.test.ts` — modified: 覆盖“下次退房补”无需补货照片且会保留标签。
- `mz-cleaning-app-frontend/src/lib/inspectionMediaQueue.test.ts` — added: 覆盖 lockbox 业务保存失败后二次重试不重复上传。
- `backend/src/modules/mzapp.ts` — modified: restock-proof 接口接受 `carry_forward` 与 `label`，并把历史 carry-forward 项投影到后续退房任务的 `restock_items`。
- `docs/change-release-ledger.md` — modified: 记录本功能单元。

### Impact / Dependencies

- API:
  - `POST /mzapp/cleaning-tasks/:id/restock-proof` 现在接受 `status='carry_forward'` 和可选 `label`。
  - `GET /mzapp/work-tasks` 的 `restock_items` 现在可能包含来自历史检查任务的 `carry_forward` 项。
  - `POST /mzapp/cleaning-tasks/:id/lockbox-video` 调用时机从“必须人工点完成”扩展为“队列自动补保存 + 人工兜底”。
- Database / migration: none; 继续复用 `cleaning_task_media` 和 `cleaning_consumable_usages`。
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Follow-up to `CRL-20260623-016` through `CRL-20260623-023` 的 InspectionPanel 本地草稿、提交队列、缩略图缓存和必拍校验。
  - Shares `InspectionPanelScreen.tsx`, `InspectionCompleteScreen.tsx`, `inspectionPanelSubmitQueue.ts`, `api.ts`, and `TaskDetailScreen.tsx` with multiple in-flight mobile units; selective release requires hunk-level staging.
  - Shares root `backend/src/modules/mzapp.ts` with other 2026-06-23 backend/mobile integration units; selective release requires verified hunk staging in the root repo.

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm test -- --runInBand inspectionPanelSubmitQueue.test.ts inspectionMediaQueue.test.ts TaskDetailScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 3 suites, 13 tests.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 125 existing warnings.
- `npm run build` in `backend` — passed.
- `npm run test:cleaning-inspection-merge` in `backend` — passed: `test_cleaning_inspection_merge: ok`.
- `build` in `mz-cleaning-app-frontend` — not run: this repo has no `build` script.

### Risks / Release Notes

- Runtime risk: 还没有在真实设备上走一次“断网拍挂钥匙视频 -> 恢复网络自动保存 -> 任务列表刷新”的端到端回归，当前验证基于队列单测、类型检查和后端编译。
- Projection boundary: “下次退房补”目前按同房源后续 checkout / turnover 清洁任务投影；如果业务后续希望在 web task center 或更多任务类型同步展示，还需要额外补同源展示逻辑。
- Shared-file risk: 本单元涉及的移动端文件和 `backend/src/modules/mzapp.ts` 都与其他未提交单元共用，后续若选择性发布，必须按 hunk 暂存，不能整文件 stage。
- Rollback: remove carry-forward restock state plus future-task projection, restore alert-only validation, and revert lockbox queue auto-save to the previous “upload first, manual submit later” flow.
- Sensitive-information review: tests use synthetic URLs/tokens only; no real secrets, `.env` values, credentials, database URLs, sensitive logs, or local caches were added.
- Git state: uncommitted; changes span root repo plus nested `mz-cleaning-app-frontend`, and both worktrees still contain unrelated in-flight edits from other units.

## CRL-20260624-004 — 移动端取消拍照后恢复钥匙上传按钮

- **Status:** pushed
- **Updated:** 2026-06-24 11:20 AEST
- **Request:** 移动端清洁点上传钥匙，取消拍照以后，按钮不会恢复成上传拍照，还是加载中的状态，无法继续拍照。需要修复。
- **Outcome:** 清洁任务详情页点击“上传钥匙”后，如果用户取消拍照、没有拍到图片，或中途提前返回，按钮会立即退出 `加载中...` 并恢复成可再次点击的上传状态。

### Implementation

- Previous behavior: `onUploadKey` 在进入相机前就把 `keyUploading` 设为 `true`，但权限拒绝、相机打开失败、用户取消拍照这些提前 `return` 的分支没有统一复位，导致按钮卡在 `加载中...`。
- New behavior: 把整个钥匙拍照流程包在统一的外层 `try/finally` 里，确保所有提前退出路径都会执行 `setKeyUploading(false)`；补充回归测试覆盖取消拍照场景。
- Key decisions: 不改上传文案、不改排队/同步逻辑，只修复 loading 状态的生命周期，避免引入第二个状态来源。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` — modified: 统一在钥匙上传流程结束时复位 `keyUploading`，覆盖权限、异常和取消拍照分支。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` — modified: 新增“取消拍照后按钮恢复”的回归测试。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `TaskDetailScreen.tsx` with `CRL-20260624-001` and earlier in-flight mobile task-detail work; selective release requires hunk-level staging.

### Validation

- `npm test -- --runInBand src/screens/tasks/TaskDetailScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 1 suite, 7 tests.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 125 existing warnings.
- `git -C mz-cleaning-app-frontend diff --check` — passed.
- `npm run build` in `mz-cleaning-app-frontend` — not run: this repo has no `build` script.

### Risks / Release Notes

- Runtime risk: 这次修复覆盖了取消拍照分支的自动化测试，但还没有在真机上手点一次“打开相机 -> 取消”做 UI 回归。
- Shared-file risk: `TaskDetailScreen.tsx` 和 `TaskDetailScreen.test.tsx` 在当前 nested repo 里本来就有其他未提交改动；如果后续选择性发布，必须按 hunk 暂存，不能整文件 stage。
- Rollback: revert the outer `try/finally` state-reset change and the cancel-capture test.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: uncommitted in nested repo `mz-cleaning-app-frontend`; root repo ledger updated but not committed.

## CRL-20260624-005 — 弱网时隐藏钥匙同步网络失败文案

- **Status:** pushed
- **Updated:** 2026-06-24 11:25 AEST
- **Request:** 弱网状态下，网络请求失败就不用显示了吧。
- **Outcome:** 任务详情页在钥匙照片弱网待同步时，仍保留“钥匙照片待同步”状态，但不再把 `Network request failed`、`timeout`、`aborted` 这类通用网络错误直接展示给用户；只有需要用户处理的非网络错误才继续显示。

### Implementation

- Previous behavior: 钥匙上传队列的 `last_error` 会原样显示在任务详情页；弱网重试场景下，用户会看到英文 `Network request failed`，但页面本身已经有“待同步”状态，属于重复且低价值噪音。
- New behavior: 新增 `getKeyUploadVisibleError`，统一把弱网类错误过滤为 `null`；任务详情页继续展示“钥匙照片待同步”和本地预览，但不再显示通用网络失败文案。
- Key decisions: 不改队列重试和状态流转，不吞掉“本地文件丢失/请重新拍摄”这类可操作错误，只对弱网重试类消息做 UI 层过滤。

### Files / Areas

- `mz-cleaning-app-frontend/src/lib/keyUploadQueue.ts` — modified: 新增钥匙上传错误可见性 helper，集中处理弱网错误过滤规则。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` — modified: 任务详情页改为使用 helper 渲染错误文案。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` — modified: 新增“弱网错误隐藏但待同步状态保留”的回归测试。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `TaskDetailScreen.tsx`, `TaskDetailScreen.test.tsx`, and `keyUploadQueue.ts` with in-flight mobile task-detail / key-upload work; selective release requires hunk-level staging.

### Validation

- `npm test -- --runInBand src/screens/tasks/TaskDetailScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 1 suite, 8 tests.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 125 existing warnings.
- `git -C mz-cleaning-app-frontend diff --check` — passed.
- `npm run build` in `mz-cleaning-app-frontend` — not run: this repo has no `build` script.

### Risks / Release Notes

- Runtime risk: 这次只隐藏了弱网类提示文案，仍需真机确认“待同步”状态本身已经足够让一线人员理解，无需额外说明。
- Scope boundary: 当前过滤规则只应用在钥匙照片同步详情，不会自动扩散到检查视频、InspectionPanel 或其他离线队列页面。
- Rollback: remove `getKeyUploadVisibleError` and restore direct rendering of `keyQueueItem.last_error`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: uncommitted in nested repo `mz-cleaning-app-frontend`; root repo ledger updated but not committed.

## CRL-20260624-006 — 补品页真正折叠卡片并保留弱网照片进度

- **Status:** pushed
- **Updated:** 2026-06-24 11:47 AEST
- **Request:** “这个展开收起的功能没用啊。清洁人员网络不好的时候上传的照片，网络恢复了报错，需要重新拍。要修复一下。”
- **Outcome:** 补品页右上角现在变成真正可用的卡片折叠开关；补品照片在弱网下部分上传成功后，不会再因为草稿仍指向已删除的本地文件而要求整组重拍。

### Implementation

- Previous behavior:
  - `SuppliesFormScreen` 右上角的“展开/收起”其实挂在房号文字的 `AppText expandable` 上，只会尝试展开两行标题文本；房号本来就很短，所以用户几乎看不到任何变化。
  - 补品照片上传时，某些本地照片一旦先上传成功就会立刻删除本地草稿文件；如果后续又因为弱网失败，离线草稿和队列还可能保留旧的本地 URI，恢复网络后重试就会命中“本地文件已丢失，请重新拍摄”。
- New behavior:
  - `SuppliesFormScreen` 右上角 badge 改成真正的折叠按钮，能收起/展开地址、统计和重点补充区块。
  - `SuppliesFormScreen`、`CleaningSelfCompleteScreen` 在补品提交前改为顺序上传，并把“已成功上传”的远端 URL 保存在工作快照里；如果稍后因弱网失败，转离线队列时会带着这份部分成功进度，不再回退成已经删掉的本地文件路径。
  - `cleaningConsumablesSubmitQueue` 在后台自动重试时，也会在每一步上传成功后立即把草稿更新成最新远端 URL，避免“前半段成功、后半段失败”后再次恢复成坏草稿。
- Key decisions:
  - 不重做补品离线架构，继续复用现有 `cleaningConsumablesDraft` 和 `cleaningConsumablesSubmitQueue`。
  - 不在弱网失败后强迫用户重拍；优先保留已经成功上传的远端结果，只让真正还没成功的本地照片继续重试。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tasks/SuppliesFormScreen.tsx` — modified: 把 badge 改成真正的展开/收起按钮，并在直接提交失败转离线时保留已上传照片进度。
- `mz-cleaning-app-frontend/src/screens/tasks/CleaningSelfCompleteScreen.tsx` — modified: 自完成页的补品提交流程同样保留部分成功的上传进度。
- `mz-cleaning-app-frontend/src/lib/cleaningConsumablesSubmitQueue.ts` — modified: 后台重提队列在每次成功上传后立刻持久化最新草稿，避免后续失败时留下失效本地 URI。
- `mz-cleaning-app-frontend/src/lib/cleaningConsumablesSubmitQueue.test.ts` — modified: 新增“部分上传成功后弱网失败，草稿仍保留远端 URL”的回归测试。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Follow-up to earlier 2026-06-23/24 mobile consumables offline work that introduced `cleaningConsumablesDraft` and `cleaningConsumablesSubmitQueue`.
  - Shares `SuppliesFormScreen.tsx`, `CleaningSelfCompleteScreen.tsx`, and `cleaningConsumablesSubmitQueue.ts` with other in-flight mobile changes; selective release still requires hunk-level staging.

### Validation

- `npm test -- --runInBand src/lib/cleaningConsumablesSubmitQueue.test.ts` in `mz-cleaning-app-frontend` — passed: 1 suite, 3 tests.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 125 existing warnings.
- `git -C mz-cleaning-app-frontend diff --check` — passed.
- `npm run build` in `mz-cleaning-app-frontend` — not run: this repo has no `build` script.
- Expand/collapse manual UI verification — not run: no focused screen test currently covers the new fold state, and this turn did not launch a simulator/browser UI session.

### Risks / Release Notes

- Runtime risk: 这次主要用单测验证了弱网恢复时的草稿持久化路径，但还没有在真机上完整走一遍“拍 2-3 张补品图 -> 中途断网 -> 恢复网络自动同步”的端到端回归。
- Scope boundary: 这次修复的是补品填报与自完成里的补品提交流程，不包含房间完成照片、挂钥匙视频或别的媒体队列。
- Rollback: revert the hero-card fold state and the progressive draft-persistence changes in `SuppliesFormScreen`, `CleaningSelfCompleteScreen`, and `cleaningConsumablesSubmitQueue`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: uncommitted in nested repo `mz-cleaning-app-frontend`; root repo ledger updated but not committed.

## CRL-20260624-007 — 补品页厨房检查支持连拍且保存按钮取消底部冻结

- **Status:** pushed
- **Updated:** 2026-06-24 12:18 AEST
- **Request:** 清洁的补品填报，厨房检查拍照需要连拍，保存修改的按钮不要冻结到页面底部。
- **Outcome:** 补品页“厨房检查”顶部拍照按钮现在会连续完成剩余厨房点位拍摄；“保存修改”按钮改为随页面内容一起滚动，不再固定贴在页面底部遮挡浏览节奏。

### Implementation

- Previous behavior:
  - `SuppliesFormScreen` 的“厨房检查”顶部按钮每次只拍 1 张，清洁员需要反复点多次才能补齐多个厨房点位。
  - “保存修改”依赖底部固定栏，浏览照片和表单内容时按钮会一直悬浮在页面底部。
- New behavior:
  - `onTakeRequiredScenePhotoSequence('kitchen')` 会按顺序遍历当前尚未完成的厨房必拍点位；每次拍完自动进入下一个点位，直到用户取消或全部完成。
  - “保存修改/提交”按钮改为放回 `ScrollView` 内容流末尾，页面底部只保留正常滚动留白，不再使用固定底栏冻结按钮。
- Key decisions:
  - 保留浴室逻辑为单点拍摄，不把连拍行为扩散到本来只有 1 组点位的区域。
  - 不额外引入新的浮层或吸底状态，直接复用现有页面流布局，减少键盘和弱网状态下的交互副作用。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tasks/SuppliesFormScreen.tsx` — modified: 厨房检查改为顺序连拍剩余点位；提交按钮改回页面内联布局并调整滚动底部留白。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Follow-up to `CRL-20260624-006`, sharing `SuppliesFormScreen.tsx`.
  - Shares the same mobile screen with other in-flight nested-repo changes; selective release still requires hunk-level staging.

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 125 existing warnings.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 26 suites, 81 tests. Jest still reports an existing open-handles notice after completion, and `TasksScreen.test.tsx` still prints an existing `SafeAreaView` deprecation warning.
- `git diff --check` in `mz-cleaning-app-frontend` — passed.
- `npm run build` in `mz-cleaning-app-frontend` — not run: this package has no `build` script.

### Risks / Release Notes

- Runtime risk: 这次没有新增针对 `SuppliesFormScreen` 的专门 UI 测试，厨房连拍和按钮位置仍需要真机回归确认滚动、拍照取消和键盘交互手感。
- Scope boundary: 这次只调整补品页厨房必拍组和提交按钮布局，不改变浴室、客厅、遥控器或后台离线队列协议。
- Rollback: revert the kitchen batch-capture loop and restore the previous fixed-bottom submit bar layout in `SuppliesFormScreen`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: uncommitted in nested repo `mz-cleaning-app-frontend`; root repo ledger updated but not committed.

## CRL-20260624-008 — 移动端通知/反馈/线下任务完成与检查补充排版修复

- **Status:** pushed
- **Updated:** 2026-06-24 12:49 AEST
- **Request:** 修复 6 个移动端问题：通知横幅缺少房号与内容、维修/深清反馈不能一次性提交已完成、线下任务完成不应强制照片、已完成照片要回写到维修/深清/日用品记录、admin/线下经理多角色下“全部/我的”无法切换、检查与补充页按钮排版混乱。
- **Outcome:** 通知卡片重新显示房号与可操作摘要；维修/深清可一次性提交反馈和完工照片；纯线下任务可无图完成；物业维修/深清/日用品任务完成照片会写回源记录；manager 模式下“全部/我的”可正常切换；检查与补充页的补货按钮布局更稳定。

### Implementation

- Previous behavior:
  - 多类通知仍能送达，但 `consumables` / `inspection_complete` / `restock` 相关卡片只显示通用文案，横幅里看不到明确房号或补货内容。
  - `FeedbackFormScreen` 在“已完成”模式下，新建记录后会直接调用 `completePropertyFeedbackProject(..., legacy-*)`；该路径对新记录不稳定，导致维修/深清直接提交完工信息失败。
  - `TaskDetailScreen` 对所有非清洁任务都强制先上传照片，线下任务无法直接标记完成。
  - `POST /mzapp/work-tasks/:id/mark` 完成房源跟进任务时只改 `work_tasks.status`，不会把照片/备注回写到 `property_maintenance`、`property_deep_cleaning`、`property_daily_necessities`。
  - `TasksScreen` 在 manager-only 多角色场景下被 effect 强制把 `view` 打回 `all`，导致“全部/我的”看起来不可切换。
  - `InspectionPanelScreen` 的补货状态按钮与拍照按钮在窄屏上换行混乱，上传按钮容易挤到卡片右侧。
- New behavior:
  - 通知展示层为 `consumables_submitted`、`consumables_updated`、`inspection_complete`、`restock_done`、`restock_proof_saved`、`restock_sufficient_confirmed` 补上房号标题和具体摘要。
  - 维修/深清“一起提交完工信息”会先创建真实项目，再用返回的项目 ID 完成该项目，避免对不存在项目执行完工。
  - 纯 `offline` 任务完成/未完成可不带照片；照片仍可选传留档。
  - 房源跟进任务完成时，后端会把完成照片与备注合并回源记录的 `repair_photo_urls` / `photo_urls` 与对应备注字段。
  - manager-only 用户仍固定在 manager 模式，但 `view=all|mine` 不再被重置，可正常切换。
  - 检查与补充页的三种状态按钮改为更稳定的两列/整行布局，拍照按钮换到整行区域，减少挤压。
- Key decisions:
  - 不新增新的反馈系统或第二套记录表，继续复用现有 `property_feedback` 项目接口与 `work_tasks` 完成入口。
  - 线下任务只放开“照片可选”，不把维修/深清等房源跟进任务一并放开，以免影响原有完成留痕要求。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: 房源跟进任务完成时把完成照片/备注回写到源记录，并保留原 `work_tasks` 完成流程。
- `mz-cleaning-app-frontend/src/lib/noticePresentation.ts` — modified: 为消耗品/检查/补货类通知补房号与摘要映射。
- `mz-cleaning-app-frontend/src/lib/noticePresentation.test.ts` — modified: 补通知标题/摘要回归测试。
- `mz-cleaning-app-frontend/src/screens/tasks/FeedbackFormScreen.tsx` — modified: 维修/深清“一次性提交已完成”改为先建项目再完工。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 解除 manager-only 场景下对 `view` 的强制回滚。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx` — modified: 补 manager-only “全部/我的”切换回归测试。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` — modified: 线下任务照片改为可选，并保留上传入口。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` — modified: 补线下任务无图完成回归测试。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — modified: 调整补货状态按钮与拍照按钮布局。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API:
  - `POST /mzapp/work-tasks/:id/mark` 的返回结构不变，但完成房源跟进任务时会同步更新源记录照片与备注。
  - `POST /mzapp/property-feedbacks/:kind/:id/projects` 与 `.../complete` 继续复用，前端改为显式串联两步。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Shares `backend/src/modules/mzapp.ts` with multiple in-flight root changes, so selective release still requires hunk-level staging.
  - Shares `TasksScreen.tsx`, `TaskDetailScreen.tsx`, `FeedbackFormScreen.tsx`, and `InspectionPanelScreen.tsx` with other nested-repo mobile work.

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 126 existing warnings.
- `npm test -- --runInBand src/lib/noticePresentation.test.ts src/screens/tabs/TasksScreen.test.tsx src/screens/tasks/TaskDetailScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 3 suites, 18 tests. Jest still prints an existing open-handles notice after completion, and `TasksScreen.test.tsx` still logs an existing `SafeAreaView` deprecation warning.
- `npm run build` in `backend` — passed; TypeScript compilation completed.
- `git diff --check` in root repo — passed.
- `git diff --check` in `mz-cleaning-app-frontend` — passed.
- `npm run build` in `mz-cleaning-app-frontend` — not run: this repo has no `build` script.

### Risks / Release Notes

- Runtime risk: 维修/深清“一次性提交完成”这次主要靠前端串联逻辑和类型检查验证，仍需要真机再走一遍“新建记录 -> 直接完成 -> 历史记录查看”的端到端回归。
- Runtime risk: 线下任务完成照片改为可选仅针对 `offline` 任务；如果还有别的非清洁任务类型也应放开，需要再补充业务确认。
- Scope boundary: 这次没有修改消息中心列表样式、后端通知规则配置页或维修/深清网页端管理页面，只修移动端展示与提交链路。
- Rollback: revert the notice presentation mapping, manager-view state guard, optional offline-photo guard, feedback project chaining, and source-record write-back changes in `backend/src/modules/mzapp.ts`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: uncommitted in both root repo and nested repo `mz-cleaning-app-frontend`.

## CRL-20260624-009 — Admin/线下经理日终交接角色分流与人员进度统计

- **Status:** pushed
- **Updated:** 2026-06-24 13:55 AEST
- **Request:** 日终交接总览不要给客服显示；admin 和线下经理看到的日终交接内容要按“检查人员/清洁人员”职责区分；admin 移动端还要能看见每位清洁/检查人员今天做了多少房、正在做哪几间。
- **Outcome:** `customer_service` 不再看到“今日日终交接总览”；`admin/offline_manager` 的日终交接入口和详情会按目标员工当天实际任务角色显示正确内容；manager 页面新增“今日工作情况”，可直接看到每位清洁/检查人员的完成数、进行中房号与交接提交状态。

### Implementation

- Previous behavior:
  - `TasksScreen` 只要进入 manager 模式就显示“今日日终交接总览”，因此 `customer_service` 也会看到该入口。
  - `DayEndBackupKeysScreen` 在 manager 查看别人交接时，仍然按“当前登录人的 auth 角色”判断展示检查版还是清洁版，导致 admin/线下经理点开检查员记录时会看到备用钥匙、脏床品等错误区块。
  - admin 移动端没有汇总每位清洁/检查人员当天任务进度，只能逐条翻任务，不知道谁完成了几间、谁还在做哪间。
- New behavior:
  - 只有 `admin` 和 `offline_manager` 会看到“今日日终交接总览”和“今日工作情况”；`customer_service` 继续保留 manager 任务页，但不显示该总览入口。
  - `TasksScreen` 会用 `listWorkTasks(..., view: 'all')` 汇总今天所有清洁/检查任务，按人员生成 `targetRoles`、房号集合、完成数、进行中房号和日终交接提交状态。
  - `DayEndBackupKeysScreen` 接收并解析 `targetRoles`；即使 manager 在查看别人记录，也会按目标员工当天实际职责展示：
    - 检查人员：剩余消耗品 + Reject 床品登记
    - 清洁人员：备用钥匙 + 脏床品 + 仓库钥匙记录 + Reject 床品登记
  - 日终交接总览页里也补上每位人员的“清洁 x/y”或“检查 x/y”进度摘要，点进后仍能继续查看对应交接内容。
- Key decisions:
  - 不新增第二套统计接口，manager 端今日人员统计继续复用已有移动端任务接口；follow-up 改为使用未合并的 `cleaning-app/tasks`，避免 `work_tasks` manager 视图折叠后丢失清洁状态。
  - 角色展示优先看“目标员工今天实际有哪类任务”，而不是看当前查看人的登录角色，避免 manager 代看时语义错位。

### 2026-06-24 Follow-up Update

- Follow-up request:
  - 今日工作情况里清洁人员状态没显示。
  - 日终交接想并入“今日工作情况”模块。
  - “今日工作情况”要支持折叠收起。
  - 集成后出现重复摘要，需要删掉“日终交接总览”那条重复行。
  - 所有角色进入带“全部/我的”切换的任务页时，默认应落在“全部”而不是“我的”。
- Follow-up behavior change:
  - “今日工作情况”不再依赖 manager `work_tasks` 合并结果，而是改用 `cleaning-app/tasks` 原始清洁任务数据汇总人员状态，避免清洁状态被合并后丢失。
  - 独立的“今日日终交接总览”卡片被并入“今日工作情况”顶部，作为同一模块内的交接摘要入口。
  - “今日工作情况”模块新增折叠开关，默认展开，可一键收起整块人员进度与交接摘要。
  - 随后又移除了集成后重复出现的“日终交接总览”摘要行，仅保留人员卡片里的交接状态，不再重复显示一条总览横条。
  - 任务页的 `view` 初始值改为 `all`，因此所有带切换能力的角色首次进入都会默认落在“全部”；手动切回“我的”后仍可正常使用。

### 2026-06-24 Follow-up 2 — 合并任务记录统计修复

- Follow-up request:
  - admin 移动端“今日工作情况”汇总数据不准确。
  - 清洁人员的工作情况没有显示出来。
  - 仅检查人员 zhi-f 被错误显示成“清洁 + 检查”。
- Follow-up behavior change:
  - “今日工作情况”现在会识别 `/mzapp/work-tasks?view=all` 合并记录里的 `cleaning_task_ids` / `inspection_task_ids` 和 `cleaning_status` / `inspection_status`。
  - 同一条合并房间记录里同时有清洁与检查时，会分别按清洁人员和检查人员统计；清洁进行中不会再被当成检查进行中，清洁人员也不会因为顶层 `task_kind=inspection` 被漏掉。
  - 合并记录如果没有明确 `cleaner_id`，不会再把顶层 `assignee_id` 兜底成清洁人员；同理，没有明确 `inspector_id` 时也不会把清洁员兜底成检查人员。
  - 移动端 `WorkTask` 类型补齐后端实际返回的 `cleaner_id` 字段，避免后续统计继续依赖未声明字段。

### Files / Areas

- `mz-cleaning-app-frontend/src/navigation/RootNavigator.tsx` — modified: 扩展日终交接导航参数，新增 `targetRoles` 与 overview 统计类型。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: `WorkTask` 类型补齐 `cleaner_id` 字段。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 限制总览入口到 `admin/offline_manager`，基于今日 `work_tasks` 生成人员交接/进度摘要，并把目标角色传给详情页。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx` — modified: 补 `customer_service` 不显示总览、admin 可见人员进度摘要的回归测试。
- `backend/src/lib/cleaningInspection.ts` — modified: 延期检查投影不再因完成状态被提前剔除，完成后仍保留在到期日对应的检查任务视图。
- `backend/scripts/tests/test_cleaning_inspection_merge.ts` — modified: 回归测试改为验证“延期检查完成后仍投影到到期日”。
- `mz-cleaning-app-frontend/src/screens/tasks/DayEndBackupKeysScreen.tsx` — modified: 按目标员工角色而非当前 viewer 角色渲染日终交接区块，并在总览列表中展示进度摘要。
- `mz-cleaning-app-frontend/src/screens/tasks/DayEndBackupKeysScreen.test.tsx` — added: 覆盖 manager 查看检查员/清洁员时的区块分流回归。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API:
  - manager 端“今日工作情况”继续复用 `GET /mzapp/work-tasks?view=all`，但 follow-up 改成只按角色化 `cleaning/inspection` 任务行计算，不再从 `GET /cleaning-app/tasks` 的混合状态推断双角色进度。
  - `DayEndBackupKeys` 导航参数新增 `targetRoles` 与 richer `overviewUsers` 结构，仍只在前端内部使用。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units:
  - Shares `TasksScreen.tsx` with `CRL-20260624-008` and earlier manager/mobile fixes.
  - Shares `DayEndBackupKeysScreen.tsx` with existing mobile day-end handover flow, so release still needs nested-repo selective staging.

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `./node_modules/.bin/eslint src/screens/tabs/TasksScreen.tsx src/screens/tasks/DayEndBackupKeysScreen.tsx src/screens/tabs/TasksScreen.test.tsx src/screens/tasks/DayEndBackupKeysScreen.test.tsx src/navigation/RootNavigator.tsx` in `mz-cleaning-app-frontend` — passed with 0 errors and existing warnings in touched files.
- `npm test -- --runInBand src/screens/tabs/TasksScreen.test.tsx src/screens/tasks/DayEndBackupKeysScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 2 suites, 6 tests. Jest still reports the existing open-handles notice after completion, and `TasksScreen.test.tsx` still logs the existing `SafeAreaView` deprecation warning.
- `./node_modules/.bin/eslint src/screens/tabs/TasksScreen.tsx src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed with 0 errors and existing warnings in touched files after the follow-up integration/collapse changes.
- `npm test -- --runInBand src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 1 suite, 4 tests after the follow-up integration/collapse changes. Jest still reports the existing open-handles notice after completion, and `TasksScreen.test.tsx` still logs the existing `SafeAreaView` deprecation warning.
- `npm run test:cleaning-inspection-merge` in `backend` — passed: `test_cleaning_inspection_merge: ok`.
- `npm run build` in `backend` — passed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `./node_modules/.bin/eslint src/screens/tabs/TasksScreen.tsx src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed with 0 errors and existing warnings in touched files.
- `npm test -- --runInBand src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 1 suite, 4 tests after the deferred-inspection/statistics follow-up. Jest still reports the existing open-handles notice after completion, and `TasksScreen.test.tsx` still logs the existing `SafeAreaView` deprecation warning.
- `git diff --check -- backend/src/lib/cleaningInspection.ts backend/scripts/tests/test_cleaning_inspection_merge.ts mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx docs/change-release-ledger.md` — passed.
- `python3 scripts/audit_change_release_ledger.py` — passed.
- `git diff --check -- mz-cleaning-app-frontend/src/navigation/RootNavigator.tsx mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx mz-cleaning-app-frontend/src/screens/tasks/DayEndBackupKeysScreen.tsx mz-cleaning-app-frontend/src/screens/tasks/DayEndBackupKeysScreen.test.tsx` — passed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed after the merged-record staff-summary fix.
- `./node_modules/.bin/eslint src/screens/tabs/TasksScreen.tsx src/screens/tabs/TasksScreen.test.tsx src/lib/api.ts` in `mz-cleaning-app-frontend` — passed with 0 errors and existing warnings in touched files.
- `npm test -- --runInBand src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 1 suite, 4 tests after adding the merged-record regression. Jest still reports the existing open-handles notice after completion, and `TasksScreen.test.tsx` still logs the existing `SafeAreaView` deprecation warning.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed after the zhi-f role fallback correction.
- `./node_modules/.bin/eslint src/screens/tabs/TasksScreen.tsx src/screens/tabs/TasksScreen.test.tsx src/lib/api.ts` in `mz-cleaning-app-frontend` — passed with 0 errors and existing warnings in touched files after the zhi-f role fallback correction.
- `npm test -- --runInBand src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 1 suite, 4 tests after adding the inspector-only merged-record regression. Jest still reports the existing open-handles notice after completion, and `TasksScreen.test.tsx` still logs the existing `SafeAreaView` deprecation warning.
- `npm run build` in `mz-cleaning-app-frontend` — not run: this repo has no `build` script.

### Risks / Release Notes

- Runtime risk: 延期检查完成后会继续按到期日保留在当天任务/看板中；仍建议用真机检查员账号确认“完成后保留到当天、跨天后消失”符合预期。
- Runtime risk: 人员进度摘要目前按今日 `work_tasks` 角色化状态即时汇总，仍建议在真机 manager 账号下回归确认“进行中/已完成”与实际任务流一致，尤其是双角色或跨房源同日任务。
- Runtime risk: 本轮验证覆盖了合并记录单元测试和类型检查，但还未用真实 admin 账号在移动端对今天的生产样例做手工截图回归。
- Scope boundary: 这次只修 manager 端日终交接入口、职责分流和进度摘要，没有改客服任务筛选、消息中心角色入口，或后端 day-end 数据结构。
- Rollback: revert the `targetRoles` navigation wiring, manager day-end overview gating, and the role-based rendering changes in `DayEndBackupKeysScreen`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: root repo ledger updated; functional changes remain uncommitted in nested repo `mz-cleaning-app-frontend`.

## CRL-20260624-010 — 移动端包版本同步到 1.0.22

- **Status:** pushed
- **Updated:** 2026-06-24 16:20 AEST
- **Request:** Android版本也改一下，改成 `1.0.22`；随后用 EAS 云构建重新封装 iOS 和 Android 包。
- **Outcome:** 移动端 npm 包版本从 `1.0.21` 同步到 `1.0.22`，与 `app.json` 中 Expo 版本 `1.0.22`、iOS build `22`、Android versionCode `22` 保持一致，避免 Android 构建元数据仍显示旧版本。

### Implementation

- Previous behavior: `app.json` 已是 `1.0.22`，但 `package.json` 和 `package-lock.json` 顶层版本仍是 `1.0.21`。
- New behavior: 移动端包元数据统一为 `1.0.22`；Android 打包继续使用 `app.json` 的 `versionCode: 22`。
- Key decisions: 只同步版本字段，不改业务代码、不新增配置。

### Files / Areas

- `mz-cleaning-app-frontend/package.json` — modified: 包版本同步到 `1.0.22`。
- `mz-cleaning-app-frontend/package-lock.json` — modified: lockfile 顶层包版本同步到 `1.0.22`。
- `docs/change-release-ledger.md` — modified: 记录本版本同步单元。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: mobile package metadata only; `app.json` build fields were already `1.0.22 / 22` and were not changed.
- Dependencies: none.
- Related units: follows the pushed mobile release batch and prepares EAS preview build.

### Validation

- `node -e "..."` in `mz-cleaning-app-frontend` — passed: `packageVersion`, `lockVersion`, `lockRootVersion`, and `expoVersion` are all `1.0.22`; iOS build is `22`; Android versionCode is `22`.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `python3 scripts/audit_change_release_ledger.py` — passed.

### Risks / Release Notes

- Runtime risk: none expected; metadata-only change.
- Rollback: revert the package version fields to `1.0.21` if a downstream build process unexpectedly depends on the old npm package version.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: pushed to root `Dev` and nested mobile `Dev`.

## CRL-20260625-001 — 移动端 MSQ 钥匙卡片、分配状态与今日工作统计修复

- **Status:** pushed
- **Updated:** 2026-06-25 15:27 AEST
- **Request:** 修复 admin 看不到 MSQ 钥匙卡片；已分配检查/挂钥匙人员的任务仍显示“未分配”；“今日工作情况”改成清洁人员在前、检查人员在后，并优化状态统计准确性。
- **Outcome:** admin/offline manager 在管理-全部今日任务里可看到 Southbank/MSQ 仓库钥匙卡片；检查或清洁任务只要已有对应执行人就显示“已分配”；今日工作情况按清洁优先、检查其次排序，并把 `to_hang_keys` 视为待处理而不是已完成。

### Implementation

- Previous behavior:
  - MSQ 仓库钥匙卡片只在当前登录用户本人被分配到 Southbank 清洁/检查任务时显示，因此 admin 在管理全部任务时可能看不到。
  - `getTaskStatusMeta` 的检查任务分支直接使用基础 `pending/todo -> 未分配` 映射，没有考虑 `inspector_id` / `inspector_name` / `assignee_id` 已存在的情况。
  - 今日工作情况按人员名/交接状态排序，清洁和检查人员没有固定分组顺序；检查统计把 `to_hang_keys` 算作已提交，容易把“待挂钥匙”误算进已完成。
- New behavior:
  - `TasksScreen` 对 admin/offline manager 的管理-全部今日视图放开 MSQ 卡片可见性，只要当前日期可见任务里有 Southbank 清洁/检查任务即可显示；普通清洁/检查人员仍按本人相关任务显示。
  - `taskVisualTheme` 在检查任务 pending/todo/unassigned 且已有检查执行人时显示“已分配”；清洁任务执行人判断补上 `cleaner_id`。
  - 今日工作情况使用统一排序：清洁相关人员优先，其次检查人员；同一人员/角色/房间只统计一次；`to_hang_keys` 保持待处理，不再作为检查已完成。
- Key decisions:
  - 不扩大仓库钥匙写入权限；后端获取状态接口已允许 `cleaning_app.calendar.view.all`，本次只恢复 admin 可见性。
  - 不新增统计接口或数据库字段，继续复用现有 `work_tasks` 字段与前端展示 helper。

### 2026-06-25 Follow-up — 合并任务清洁人员漏统修复

- Follow-up request:
  - 截图中任务卡片已经安排清洁人员，但“今日工作情况”只显示检查人员。
- Follow-up behavior change:
  - “今日工作情况”统计清洁人员时，如果合并任务记录没有 `cleaner_id`，但存在 `cleaner_name` 且 `assignee_id` 不是当前检查员 ID，则用 `assignee_id` 作为清洁人员身份。
  - 这样 WSP2603C 这类“卡片可显示清洁 cleaner-2，但统计输入缺少 cleaner_id”的记录会进入清洁人员进度。
  - 仍保留防误判规则：没有 `cleaner_name`，或 `assignee_id` 等于 `inspector_id` 时，不把该记录兜底成清洁人员，避免 zhi-f 再被显示为“清洁 + 检查”。

### 2026-06-25 Follow-up 2 — 今日工作情况清洁/检查分组展示

- Follow-up request:
  - “今日工作情况”列出来的顺序很乱；清洁人员要放一起，检查人员要放一起，不要清洁中间插着检查人员。
- Follow-up behavior change:
  - 今日工作情况渲染前先拆成展示分组：清洁人员组整体在前，检查人员组整体在后。
  - 每组内部仍按交接状态和人员名排序。
  - 如果某个人当天同时有清洁和检查职责，会按当前展示角色拆成两个条目，分别出现在清洁组和检查组里；点击条目进入日终交接时也只传当前组对应的目标角色。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: MSQ 卡片可见条件、今日工作情况排序/去重/状态统计修正，补清洁人员身份兜底，并按清洁/检查分组渲染人员列表。
- `mz-cleaning-app-frontend/src/lib/taskVisualTheme.ts` — modified: 已分配检查/清洁执行人的 pending 任务不再显示“未分配”。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx` — modified: 覆盖 admin MSQ 卡片可见、清洁优先排序、`to_hang_keys` 待处理统计、`cleaner_id` 缺失但 `assignee_id + cleaner_name` 存在时清洁人员仍显示，以及清洁组整体排在检查组前。
- `mz-cleaning-app-frontend/src/lib/taskVisualTheme.test.ts` — added: 覆盖执行人已存在时状态文案为“已分配”的 helper 回归。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: none; request/response shape unchanged.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: follows prior mobile task/day-end summary work in `CRL-20260624-009`.

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm test -- --runInBand src/lib/taskVisualTheme.test.ts src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 2 suites, 8 tests. Jest still reports the existing open-handles notice after completion, and `TasksScreen.test.tsx` still logs the existing `SafeAreaView` deprecation warning.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 120 existing warnings.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 28 suites, 91 tests. `TasksScreen.test.tsx` still logs the existing `SafeAreaView` deprecation warning.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed after the follow-up cleaner fallback.
- `npm test -- --runInBand src/screens/tabs/TasksScreen.test.tsx src/lib/taskVisualTheme.test.ts` in `mz-cleaning-app-frontend` — passed after the follow-up cleaner fallback: 2 suites, 8 tests. Jest still reports the existing open-handles notice after completion, and `TasksScreen.test.tsx` still logs the existing `SafeAreaView` deprecation warning.
- `npm run lint` in `mz-cleaning-app-frontend` — passed after the follow-up cleaner fallback with 0 errors and 120 existing warnings.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed after the follow-up cleaner fallback: 28 suites, 91 tests. Jest still reports the existing open-handles notice after completion, and `TasksScreen.test.tsx` still logs the existing `SafeAreaView` deprecation warning.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed after the grouped display follow-up.
- `npm test -- --runInBand src/screens/tabs/TasksScreen.test.tsx src/lib/taskVisualTheme.test.ts` in `mz-cleaning-app-frontend` — passed after the grouped display follow-up: 2 suites, 8 tests. Jest still reports the existing open-handles notice after completion, and `TasksScreen.test.tsx` still logs the existing `SafeAreaView` deprecation warning.
- `npm run lint` in `mz-cleaning-app-frontend` — passed after the grouped display follow-up with 0 errors and 120 existing warnings.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed after the grouped display follow-up: 28 suites, 91 tests. Jest still reports the existing open-handles notice after completion, and `TasksScreen.test.tsx` still logs the existing `SafeAreaView` deprecation warning.
- `npm run build` in `mz-cleaning-app-frontend` — not run: this repo has no `build` script.

### Risks / Release Notes

- Runtime risk: 本轮未用真实 admin 账号在真机上截图回归 MSQ 卡片；验证覆盖到组件测试、类型检查、lint 和全量 Jest。
- Scope boundary: 只恢复 admin/offline manager 的 MSQ 卡片可见性，没有扩大 `POST /cleaning-app/warehouse-key/events` 写入权限。
- Rollback: revert the MSQ visibility condition, staff-summary sort/stat helpers, and `taskVisualTheme` assigned-state branches.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: pushed to nested mobile `Dev` in commit `4ab0aa3`; root ledger status update pushed separately.

## CRL-20260625-002 — 移动端每日清洁检查照片离线缓存后可见性修复

- **Status:** pushed
- **Updated:** 2026-06-25 15:27 AEST
- **Request:** 增加离线本地缓存以后，检查人员拍的照片都不显示；需要确认原因并恢复显示。
- **Outcome:** 每日清洁详情页读取检查照片时同时覆盖检查任务 ID、清洁任务 ID、聚合 `source_ids` 和主 `source_id`；页面内清洁相关图片统一走已有鉴权媒体代理，因此离线同步后保存为私有 R2 URL 或 `cleaning/...` object key 的检查照片可以正常加载。

### Implementation

- Previous behavior:
  - 离线检查提交流程同步成功后会删除原始本地文件，只保留缩略图和远端引用。
  - 每日清洁详情页展示检查照片时直接把返回值当普通 URL 给 React Native `Image`，没有复用 `buildCleaningMediaImageSource` 的清洁媒体代理。
  - 检查照片拉取 ID 没有显式包含 `cleaning_task_ids`，在部分聚合任务或 source 字段不完整时可能查不到实际保存照片的 task id。
- New behavior:
  - 新增 `inspectionPhotoTaskIdsFromTask`，检查照片查询 ID 来源包括 `inspection_task_ids`、`cleaning_task_ids`、`source_ids` 和 `source_id`，并去重保序。
  - `ManagerDailyTaskScreen` 的图片展示改用 `buildCleaningMediaImageSource(token, ...)`，对 `cleaning/...` key 和私有 R2 URL 自动走 `/cleaning-app/media/image` 鉴权代理。
  - 保留挂钥匙视频继续使用普通绝对 URL 处理，避免把视频误走图片代理。
- Key decisions:
  - 不新增接口、不改数据库、不改检查提交队列；本次修复只修每日清洁详情页读取/展示端，复用已有清洁媒体代理。
  - 纯 ID 选择规则拆到 lib 后单测，避免屏幕组件测试被原生 SSE 依赖影响。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tasks/ManagerDailyTaskScreen.tsx` — modified: 检查照片查询 ID 改用统一 helper；清洁相关图片渲染改走 `buildCleaningMediaImageSource`。
- `mz-cleaning-app-frontend/src/lib/managerDailyTaskPhotos.ts` — added: 每日清洁详情页检查照片 task id 选择规则。
- `mz-cleaning-app-frontend/src/screens/tasks/ManagerDailyTaskScreen.test.ts` — added: 覆盖检查照片查询同时包含清洁/检查/source IDs，以及非清洁任务不查询。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: none; existing `getInspectionPhotos` and `/cleaning-app/media/image` are reused.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: shares mobile task detail surface with `CRL-20260625-001`, but behavior is independent and can be selected separately.

### Validation

- Initial `npm test -- --runInBand src/screens/tasks/ManagerDailyTaskScreen.test.ts` in `mz-cleaning-app-frontend` — failed before refactor because importing the full screen pulled untransformed `react-native-sse`; the test was moved to a pure lib helper.
- `npm test -- --runInBand src/screens/tasks/ManagerDailyTaskScreen.test.ts` in `mz-cleaning-app-frontend` — passed after refactor: 1 suite, 2 tests.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 120 existing warnings.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 29 suites, 93 tests. `TasksScreen.test.tsx` still logs the existing `SafeAreaView` deprecation warning, and Jest still reports the existing open-handles notice after completion.
- `npm run build` in `mz-cleaning-app-frontend` — not run: this repo has no `build` script.

### Risks / Release Notes

- Runtime risk: 本轮未用真实生产 task id 在真机上打开每日清洁详情页截图回归；验证覆盖到 helper 单测、类型检查、lint 和全量 Jest。
- Scope boundary: 只修检查照片在每日清洁详情页的读取/渲染；没有改变检查提交、R2 上传、补品照片、清洁完成照片或后端权限。
- Rollback: revert `ManagerDailyTaskScreen` media source changes and remove `managerDailyTaskPhotos` helper/test.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: pushed to nested mobile `Dev` in commit `4ab0aa3`; root ledger status update pushed separately.

## CRL-20260625-003 — 订单入住新密码自动回填退房旧密码

- **Status:** pushed
- **Updated:** 2026-06-25 15:27 AEST
- **Request:** 已经有的订单入住的新密码，要自动写入退房时的旧密码字段。
- **Outcome:** 同一订单的 `checkin_clean.new_code` 现在会自动同步到 `checkout_clean.old_code`；订单同步、重试、回填、网页任务编辑和移动端管理字段保存都会复用同一条规则。

### Implementation

- Previous behavior:
  - 订单同步会分别生成入住任务 `new_code` 和退房任务 `old_code`，但如果已有入住任务的新密码后来被补录或修改，退房任务旧密码不会自动跟随。
  - 移动端每日任务管理字段和网页任务编辑保存 `new_code` 时，只更新当前任务或选中任务。
- New behavior:
  - `syncCheckoutOldCodeFromCheckinNewCode` 以同订单入住任务 `new_code` 为来源，补写同订单退房任务 `old_code`。
  - 订单同步完成后会执行该联动，因此已有订单在重试或回填时也会被补齐。
  - 网页 `/cleaning/tasks` 单个/批量编辑和移动端 `/mzapp/cleaning-tasks/manager-fields` 保存入住新密码时，会立即触发同订单退房旧密码同步。
  - 退房任务 `auto_sync_enabled=false` 时不覆盖，并记录 skipped_locked 同步日志。
- Key decisions:
  - 不新增数据库字段、不新增接口；复用现有 `cleaning_tasks.old_code/new_code`。
  - 不把退房旧密码作为第二个手工来源；入住任务新密码是本次联动的来源，退房旧密码只是同步结果。

### Files / Areas

- `backend/src/services/cleaningSync.ts` — modified: 新增并导出同订单入住新密码到退房旧密码的同步 helper，并接入订单同步流程。
- `backend/src/modules/cleaning.ts` — modified: 网页/后端任务单个与批量编辑入住新密码后触发同订单退房旧密码同步；补齐本地 store 批量编辑对 `old_code/new_code` 的写入。
- `backend/src/modules/mzapp.ts` — modified: 移动端管理字段保存 `new_code` 时，对关联入住订单触发同订单退房旧密码同步。
- `backend/scripts/tests/test_cleaning_sync_v2.ts` — modified: 覆盖已有入住任务 `new_code` 回填退房任务 `old_code`。
- `backend/dist/modules/cleaning.js` — modified: `npm run build` 生成的已跟踪后端构建产物。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: request/response shape unchanged; existing task update endpoints now have an additional same-order side effect.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: none.

### Validation

- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_cleaning_sync_v2.ts` in `backend` — passed: printed `ok`.
- `npm run build` in `backend` — passed: `tsc -p .` completed.
- `git diff --check` — passed.
- Full frontend/mobile test suites — not run: change is backend task/password synchronization only.

### Risks / Release Notes

- Runtime risk: 未用真实订单在生产数据库手工回归；验证覆盖到同步脚本和 TypeScript build。
- Scope boundary: 清空入住新密码时不会自动清空退房旧密码；当前规则只在入住新密码有非空值时回填。
- Rollback: revert the helper and its calls from `cleaningSync`, `cleaning`, and `mzapp`, then rebuild backend dist if required.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: pushed to root `Dev` in commit `18b5410`; root ledger status update pushed separately.
