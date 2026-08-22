# Feature Regression Registry

本文件只保存当前有效的业务不变量、责任范围、测试映射和最近一次完整验证索引。

- `最后验证` 只保存最近一次完整确认该 FR 仍然有效的 CRL、Commit 和日期。
- `相关 CRL` 保存对该 FR 产生实质影响的重要历史变更，可保留多条；完整历史以 `docs/change-release-ledger.md` 为准。
- 测试映射必须说明保护点和测试场景；只登记测试文件名不算覆盖证据。
- `sufficient` 表示当前测试覆盖该保护点；`partial` 表示已有测试但仍有缺口；`not-wired` 表示测试存在但尚未进入对应质量检查；`missing` 表示尚无测试。

## FR-015：日用品更换前后私有照片认证读取

- **维护责任范围：** backend / web / mobile
- **最后审查日期：** 2026-08-17
- **状态：** active

### 业务保护规则

- `property_daily_necessities` 的更换前照片来自 `before_photo_urls`（兼容历史 `photo_urls`），更换后照片来自 `after_photo_urls`；三者都必须作为同一日用品记录的媒体关联参与授权判断，不能只读取旧的 `photo_urls`。
- 仅当 `inventory/...` 私有对象 key 与一条唯一、已授权的日用品记录精确关联时，认证媒体代理才可读取。错误记录、无关 key、歧义关联和未授权用户必须返回 `403`；已授权但对象不存在保持 `404`。
- Web 与移动端必须将 `inventory/...` 直接 key 和历史 R2 URL 规范化后交给认证媒体读取组件，禁止回退裸私有 URL。移动端日用品 `replaced` / `no_action` 历史记录须保留前后照片，详情和 viewer 使用相同任务上下文。

### 跨层适用范围

- **后端：** `/cleaning-app/media/image` 的 `inventory/...` 来源识别、日用品记录精确关联和移动反馈 payload。
- **Web：** 日用品更换前后照片的认证缩略图和预览。
- **移动端：** 日用品处理历史、缩略图、详情、viewer 与认证媒体代理上下文。
- **一致性：** 不改变 R2 ACL、角色矩阵、对象归属、数据库结构或照片上传写入链路。

### 测试映射

| 保护点 | 测试文件 | 测试场景 | 覆盖状态 | 执行命令 |
|---|---|---|---|---|
| 后照片精确关联与私有来源拒绝 | `backend/scripts/tests/test_mzapp_media_visibility.ts` | `after_photo_urls` 命中允许；无关 `inventory/...` key 拒绝；日用品前后字段和查询候选存在 | sufficient | `npm run test:mzapp-media-visibility --prefix backend` |
| Web 直接 key / 历史 R2 URL 认证读取 | `frontend/src/lib/maintenanceFeedbackMedia.test.ts` | `inventory/...` key 和 legacy URL 均生成现有认证代理请求 | sufficient | `npm run test --prefix frontend -- --run src/lib/maintenanceFeedbackMedia.test.ts --coverage.enabled=false` |
| 移动端前后照片与任务上下文 | `mz-cleaning-app-frontend/src/lib/cleaningMedia.test.ts` | 前后 `inventory/...` 照片走认证代理；日用品更换记录进入历史详情并展示两组照片 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/lib/cleaningMedia.test.ts src/screens/tasks/FeedbackFormScreen.test.tsx` |

### 验证策略

- **本地：** 后端精确关联、Web URL 规范化、移动端认证渲染与历史详情的定向回归；共享代理和移动媒体工具的全依赖回归在提交前完成。
- **发布后：** 以有权账号验证日用品通知/反馈的缩略图 → 详情 → viewer；独立错误记录、无关 key 与越权用户仍应为 `403`。

### 最后验证

- **CRL：** root/CRL-20260817-003；paired mobile/CRL-20260817-003
- **Commit：** not committed
- **日期：** 2026-08-17

### 相关 CRL

- root/CRL-20260817-003：日用品前后照片精确关联、认证读取与 Web 预览候选。
- mobile/CRL-20260817-003：日用品历史前后照片认证渲染候选。

### 非保护范围

- 日用品库存数量、通知收件人、Push、Badge、R2 ACL、对象恢复和历史数据修复。

## FR-001：任务操作权限与 available_actions

- **维护责任范围：** backend / web / mobile
- **最后审查日期：** 2026-08-11
- **状态：** active

### 业务保护规则

- 服务端 `available_actions` 是任务操作的权威来源；客户端不得在空列表时用旧角色或状态逻辑自行补按钮。
- `password_only` 只适用于 `upload_access_video`；不得把 `submit_inspection` 或通用完成动作错误地改成 password-only。
- 不同角色、参与者和任务状态的可操作性及禁用原因必须一致；客服、admin、线下经理在非参与任务上使用同样的管理动作矩阵，明确参与授权才显示对应执行动作。
- 管理视图的“全部”保持管理详情入口；切换到“我的”后，任务卡必须进入既有执行详情，不能因管理角色跳回管理页。
- “标记已退房”只可由真实 `checkout_clean` 来源生成；`checkin_clean` 即使带有订单号或旧缓存 action 也不得显示或调用该动作。合并卡只能携带真实退房子任务的来源 ID。
- 已完成的线下任务如需补充完成照片，必须由服务端显式下发 `append_completion_photo`；客户端只调用受权限控制的追加接口写入 `completion_photo_urls`，不能重新启用通用“标记完成”。追加成功以前不得显示为已保存；没有服务端删除动作时不得显示本地假删除。维修任务继续使用专用维修工作流。

### 跨层适用范围

- **后端：** payload 字段、action/permission、状态流转、空列表和历史状态兼容。
- **客户端：** 按服务端 action 展示、禁用原因、提交后的刷新。
- **入口：** 正常列表、任务详情、通知/深链接进入。
- **一致性：** Web、移动端不得重新推导后端权限。

### 测试映射

| 保护点 | 测试文件 | 测试场景 | 覆盖状态 | 执行命令 |
|---|---|---|---|---|
| 角色、参与者、状态和空 action 列表 | `backend/scripts/tests/test_work_task_actions.ts` | `available_actions`、`not_participant`、`task_completed`、password-only action | sufficient | `npm run test:work-task-actions --prefix backend` |
| 检查照片和 password-only 完成门槛 | `backend/scripts/tests/test_cleaning_task_transition_guard.ts` | 缺照片阻止检查完成；密码任务视频完成 | sufficient | `npm run test:cleaning-task-transition-guard --prefix backend` |
| 移动端提交后刷新保留退房标记 | `mz-cleaning-app-frontend/src/lib/workTasksStore.test.ts` | 服务端缺少 `checked_out_at` 时按稳定任务来源保留本地标记；服务端明确返回 `null` 时清除 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/lib/workTasksStore.test.ts` |
| 详情页按服务端 action 进入 | `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` | 任务详情 action 展示和入口 | partial | `npm run test --prefix mz-cleaning-app-frontend -- src/screens/tasks/TaskDetailScreen.test.tsx` |
| 已完成线下任务补充完成照片（后端 action / 写入） | `backend/scripts/tests/test_work_task_actions.ts` | 只对已完成、已授权的 `cleaning_offline_tasks` 下发动作；维修和未映射来源均被排除，追加只接受规范任务照片引用 | partial | `npm run test:work-task-actions --prefix backend` |
| 已完成线下任务补充完成照片（私有读取） | `backend/scripts/tests/test_cleaning_media_image.ts` | 认证代理必须以同一 `work_task_id` 精确匹配 `photo_urls` 或 `completion_photo_urls`，并在授权前拒绝歧义/未关联引用 | partial | `npm run test:cleaning-media-image --prefix backend` |
| 已完成线下任务补充完成照片（移动端） | `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` | 有服务端动作时立即写入；缩略图/预览传任务上下文；保存失败不显示未落库照片；已完成照片无服务端删除动作时隐藏删除入口 | partial | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/screens/tasks/TaskDetailScreen.test.tsx` |
| 管理角色详情动作矩阵（后端） | `backend/scripts/tests/test_work_task_actions.ts` | admin、线下经理与客服在非参与任务上只显示管理动作；显式参与授权保留检查入口 | sufficient | `npm run test:work-task-actions --prefix backend` |
| 管理角色详情动作矩阵（移动端旧 payload） | `mz-cleaning-app-frontend/src/lib/workTaskActions.test.ts` | admin、线下经理与客服在旧 payload 下保持管理动作一致 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/lib/workTaskActions.test.ts` |
| 全部管理入口与我的执行入口 | `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx` | 管理角色在“全部”进入 `ManagerDailyTask`；切换“我的”后进入执行详情 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/screens/tabs/TasksScreen.test.tsx` |
| 入住检查退房动作防护（后端） | `backend/scripts/tests/test_work_task_actions.ts` | 后端不为入住检查提供退房动作 | sufficient | `npm run test:work-task-actions --prefix backend` |
| 入住检查退房动作防护（移动端旧缓存） | `mz-cleaning-app-frontend/src/lib/workTaskActions.test.ts` | 旧客户端缓存不为入住检查提供退房动作 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/lib/workTaskActions.test.ts` |
| 通知入口的本地 action 防护 | `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.test.tsx` | 入口 action 被服务端禁用时阻止提交 | partial | `npm run test --prefix mz-cleaning-app-frontend -- src/screens/tasks/InspectionCompleteScreen.test.tsx` |

### 验证策略

- **backend 修改：** `check:fast`、backend targeted 和上述两个纯 contract test。
- **web/mobile 修改：** 对应客户端 targeted test，并核对入口和刷新。
- **跨层修改：** backend action/payload + 客户端渲染/导航/刷新。
- **发布前：** `npm run check:full`。

### 最后验证

- **CRL：** CRL-20260727-001
- **Commit：** not yet
- **日期：** 2026-07-27

### 相关 CRL

- CRL-20260722-013：仅改密码任务动作路由修复
- CRL-20260723-006：弱网视频提交与检查照片完成状态解耦
- CRL-20260724-010：任务详情展示补品填报照片与弱网状态
- CRL-20260727-001：管理角色统一客服任务详情入口
- CRL-20260811-006：已完成非维修任务补充完成记录照片（候选，未提交）

### 非保护范围

- 按钮颜色、间距和普通文案微调。
- 不改变 action 结果的组件重构。

## FR-002：自动任务与手动任务合并及字段继承

- **维护责任范围：** backend / web / mobile
- **最后审查日期：** 2026-07-27
- **状态：** active

### 业务保护规则

