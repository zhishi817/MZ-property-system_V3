# Feature Regression Registry

本文件只保存当前有效的业务不变量、责任范围、测试映射和最近一次完整验证索引。

- `最后验证` 只保存最近一次完整确认该 FR 仍然有效的 CRL、Commit 和日期。
- `相关 CRL` 保存对该 FR 产生实质影响的重要历史变更，可保留多条；完整历史以 `docs/change-release-ledger.md` 为准。
- 测试映射必须说明保护点和测试场景；只登记测试文件名不算覆盖证据。
- `sufficient` 表示当前测试覆盖该保护点；`partial` 表示已有测试但仍有缺口；`not-wired` 表示测试存在但尚未进入对应质量检查；`missing` 表示尚无测试。

## FR-001：任务操作权限与 available_actions

- **维护责任范围：** backend / web / mobile
- **最后审查日期：** 2026-07-25
- **状态：** active

### 业务保护规则

- 服务端 `available_actions` 是任务操作的权威来源；客户端不得在空列表时用旧角色或状态逻辑自行补按钮。
- `password_only` 只适用于 `upload_access_video`；不得把 `submit_inspection` 或通用完成动作错误地改成 password-only。
- 不同角色、参与者和任务状态的可操作性及禁用原因必须一致。

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
| 通知入口的本地 action 防护 | `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.test.tsx` | 入口 action 被服务端禁用时阻止提交 | partial | `npm run test --prefix mz-cleaning-app-frontend -- src/screens/tasks/InspectionCompleteScreen.test.tsx` |

### 验证策略

- **backend 修改：** `check:fast`、backend targeted 和上述两个纯 contract test。
- **web/mobile 修改：** 对应客户端 targeted test，并核对入口和刷新。
- **跨层修改：** backend action/payload + 客户端渲染/导航/刷新。
- **发布前：** `npm run check:full`。

### 最后验证

- **CRL：** CRL-20260725-016
- **Commit：** not yet
- **日期：** 2026-07-25

### 相关 CRL

- CRL-20260722-013：仅改密码任务动作路由修复
- CRL-20260723-006：弱网视频提交与检查照片完成状态解耦
- CRL-20260724-010：任务详情展示补品填报照片与弱网状态

### 非保护范围

- 按钮颜色、间距和普通文案微调。
- 不改变 action 结果的组件重构。

## FR-002：自动任务与手动任务合并及字段继承

- **维护责任范围：** backend / web / mobile
- **最后审查日期：** 2026-07-25
- **状态：** active

### 业务保护规则

- 同日合并卡必须保留正确的任务来源、执行人、检查模式、周转日期和状态。
- 手动任务的有效字段可以继承，但不能用占位值覆盖有效自动任务字段。
- 合并结果必须区分 active、取消、延后和已完成来源，不能仅按首个子任务推导。
- 周转合并卡的入住晚数必须取后一个入住订单，并明确显示为“待住 X晚”，不能继续显示前一个退房订单的晚数。

### 跨层适用范围

- **后端：** 合并查询、字段继承、来源优先级、历史空值和占位值兼容。
- **客户端：** 合并卡标题、状态、执行人、检查/清洁顺序和详情内容。
- **入口：** Web 清洁安排表、Web 任务中心、移动端任务列表和详情。
- **一致性：** 同一任务在 Web、移动端和刷新后使用同一合并结果。

### 测试映射