- 同日合并卡必须保留正确的任务来源、执行人、检查模式、周转日期和状态。
- 手动任务的有效字段可以继承，但不能用占位值覆盖有效自动任务字段。
- 线下手动任务的执行人以 `work_tasks` canonical 投影为准；PATCH 指派必须与源任务原子一致，缺省字段不得覆盖既有执行人，`assignee_id: null` 在第一版返回业务错误。
- 合并结果必须区分 active、取消、延后和已完成来源，不能仅按首个子任务推导。
- 周转合并卡的入住晚数必须取后一个入住订单，并明确显示为“待住 X晚”，不能继续显示前一个退房订单的晚数。
- 同一订单的入住 `new_code` 必须回填有效退房任务的 `old_code`；同步查询同时兼容当前 `task_type` 与历史仅有 `type` 的任务行，并保留手工锁定退房任务不覆盖的边界。
- 纯入住任务的 `old_code` 必须优先继承同房源最近一笔有效退房任务的 `old_code`；历史退房任务缺该字段时，只能回退到该上一笔订单的入住 `new_code`，绝不能使用当前订单的 `new_code` 或猜测密码。来源失效后须清空此前自动填入的值；没有可信来源时保持空白，手工锁定的入住任务不得覆盖。
- 历史订单的 `checkin_only` 修复只能创建缺失的 `checkin_clean`；任何已有入住任务（包括未分配、未锁定或仍为 `pending` 的人工编辑）都必须保护跳过，不得改写日期、密码、排期、状态或退房/延期检查投影。
- 普通同步与 `checkin_only` 同步的 active queue identity 必须包含作用域；两者可并存但不得互相覆盖 payload 或改变彼此的执行范围。同一作用域的重试仍可幂等合并。订单取消清理和删除 job 的 supersede 仅属于 `full`，受控 job 对这些场景必须无操作，不得取消任务或改变普通 job。

### 跨层适用范围

- **后端：** 合并查询、字段继承、来源优先级、历史空值和占位值兼容；清洁同步 job 的作用域身份、受控入住补建和索引迁移。
- **客户端：** 合并卡标题、状态、执行人、检查/清洁顺序和详情内容。
- **入口：** Web 清洁安排表、Web 任务中心、移动端任务列表和详情。
- **一致性：** 同一任务在 Web、移动端和刷新后使用同一合并结果。

### 测试映射

| 保护点 | 测试文件 | 测试场景 | 覆盖状态 | 执行命令 |
|---|---|---|---|---|
| 检查模式、周转日期和来源优先级 | `backend/scripts/tests/test_cleaning_inspection_merge.ts` | same-day、pending、deferred、self-complete 合并 | sufficient | `npm run test:cleaning-inspection-merge --prefix backend` |
| 退房标记跨关联任务传播与合并状态优先级 | `backend/scripts/tests/test_task_assignment_canonical.ts` | 客服标记退房后，同订单或同房源日期的有效入住检查任务得到 `checked_out_at`；未开始显示退房，清洁进行中显示进行中，补品完成后客服/检查人员显示待检查 | sufficient | `npx ts-node-dev --transpile-only backend/scripts/tests/test_task_assignment_canonical.ts` |
| 线下任务执行人 source/canonical 一致性 | `backend/scripts/tests/test_offline_task_assignment_patch_contract.ts` | root backend Full 确认 assignee 的 omitted/null 语义、source/canonical 表确保、事务投影和 canonical 回读 | sufficient | `npm run test:offline-task-assignment-patch --prefix backend` |
| 线下任务执行人三角色授权 | `backend/scripts/tests/test_offline_task_assignment_patch.ts` | 客服、线下经理和 admin 的 HTTP/数据库验证；仅在显式非生产测试库、写入确认与生产库身份比对均存在时运行 | partial | `npm run test:offline-task-assignment-patch-integration --prefix backend` |
| 首次 PATCH 的 canonical 表确保顺序 | `backend/scripts/tests/test_offline_task_assignment_first_patch_contract.ts` | root backend Full 每次断言两张表确保均位于 `pgRunInTransaction` 和首个 `FOR UPDATE` 之前；独立 integration 脚本只在显式非生产测试库与写入确认下覆盖无投影首次写入与三角色 | sufficient | `npm run test:offline-task-assignment-first-patch --prefix backend` |
| 自动/手动字段继承、受控入住补建和队列作用域隔离 | `backend/scripts/tests/test_cleaning_sync_v2.ts` | 手动 placeholder、旧任务、同步后字段保留；`checkin_only` 只补缺失任务并保留未锁定人工日期/密码/排期；普通↔受控 job 双向不合并、同作用域幂等合并；取消订单的 scoped update 与 scoped delete 均不改变普通 job 或任务投影；scope-aware active-job 索引迁移/初始化契约 | sufficient | `npm run test:cleaning-sync-v2 --prefix backend`（由 root `check:backend` / `check:full` 执行） |
| 入住/纯入住旧密码的历史字段兼容 | `backend/scripts/tests/test_cleaning_sync_v2.ts` | `task_type` 缺失时同订单回填；纯入住优先取上一笔退房 `old_code`、退房历史缺字段时回退上一笔入住 `new_code`、两类来源失效均清空自动值、无来源保持空白、手工锁定不覆盖，统一展示保留纯入住旧密码 | partial | `npx ts-node-dev --transpile-only backend/scripts/tests/test_cleaning_sync_v2.ts` |
| Web 合并卡展示 | `frontend/src/lib/cleaningDailyMerge.test.ts` | 每日清洁合并和来源展示；后一个入住订单的晚数优先并显示“待住 X晚” | partial | `npm run test --prefix frontend -- src/lib/cleaningDailyMerge.test.ts` |
| Web 任务中心字段展示 | `frontend/src/app/task-center/taskCenterDisplay.test.ts` | 合并任务标题、状态和字段；退房入住卡显示“已住 X晚”和“待住 X晚”；延期检查与入住冲突显示危险色标签及原定检查/入住时间 | partial | `npm run test --prefix frontend -- --coverage.enabled=false src/app/task-center/taskCenterDisplay.test.ts` |
| 移动端周转展示 | `mz-cleaning-app-frontend/src/lib/turnoverDisplay.test.ts` | 合并卡周转和检查显示 | partial | `npm run test --prefix mz-cleaning-app-frontend -- src/lib/turnoverDisplay.test.ts` |
| 移动端检查任务退房状态展示与流程优先级 | `mz-cleaning-app-frontend/src/lib/taskVisualTheme.test.ts` | 未开始检查任务显示“已退房”；合并任务有清洁进行中时显示“进行中”，清洁完成且检查未完成时显示“待检查” | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/lib/taskVisualTheme.test.ts` |

### 验证策略

- **纯函数/展示修改：** 对应 backend/frontend/mobile targeted test。
- **数据库同步修改：** 先确认测试数据库非生产，再运行 `test_cleaning_sync_v2.ts`；未确认前不得宣称完整覆盖。
- **跨层修改：** 后端合并结果 + Web/mobile 显示和刷新。
- **发布前：** `npm run check:full`，另行完成安全的数据库测试。

### 最后验证

- **CRL：** root/CRL-20260820-004
- **Commit：** not committed
- **日期：** 2026-08-20

### 相关 CRL

- CRL-20260727-003：网页任务中心周转卡显示已住与待住晚数
- CRL-20260712-003：清洁安排表周转合并保留 active 手工任务
- CRL-20260712-004：任务中心客人需求过滤 null 占位值
- CRL-20260712-005：手动补位合并继承安全字段并记录冲突
- CRL-20260712-007：每日清洁显示手工补位冲突明细
- CRL-20260712-008：手工补位自动合并字段可信度规则优化
- CRL-20260725-008：移动端退房标记刷新保留与合并卡 payload 修复
- CRL-20260725-016：客服退房状态同步到检查人员关联任务
- CRL-20260725-017：修复退房标记覆盖清洁与检查进行状态
- CRL-20260725-022：每日清洁周转卡显示后续订单待住晚数
- CRL-20260731-009：线下任务执行人 canonical 一致性
- CRL-20260805-008：恢复线下任务指派 PATCH 业务契约与质量门执行链
- CRL-20260804-009：历史 `type` 兼容的同订单密码回填
- CRL-20260806-001：纯入住任务继承上一段有效旧密码
- root/CRL-20260820-004：历史订单入住任务受控队列范围保护

### 非保护范围

- 不改变合并结果的卡片颜色、间距和普通文案。
- 不影响业务结果的组件拆分。

## FR-003：任务修改脏数据识别与通知去重

- **维护责任范围：** backend / web / mobile
- **最后审查日期：** 2026-07-25
- **状态：** active

### 业务保护规则

- 只有实际业务字段变化才触发任务更新通知。
- 同一业务变化不能因为合并卡、刷新或多入口保存重复通知。
- 通知收件人按服务端策略和角色组计算，不能由客户端页面自行扩展。
- null、占位值和旧格式不能被误判为新的业务修改。

### 跨层适用范围

- **后端：** 脏字段比较、合并去重、通知策略和 event queue 语义。
- **客户端：** 保存反馈、通知展示、重复事件处理和刷新。
- **入口：** Web 编辑保存、移动端通知列表、通知详情和重新进入任务。
- **一致性：** 通知内容和收件人以服务端策略为准。

### 测试映射

| 保护点 | 测试文件 | 测试场景 | 覆盖状态 | 执行命令 |
|---|---|---|---|---|
| 通知策略、角色组和未知事件 | `backend/scripts/tests/test_app_notification_policies.ts` | policy key、角色组、未知 kind | sufficient | `npm run test:app-notification-policies --prefix backend` |
| 实际字段变化后的通知去重 | `backend/scripts/tests/test_task_assignment_canonical.ts` | 清洁任务更新、合并卡 group key、重复事件 | not-wired | `npx ts-node-dev --transpile-only backend/scripts/tests/test_task_assignment_canonical.ts` |
| 同步时忽略占位或无效变化 | `backend/scripts/tests/test_cleaning_sync_v2.ts` | placeholder、历史字段继承和同步结果 | not-wired | `npx ts-node-dev --transpile-only backend/scripts/tests/test_cleaning_sync_v2.ts` |
| Web 保存和任务中心反馈 | `frontend/src/app/task-center/taskCenterDisplay.test.ts` | 保存后的任务显示和变更提示 | partial | `npm run test --prefix frontend -- src/app/task-center/taskCenterDisplay.test.ts` |
| 移动端通知读取和去重展示 | `mz-cleaning-app-frontend/src/lib/notificationInbox.test.ts` | 通知缓存和重复事件处理 | partial | `npm run test --prefix mz-cleaning-app-frontend -- src/lib/notificationInbox.test.ts` |

### 验证策略

- **通知纯规则修改：** notification policy test + 客户端通知 test。
- **数据库事件/去重修改：** 仅在确认非生产测试数据库后运行写测试。
- **任务中心修改：** 后端 dirty-field/event 证据 + Web/mobile 保存和刷新证据。
- **发布前：** `npm run check:full`；数据库写测试单独记录实际环境和结果。

### 最后验证

- **CRL：** not yet
- **Commit：** not yet
- **日期：** not yet

### 相关 CRL

- CRL-20260705-003：任务中心保存通知按实际改动和合并卡片去重
- CRL-20260712-003：清洁安排表周转合并保留 active 手工任务
- CRL-20260712-004：任务中心客人需求过滤 null 占位值
- CRL-20260712-005：手动补位合并继承安全字段并记录冲突

### 非保护范围

- 通知卡片的颜色、图标和普通文案微调。
- 不改变事件语义的展示组件重构。

## FR-004：检查、自完成、补品和挂钥匙流程

- **维护责任范围：** backend / mobile
- **最后审查日期：** 2026-08-17
- **状态：** active

### 业务保护规则

- 检查照片、补品、挂钥匙和自完成必须按任务类型和 inspection scope 执行各自门槛。
- 缺少必需照片时不得完成检查；password-only 视频流程不得被普通检查照片门槛阻塞。
- 普通检查只有在必需照片完整保存到本机或已有可靠远端引用后才能进入视频流程；客人已到达并急需入住时，必须通过明确的 `guest_arrival_confirmed` 豁免记录。
- 状态流转、提交后刷新和失败重试必须保持可恢复，不得把中间状态误判为已完成。
- 普通检查提交必须等待同一清洁任务的补品记录和房源照片已持久化；检查入口和后端接口都不得只凭共享 `status` 放行，清洁未提交时清洁补品入口必须仍可恢复编辑。
- 自完成挂钥匙视频必须复用本机优先的媒体队列；文件上传成功但任务记录保存失败时，页面必须显示失败、保留本地文件和远端引用，并在重进/重试时只补做未完成步骤。该自完成视频动作不得套用普通检查的“清洁补品 + 房源照片 + 检查照片”前置；最终自完成仍按其自身视频、完成照片和补品门槛完成。
- Android 照片在本地草稿、上传和历史媒体读取链路中必须保持可解码的 JPEG；格式转换失败不得把原始 HEIC/未知字节以错误 MIME 继续上传，也不得在客户端伪装成黑色缩略图。
- 清洁照片上传响应中的稳定 `cleaning/...` 对象 key 必须跨队列、本地清理、业务提交和任务刷新保留；有 key 时不得只保存可能无法解析或访问的 R2 URL，缩略图、预览和原图必须可通过认证媒体代理读取。
- 日终交接已登记的 `cleaning/...` 照片必须经同一认证媒体代理读取；仅记录所属人或既有日终管理角色可读取。同一 key 若跨任务、日终、临时通知、房源反馈或外部维护媒体，或跨日终用户、日期或类别登记，必须拒绝读取。
- 当天任务临时通知照片必须精确关联一条 `guest_luggage_notices.photo_urls` 记录，并携带相同的 `guest_luggage_id` 用于缩略图和原图预览；只有当日对应房源的活跃清洁/检查执行人或既有管理查看角色可读取，缺少上下文、未关联、歧义或跨来源冲突一律拒绝。
- 当天任务临时通知刚上传但尚未保存关联的照片，只能用该次选图的本地 URI 预览；不得请求认证代理或把未关联对象伪装成已保存。保存成功后才清除本地预览并以返回通知 ID 读取已登记引用；保存失败时必须保留本地 URI 与远端引用以便重试。
- 上传队列成功回调后，页面仍可能使用本地 `file://` 引用；在页面切换到远端媒体引用前不得立即删除本地副本，已同步孤儿文件交给既有延迟清理机制处理。
- 挂钥匙页收到后台检查队列事件时只能静默同步当前校验结果，不能重置为阻塞“校验中”；重拍必须先成功持久化新的本地队列项，才能清理旧的未同步视频。
- 钥匙照片被删除后，钥匙照片上传动作必须恢复可用，不得因为补品已提交、清洁状态已进入完成态或共享任务状态已推进而阻止重新上传；钥匙照片仍存在时继续保持已记录状态。
- 补品提交完成后的钥匙重传不得把 `done`、`cleaned`、`restock_pending`、检查中间态或其他已推进状态覆盖为 `in_progress`；钥匙上传事件必须增量合并，不能用不完整任务刷新覆盖已保存的补品消耗照片。
- 正式检查与补充已成功保存到服务器后，只允许从相册追加新的“清洁问题反馈”；已提交的检查、补货和问题照片必须保持只读，追加问题不得替换历史媒体或再次推进任务状态。
- 追加问题照片在上传成功但服务端业务保存失败时，必须保留本地草稿和远端引用；重试只能补做业务保存，不得重复上传已确认的照片。
- 自完成完成照片的客户端必拍清单、后端保存 schema、最终完成门槛、任务卡状态投影和管理端详情展示必须使用同一组区域：基础房间照片、浴室下水口、电视和空调遥控器同框的一张必拍照片及吸尘器使用后。新照片继续使用 `remote_tv` 区域；旧 `remote_ac`、`remote_controls` 记录重进时必须合并展示，不能丢失。刚拍完的本地大图必须显示与最终上传相同的房号/执行人/时间水印，远端图片继续由既有上传链路实际写入水印。
- 自完成补品草稿只能保存用户已明确选择的结果；未选择项必须保持空状态并回显为“待确认”。未结束自完成任务进入页面必须确认房号，已结束状态重进不得重复阻断查看。可选的补品图片字段没有远端引用时必须从请求中省略，不能以空字符串触发服务端非空校验。
- admin、客服和线下经理进入同一管理详情时，必须能只读查看自完成保存的 `completion_*` 照片。合并卡需要查询所有关联清洁任务；其中某个历史/关联任务的照片请求失败时，已成功读取的完成照片必须继续显示，且失败不能伪装成“暂无”。

### 跨层适用范围

- **后端：** action、状态流转、完成门槛、缺失项、追加媒体和历史状态兼容。
- **客户端：** 检查步骤、补品/钥匙按钮、禁用原因、提交反馈、房号确认和刷新。
- **入口：** 任务列表、详情、检查完成页、通知/深链接。
- **一致性：** 客户端只执行服务端允许的流程，不绕过完成门槛。

### 测试映射

| 保护点 | 测试文件 | 测试场景 | 覆盖状态 | 执行命令 |
|---|---|---|---|---|
| 检查照片和 password-only 状态门槛 | `backend/scripts/tests/test_cleaning_task_transition_guard.ts` | 缺照片、视频保存、password-only 完成 | sufficient | `npm run test:cleaning-task-transition-guard --prefix backend` |
| inspection photo 区域兼容性 | `backend/scripts/tests/test_mzapp_form_photo_read.ts` | cleaning-app 与 legacy mzapp 的检查照片 schema 接受 `bathroom`，数量上限为 3 | not-wired | `npx ts-node --transpile-only backend/scripts/tests/test_mzapp_form_photo_read.ts` |
| 操作 action 和状态结果 | `backend/scripts/tests/test_work_task_actions.ts` | fill supplies、挂钥匙、检查完成、`inspected` 中间态继续挂钥匙、password-only `inspected` 终态、restock_pending、清洁完成后钥匙照片已删除时允许重新上传 | sufficient | `npm run test:work-task-actions --prefix backend` |
| 钥匙重传状态保持与事件字段 | `backend/scripts/tests/test_work_task_actions.ts` | `done`、`completed`、`cleaned`、`restock_pending` 等已推进状态重传不写入 `in_progress/started_at`，首次上传才进入 `in_progress`；事件只携带状态变化和钥匙照片字段 | sufficient | `npm run test:work-task-actions --prefix backend` |
| 后端清洁/检查流程状态不能被退房标记覆盖 | `backend/scripts/tests/test_task_assignment_canonical.ts` | 客服合并卡和检查人员任务在未开始、进行中、补品完成后三态保持正确状态 | sufficient | `npx ts-node-dev --transpile-only backend/scripts/tests/test_task_assignment_canonical.ts` |
| 移动端清洁/检查流程状态不能被退房标记覆盖 | `mz-cleaning-app-frontend/src/lib/taskVisualTheme.test.ts` | 合并任务有清洁进行中时显示“进行中”，清洁完成且检查未完成时显示“待检查”，未开始任务仍显示“已退房” | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/lib/taskVisualTheme.test.ts` |
| 实时事件的检查状态投影 | `mz-cleaning-app-frontend/src/lib/workTasksStore.test.ts` | 普通检查的 `inspected` 投影为 `to_hang_keys`；password-only 仍投影为 `done` | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/lib/workTasksStore.test.ts` |
| 钥匙重传不触发整卡覆盖 | `mz-cleaning-app-frontend/src/lib/workTasksStore.test.ts` | 仅状态/钥匙照片字段的钥匙重传事件走安全增量合并；含 `started_at` 等非安全字段的旧事件被识别为需整卡同步 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/lib/workTasksStore.test.ts` |
| 检查面板步骤和缺失项 | `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.test.tsx` | 四个核心步骤和检查入口 | partial | `npm run test --prefix mz-cleaning-app-frontend -- src/screens/tasks/InspectionPanelScreen.test.tsx` |
| 检查成功后的清洁问题追加 | `backend/scripts/tests/test_inspection_issue_append_contract.ts` | 仅已检查任务可追加、按 `inspection_unclean` 计数与插入、具备幂等 receipt，且不删除历史检查媒体或再次流转状态 | partial | `./backend/node_modules/.bin/ts-node-dev --transpile-only backend/scripts/tests/test_inspection_issue_append_contract.ts` |
| 检查/补品进入前房号确认与问题追加重试 | `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.test.tsx` | 两个编辑表单先确认房号；已完成任务即使入口缺少 `readOnly` 也跳过确认；检查批次 `synced` 后仅相册追加清洁问题；服务端保存失败保留远端断点且重试不重复上传；遥控器只拍一张但电视仍必拍 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/screens/tasks/InspectionPanelScreen.test.tsx src/screens/tasks/SuppliesFormScreen.test.tsx` |
| 补品“已补充”相机与照片门槛 | `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.test.tsx` | 点击“已补充”调用相机；拍照成功后写入 `restocked` 与本地补货照片 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/screens/tasks/InspectionPanelScreen.test.tsx` |
| 补品新增入口的本次/下次状态语义 | `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.test.tsx` | “添加其他要补充项”保持待处理；“添加下次要补充项”加入后直接为 `carry_forward` | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/screens/tasks/InspectionPanelScreen.test.tsx` |
| 补品加载态与读取失败不显示虚假空状态 | `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.test.tsx` | 补品请求未完成时不显示“没有待补充项”；请求失败显示重试入口，成功重试后显示缺失项目 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/screens/tasks/InspectionPanelScreen.test.tsx` |
| 浴室整体照片与必拍校验 | `mz-cleaning-app-frontend/src/lib/inspectionPanelSubmitQueue.test.ts` | 其他区域已有照片但浴室为空时，提交被拒绝并提示浴室照片 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/lib/inspectionPanelSubmitQueue.test.ts` |
| 自完成补货结果、房号确认和完成照片区域 | `mz-cleaning-app-frontend/src/screens/tasks/CleaningSelfCompleteScreen.test.tsx` | 自完成页显示“现场够用/已补充/下次退房补”；已补充必须有凭证，空白项目和误存的 `ok` + 空补货结果都不伪装为已选择；未结束任务先确认房号，已结束任务直接查看；客厅/沙发/卧室/厨房显示指定拍摄提示；电视和空调遥控器合为一个必拍位且只保留一张，旧遥控器区域兼容显示；本地大图显示水印并使用全屏预览 | partial | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/screens/tasks/CleaningSelfCompleteScreen.test.tsx` |
| 自完成挂钥匙视频弱网恢复与普通检查前置隔离 | `mz-cleaning-app-frontend/src/lib/inspectionMediaQueue.test.ts` | 自完成视频使用同一私有队列和自完成业务路由；业务保存失败不误报已同步；普通检查仍受前置阻断，自完成视频不要求普通检查补品/房源照片；两条路由事务保存动作、媒体和时间 | partial | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/lib/inspectionMediaQueue.test.ts src/screens/tasks/CleaningSelfCompleteScreen.test.tsx && npm run test:cleaning-task-transition-guard --prefix backend && npm run test:idempotency-submit-id-contract --prefix backend` |
| 挂钥匙视频静默刷新与重拍本地保留 | `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.test.tsx` | 全局检查队列事件不会把已打开的完成页切回阻塞校验；新视频本地入队失败时保留旧的待上传视频，入队成功后才清理旧副本 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/screens/tasks/InspectionCompleteScreen.test.tsx` |
| 管理详情自完成完成照片关联与部分失败展示 | `mz-cleaning-app-frontend/src/screens/tasks/ManagerDailyTaskScreen.test.ts` | active source、`cleaning_task_ids`、旧来源 ID 均进入完成照片读取；一个关联任务失败时成功照片继续保留并去重 | partial | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/screens/tasks/ManagerDailyTaskScreen.test.ts` |
| 自完成完成照片跨层区域一致性 | `backend/scripts/tests/test_idempotency_submit_id_contract.ts` | 自完成最终完成门槛和工作任务状态投影均要求浴室下水口、电视遥控器、吸尘器使用后；保存 schema 接受电视和可选空调遥控器区域，并兼容旧遥控器记录 | partial | `npm run test:idempotency-submit-id-contract --prefix backend` |
| 自完成队列分步提交与可选字段 | `mz-cleaning-app-frontend/src/lib/cleaningConsumablesSubmitQueue.test.ts` | 完成照片先本机暂存，只有标记完成时才进入逐张上传与单次业务保存；补品同步不得提前上传或保存暂存完成照片；未拍可选客厅补品照片时不传空字符串 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/lib/cleaningConsumablesSubmitQueue.test.ts` |
| 完成照片读取失败不清空当前显示 | `mz-cleaning-app-frontend/src/screens/tasks/CleaningSelfCompleteScreen.test.tsx` | 已有完成照片后再次读取失败时仍保留照片，不把失败误判为空 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/screens/tasks/CleaningSelfCompleteScreen.test.tsx` |
| 清洁人员补品拍摄、离线提交和状态反馈 | `mz-cleaning-app-frontend/src/screens/tasks/SuppliesFormScreen.test.tsx` | 本地照片、待同步、取消和失败解锁；只点一项后重新进入时其余项目仍待确认 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/screens/tasks/SuppliesFormScreen.test.tsx` |
| 补充与完成入口的补品草稿回显 | `mz-cleaning-app-frontend/src/screens/tasks/CleaningSelfCompleteScreen.test.tsx` | 只点一项后重新进入时其余项目仍显示“待确认”；旧的明确“足够”记录映射为“现场够用”，不把空状态误标为已选择 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/screens/tasks/CleaningSelfCompleteScreen.test.tsx` |
| 检查完成页入口防护 | `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.test.tsx` | action 禁用、视频队列和待同步 | partial | `npm run test --prefix mz-cleaning-app-frontend -- src/screens/tasks/InspectionCompleteScreen.test.tsx` |
| 完成页视频上传与业务保存状态 | `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.test.tsx` | 视频文件已上传但业务保存失败时显示真实错误，不误显示联网恢复；进入页面触发既有队列处理 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/screens/tasks/InspectionCompleteScreen.test.tsx` |
| 视频前置的本机照片门槛 | `mz-cleaning-app-frontend/src/lib/inspectionPanelSubmitQueue.test.ts` | 普通任务照片未完成时阻止视频；本机照片完成但弱网时允许视频入队 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/lib/inspectionPanelSubmitQueue.test.ts` |
| 完成页视频门槛与客人到达豁免入口 | `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.test.tsx` | 普通任务未完成照片时阻止进入视频；客人到达豁免后允许视频入队 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/screens/tasks/InspectionCompleteScreen.test.tsx` |
| 服务端客人到达豁免与视频门槛 | `backend/scripts/tests/test_cleaning_task_transition_guard.ts` | 客人到达豁免可提交空照片批次并完成视频状态门槛 | sufficient | `npm run test:cleaning-task-transition-guard --prefix backend` |
| 检查同步幂等 ID与历史队列迁移 | `mz-cleaning-app-frontend/src/lib/inspectionPanelSubmitQueue.test.ts` | 超长历史 `submit_id` 自动迁移；已有媒体上传成功时只重试失败的补品/检查业务保存步骤 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/lib/inspectionPanelSubmitQueue.test.ts` |
| 后端保存接口共享幂等 ID上限 | `backend/scripts/tests/test_idempotency_submit_id_contract.ts` | cleaning-app、mzapp 的检查/补品/反馈保存接口使用共享 256 字符上限，不回退到旧 120 字符限制 | not-wired | `npm run test:idempotency-submit-id-contract --prefix backend` |
| 自完成补货凭证授权与前置 | `backend/scripts/tests/test_idempotency_submit_id_contract.ts` | 只有自完成任务的清洁执行人（或受控手工 action）可用 `self_complete_restock`；仍先要求消耗品记录，审计为 `fill_supplies`，不套用检查专用的房源照片前置 | partial | `npm run test:idempotency-submit-id-contract --prefix backend` |
| 清洁未提交时阻止检查提交 | `backend/scripts/tests/test_work_task_actions.ts` | `cleaning_submission_ready=false` 时禁用检查照片和挂钥匙 action，并保留清洁补品 action | sufficient | `npm run test:work-task-actions --prefix backend` |
| 纯入住检查不套用清洁提交前置 | `backend/scripts/tests/test_work_task_actions.ts` | `checkout_clean` 的 `cleaning_submission_ready=false` 仍禁用检查/挂钥匙；`checkin_clean` 不套用该门槛 | sufficient | `npm run test:work-task-actions --prefix backend` |
| 检查提交前置断言和共享任务恢复 | `backend/scripts/tests/test_cleaning_task_transition_guard.ts` | `checkout_clean` 缺少清洁补品/房源照片时返回 `CLEANING_SUBMISSION_REQUIRED`；`checkin_clean` 只跳过清洁前置、仍保留检查照片状态门槛 | sufficient | `npm run test:cleaning-task-transition-guard --prefix backend` |
| 移动端清洁恢复入口 | `mz-cleaning-app-frontend/src/lib/workTaskActions.test.ts` | 共享状态已为 `inspected` 但清洁提交状态为 false 时补品入口保持可编辑；钥匙照片删除后即使任务已完成仍保留重新上传入口 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/lib/workTaskActions.test.ts` |
| 任务详情钥匙照片重传入口 | `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` | 清洁提交完成且钥匙照片已删除时，任务详情的上传钥匙按钮仍可点击 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/screens/tasks/TaskDetailScreen.test.tsx` |
| 检查页提交前置提示 | `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.test.tsx` | 检查页仅服从服务端 action；纯入住检查不被旧 `cleaning_submission_ready=false` 本地阻止 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/screens/tasks/InspectionPanelScreen.test.tsx` |
| 检查照片上传进度不重载草稿 | `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.test.tsx` | 连续队列进度通知仍更新同步状态，但不重复读取冻结草稿 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/screens/tasks/InspectionPanelScreen.test.tsx` |
| Android 本地照片格式统一 | `mz-cleaning-app-frontend/src/lib/imageCompression.test.ts` | HEIC 转换成功生成新的 JPEG URI；转换失败或伪造原 URI 结果时阻断上传 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/lib/imageCompression.test.ts` |
| Android 媒体预览失败反馈 | `mz-cleaning-app-frontend/src/components/CleaningMediaPreview.test.tsx` | 缩略图或原图加载失败显示明确错误并允许重试；本地 URI 同时用于两层 Image 时不产生重复 key，不伪装成黑色加载态 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/components/CleaningMediaPreview.test.tsx` |
| Android 认证媒体私有缓存 | `mz-cleaning-app-frontend/src/lib/cleaningMediaCache.test.ts` | 带认证的远端清洁媒体下载为应用私有文件 URI，供安卓原生 Image 渲染，下载失败时保留已有缓存 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/lib/cleaningMediaCache.test.ts` |
| 后端图片上传、读取格式与已登记媒体绑定 | `backend/scripts/tests/test_cleaning_media_image.ts` | HEIC/缺失 MIME 统一为 JPEG；无效图片返回 `IMAGE_FORMAT_UNSUPPORTED`；代理只读取已登记媒体并在 R2 读取前 fail closed | sufficient | `npm run test:cleaning-media-image --prefix backend` |
| 同 key 跨任务或跨媒体类型授权冲突 | `backend/scripts/tests/test_cleaning_media_image.ts` | 代理仅允许唯一任务且唯一媒体类型的已登记引用；任一冲突一律拒绝读取 | sufficient | `npm run test:cleaning-media-image --prefix backend` |
| 日终交接媒体代理授权 | `backend/scripts/tests/test_cleaning_media_image.ts` | 已登记日终照片进入受控代理；库存管理员作为日终管理角色仍受记录级授权，记录所属人允许、无关角色或清洁员拒绝；owner/date 专用分支在 R2 读取前拒绝同 key 的任务、日终、临时通知、房源反馈或外部维护关联。实际 R2 对象读取端到端验证仍待补充 | partial | `npm run test:cleaning-media-image --prefix backend` |
| 当天任务临时通知后端授权 | `backend/scripts/tests/test_mzapp_media_visibility.ts` | 认证代理按保存通知记录和当前角色授权，并拒绝缺少通知上下文或跨来源冲突 | sufficient | `npm run test:mzapp-media-visibility --prefix backend` |
| 当天任务临时通知客户端认证请求 | `mz-cleaning-app-frontend/src/lib/cleaningMedia.test.ts` | 缩略图和预览构造同一 `guest_luggage_id` 认证请求 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/lib/cleaningMedia.test.ts` |
| 当天任务临时通知原图预览上下文 | `mz-cleaning-app-frontend/src/components/CleaningMediaPreview.test.tsx` | 缩略图与原图预览带相同通知上下文 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/components/CleaningMediaPreview.test.tsx` |
| 当天任务临时通知卡片传参 | `mz-cleaning-app-frontend/src/components/GuestLuggageCard.test.tsx` | 卡片向缩略图和预览传递相同 notice ID 与 Bearer token | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/components/GuestLuggageCard.test.tsx` |
| 当天任务临时通知保存前本地预览 | `mz-cleaning-app-frontend/src/screens/tasks/ManagerDailyTaskScreen.test.ts` | 刚上传照片优先保留本地 URI，已保存照片才携带 notice ID 走认证读取 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/screens/tasks/ManagerDailyTaskScreen.test.ts` |
| 管理端客厅多图兼容和重试入口 | — | 当前移动端 `origin/Dev` 已无历史多图测试；需恢复或新增测试以覆盖兼容单图、稳定顺序和失败重试 | missing | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/screens/tasks/ManagerDailyTaskScreen.test.ts` |
| 任务媒体类型与参与关系读取授权 | `backend/scripts/tests/test_mzapp_media_visibility.ts` | 未分配用户不能用已知 key 越权；检查媒体、挂钥匙视频、补货凭证和普通媒体按任务级可见性分别判定 | sufficient | `npm run test:mzapp-media-visibility --prefix backend` |
| 清洁媒体 key 跨钥匙上传和刷新保留 | `mz-cleaning-app-frontend/src/lib/keyUploadQueue.test.ts` | 上传返回 key 时钥匙业务 payload 优先使用 `cleaning/...` key；无 key 时保留 URL fallback | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/lib/keyUploadQueue.test.ts` |
| 清洁媒体 key 跨补品提交和刷新保留 | `mz-cleaning-app-frontend/src/lib/cleaningConsumablesSubmitQueue.test.ts` | 上传返回 key 时补品和完成照片业务 payload 优先使用 `cleaning/...` key | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/lib/cleaningConsumablesSubmitQueue.test.ts` |
| 清洁媒体 key 跨检查提交和刷新保留 | `mz-cleaning-app-frontend/src/lib/inspectionPanelSubmitQueue.test.ts` | 检查/补货凭证保存使用稳定 key，业务保存失败重试不重复上传 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/lib/inspectionPanelSubmitQueue.test.ts` |
| 后端清洁媒体 key 格式校验 | `backend/scripts/tests/test_cleaning_media_reference.ts` | 允许安全 `cleaning/...` key，拒绝路径穿越、查询参数和非 key URL | sufficient | `npm run test:cleaning-media-reference --prefix backend` |
| 上传成功后的页面媒体引用切换 | `mz-cleaning-app-frontend/src/lib/cleaningConsumablesSubmitQueue.test.ts` | Android 页面使用的本地副本不会在成功回调中提前删除；同一命令同时覆盖钥匙队列和钥匙详情远端刷新 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/lib/cleaningConsumablesSubmitQueue.test.ts src/lib/keyUploadQueue.test.ts src/screens/tasks/TaskDetailScreen.test.tsx` |