| 保护点 | 测试文件 | 测试场景 | 覆盖状态 | 执行命令 |
|---|---|---|---|---|
| 检查模式、周转日期和来源优先级 | `backend/scripts/tests/test_cleaning_inspection_merge.ts` | same-day、pending、deferred、self-complete 合并 | sufficient | `npm run test:cleaning-inspection-merge --prefix backend` |
| 退房标记跨关联任务传播与合并状态优先级 | `backend/scripts/tests/test_task_assignment_canonical.ts` | 客服标记退房后，同订单或同房源日期的有效入住检查任务得到 `checked_out_at`；未开始显示退房，清洁进行中显示进行中，补品完成后客服/检查人员显示待检查 | sufficient | `npx ts-node-dev --transpile-only backend/scripts/tests/test_task_assignment_canonical.ts` |
| 自动/手动字段继承和历史数据兼容 | `backend/scripts/tests/test_cleaning_sync_v2.ts` | 手动 placeholder、旧任务、同步后字段保留 | not-wired | `npx ts-node-dev --transpile-only backend/scripts/tests/test_cleaning_sync_v2.ts` |
| Web 合并卡展示 | `frontend/src/lib/cleaningDailyMerge.test.ts` | 每日清洁合并和来源展示；后一个入住订单的晚数优先并显示“待住 X晚” | partial | `npm run test --prefix frontend -- src/lib/cleaningDailyMerge.test.ts` |
| Web 任务中心字段展示 | `frontend/src/app/task-center/taskCenterDisplay.test.ts` | 合并任务标题、状态和字段 | partial | `npm run test --prefix frontend -- src/app/task-center/taskCenterDisplay.test.ts` |
| 移动端周转展示 | `mz-cleaning-app-frontend/src/lib/turnoverDisplay.test.ts` | 合并卡周转和检查显示 | partial | `npm run test --prefix mz-cleaning-app-frontend -- src/lib/turnoverDisplay.test.ts` |
| 移动端检查任务退房状态展示与流程优先级 | `mz-cleaning-app-frontend/src/lib/taskVisualTheme.test.ts` | 未开始检查任务显示“已退房”；合并任务有清洁进行中时显示“进行中”，清洁完成且检查未完成时显示“待检查” | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/lib/taskVisualTheme.test.ts` |

### 验证策略

- **纯函数/展示修改：** 对应 backend/frontend/mobile targeted test。
- **数据库同步修改：** 先确认测试数据库非生产，再运行 `test_cleaning_sync_v2.ts`；未确认前不得宣称完整覆盖。
- **跨层修改：** 后端合并结果 + Web/mobile 显示和刷新。
- **发布前：** `npm run check:full`，另行完成安全的数据库测试。

### 最后验证

- **CRL：** CRL-20260725-017
- **Commit：** not yet
- **日期：** 2026-07-25

### 相关 CRL

- CRL-20260712-003：清洁安排表周转合并保留 active 手工任务
- CRL-20260712-004：任务中心客人需求过滤 null 占位值
- CRL-20260712-005：手动补位合并继承安全字段并记录冲突
- CRL-20260712-007：每日清洁显示手工补位冲突明细
- CRL-20260712-008：手工补位自动合并字段可信度规则优化
- CRL-20260725-008：移动端退房标记刷新保留与合并卡 payload 修复
- CRL-20260725-016：客服退房状态同步到检查人员关联任务
- CRL-20260725-017：修复退房标记覆盖清洁与检查进行状态
- CRL-20260725-022：每日清洁周转卡显示后续订单待住晚数

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
- **最后审查日期：** 2026-07-25
- **状态：** active

### 业务保护规则

- 检查照片、补品、挂钥匙和自完成必须按任务类型和 inspection scope 执行各自门槛。
- 缺少必需照片时不得完成检查；password-only 视频流程不得被普通检查照片门槛阻塞。
- 普通检查只有在必需照片完整保存到本机或已有可靠远端引用后才能进入视频流程；客人已到达并急需入住时，必须通过明确的 `guest_arrival_confirmed` 豁免记录。
- 状态流转、提交后刷新和失败重试必须保持可恢复，不得把中间状态误判为已完成。

### 跨层适用范围

- **后端：** action、状态流转、完成门槛、缺失项和历史状态兼容。
- **客户端：** 检查步骤、补品/钥匙按钮、禁用原因、提交反馈和刷新。
- **入口：** 任务列表、详情、检查完成页、通知/深链接。
- **一致性：** 客户端只执行服务端允许的流程，不绕过完成门槛。

### 测试映射

| 保护点 | 测试文件 | 测试场景 | 覆盖状态 | 执行命令 |
|---|---|---|---|---|
| 检查照片和 password-only 状态门槛 | `backend/scripts/tests/test_cleaning_task_transition_guard.ts` | 缺照片、视频保存、password-only 完成 | sufficient | `npm run test:cleaning-task-transition-guard --prefix backend` |
| inspection photo 区域兼容性 | `backend/scripts/tests/test_mzapp_form_photo_read.ts` | cleaning-app 与 legacy mzapp 的检查照片 schema 接受 `bathroom`，数量上限为 3 | not-wired | `npx ts-node --transpile-only backend/scripts/tests/test_mzapp_form_photo_read.ts` |
| 操作 action 和状态结果 | `backend/scripts/tests/test_work_task_actions.ts` | fill supplies、挂钥匙、检查完成、`inspected` 中间态继续挂钥匙、password-only `inspected` 终态、restock_pending | sufficient | `npm run test:work-task-actions --prefix backend` |
| 后端清洁/检查流程状态不能被退房标记覆盖 | `backend/scripts/tests/test_task_assignment_canonical.ts` | 客服合并卡和检查人员任务在未开始、进行中、补品完成后三态保持正确状态 | sufficient | `npx ts-node-dev --transpile-only backend/scripts/tests/test_task_assignment_canonical.ts` |
| 移动端清洁/检查流程状态不能被退房标记覆盖 | `mz-cleaning-app-frontend/src/lib/taskVisualTheme.test.ts` | 合并任务有清洁进行中时显示“进行中”，清洁完成且检查未完成时显示“待检查”，未开始任务仍显示“已退房” | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/lib/taskVisualTheme.test.ts` |
| 实时事件的检查状态投影 | `mz-cleaning-app-frontend/src/lib/workTasksStore.test.ts` | 普通检查的 `inspected` 投影为 `to_hang_keys`；password-only 仍投影为 `done` | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/lib/workTasksStore.test.ts` |
| 检查面板步骤和缺失项 | `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.test.tsx` | 四个核心步骤和检查入口 | partial | `npm run test --prefix mz-cleaning-app-frontend -- src/screens/tasks/InspectionPanelScreen.test.tsx` |
| 补品“已补充”相机与照片门槛 | `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.test.tsx` | 点击“已补充”调用相机；拍照成功后写入 `restocked` 与本地补货照片 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/screens/tasks/InspectionPanelScreen.test.tsx` |
| 补品新增入口的本次/下次状态语义 | `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.test.tsx` | “添加其他要补充项”保持待处理；“添加下次要补充项”加入后直接为 `carry_forward` | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/screens/tasks/InspectionPanelScreen.test.tsx` |
| 补品加载态与读取失败不显示虚假空状态 | `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.test.tsx` | 补品请求未完成时不显示“没有待补充项”；请求失败显示重试入口，成功重试后显示缺失项目 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/screens/tasks/InspectionPanelScreen.test.tsx` |
| 浴室整体照片与必拍校验 | `mz-cleaning-app-frontend/src/lib/inspectionPanelSubmitQueue.test.ts` | 其他区域已有照片但浴室为空时，提交被拒绝并提示浴室照片 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/lib/inspectionPanelSubmitQueue.test.ts` |
| 自完成照片和完成门槛 | `mz-cleaning-app-frontend/src/screens/tasks/CleaningSelfCompleteScreen.test.tsx` | 清洁完成照片和提交门槛 | partial | `npm run test --prefix mz-cleaning-app-frontend -- src/screens/tasks/CleaningSelfCompleteScreen.test.tsx` |
| 补品拍摄、离线提交和状态反馈 | `mz-cleaning-app-frontend/src/screens/tasks/SuppliesFormScreen.test.tsx` | 本地照片、待同步、取消和失败解锁 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- src/screens/tasks/SuppliesFormScreen.test.tsx` |
| 检查完成页入口防护 | `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.test.tsx` | action 禁用、视频队列和待同步 | partial | `npm run test --prefix mz-cleaning-app-frontend -- src/screens/tasks/InspectionCompleteScreen.test.tsx` |
| 视频前置的本机照片门槛 | `mz-cleaning-app-frontend/src/lib/inspectionPanelSubmitQueue.test.ts` | 普通任务照片未完成时阻止视频；本机照片完成但弱网时允许视频入队 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/lib/inspectionPanelSubmitQueue.test.ts` |
| 完成页视频门槛与客人到达豁免入口 | `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.test.tsx` | 普通任务未完成照片时阻止进入视频；客人到达豁免后允许视频入队 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/screens/tasks/InspectionCompleteScreen.test.tsx` |
| 服务端客人到达豁免与视频门槛 | `backend/scripts/tests/test_cleaning_task_transition_guard.ts` | 客人到达豁免可提交空照片批次并完成视频状态门槛 | sufficient | `npm run test:cleaning-task-transition-guard --prefix backend` |
| 检查同步幂等 ID与历史队列迁移 | `mz-cleaning-app-frontend/src/lib/inspectionPanelSubmitQueue.test.ts` | 超长历史 `submit_id` 自动迁移；已有媒体上传成功时只重试失败的补品/检查业务保存步骤 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- --runInBand src/lib/inspectionPanelSubmitQueue.test.ts` |
| 后端保存接口共享幂等 ID上限 | `backend/scripts/tests/test_idempotency_submit_id_contract.ts` | cleaning-app、mzapp 的检查/补品/反馈保存接口使用共享 256 字符上限，不回退到旧 120 字符限制 | not-wired | `npm run test:idempotency-submit-id-contract --prefix backend` |

### 验证策略

- **backend 修改：** action/transition contract test。
- **mobile 修改：** 对应 screen test + mobile typecheck/lint；涉及队列时增加队列测试。
- **跨层修改：** 后端门槛、客户端显示/提交/刷新和通知入口。
- **发布前：** `npm run check:full`。

### 最后验证

- **CRL：** CRL-20260725-021
- **Commit：** not committed
- **日期：** 2026-07-25

### 相关 CRL

- CRL-20260723-006：弱网视频提交与检查照片完成状态解耦
- CRL-20260724-014：修复厨房照片连续拍摄卡住
- CRL-20260725-021：修复检查与补品保存的超长幂等 ID失败
- CRL-20260725-001：明确补品照片上传状态
- CRL-20260725-009：检查人员点击“已补充”自动打开相机
- CRL-20260725-010：检查照片新增浴室整体区域
- CRL-20260725-011：检查照片提交后的待挂钥匙状态与刷新稳定性修复
- CRL-20260725-012：浴室整体照片上限调整为三张
- CRL-20260725-013：检查面板客厅提示与同步状态位置调整
- CRL-20260725-016：客服退房状态同步到检查人员关联任务
- CRL-20260725-017：修复退房标记覆盖清洁与检查进行状态
- CRL-20260725-018：检查人员补充项新增入口区分本次与下次退房
- CRL-20260725-019：检查照片本机就绪后才允许视频并支持客人到达豁免
- CRL-20260725-020：检查页补品加载态与读取失败防止误判为空
- CRL-20260704-011：移动端检查照片弱网待同步修复

### 非保护范围

- 流程页面的颜色、间距和普通文案调整。
- 不改变提交门槛和状态结果的组件重构。

## FR-005：离线媒体上传、业务提交与本地清理

- **维护责任范围：** backend / mobile
- **最后审查日期：** 2026-07-25
- **状态：** active

### 业务保护规则

- 视频、检查照片、补品照片和反馈提交队列可以独立重试，单步失败不能抹掉已成功步骤。
- 业务记录未确认保存成功前，必须保留本地媒体和失败诊断。
- 已有远端引用且最终同步成功后，才允许清理本地媒体；缩略图生成失败不得误删原文件。
- 媒体类型、任务 ID 和提交动作必须保持正确关联，不能只凭本地预览判断业务保存成功。

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
| 补品提交队列和部分上传 | `mz-cleaning-app-frontend/src/lib/cleaningConsumablesSubmitQueue.test.ts` | 弱网入队、恢复、部分上传失败 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- src/lib/cleaningConsumablesSubmitQueue.test.ts` |
| 本地媒体引用和孤儿清理 | `mz-cleaning-app-frontend/src/lib/localMediaHousekeeping.test.ts` | 嵌套队列引用、旧且未引用文件 | sufficient | `npm run test --prefix mz-cleaning-app-frontend -- src/lib/localMediaHousekeeping.test.ts` |
| 媒体上传和本地/远端状态 | `mz-cleaning-app-frontend/src/lib/cleaningMedia.test.ts` | 上传失败、远端引用和重试 | partial | `npm run test --prefix mz-cleaning-app-frontend -- src/lib/cleaningMedia.test.ts` |
| 钥匙媒体队列 | `mz-cleaning-app-frontend/src/lib/keyUploadQueue.test.ts` | 钥匙照片入队和恢复同步 | partial | `npm run test --prefix mz-cleaning-app-frontend -- src/lib/keyUploadQueue.test.ts` |

### 验证策略

- **移动端队列修改：** 对应 queue test + mobile typecheck/lint。
- **后端媒体聚合修改：** 先做只读 payload/任务 ID 核对；涉及写测试时确认非生产数据库。
- **跨层修改：** 媒体类型、业务保存结果、客户端状态和本地清理顺序一起验证。
- **发布前：** `npm run check:full`，并单独记录未执行的真实设备/EAS 验证。

### 最后验证

- **CRL：** not yet
- **Commit：** not yet
- **日期：** not yet

### 相关 CRL

- CRL-20260704-011：移动端检查照片弱网待同步修复
- CRL-20260704-012：移动端本地媒体空间自动治理
- CRL-20260723-006：弱网视频提交与检查照片完成状态解耦
- CRL-20260724-010：任务详情展示补品填报照片与弱网状态
- CRL-20260725-008：移动端退房标记刷新保留与合并卡 payload 修复

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
| 通知默认模板与普通 cleaner 过滤 | `backend/scripts/tests/test_app_notification_policies.ts` | 挂钥匙/补品默认走检查参与人；普通 cleaner 被过滤；兼任检查员和未知账号保留 | sufficient | `npm run test:app-notification-policies --prefix backend` |
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