### 验证策略

- **backend 修改：** action/transition contract test。
- **mobile 修改：** 对应 screen test + mobile typecheck/lint；涉及队列时增加队列测试。
- **跨层修改：** 后端门槛、客户端显示/提交/刷新和通知入口。
- **发布前：** `npm run check:full`。

### 最后验证

- **CRL：** mobile/CRL-20260817-001；root/CRL-20260817-001（此前记录保留）
- **Commit：** not committed
- **日期：** 2026-08-17

### 相关 CRL

- CRL-20260812-006：当天任务临时通知已保存照片认证读取
- CRL-20260812-007：当天任务临时通知保存前本地预览
- CRL-20260812-008：日终媒体跨来源冲突 fail-closed 补丁
- mobile/CRL-20260817-001：挂钥匙视频静默刷新与重拍本地保留
- root/CRL-20260817-001：FR-004 挂钥匙视频回归映射
- CRL-20260723-006：弱网视频提交与检查照片完成状态解耦
- CRL-20260724-014：修复厨房照片连续拍摄卡住
- CRL-20260725-021：修复检查与补品保存的超长幂等 ID失败
- CRL-20260725-001：明确补品照片上传状态
- CRL-20260727-007：钥匙重传保持任务状态并保留补品照片
- CRL-20260725-009：检查人员点击“已补充”自动打开相机
- CRL-20260725-010：检查照片新增浴室整体区域
- CRL-20260728-005：自完成完成照片新增浴室下水口、遥控器并统一完成门槛
- CRL-20260729-001：自完成照片全屏预览、水印和单一遥控器拍照位
- CRL-20260729-002：自完成补品可选客厅照片空字符串参数修复
- CRL-20260729-003：自完成挂钥匙视频弱网同步与检查前置隔离
- CRL-20260729-004：管理详情恢复自完成完成照片展示
- CRL-20260725-011：检查照片提交后的待挂钥匙状态与刷新稳定性修复
- CRL-20260725-012：浴室整体照片上限调整为三张
- CRL-20260725-013：检查面板客厅提示与同步状态位置调整
- CRL-20260725-016：客服退房状态同步到检查人员关联任务
- CRL-20260725-017：修复退房标记覆盖清洁与检查进行状态
- CRL-20260726-009：挂钥匙视频业务保存状态不再误判为离线
- CRL-20260725-018：检查人员补充项新增入口区分本次与下次退房
- CRL-20260725-019：检查照片本机就绪后才允许视频并支持客人到达豁免
- CRL-20260725-020：检查页补品加载态与读取失败防止误判为空
- CRL-20260704-011：移动端检查照片弱网待同步修复
- CRL-20260726-001：修复清洁人员补品状态回显把未选择项标成足够
- CRL-20260726-008：清洁人员房间完成照片接入唯一草稿队列与幂等提交
- CRL-20260726-007：检查提交必须等待清洁补品与房源照片
- CRL-20260728-001：移动端房号确认、遥控器合拍与检查后清洁问题追加
- CRL-20260731-005：纯入住检查错误清洁照片前置修复
- CRL-20260731-007：检查照片上传进度不重载草稿
- CRL-20260731-008：清洁媒体完整性、多图展示与安全清理
- CRL-20260805-008：恢复清洁媒体读取唯一归属、日终媒体授权和质量门执行链

### 非保护范围

- 流程页面的颜色、间距和普通文案调整。
- 不改变提交门槛和状态结果的组件重构。

## FR-005：离线媒体上传、业务提交与本地清理

- **维护责任范围：** backend / mobile
- **最后审查日期：** 2026-08-11
- **状态：** active

### 业务保护规则

- 视频、检查照片、补品照片和反馈提交队列可以独立重试，单步失败不能抹掉已成功步骤。
- 业务记录未确认保存成功前，必须保留本地媒体和失败诊断。
- 已有远端引用且最终同步成功后，才允许清理本地媒体；缩略图生成失败不得误删原文件。
- 页面仍持有本地 `file://` 媒体引用时，队列不得在成功回调中抢先删除该文件；同步孤儿文件使用已有延迟清理机制回收。
- 媒体类型、任务 ID 和提交动作必须保持正确关联，不能只凭本地预览判断业务保存成功。
- 补品页面入队后不得再走第二套直传/直提交逻辑；队列是唯一执行者，持久化草稿是唯一提交进度事实来源。
- 草稿、队列项、提交和每张媒体都必须有稳定 ID；每张媒体必须记录 `local_uri`、`remote_url`、上传状态和稳定错误码。
- 每张照片上传成功后，必须先完成草稿整快照写入和读回校验，再尝试删除本地文件；删除失败只能进入清理任务，不能使业务提交失败。
- 业务提交成功后才清理整份草稿；网络/5xx 使用退避和上限，400/401/403、本地文件丢失进入明确阻断状态。
- 同一队列项不可并发执行；已上传媒体和业务提交超时重试不得重新上传已确认的照片。
- 检查已成功同步后的清洁问题追加必须单独持久化本地草稿；上传成功但追加业务保存失败时保留远端引用，重试不得重复上传。
- 线下任务说明照片的新写入必须保存服务端返回的 `r2://<namespace>/mzapp/...` 稳定引用；认证读取必须先精确匹配 `work_tasks.photo_urls` 和 `work_task_id`，再校验 manager/view-all、assignee 或 manual participant。历史 `.r2.dev/mzapp/...` 或当前配置 public base 下的安全 HTTPS 对象只能在已记录同一任务时由服务端认证代理读取；未知主机、查询/片段、认证信息、端口、路径穿越和未关联引用一律拒绝。
- 认证读取的 401/403 与 404 必须分别显示权限不足与照片不可用，均不得重试；只有网络、超时或 5xx 可显示重试。终态响应不得继续使用缓存副本。
- 移动端缩略图读取失败不得只显示空白占位：必须保留并显示经认证代理分类后的 403/404 原因，网络、超时或 5xx 必须提供明确的重试入口；这只说明客户端边界，实际服务端根因仍须由受控请求追踪确认。

### 跨层适用范围

- **后端：** 媒体类型、任务 ID 聚合、业务保存结果和重复提交兼容。
- **客户端：** 上传状态、独立队列、失败步骤、重试入口、本地保留和清理。
- **入口：** 任务详情、检查面板、补品页、通知/恢复后重试。
- **一致性：** 本地“已保存”不能代替服务端业务保存确认。

### 测试映射

| 保护点 | 测试文件 | 测试场景 | 覆盖状态 | 执行命令 |
|---|---|---|---|---|
| 视频队列独立重试和不重复上传 | `mz-cleaning-app-frontend/src/lib/inspectionMediaQueue.test.ts` | 业务保存失败、上传中断、超时重试 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- src/lib/inspectionMediaQueue.test.ts` |
| 检查提交队列分步失败和本地保留 | `mz-cleaning-app-frontend/src/lib/inspectionPanelSubmitQueue.test.ts` | 缺照片、部分成功、重试、缩略图失败、相同 action 绑定不重复触发刷新 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- src/lib/inspectionPanelSubmitQueue.test.ts` |
| 检查成功后的问题照片追加断点 | `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.test.tsx` | 相册选图、上传后业务保存失败保留草稿，重试只调用追加保存而不重复上传 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/screens/tasks/InspectionPanelScreen.test.tsx` |
| 补品提交队列和部分上传 | `mz-cleaning-app-frontend/src/lib/cleaningConsumablesSubmitQueue.test.ts` | 弱网入队、逐张断点、只重试失败照片、补货凭证先上传再批量写入 restock proof、业务提交超时不重复上传、连续入队去重、并发 worker、400/401/403 阻断、本地文件丢失、5xx 退避、稳定 ID 跨存储读取 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- src/lib/cleaningConsumablesSubmitQueue.test.ts` |
| 清洁人员房间完成照片队列 | `mz-cleaning-app-frontend/src/lib/cleaningConsumablesSubmitQueue.test.ts` | 完成照片拍摄后仅本机暂存；最终标记完成才逐张上传并以稳定 `submit_id`/`step_key` 单次业务保存；失败保留本地原图、成功后进入延迟清理 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- src/lib/cleaningConsumablesSubmitQueue.test.ts` |
| 补品页面唯一提交入口 | `mz-cleaning-app-frontend/src/screens/tasks/SuppliesFormScreen.test.tsx` | 页面只持久化/入队，队列状态刷新页面，后台完成不残留离线提示 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- src/screens/tasks/SuppliesFormScreen.test.tsx src/screens/tasks/CleaningSelfCompleteScreen.test.tsx` |
| 补品页面唯一提交入口 | `mz-cleaning-app-frontend/src/screens/tasks/CleaningSelfCompleteScreen.test.tsx` | 页面只持久化/入队，队列状态刷新页面，后台完成不残留离线提示 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- src/screens/tasks/SuppliesFormScreen.test.tsx src/screens/tasks/CleaningSelfCompleteScreen.test.tsx` |
| 补品提交错误分类 | `mz-cleaning-app-frontend/src/lib/api.test.ts` | 5xx 转为可退避的稳定 `SERVER_ERROR` | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- src/lib/api.test.ts` |
| 补品业务提交后端幂等契约 | `backend/scripts/tests/test_idempotency_submit_id_contract.ts` | 补品接口接受共享长度限制，使用 `cleaning_task_consumables` + `consumables_submit` receipt，并在重复/冲突前检查、成功后保存 | partial | `npm run test:idempotency-submit-id-contract --prefix backend` |
| 清洁人员完成照片业务提交幂等契约 | `backend/scripts/tests/test_idempotency_submit_id_contract.ts` | 完成照片接口使用任务行锁、`cleaning_task_completion_photos` receipt 和稳定 `step_key`，重复提交不重复替换记录 | partial | `npm run test:idempotency-submit-id-contract --prefix backend` |
| 补品业务事务与稳定媒体对象 | `backend/scripts/tests/test_idempotency_submit_id_contract.ts` | 任务行锁、补品记录/任务状态/回执同事务，事务成功后才触发副作用；请求期不做结构检查；`media_id` 生成稳定清洁媒体 key | partial | `npm run test:idempotency-submit-id-contract --prefix backend` |
| R2 媒体引用与孤儿治理规则 | `backend/scripts/tests/test_r2_media_governance.ts` | 识别 URL/key 引用、区分业务前缀、仅老且未引用对象进入候选；默认无可删除临时前缀，删除必须精确授权 | sufficient | `npm run test:r2-media-governance --prefix backend` |
| 第五阶段跨层提交执行者约束 | `backend/scripts/tests/test_phase5_release_contract.ts` | 页面只入队、队列单 worker/稳定 ID/5xx 退避，后端事务锁和提交后副作用，E2E 写入需要非生产显式闸门 | partial | `npm run test:phase5-release-contract --prefix backend` |
| 本地媒体引用和孤儿清理 | `mz-cleaning-app-frontend/src/lib/localMediaHousekeeping.test.ts` | 嵌套队列引用、旧且未引用文件 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- src/lib/localMediaHousekeeping.test.ts` |
| 媒体上传和本地/远端状态 | `mz-cleaning-app-frontend/src/lib/cleaningMedia.test.ts` | 上传失败、远端引用和重试 | partial | `npm run test --prefix mz-cleaning-app-frontend -- src/lib/cleaningMedia.test.ts` |
| 钥匙媒体队列 | `mz-cleaning-app-frontend/src/lib/keyUploadQueue.test.ts` | 钥匙照片入队和恢复同步 | partial | `npm run test --prefix mz-cleaning-app-frontend -- src/lib/keyUploadQueue.test.ts` |
| 线下任务历史 public-base 读取 | `backend/scripts/tests/test_mzapp_task_photo_reference.ts` | 当前引用规范化；当前 public base 历史 URL 的安全 key、未知主机和路径穿越边界 | sufficient | `ts-node-dev --transpile-only scripts/tests/test_mzapp_task_photo_reference.ts`（在 backend） |
| 线下任务照片代理授权 | `backend/scripts/tests/test_mzapp_media_visibility.ts` | manager、assignee、participant 与 outsider 的读取边界 | sufficient | `npm run test:mzapp-media-visibility --prefix backend` |
| 线下任务照片精确关联 | `backend/scripts/tests/test_cleaning_media_image.ts` | `photo_urls` 当前任务关联、历史 URL 认证读取和缺失对象终态 | sufficient | `npm run test:cleaning-media-image --prefix backend` |
| 线下任务历史 URL 客户端认证构造 | `mz-cleaning-app-frontend/src/lib/cleaningMedia.test.ts` | 仅显式 offline task context 且含 `work_task_id` 的历史 HTTPS 引用走认证代理 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/lib/cleaningMedia.test.ts` |
| 线下任务历史 URL 缩略图与预览 | `mz-cleaning-app-frontend/src/components/CleaningMediaPreview.test.tsx` | 缩略图和预览复用同一代理和任务上下文 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/components/CleaningMediaPreview.test.tsx` |
| 线下任务历史 URL 页面上下文 | `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` | 顶部任务照片的缩略图与预览显式进入 offline 认证读取 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/screens/tasks/TaskDetailScreen.test.tsx` |
| 移动端稳定引用响应 | `mz-cleaning-app-frontend/src/lib/api.test.ts` | 记录 `remoteReference` 并兼容 URL | sufficient | `npm run test -- --runInBand --no-cache src/lib/api.test.ts`（在 mobile） |
| 移动端终态读取边界 | `mz-cleaning-app-frontend/src/lib/cleaningMediaCache.test.ts` | 403/404 终态与网络重试 | sufficient | `npm run test -- --runInBand --no-cache src/lib/cleaningMediaCache.test.ts`（在 mobile） |
| 移动端缩略图失败可见性 | `mz-cleaning-app-frontend/src/components/CleaningMediaImage.test.tsx` | 403/404 显示终态原因；临时读取错误显示重试入口 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/components/CleaningMediaImage.test.tsx` |

### 验证策略

- **移动端队列修改：** 对应 queue/page/API tests + mobile typecheck/lint。
- **后端媒体聚合修改：** 先做只读 payload/任务 ID 核对；涉及写测试时确认非生产数据库。
- **补品幂等修改：** 复用已有 receipt 表；构建、事务/锁/启动 warmup/稳定媒体 key 源码契约和移动端请求传参已验证，真实数据库回滚/重复请求/并发及 R2 覆盖验证待非生产环境。
- **R2 治理修改：** 纯治理规则和 dry-run 盘点工具已验证；真实 R2/数据库盘点、引用覆盖复核和任何删除均未执行，默认不允许删除。
- **第五阶段发布准备：** 跨层源码契约、队列 5xx 退避和稳定 ID 持久化测试已验证；真实非生产 E2E、真机/EAS 和真实 R2 覆盖验证仍需单独执行。
- **跨层修改：** 媒体类型、业务保存结果、客户端状态和本地清理顺序一起验证。
- **发布前：** `npm run check:full`，并单独记录未执行的真实设备/EAS 验证。

### 最后验证

- **CRL：** CRL-20260811-009
- **Commit：** not yet
- **日期：** 2026-08-12

### 相关 CRL

- CRL-20260704-011：移动端检查照片弱网待同步修复
- CRL-20260704-012：移动端本地媒体空间自动治理
- CRL-20260723-006：弱网视频提交与检查照片完成状态解耦
- CRL-20260724-010：任务详情展示补品填报照片与弱网状态
- CRL-20260725-008：移动端退房标记刷新保留与合并卡 payload 修复
- CRL-20260726-002：补品提交队列唯一执行者与草稿媒体断点状态
- CRL-20260726-003：补品业务提交 submit_id 幂等保护
- CRL-20260726-004：补品后端事务、启动预热与稳定媒体对象
- CRL-20260726-005：R2 媒体引用盘点与孤儿回收闸门
- CRL-20260726-006：第五阶段跨层回归与发布前写入闸门
- CRL-20260728-001：移动端房号确认、遥控器合拍与检查后清洁问题追加
- CRL-20260811-009：线下任务历史公共基址照片认证读取（root/mobile pair）

### 非保护范围

- 媒体缩略图尺寸、卡片布局和普通文案微调。
- 不改变保存确认和清理时机的图片展示组件重构。

## FR-006：挂钥匙视频与检查补品通知的角色边界

- **维护责任范围：** backend / mobile
- **最后审查日期：** 2026-07-25
- **状态：** active

### 业务保护规则

- 普通 `cleaner` 不得从 `/mzapp/work-tasks` payload 获得 `lockbox_video_url`，也不得在任务详情渲染挂钥匙视频。
- `cleaning_inspector`、`cleaner_inspector`、`admin`、`offline_manager` 和 `customer_service` 可以继续查看挂钥匙视频。
- 挂钥匙照片、挂钥匙视频、检查补品和补货凭证相关通知不得发送给普通 `cleaner`。
- 通知策略的默认收件人使用检查参与人；额外用户、额外组和显式收件人不能绕过普通清洁员排除规则。
- 已有的 `available_actions` 权限和 password-only 上传动作不因本保护规则改变。

### 跨层适用范围

- **后端：** work-tasks payload 媒体字段、通知策略默认模板、角色解析和最终收件人过滤。
- **客户端：** 移动端任务详情视频渲染和角色防御性判断。
- **入口：** 任务列表/详情、通知中心和通知深链接。
- **一致性：** 服务端 payload 与通知收件人是权威结果；客户端不能通过缓存或本地角色回退重新显示视频。

### 测试映射

| 保护点 | 测试文件 | 测试场景 | 覆盖状态 | 执行命令 |
|---|---|---|---|---|
| 后端挂钥匙视频角色能力 | `backend/scripts/tests/test_mzapp_media_visibility.ts` | 普通 cleaner/staff 为 false；检查员、兼任检查员和管理角色为 true | sufficient | `npm run test:mzapp-media-visibility --prefix backend` |
| 通知默认模板与普通 cleaner 过滤 | `backend/scripts/tests/test_app_notification_policies.ts` | 挂钥匙/补品默认走检查参与人；普通 cleaner 和未知账号被过滤；兼任检查员保留 | sufficient | `npm run test:app-notification-policies --prefix backend` |
| 移动端详情视频渲染 | `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` | 普通 cleaner 不显示视频；允许角色列表由后端角色能力测试覆盖 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/screens/tasks/TaskDetailScreen.test.tsx` |

### 验证策略

- **backend 修改：** 运行媒体角色测试、通知策略测试和 backend build；`check:backend` 纳入两个 contract test。
- **mobile 修改：** 运行任务详情 targeted test，并执行 mobile typecheck/lint/test。
- **跨层修改：** 同时核对后端角色能力、payload 投影、通知最终收件人和客户端渲染。
- **发布前：** `npm run check:full`、Registry/ledger audit；不执行生产数据写入。

### 最后验证

- **CRL：** CRL-20260725-023
- **Commit：** root `83a9073`；mobile `ab3cf11`
- **日期：** 2026-07-25

### 相关 CRL

- CRL-20260725-015：已挂钥匙任务保留单一完成状态并支持只读查看检查照片
- CRL-20260725-019：检查照片本机就绪后才允许视频并支持客人到达豁免
- CRL-20260725-021：修复检查与补品保存的超长幂等 ID失败

### 非保护范围

- 视频编码、缩略图尺寸、卡片布局和普通文案微调。
- 历史已发送通知的撤回或批量删除。
- 不改变 `upload_access_video` 的执行权限和 password-only 业务流程。

## FR-007：管理移动端工作情况历史读取与仓库钥匙时间

- **维护责任范围：** mobile（复用既有任务、交接和钥匙只读 API）
- **最后审查日期：** 2026-07-28
- **状态：** active

### 业务保护规则

- 只有 admin、线下经理在管理模式可见“工作情况”；模块初始必须收起，收起时不得读取工作情况任务或员工交接记录。
- 展开后的工作情况必须以当前所选日期为唯一查询日期，复用既有历史任务和交接记录；不可只因进入周/月视图就继续展示今天的数据。
- 当前页面可按日期缓存成功读取的结果以避免重复访问；不得预取历史日期或新增后台轮询。手动下拉刷新必须使该页面缓存失效并重新读取。
- 从历史工作情况进入交接详情时，必须带同一所选日期；不创建新的不可变快照、表或写入。
- MSQ 仓库钥匙最近事件必须清楚区分：当天为“谁借出 HH:mm”、昨天为“昨天 谁借出 HH:mm”、更早为明确日期和时间；不得把前一天及更早记录标作“最近”。

### 跨层适用范围

- **后端依赖：** 既有按日期任务、交接记录和仓库钥匙事件读取结果。
- **客户端：** 管理模式卡片的收起状态、日期切换、会话缓存、交接详情导航和钥匙事件文案。
- **入口：** 移动端任务页的今天/本周/本月日期选择与 MSQ 仓库钥匙卡。
- **一致性：** 历史数据以既有服务端记录为准；页面缓存不改变服务端数据且手动刷新后必须失效。

### 测试映射

| 保护点 | 测试文件 | 测试场景 | 覆盖状态 | 执行命令 |
|---|---|---|---|---|
| 默认收起、展开读取、历史日期和页面缓存 | `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx` | admin 初始不调用工作情况读取；展开后读取当天；月视图选择上月日期后按该日期读取；回到已读当天不重复读取 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/screens/tabs/TasksScreen.test.tsx` |
| MSQ 钥匙最近事件日期语义 | `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx` | 同一天、昨天和更早事件分别生成正确的借出/归还人和时间文案 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/screens/tabs/TasksScreen.test.tsx` |

### 验证策略

- **移动端修改：** 运行任务页聚焦测试、typecheck、lint 和按钮规范审计。
- **读取行为修改：** 核对收起时无读取、展开后请求参数和历史日期参数；不调用生产写接口。
- **发布前：** `npm run check:full`，并在真机确认周/月日期切换与 MSQ 文案。

### 最后验证

- **CRL：** CRL-20260728-002
- **Commit：** not yet
- **日期：** 2026-07-28

### 相关 CRL

- CRL-20260728-002：管理端历史工作情况与 MSQ 钥匙时间语义

### 非保护范围

- 任务状态、交接内容、钥匙借还权限或仓库钥匙数据本身的修改。

## FR-008：员工 Photo ID 与签证资料的水印、存储与自助隔离

- **维护责任范围：** backend / mobile
- **最后审查日期：** 2026-07-29
- **状态：** active

### 业务保护规则

- Photo ID 与签证资料仅支持图片上传；不引入 PDF、OCR 或证件识别流程。
- 两类图片必须在服务端上传时写入同一段整版、重复倾斜水印：`仅用于MZ Property（ABN：42 657 925 365）记录,不做任何其他用途。` / `For the records of MZ Property (ABN: 42 657 925 365) only, not for other purpose.`；客户端本地原图预览也必须覆盖等价整版水印，不能以右下角单点水印代替。
- Photo ID 与签证图片缩略图可打开只读、等比的全屏大图；大图必须支持 1x–4x 双指捏合缩放与放大后拖动查看局部，并可通过关闭按钮、背景或系统返回关闭。全屏层不得新增下载、替换、删除、上传、保存或权限能力。
- 签证资料包含图片地址和 Visa Grant Number；既有本地个人资料缓存缺字段时必须安全补为 `null` / 空字符串，不能使资料页崩溃或把字段误写为其他用户的数据。
- 敏感资料仅通过认证用户自己的 `GET/PATCH /users/me` 读取或修改；通讯录和任务列表等非个人资料入口不得返回或展示 Photo ID、签证文件地址、Visa Grant Number。
- 图片上传成功不等于资料保存成功：上传结果必须通过 `/users/me` 落到当前用户的对应字段；失败时不得把失败的本地预览当成已存档资料。

### 跨层适用范围

- **后端：** `/mzapp/upload` 的资料水印模式、`users` 字段初始化、自助资料 schema 与 `/users/me` 读写。
- **客户端：** 个人资料页的图片选择、本地预览水印、远程水印文件预览、Visa Grant Number 编辑和个人资料缓存迁移。
- **入口：** 移动端“我 → 个人信息 → 编辑资料”。
- **一致性：** 服务端生成的水印文件是最终存档；本地覆盖层仅用于尚未被服务端处理的即时预览。

### 测试映射

| 保护点 | 测试文件 | 测试场景 | 覆盖状态 | 执行命令 |
|---|---|---|---|---|
| 自助字段、迁移脚本和整版水印模式 | `backend/scripts/tests/test_profile_compliance_document_contract.ts` | 校验 `/users/me` schema/字段读写、三个 schema 初始化入口、Photo ID 与签证水印模式和后端重复水印实现 | partial | `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_profile_compliance_document_contract.ts` |
| 资料页签证字段、水印、上传和缩放大图 | `mz-cleaning-app-frontend/src/screens/me/ProfileEditScreen.test.tsx` | 合规角色可见 Visa Grant Number/签证图片上传；Photo ID 与签证均传入专属水印模式、显示本地整版水印，并可打开/关闭 1x–4x 缩放大图 | partial | `npm run test -- --runInBand --no-cache src/screens/me/ProfileEditScreen.test.tsx` |
| 本地资料缓存字段持久化 | `mz-cleaning-app-frontend/src/lib/profileStore.test.ts` | 签证文件地址和 Visa Grant Number 写入后可恢复 | partial | `npm run test -- --runInBand --no-cache src/lib/profileStore.test.ts` |

### 验证策略

- **backend 修改：** 执行资料合约测试和 TypeScript 编译；真实对象存储上传仅在非生产测试账号、无真实证件时单独验证。
- **mobile 修改：** 执行资料页和缓存定向测试、typecheck、lint、按钮规范审计；真机检查本地原图与服务端返回图的整版水印。
- **安全验证：** 仅核对 `users/me` 自助接口与通讯录选择字段；不得在日志、测试夹具或截图中放入真实证件、签证号或访问令牌。
- **发布前：** Registry/ledger audit；不执行生产资料写入。

### 最后验证

- **CRL：** CRL-20260729-006
- **Commit：** not yet
- **日期：** 2026-07-29

### 相关 CRL

- CRL-20260729-006：移动端 Photo ID 与签证图片整版水印和 Visa Grant Number

### 非保护范围

- PDF、OCR、签证有效期识别、自动审批和管理端证件资料浏览。
- 头像上传、银行资料规则、普通个人资料字段和认证权限模型的重构。
- 历史记录不可变快照、数据归档或新的报表统计。

## FR-009：固定支出月度快照完整性

- **维护责任范围：** web / backend recurring payments
- **最后审查日期：** 2026-08-03
- **状态：** active

### 业务保护规则

- 对于已启用、当月到期的固定支出模板，若该月份不存在快照，Web 自动补建必须包含固定金额、按营收百分比及金额为 `0` 的模板，不能只处理按营收百分比模板。
- 已存在且已付款的按营收百分比快照不得被页面自动补建逻辑重新计算；已存在但未付款的按营收百分比快照仍可按既有流程刷新。
- 房源营收以 `property_expenses.fixed_expense_id + month_key` 的月度快照为权威，不能以当前模板金额替代历史月度结果。
- 自动补建只处理当前月；历史月份缺失快照必须通过受控回填单独处理，避免浏览历史月份时产生写入。

### 跨层适用范围

- **Web：** `/finance/recurring` 在当前月筛选到期模板后调用既有 `ensure-snapshot`。
- **后端：** `POST /recurring/payments/:id/ensure-snapshot` 负责幂等创建月度快照，并由月度快照读取接口提供房源营收数据。
- **入口：** 固定支出页面、房源营收页面。
- **一致性：** 后端快照是历史支出的权威记录；前端仅决定哪些当前月模板需要请求补建。

### 测试映射

| 保护点 | 测试文件 | 测试场景 | 覆盖状态 | 执行命令 |
|---|---|---|---|---|
| 缺快照固定支出补建筛选 | `frontend/src/lib/recurringPaymentRules.test.ts` | 固定金额和金额为零的缺快照模板会补建；已有固定快照不重建 | sufficient | `npm run test --prefix frontend -- --run src/lib/recurringPaymentRules.test.ts` |
| 按营收百分比已付款保护 | `frontend/src/lib/recurringPaymentRules.test.ts` | 缺快照或未付款快照可处理；已付款快照不重新计算 | sufficient | `npm run test --prefix frontend -- --run src/lib/recurringPaymentRules.test.ts` |

### 验证策略

- **Web 修改：** 运行月度快照筛选单测、frontend lint 与 production build。
- **生产修复：** 在代码部署后，先做 2026-07 目标模板预览，再只对缺失快照调用既有幂等补建接口并复核笔数、金额和零金额快照数。
- **发布前：** Registry/ledger audit、独立发布审查；不通过浏览历史月份触发生产写入。

### 最后验证

- **CRL：** CRL-20260803-003
- **Commit：** `fdbd6a4d0241fecf202d1acd13b34b445e4f98ab`
- **日期：** 2026-08-03

### 相关 CRL

- CRL-20260803-003：恢复固定支出缺失月度快照的补建筛选。

### 非保护范围

- 固定支出模板的金额、付款方式、启停状态和历史已存在快照的批量重算。
- 除 2026-07 已确认缺失范围外的生产历史数据回填。

## FR-010：维修完工投影与房源反馈私有图片读取

- **维护责任范围：** backend / web / mobile
- **最后审查日期：** 2026-08-17
- **状态：** active

### 业务保护规则

- 维修执行人通过服务端专用完成动作保存的完工照片、备注和未完成原因，必须同步到同一 `work_tasks` 来源投影；不得恢复通用工单 `mark` 接口来绕过维修状态机。
- 已保存的内部维修完工图片只能从未删除的真实房源维修记录精确匹配；外部维修完工图片只允许管理角色或当前被分配的 `maintenance_staff` 读取。
- 缩略图、预览和原图都必须通过认证的 `/cleaning-app/media/image` 读取；客户端不得使用 R2 直链或把本地未保存预览当作已保存证据。
- 历史 `property_deep_cleaning` 记录中的 `deep-cleaning/...` 与 `deep-cleaning-upload/...` 私有引用，只能在唯一、未删除且关联真实房源的深清记录精确匹配后进入同一认证代理；错误、未关联、歧义、已删除或未认证读取保持 `403`，不能降级为 R2 直链。
- `property_maintenance` 的 `pending_review` 源状态是权威状态：任务中心陈旧的 `assigned` 同步不得回退它，`GET /mzapp/work-tasks` 必须投影规范化源状态。维修前照片字段必须在旧缓存详情只刷新一次后显示，并保留同一任务上下文给认证代理。
- 网页维修分派的 `photo_urls` 参数保持 PostgreSQL `text[]`，不得按完成照片的 `jsonb` 绑定。

### 跨层适用范围

- **后端：** `maintenanceWorkflowStore` 任务投影、`cleaning_app` 媒体归属与授权代理。
- **客户端：** Web 维修/反馈详情与移动端房源反馈只使用认证媒体 URL；移动端 OTA 不属于本根仓发布单元。
- **入口：** 维修完成/未完成动作、历史深清反馈列表/详情，以及相册缩略图和全屏预览。
- **一致性：** 服务端以源维修记录、分配关系和角色决定图片读取；客户端不自行扩大权限。

### 测试映射

| 保护点 | 测试文件 | 测试场景 | 覆盖状态 | 执行命令 |
|---|---|---|---|---|
| 完工字段投影 | `backend/scripts/tests/test_maintenance_workflow_actions.ts` | 维修任务投影在冲突更新时同步完工照片、备注和原因 | partial | `npm run test:maintenance-workflow-actions --prefix backend` |
| 完工图片认证读取 | `backend/scripts/tests/test_mzapp_media_visibility.ts` | 内部真实房源精确匹配、外部维修单分配/角色授权和私有代理读取 | partial | `npm run test:mzapp-media-visibility --prefix backend` |
| 历史深清服务端认证读取 | `backend/scripts/tests/test_mzapp_media_visibility.ts` | 深清的三个持久化字段与项目 before/after 保留精确关联；两个历史前缀仅进入既有唯一关联和认证授权分支 | partial | `npm run test:mzapp-media-visibility --prefix backend` |
| 历史深清 Web 认证读取 | `frontend/src/lib/maintenanceFeedbackMedia.test.ts` | `deep-cleaning/`、`deep-cleaning-upload/` 的 Web 详情读取认证代理，不回退为原始 URL | sufficient | `npm run test --prefix frontend -- --run src/lib/maintenanceFeedbackMedia.test.ts --coverage.enabled=false` |
| 历史深清 Mobile 认证读取 | `mz-cleaning-app-frontend/src/lib/cleaningMedia.test.ts` | 两个历史前缀的移动端缩略图和预览携带认证信息与任务上下文，不回退为原始 URL | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand --no-cache src/lib/cleaningMedia.test.ts` |
| 维修源状态与前照片类型 | `backend/scripts/tests/test_maintenance_workflow_actions.ts` | `text[]` 前照片绑定和待审核状态不回退 | sufficient | `npm run test:maintenance-workflow-actions --prefix backend` |
| 维修详情缓存前照片回填 | `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` | 旧详情缓存只刷新一次并显示前照片 | sufficient | `npm run test -- --runInBand --no-cache src/screens/tasks/TaskDetailScreen.test.tsx`（在 mobile） |

### 验证策略

- **代码验证：** 运行后端精确关联契约、Web/Mobile 认证读取回归、后端 TypeScript 编译、feature registry 与 ledger audit。
- **集成验证：** 仅在明确确认的非生产环境中，以执行人、管理角色及非关联账号验证内部/外部图片的缩略图、预览、原图和 403 边界。
- **发布后：** 在真实 TestFlight 维修任务执行“相册选图 → 标记完成 → 重新打开任务 → 缩略图/大图”，不对生产数据做额外测试写入。

### 最后验证

- **CRL：** root/CRL-20260817-002
- **Commit：** not committed
- **日期：** 2026-08-17

### 相关 CRL

- CRL-20260806-006：维修执行人专用动作当前 Dev 契约重基线。
- CRL-20260807-007（mobile）：维修详情专用动作路由与认证图片展示。
- root/CRL-20260817-002、mobile/CRL-20260817-002：历史深清私有媒体前缀兼容与认证读取。

### 非保护范围

- 维修审核关闭、费用结算、历史生产数据回填、R2 对象物理删除，以及 R2 ACL/公开读取策略。

## FR-014：Airbnb 邮件订单缺失年份的跨年日期解析

- **维护责任范围：** backend / web
- **最后审查日期：** 2026-08-16
- **状态：** active

### 业务保护规则

- Airbnb 订单邮件中的入住和退房日期若带四位年份，必须以该年份为准，不得依赖邮件月份或客户端时区猜测。
- 未带年份时，必须以邮件头在 `Australia/Melbourne` 的当地日历日为基准：日期严格早于邮件当天才进入下一年；同日或之后的日期仍为邮件当年。
- 解析前必须校验日历日期；无效日期不得被 JavaScript 自动归一化为另一月份或年份。
- 无年份且成功解析的日期必须保留原始文本并写入 `year_inferred=true`，使后续审计可区分推断和显式日期。
- Airbnb 已确认/已变更订单邮件必须优先从实际订单日期卡片提取入住和退房；页面中较早出现但不含日期的 `Check-in details` 等说明文字不得阻断后续真实日期字段的解析。
- 入住和退房必须从全部候选中组成唯一、合法且与已解析住晚一致的区间；重复同日期标签可去重，缺日期、日期倒置、住晚冲突或多组冲突候选不得写入 `confirmed` 订单。
- 上述日期不完整或冲突时，导入记录必须以稳定错误码（如 `CHECKIN_DATE_NOT_FOUND`）失败并保留解析审计；不得创建订单或投递清洁同步任务。
- 对已入库的高置信历史记录，修复只能在固定候选数、住晚一致性、任务锁定和目标日期冲突预检均通过后执行；修复不得直接更新 `cleaning_tasks`，必须投递既有清洁同步队列。

### 跨层适用范围

- **后端：** Airbnb 邮件解析、订单写入字段、受控订单年份修复脚本和清洁同步队列。
- **客户端：** 管理端订单页继续显示服务端存储日期，不自行补年份或覆盖服务器值。
- **入口：** 邮件同步导入、历史订单受控修复、订单管理列表和详情。
- **一致性：** 入住、退房和 nights 必须保持同一住宿区间；任务日期由现有同步 worker 从订单重新投影。

### 测试映射

| 保护点 | 测试文件 | 测试场景 | 覆盖状态 | 执行命令 |
|---|---|---|---|---|
| 缺失年份的年界、同日、事故日期、墨尔本日界、闰日、无效日期、显式年份和日期卡片 | `backend/scripts/test_email_year_rule.ts` | 12 月到 1 月、1 月到 12 月、8 月确认次年 2 月、UTC 与 Australia/Melbourne 日界不同、闰年 2 月 29 日、4 月 31 日拒绝、显式年份优先；`Check-in details` 在前、真实入住/退房日期卡、重复标签、缺入住/退房和住晚冲突 | sufficient | `npm run test:email-year-rule --prefix backend` |
| 遗留年份推断调用点 | `backend/scripts/test_infer_year.ts` | 年初、年末和同年未来日期都按下一次出现日期解析 | partial | `./backend/node_modules/.bin/ts-node --transpile-only backend/scripts/test_infer_year.ts` |
| 历史订单修复前置安全 | `backend/scripts/repair_airbnb_email_year_rollover.ts` | 默认只读；固定候选数；住晚、已锁任务、目标日期冲突和 apply 双重确认 | partial | `./backend/node_modules/.bin/ts-node --transpile-only backend/scripts/repair_airbnb_email_year_rollover.ts` |

### 验证策略

- **代码验证：** 执行日期规则/日期卡片回归、后端 TypeScript no-emit 编译、Registry/ledger audit 和 diff 检查。
- **生产预检：** 只读重跑严格候选查询，确认候选数、住晚、任务锁定和日期冲突均符合已批准的固定值；不得输出客户信息或数据库连接信息。
- **生产修复：** 只在代码已部署且另行批准的精确写入操作中，使用 `--apply --expected-count=<approved-count> --acknowledge-cleaning-jobs` 与环境确认；随后确认同步队列完成和订单/任务日期一致。

### 最后验证

- **CRL：** CRL-20260820-001
- **Commit：** not committed
- **日期：** 2026-08-20

### 相关 CRL

- CRL-20260816-001：Airbnb 邮件订单缺失年份跨年解析与受控修复（root）
- CRL-20260820-001：Airbnb 邮件日期卡片漏解析与失败闭环（root）

### 非保护范围

- 带显式年份的第三方订单、非 Airbnb 邮件来源、前端自行猜测日期、批量重建全部清洁任务，以及未通过高置信预检的历史订单。

## FR-016：报销凭证认证媒体读取

- **维护责任范围：** backend / mobile（专用报销凭证媒体路由）
- **最后审查日期：** 2026-08-17
- **状态：** active

### 业务保护规则

- 已提交的报销凭证图片只能通过凭证 ID、图片 ID 和当前认证用户读取；客户端不得把 `expense_receipt_images.url`、`first_image_url` 或对象存储 URL 直接交给 `Image`。
- 服务端必须先解析未删除的 `expense_receipts` 记录、精确匹配其 `expense_receipt_images.id`，并在读取对象字节前复用既有凭证权限：凭证提交者须拥有记录所含全部 scope 的 `view.self`；`admin`、`finance_staff`、`customer_service` 保留既有财务详情读取权限。
- 图片 ID 不属于请求凭证、无权限读者或不被认可的存储引用必须返回 `403 forbidden_media`，且不得访问对象存储；已授权且精确关联的对象缺失返回 `404 media_not_found`。
- 未提交的上传仅可用当前设备的临时本地 URI 预览；未关联草稿不得调用凭证认证读取路由，也不得回退到裸 URL。保存、重置或移除后必须清除该临时预览映射。
- 认证响应必须是私有、不可复用缓存；不得复用 `/cleaning-app/media/image`、不得放宽 R2 ACL，也不迁移既有历史对象。
- 凭证图片 GET 是读取路径：不得调用 `ensureMzappExpenseReceiptSchema()` 或发出任何 DDL。缺少既有凭证 schema 是独立部署/迁移问题，读取请求不得以自建表或改表绕过。

### 跨层适用范围

- **后端：** `expense_receipts`、`expense_receipt_images` 的精确关联，`GET /mzapp/expense-receipts/:receiptId/images/:imageId` 和 R2/历史 `/uploads` 的只读兼容读取。
- **客户端：** `ExpenseCenterScreen` 的新建草稿、我的记录缩略图、详情缩略图和全屏查看器。
- **入口：** 移动端“我 → 支出中心”。
- **一致性：** 数据库的凭证-图片行与当前认证权限是字节读取唯一权威；R2 对象存在不等于可被客户端直接读取。

### 测试映射

| 保护点 | 测试文件 | 测试场景 | 覆盖状态 | 执行命令 |
|---|---|---|---|---|
| 凭证-图片精确关联、四类授权角色、越权/错误图片 403、对象缺失 404、读取路径零 DDL | `backend/scripts/tests/test_mzapp_expense_receipt_media_contract.ts` | 仅绑定 `127.0.0.1` 的 Express 路由夹具验证读者必须先通过记录关联和权限，只有允许请求到达 R2，并拒绝 `CREATE` / `ALTER` | sufficient | `npm run test:expense-receipt-media-contract --prefix backend`（由 root `check:backend` / `check:full` 执行） |
| 认证源构造与草稿/已保存读取边界 | `mz-cleaning-app-frontend/src/lib/expenseReceiptMedia.test.ts` | 认证 header、凭证图片路径与缺失上下文拒绝；页面裸 URL 分支另由 source audit 覆盖 | partial | `npm run test -- --runInBand --no-cache src/lib/expenseReceiptMedia.test.ts`（在 mobile） |

### 验证策略

- **代码验证：** root `check:backend` / `check:full` 必须运行后端凭证媒体契约；另运行移动端凭证媒体测试、两端 typecheck、Registry/ledger audit 和 diff 检查。
- **发布后：** 用凭证提交者、admin、finance_staff、customer_service 与无关角色依次验证我的记录缩略图、详情缩略图和大图；只读取已有测试凭证，不创建或修改生产财务数据。
- **存储验证：** 对已授权而对象丢失的历史记录预期得到 404，不以公开 URL或放宽 ACL 绕过。

### 最后验证

- **CRL：** root/CRL-20260820-003；paired mobile/CRL-20260817-007
- **Commit：** not committed
- **日期：** 2026-08-20

### 相关 CRL

- root/CRL-20260817-004：报销凭证认证读取与移动端临时预览边界。
- mobile/CRL-20260817-004：凭证专用认证 source 与 temporary-only 草稿预览。
- root/CRL-20260817-007、mobile/CRL-20260817-007：凭证图片 GET 的无 DDL 读取边界与私有媒体契约登记。
- root/CRL-20260820-003：将既有 root 凭证媒体契约接入完整质量链，并通过 isolated root `check:full` 复核。

### 非保护范围

- 旧版 `/mzapp/expenses`、网页 `expense_invoices` 和报表附件的媒体迁移；它们须以独立来源审计处理。
- R2 ACL 修改、历史对象复制/删除、生产财务数据回填或任何公开下载能力。
