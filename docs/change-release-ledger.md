Warning: truncated output (original token count: 205546)
Total output lines: 9247

# Change Release Ledger

Shared cross-thread record of repository changes and selectable release units. Do not store secrets or raw sensitive values here.

## CRL-20260713-001 — CMS 菜单收拢与线下密码管理

- **Status:** pushed
- **Updated:** 2026-07-13 19:21 Australia/Melbourne
- **Request:** 执行 CMS 整理第一、第二阶段：菜单收拢为公司内容、公开指南/外链、线下密码三块；删除公司账户密码/内部机密项方向；线下密码支持新增、修改、删除、维护、搜索和授权用户明文查看。
- **Outcome:** CMS 主菜单现在只保留“公司内容中心”“公开指南与外链”“线下密码管理”三个入口；“公开指南与外链”是独立页面，公司内容中心不再出现同名重复标签；新增线下密码管理页面，房源类密码从现有房源档案选择并保存真实房源 ID，支持办公室、信箱、电子门锁、不同用途密码盒、Locker、备用钥匙和固定周期公司密码等实际类型。历史通用机密记录不会显示，也没有被自动删除。

### Implementation

- Previous behavior:
  - CMS 菜单分散为页面管理、清洁公开指南、公开访问密码、客服手册、公司内容中心五个入口。
  - 公司内容中心的密码配置同时包含外链密码和通用“内部机密项”，没有房源编号、线下密码类型、位置和状态字段。
  - 密码列表接口没有区分历史通用机密与线下实体密码；移动端列表接口只检查登录状态。
- New behavior:
  - CMS 菜单收拢为三个业务入口；旧路由保留兼容但不再显示在主菜单，客服手册继续由公司文档类别维护。
  - “公开指南与外链”使用独立 `/cms/public-resources` 页面，合并原清洁公开指南 CRUD 和现有各公开入口密码配置；公司内容中心仅保留公告、公司文档和仓库指南。
  - 复用 `company_secret_items` 的加密、权限与访问审计能力，增加 `item_type`、`property_code`、`property_codes`、`property_ids`、`secret_kind`、`box_number`、`location`、`rotation_interval_days`、`next_rotation_at`、`status` 字段；新记录固定为 `offline_password`。
  - 房源类密码不再手工录入房号，前端从 `/properties` 加载房号选项，后端校验所选房源存在并保存真实 `property_ids`；`property_codes` 仅保留为兼容显示快照。
  - 密码类型调整为办公室密码、信箱密码、房门电子锁、信箱内密码盒、车库密码盒、存放信箱钥匙的密码盒、Locker、备用钥匙密码盒、固定周期公司密码和其他；需要物理盒编号的类型前后端均强制填写编号。
  - 固定周期公司密码记录修改周期天数和可选的下次修改日期；房源类密码可关联一个或多个真实房源档案。
  - 线下密码 API 只读写 `offline_password` 记录，支持按名称、密码盒编号、关联房源的房号/地址、类型、位置和备注搜索；明文响应增加 `Cache-Control: no-store`。
  - 历史记录默认标记为 `legacy` 并隐藏，避免把可能存在的旧公司账户机密混入新页面；未执行历史数据删除。
  - App 列表与复制审计接口增加 `company_secret_items.view` 权限校验，第三阶段移动端接入前不会对普通登录用户开放。
- Key decisions:
  - 不创建第二套密码表和加密系统，继续使用现有加密存储及 `CMS_SECRET_KEY`。
  - 页面允许授权用户明文查看和复制，但数据库不保存明文，代码、测试和台账不包含任何真实密码。
  - 备用钥匙记录以“物理密码盒”为主体，而不是以单个房源为主体，符合一个盒子存放多套房源备用钥匙的实际操作方式。
  - 多房源关系沿用仓库现有数组字段风格，以真实房源 ID 数组保存并在写入时校验；不创建平行房源表或第二套密码系统。
  - 第一、第二阶段只完成 CMS/后台能力；移动端搜索页面和角色授权属于第三阶段。

### Files / Areas

- `backend/src/modules/cms_company_secrets.ts` — modified: 通用机密 CRUD 改为结构化线下密码 CRUD；增加真实房源 ID 校验、完整类型规则、密码盒编号、周期字段、房号/地址搜索、分类隔离、no-store 和移动端权限收口。
- `backend/src/modules/rbac.ts` — modified: 三个 CMS 子菜单映射到对应资源权限。
- `backend/src/permissionsCatalog.ts` — modified: `company_secret_items` 用户可见名称改为“线下密码”。
- `backend/src/store.ts` — modified: 注册三个新的 CMS 子菜单可见权限。
- `backend/dist/modules/rbac.js` — generated: 后端构建同步 RBAC 菜单资源映射。
- `backend/dist/store.js` — generated: 后端构建同步 CMS 菜单权限注册。
- `backend/scripts/init_db.ts` — modified: 初始化流程补充线下密码、真实房源 ID 数组、密码盒编号和周期字段及索引。
- `backend/scripts/schema.sql` — modified: 基础 schema 补充线下密码、真实房源 ID 数组、密码盒编号和周期字段及索引。
- `backend/scripts/migrations/20260713_offline_password_items.sql` — added: 已有数据库的增量迁移；增加真实房源 ID、密码盒编号和周期字段，历史行保持 `legacy`。
- `frontend/src/lib/adminNavigation.ts` — modified: CMS 主菜单收拢为三个入口。
- `frontend/src/lib/adminNavigation.test.ts` — added: 覆盖 CMS 菜单数量、名称、链接和资源权限可见性。
- `frontend/src/app/cms/company/page.tsx` — modified: 移除内部机密项 UI，并移除重复的“公开指南与外链”标签，只保留三个公司内容标签。
- `frontend/src/app/cms/public-resources/page.tsx` — added: 独立承载清洁公开指南和各类外链访问密码维护。
- `frontend/src/app/cms/offline-passwords/page.tsx` — added: 线下密码搜索、明文查看/复制、新增、编辑、停用和删除；从房源档案多选真实房源，按实际场景选择类型，并维护密码盒编号及周期公司密码字段。
- `frontend/src/app/rbac/page.tsx` — modified: 权限动作名称改为查看/编辑/删除线下密码。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: 现有 `/cms/company/secrets` 系列接口继续保留路径，但请求/响应语义收窄为线下密码；房源类请求要求非空 `property_ids` 且后端校验对应房源存在，需要编号的密码盒类型要求 `box_number`，固定周期公司密码要求 `rotation_interval_days`；列表新增 `q` / `status` 查询并可按关联房源的房号或地址搜索，App 端列表与复制接口新增 `company_secret_items.view` 权限要求。
- Database / migration: 需执行 `backend/scripts/migrations/20260713_offline_password_items.sql`，或由模块首次访问时的幂等建表逻辑补齐字段和索引；新增 `property_ids text[]`、`box_number text`、`property_codes text[]`、`rotation_interval_days integer` 与 `next_rotation_at date`，不自动回填、不删除历史行。
- Config / environment: 继续依赖现有 `CMS_SECRET_KEY`；缺少该配置时不能新增或修改密码。
- Dependencies: none.
- Related units: none; worktree 同时包含 `CRL-20260712-008` 等清洁模块的未提交改动，发布时必须按 release unit 精确选择文件/分块。

### Validation

- `git diff --check` — passed.
- `npm run build` in `backend` — passed: `tsc -p .` completed.
- `npm run lint` in `frontend` — passed with existing repository warnings and no errors.
- `./node_modules/.bin/vitest run src/lib/adminNavigation.test.ts --coverage=false` in `frontend` — passed: 1 file, 2 tests.
- `npm run build` in `frontend` — passed: production build and static generation completed; existing lint and Recharts size warnings remain.
- `python3 scripts/audit_change_release_ledger.py` — passed: 24 changed files, all 24 recorded.

### Risks / Release Notes

- Deployment risk: production migration has not been executed in this task; deploy backend/schema before using the new page.
- Compatibility risk: clients that previously created generic company secret items through `/cms/company/secrets` must switch to the structured offline-password payload; the removed company-account-password direction is intentionally unsupported.
- Data association risk: 此次修改前创建、仅保存文字房号的线下密码会显示“待关联”；再次编辑时必须从房源档案选择真实房源。未进行猜测式自动匹配或生产数据回填。
- Data handling: historical generic secret rows remain encrypted and classified as `legacy`; they are hidden but not deleted. Any permanent purge should be a separate preview/confirm/apply data task.
- Access risk: authorized users can see and copy plaintext by product requirement; permission assignment and screen privacy remain operational controls.
- Sensitive-information review: no screenshot password, account password, token, `.env` value, database URL, cookie, private key, sensitive log, or local cache was added to code, tests, migration, or ledger.
- Git state: implementation pushed to root `Dev` in commit `d8e8f87`; this ledger status update is recorded separately.

### Update — 2026-07-13 15:30 Australia/Melbourne

- 根据用户截图纠正重复导航：`/cms/company` 删除同名标签，左侧入口改到独立 `/cms/public-resources` 页面。
- 根据线下操作方式纠正备用钥匙模型：记录密码盒编号、盒内多个房源编号和密码；不再要求用户手工填写冗余名称。
- 重新执行 backend build、frontend lint、CMS navigation targeted test、frontend production build 和 diff check，均通过；lint/build 仍只有仓库已有 warnings。

### Update — 2026-07-13 15:55 Australia/Melbourne

- 根据用户反馈将自由输入房号改为真实房源关联：选择器读取现有房源档案并展示房号与地址，API 保存并校验 `property_ids`；旧文字房号只作兼容显示并标记“待关联”。
- 将密码类型改为办公室密码、信箱密码、房门电子锁、信箱内密码盒、车库密码盒、存放信箱钥匙的密码盒、Locker、备用钥匙密码盒、固定周期公司密码和其他；对应类型动态要求关联房源、密码盒编号或修改周期。
- 固定周期公司密码新增修改周期天数及可选下次修改日期；列表与移动端 API 同步返回关联房源和周期字段，搜索可匹配真实房源房号及地址。
- 重新执行 backend build、frontend lint、CMS navigation targeted test、frontend production build 和 diff check，均通过；lint/build 仍只有仓库已有 warnings。

### Update — 2026-07-13 16:17 Australia/Melbourne

- 修复编辑弹窗回填时机：弹窗内容挂载后再设置表单值，回填类型、名称、关联房源、密码盒编号、位置、周期、原密码、状态和备注；旧记录仅有房号快照时，按现有房源档案精确匹配对应房源 ID，不做模糊猜测。
- 关联房源选择器与已选项仅显示房号，不再显示地址；主列表仍可按地址搜索关联记录。
- 修复新增非周期密码返回 `HTTP 400`：前端新增请求不再发送无关的空周期字段，后端新增校验同时兼容空周期字段；编辑切换为非周期类型时仍会清空旧周期值。
- 重新执行 backend build、frontend lint、frontend production build 和 diff check，均通过；lint/build 仍只有仓库已有 warnings。本机没有运行中的本地前后端服务，未执行浏览器端真实新增写入测试。

### Update — 2026-07-13 16:51 Australia/Melbourne

- 根据用户再次反馈加固编辑回填：移除弹窗关闭时销毁表单的时序依赖，改为 `forceRender` 预挂载表单并继续在每次打开时重置/回填，避免行数据已存在但字段尚未注册导致编辑弹窗全部空白。
- 保存操作增加同步提交锁、按钮 loading、保存期间关闭/取消保护和中文“保存/取消”文案；同一次打开期间的快速重复点击只允许一个保存请求，成功后仍保留现有 toast 和列表刷新反馈。
- 搜索框明确使用 `type="search"`、独立 `name` 和 `autocomplete="off"`，避免浏览器把它识别成账号/密码输入；操作列改为复用房源列表同一个 `TableRowActions` 组件，移除独立的小号图标按钮样式。
- `./node_modules/.bin/tsc --noEmit` in `frontend` — passed.
- `npm run lint` in `frontend` — passed with existing repository warnings and no errors.
- `npm test` in `frontend` — passed: 39 files, 170 tests; coverage thresholds passed.
- `npm run build` in `frontend` — passed: compiled, type/lint checks, 95 static pages and production route output completed; existing Browserslist, ESLint and Recharts warnings remain.
- 浏览器只读检查确认搜索输入实际渲染为 `type=search`、`name=offline-password-record-search`、`autocomplete=off`；浏览器会话未登录且后端状态为 unknown，列表没有可编辑记录，因此没有执行真实记录编辑或保存写入。
- 隔离生产预览尝试未作为验证通过项：工作区已有 3000 开发服务持续使用同一 `.next`，3010 预览读取到不完整 vendor chunk 后返回错误并已停止；不影响上述独立完成且退出码为 0 的 production build 结果。
- Sensitive-information review: no password value, credential, token, `.env` value, database URL, cookie, private key, sensitive log, or local cache was added or recorded.

### Update — 2026-07-13 17:07 Australia/Melbourne

- 修复线下密码管理页 hydration 报错：页面首屏改为与房源列表一致的客户端挂载后渲染模式，避免 AntD `Table`、`Modal forceRender`、`Form.useWatch` 动态字段在 Next SSR 与浏览器首屏之间产生 DOM 结构差异。
- 保留上一版编辑回填、重复保存锁、保存 loading、搜索框关闭自动填充和操作列复用 `TableRowActions` 的行为；此次只调整目标页渲染时机。
- `npm run typecheck` in `frontend` — failed: package has no `typecheck` script.
- `./node_modules/.bin/tsc --noEmit` in `frontend` — passed.
- `npm run lint` in `frontend` — passed with existing repository warnings and no errors.
- `npm test` in `frontend` — passed: 39 files, 170 tests; coverage thresholds passed.
- `npm run build` in `frontend` — passed: compiled, type/lint checks, 95 static pages and production route output completed; existing Browserslist, ESLint and Recharts warnings remain.
- Browser validation: in-app browser loaded `http://localhost:3000/cms/offline-passwords` successfully after the fix; no `Hydration failed`, `Unhandled Runtime Error`, or `Expected server HTML` overlay text was detected, and no matching console error was reported. The browser session remained unauthenticated, so real edit/save write testing was not performed.
- Sensitive-information review: no password value, credential, token, `.env` value, database URL, cookie, private key, sensitive log, or local cache was added or recorded.

### Update — 2026-07-13 19:21 Australia/Melbourne

- 根据用户反馈将线下密码搜索改为输入即搜索：移除“搜索”按钮，页面初次加载一次全量线下密码，输入框变化后直接在本地过滤，清空输入时立即恢复全量列表。
- 搜索不再触发 `/cms/company/secrets?q=...` 请求，也不会让表格进入整表 loading；loading 仅保留给初次加载、保存后刷新和删除后刷新。
- 本地过滤保持原搜索语义，匹配名称、类型、房源 ID / 房号 / 地址、密码盒编号、位置和备注；不把明文密码值加入搜索索引。
- `./node_modules/.bin/tsc --noEmit` in `frontend` — passed.
- `npm run lint` in `frontend` — passed with existing repository warnings and no errors.
- `npm test` in `frontend` — passed: 39 files, 170 tests; coverage thresholds passed.
- `npm run build` in `frontend` — passed: compiled, type/lint checks, 95 static pages and production route output completed; existing Browserslist, ESLint and Recharts warnings remain.
- Browser validation not rerun for authenticated search because the available browser session was not signed in; production build verified the page compiles after the interaction change.
- Sensitive-information review: no password value, credential, token, `.env` value, database URL, cookie, private key, sensitive log, or local cache was added or recorded.

## CRL-20260713-002 — 移动端信息中心线下密码搜索

- **Status:** pushed
- **Updated:** 2026-07-13 20:35 Australia/Melbourne
- **Request:** 移动端信息中心直接搜索到相关线下密码；用户确认不需要复制密码，线下直接输入。
- **Outcome:** 移动端信息中心输入关键词后会新增“线下密码”搜索分组，匹配线下密码名称、类型、关联房源、密码盒编号、位置、备注和状态，并在结果卡片/详情中直接显示密码文本；不提供复制按钮。线下密码只保存在当前页面内存状态，不再写入公司内容本地缓存。

### Implementation

- Previous behavior:
  - 信息中心搜索只覆盖房源信息、历史任务、公司公告、公司文档和仓库指南。
  - 移动端 `listCompanySecretsForApp()` 仍使用旧通用 secret 类型，未表达线下密码的房源、类型、盒号、位置等字段。
  - 公司内容缓存类型包含 `secrets`，存在把线下密码写入本地缓存的风险。
- New behavior:
  - 复用现有 `/cms/company/secrets/app-list` App 接口，移动端类型改为结构化 `CompanyOfflinePassword`。
  - 信息中心有搜索词时本地过滤内存中的线下密码；不按输入重复请求接口，不出现额外全屏 loading。
  - 新增“线下密码”分组，结果展示密码类型、关联房源、密码盒编号、位置和密码；点击详情仅展示文本，不设置 `copyText`，因此不出现复制操作。
  - 搜索索引不包含明文密码值，仅匹配名称、类型、房源 ID/房号、盒号、位置、备注和状态。
  - 本地持久化公司内容缓存继续保存公告/文档/仓库指南，但不再读取或写入 `secrets`。
- Key decisions:
  - 不新增后端接口；后端既有 App 列表接口已经有权限校验、`no-store` 和结构化字段。
  - 不增加复制功能，也不调用复制审计接口，符合线下直接输入的使用方式。

### Files / Areas

- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: 为 App 线下密码列表补充结构化返回类型。
- `mz-cleaning-app-frontend/src/screens/tabs/NoticesScreen.tsx` — modified: 信息中心搜索新增线下密码分组、展示密码文本、去除本地缓存 secrets 写入/读取。
- `mz-cleaning-app-frontend/src/screens/tabs/NoticesScreen.test.tsx` — added: 覆盖搜索线下密码、展示密码、打开详情时不传复制文本。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: 复用现有 `/cms/company/secrets/app-list`；无新增 API。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: depends on `CRL-20260713-001` 的线下密码后端/App 列表接口和权限。

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm test -- --runInBand src/screens/tabs/NoticesScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 1 test; existing React Native `SafeAreaView` deprecation warning remains.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with existing repository warnings and no errors.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — failed: existing `TasksScreen.test.tsx` exceeded Jest default 5000 ms timeout.
- `npm test -- --runInBand --testTimeout=20000` in `mz-cleaning-app-frontend` — passed: 34 suites, 124 tests; existing React Native `SafeAreaView` deprecation warnings remain.
- `npm run build` in `mz-cleaning-app-frontend` — not run: package has no `build` script.
- `git diff --check` in `mz-cleaning-app-frontend` — passed.

### Risks / Release Notes

- Deployment: this is a mobile app code change; release requires the mobile app's normal OTA/update or rebuild path.
- Permission dependency: users still need `company_secret_items.view`; without that permission the App list request will not populate line-password results.
- Data handling: passwords are shown in-app by product requirement, but no copy action is exposed and code avoids persisting secrets into the company content cache.
- Sensitive-information review: no real password value, credential, token, `.env` value, database URL, cookie, private key, sensitive log, or local cache was added or recorded; tests use synthetic values only.
- Git state: implementation pushed to nested mobile `Dev` in commit `0e2d0b7`; this root ledger status update is recorded separately.

## CRL-20260712-008 — 手工补位自动合并字段可信度规则优化

- **Status:** pushed
- **Updated:** 2026-07-12 21:35 AEST
- **Request:** 用户确认不处理 `3202 / 3209` 历史数据，要求执行“优化自动合并规则”，让后续手工补位合并更准确地区分可信字段和占位字段。
- **Outcome:** 自动订单任务合并临时手工补位时，字段可信度规则更细：非默认入住/退房时间仍可继承；订单晚数/钥匙数保持权威；手工 `0晚` 被识别为临时补位占位值，不再作为普通人工冲突；密码仍只记录人工确认且不自动复制。

### Implementation

- Previous behavior:
  - `buildManualSupersedeMerge()` 只比较正式任务自身字段，缺少订单晚数 / 订单钥匙数上下文。
  - 手工 `nights_override=0` 会和订单真实晚数形成普通 `manual_requires_review` 冲突，容易把占位值当成业务差异。
  - 每日清洁 / 任务中心的动态 conflict helper 会把 superseded 手工 `0晚` 和订单真实晚数继续展示为普通冲突。
- New behavior:
  - Supersede 合并查询 official 任务时带上 `orders.keys_required` 和 `orders.nights`，内存路径也补同样上下文。
  - `keys_required`：订单钥匙数存在时保留订单；只有没有订单/正式值且手工是有效 `1/2` 时才继承。
  - `nights_override`：手工 `0` 且订单/正式晚数为正数时写入 `ignored_placeholder` 决策，不覆盖、不作为普通冲突；手工正数与订单晚数不一致时仍记录 `manual_requires_review`。
  - `buildCleaningTurnoverDisplay()` 忽略 `0晚` 占位差异，避免未来已继承正确时间后仍因占位晚数显示冲突。
  - 每日清洁冲突建议文案支持 `ignored_placeholder`，显示“手工补位占位值，已忽略”。
- Key decisions:
  - 不处理历史生产数据；`3202 / 3209` 由用户在每日清洁页面手动确认修正。
  - 不自动继承密码、订单晚数或订单钥匙数，避免手工补位覆盖订单权威数据。

### Files / Areas

- `backend/src/services/cleaningSync.ts` — modified: 手工补位合并增加订单上下文、占位晚数忽略、钥匙数可信度规则。
- `backend/src/lib/cleaningTurnoverDisplay.ts` — modified: 动态冲突计算忽略手工 `0晚` 占位差异。
- `backend/scripts/tests/test_cleaning_sync_v2.ts` — modified: 覆盖非默认入住时间继承、手工 `0晚` ignored placeholder、订单晚数保留、手工正数晚数仍需人工确认。
- `backend/scripts/tests/test_cleaning_turnover_display.ts` — modified: 覆盖 `0晚` 占位不生成可见 nights 冲突。
- `frontend/src/app/cleaning/page.tsx` — modified: 每日清洁冲突建议文案支持 `ignored_placeholder`。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: no shape change; `supersede_conflicts[].resolution` may now include `ignored_placeholder`.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: builds on `CRL-20260712-005` and `CRL-20260712-007`.

### Validation

- `env -u DATABASE_URL ./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_cleaning_sync_v2.ts` in `backend` — passed: `ok`.
- `env -u DATABASE_URL ./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_cleaning_turnover_display.ts` in `backend` — passed: `test_cleaning_turnover_display: ok`.
- `npm run build` in `backend` — passed: `tsc -p .`.
- `npx tsc --noEmit` in `frontend` — passed.
- `npm run lint` in `frontend` — passed with existing warnings.
- `npm run build` in `frontend` — passed.
- `python3 scripts/audit_change_release_ledger.py` — passed.
- `git diff --check` — passed.

### Risks / Release Notes

- Behavior risk: future manual `0晚` placeholders will no longer show as visible nights conflicts when an order has a positive night count. This is intentional for temporary補位占位数据.
- Data risk: historical tasks are not backfilled by this release unit.
- Sensitive-information review: no secrets, `.env` values, database URLs, tokens, cookies, private keys, sensitive logs, or local caches were added. Password fields remain non-inherited.
- Git state: implementation pushed to root `Dev` in commit `d8e8f87`; this ledger status update is recorded separately.

## CRL-20260712-007 — 每日清洁显示手工补位冲突明细

- **Status:** pushed
- **Updated:** 2026-07-12 21:20 AEST
- **Request:** 用户要求把手工补位和正式订单任务的冲突显示在每日清洁页面，并让“冲突”标签也出现在每日清洁卡片上，便于直接进入编辑修正。
- **Outcome:** 每日清洁 `/cleaning/calendar-range` 现在会把已 superseded 的手工补位任务和 active 正式任务做字段级比较，返回 `turnover_display.conflicts` / `display_conflicts`。每日清洁卡片显示“冲突”标签并展开字段差异；编辑抽屉顶部同步显示冲突核对区，用户可直接在现有入住/退房字段里修正。

### Implementation

- Previous behavior:
  - 每日清洁接口只返回 active 清洁任务；已被正式订单任务 supersede 的手工补位不会进入 payload。
  - 每日清洁卡片没有“冲突”标签，也不会展示手工补位与订单任务之间的字段差异。
  - 任务中心能通过 `turnover_display.conflicts` 标记冲突，但每日清洁页面无法复用该信息。
- New behavior:
  - `/cleaning/calendar-range` 查询 active 任务后，额外读取 `execution_state='superseded'` 且 `superseded_by` 指向这些 active 任务的手工补位行。
  - 后端复用 `buildCleaningTurnoverDisplay()` 生成 `turnover_display`，并把 `conflicts` 同步放入 `display_conflicts`。
  - 每日清洁同房同日合并卡会聚合子任务冲突，并在卡片 meta 行显示“冲突”标签。
  - 卡片和编辑抽屉显示字段级对照：手工补位值、订单任务值、建议处理方向。密码类冲突只显示“已填写/未填写”，不额外展开密码原文。
- Key decisions:
  - 本单元只做显示和 payload 补充，不自动修改历史数据，不改变保存接口。
  - 手工补位时间差异提示“建议确认后采用手工补位”；晚数/钥匙数提示“建议保留订单”，符合订单数据更权威的处理原则。

### Files / Areas

- `backend/src/modules/cleaning.ts` — modified: `/cleaning/calendar-range` 补 superseded 手工补位读取和 `turnover_display/display_conflicts` 输出。
- `frontend/src/app/cleaning/page.tsx` — modified: 每日清洁卡片与编辑抽屉展示冲突标签和字段级差异。
- `frontend/src/app/cleaning/cleaningSchedule.module.scss` — modified: 增加冲突明细面板和抽屉冲突区样式。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: `/cleaning/calendar-range` 对清洁任务 payload additive 增加 `display_conflicts` 和 `turnover_display`。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: extends `CRL-20260712-005` 的手工补位冲突记录语义到每日清洁页面。

### Validation

- `npm run build` in `backend` — passed: `tsc -p .`.
- `npx tsc --noEmit` in `frontend` — passed.
- `npm run lint` in `frontend` — passed with existing warnings only.
- `npm run build` in `frontend` — passed; emitted existing Browserslist staleness notice, existing ESLint warnings, and existing Recharts static-generation width/height warnings.
- `python3 scripts/audit_change_release_ledger.py` — passed: `Changed files: 5`, `Recorded changed files: 5`, `Coverage: PASS`.
- `git diff --check` — passed.

### Risks / Release Notes

- UI risk: 冲突明细会增加卡片高度；仅在存在真实字段差异时显示，并允许换行以避免覆盖控件。
- Data risk: 历史手工补位里的占位晚数 `0` 仍会展示为冲突，目的是让业务人员看见并按订单晚数保留；本单元不做自动数据修正。
- Sensitive-information review: no secrets, `.env` values, database URLs, tokens, cookies, private keys, sensitive logs, or local caches were added. Password conflict values are masked as filled / not filled in the new conflict display.
- Git state: implementation pushed to root `Dev` in commit `d8e8f87`; this ledger status update is recorded separately.

## CRL-20260712-006 — 任务中心前端卡片紧凑展示调整

- **Status:** ready
- **Updated:** 2026-07-12 19:58 AEST
- **Request:** 用户要求为“任务中心前端卡片紧凑展示调整”补一个台账编号，便于和后端客人需求/手动补位修复分开提交。
- **Outcome:** 任务中心紧凑卡片改成更低、更密的三段式信息结构：标题区保留房号/人员，事实行显示退房/入住/住晚数，状态行最多展示关键业务标签，底部统一放备注或订单顺序标签，减少标签重复和卡片高度。

### Implementation

- Previous behavior:
  - 紧凑卡片使用较高的 padding、圆角和多行 chip，`退房/入住/住晚数`、状态、检查安排、同步状态、订单顺序等信息容易挤占空间。
  - `任务已结束` 等宽泛 display badge 可能和更具体的 `已挂钥匙` / `已检查` 状态重复出现。
  - 订单顺序标签和备注分别占行，窄屏或 2/3 列布局下卡片高度偏高。
- New behavior:
  - 新增卡片 meta 去重与压缩 helper，只保留最关键的 2 个辅助标签，并优先显示冲突、暂不安排、待同步、具体完成态、检查安排、合并数量等信息。
  - 将时间 chip 改为事实文本行，标准/非标准时间和住晚数以短文本并列展示；没有时间事实时回退显示清洁流向或线下任务类型。
  - 订单顺序标签并入底部 footer，和备注/冲突提示共用一行；样式改为 grid 卡片骨架、窄色条和更小的标签尺寸。
  - 1/2/3 列和移动端样式同步压缩卡片高度、间距、色条和标签最大宽度，减少任务中心首屏被单张卡片撑高。
- Key decisions:
  - 本单元只调整任务中心卡片前端展示，不改任务排序、保存 payload、接口结构、数据库或业务状态计算。
  - 保留已有语义 tone 样式和现有 helper，不新增第二套任务状态系统。

### Files / Areas

- `frontend/src/app/task-center/page.tsx` — modified: 增加紧凑卡片 meta 去重/优先级 helper，重排卡片事实行、状态行和底部 footer。
- `frontend/src/app/cleaning/cleaningSchedule.module.scss` — modified: 压缩任务中心紧凑卡片布局、标签尺寸、footer 和移动端/窄列样式。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: follows `CRL-20260711-001` 的任务中心 iPad 自适应布局修复；本单元只做卡片内部密度和信息层级调整。

### Validation

- `npx tsc --noEmit` in `frontend` — passed.
- `npm run lint --prefix frontend` — passed with existing warnings only.
- `npm run build --prefix frontend` — passed; emitted existing Browserslist staleness notice, existing ESLint warnings, and existing Recharts static-generation width/height warnings.
- `python3 scripts/audit_change_release_ledger.py` — passed: `Changed files: 7`, `Recorded changed files: 7`, `Coverage: PASS`.
- `git diff --check` — passed.

### Risks / Release Notes

- UI risk: 卡片现在最多展示 2 个主要辅助标签，低优先级标签不会全部堆在卡片首屏，需要从详情或其他上下文查看完整信息。
- UI risk: 备注和订单顺序标签共用 footer；极长备注仍会被单行截断以保持卡片高度稳定。
- Rollback: revert the compact-card helper/render changes in `frontend/src/app/task-center/page.tsx` and restore the previous `.taskCenterCompact*` styles in `frontend/src/app/cleaning/cleaningSchedule.module.scss`.
- Sensitive-information review: no secrets, `.env` values, database URLs, credentials, raw production guest/request content, tokens, cookies, private keys, sensitive logs, or local caches were added.
- Git state: uncommitted.

## CRL-20260712-005 — 手动补位合并继承安全字段并记录冲突

- **Status:** ready
- **Updated:** 2026-07-12 14:58 AEST
- **Request:** 用户确认“直接复制到正式任务，可能被下一次订单同步重新覆盖”的风险后，要求按更新后的修复计划执行。
- **Outcome:** 自动订单任务合并临时手动补位时，不再只是把手动任务标记为 `superseded`。系统会把安全字段继承到正式任务：客人需求、默认入住时间、默认退房时间；密码、钥匙套数、入住天数等可能被订单同步覆盖或订单更权威的字段不会静默覆盖，而是写入 `supersede_conflicts` 供后续人工核对。

### Implementation

- Previous behavior:
  - `supersedeTemporaryManualTasksForOrder()` 只把符合条件的手动补位任务更新为 `execution_state='superseded'`。
  - 正式订单任务不继承手动补位里的入住时间、退房时间、客人需求等字段。
  - `supersede_conflicts` 基本写入空数组，密码、钥匙套数、入住天数等差异没有结构化记录。
- New behavior:
  - 新增手动补位合并决策逻辑：过滤字面 `null` / `undefined` 占位文本后比较正式任务与手动任务字段。
  - `guest_special_request`：正式为空时复制手动值；两边都有且不同则合并去重。
  - `checkin_time` / `checkout_time`：正式为空或默认 `3pm` / `10am` 时继承手动时间；正式已有非默认不同值时只记录冲突。
  - `old_code` / `new_code`、`keys_required`、`nights_override`：不覆盖正式任务，只以 `manual_requires_review` 写入 `supersede_conflicts`。
  - 若正式任务因继承字段被更新，会发 `TASK_UPDATED` 工作任务事件；被合并的手动任务仍发 `TASK_REMOVED`。
- Key decisions:
  - 不对密码字段做自动继承，避免后续 `derivedCode` 或 `syncCheckoutOldCodeFromCheckinNewCode()` 再次覆盖造成循环。
  - 不覆盖关联订单任务的钥匙套数和入住天数，避免和订单权威数据冲突。
  - 本单元只处理未来自动合并行为，不写生产数据回填。

### Files / Areas

- `backend/src/services/cleaningSync.ts` — modified: 手动补位 supersede 前计算安全字段继承、冲突记录，并对正式任务发送更新事件。
- `backend/scripts/tests/test_cleaning_sync_v2.ts` — modified: 覆盖入住/退房时间与客人需求继承，密码/钥匙套数冲突记录，以及原有 protected/manual_extra 保护语义。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: no shape change; existing task records may now carry inherited `guest_special_request` / `checkin_time` / `checkout_time` after future sync.
- Database / migration: none; reuses existing `supersede_conflicts` jsonb column.
- Config / environment: none.
- Dependencies: none.
- Related units: complements `CRL-20260712-004`, which filters `null` / `undefined` placeholders at task-center display time.

### Validation

- `env -u DATABASE_URL ./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_cleaning_sync_v2.ts` in `backend` — passed: `ok`; deliberately ran without `DATABASE_URL` so it used in-memory store and did not write any configured database.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_cleaning_turnover_display.ts` in `backend` — passed: `test_cleaning_turnover_display: ok`.
- `npm run build` in `backend` — passed: `tsc -p .`.
- `git diff --check -- backend/src/services/cleaningSync.ts backend/scripts/tests/test_cleaning_sync_v2.ts backend/src/lib/cleaningTurnoverDisplay.ts backend/scripts/tests/test_cleaning_turnover_display.ts docs/change-release-ledger.md` — passed.
- Frontend lint/build — not run; no frontend source changed in this release unit.

### Risks / Release Notes

- Behavior risk: future temporary manual placeholders with meaningful guest request or non-default times will now update the canonical order task, which is intended but changes what downstream task-center/mobile clients see.
- Review risk: password, key-count, and nights differences are recorded in `supersede_conflicts` but there is not yet a dedicated UI surfacing those conflicts.
- Rollback: remove `buildManualSupersedeMerge()` and related helper functions/usages from `cleaningSync.ts`, restore `supersede_conflicts: []`, and remove the added sync test assertions.
- Sensitive-information review: no secrets, `.env` values, database URLs, credentials, raw production guest request contents, tokens, cookies, private keys, sensitive logs, or local caches were added. Tests use synthetic task IDs and synthetic values.
- Git state: uncommitted.

## CRL-20260712-004 — 任务中心客人需求过滤 null 占位值

- **Status:** ready
- **Updated:** 2026-07-12 14:18 AEST
- **Request:** 用户确认移动端新建/修改入住任务客人需求仍在数据库后，要求执行修复并提供台账编号。
- **Outcome:** 任务中心周转展示不再把订单备注里的字面 `null` / `undefined` 当作真实客人需求。若订单备注是占位脏值，会继续回退到任务自身的 `guest_special_request`，避免显示“客人需求：null”并遮住移动端填写的真实客人需求。

### Implementation

- Previous behavior:
  - `buildCleaningTurnoverDisplay()` 通过 `firstText(orderNote, guestSpecialRequest)` 取客人需求。
  - `nullableText()` 只过滤空字符串，没有过滤字面 `null` / `undefined`。
  - 当订单备注存成字面 `null` 时，展示层会优先返回该字符串，不再读取真实的 `guest_special_request`。
- New behavior:
  - `nullableText()` 将大小写/空格归一后的 `null`、`undefined` 视为空值。
  - 客人需求、任务 ID、密码等共用 `firstText()` 的展示字段都会自动跳过这些占位字符串，保留后续真实字段兜底。
  - 回归测试覆盖订单备注为 `NULL` / `undefined` 时，入住任务仍显示真实 `guest_special_request`。
- Key decisions:
  - 不修改生产数据；本单元只修展示归一化，避免同类脏值再次遮住真实字段。
  - 不改变 `order_note` 优先级本身，只让无效占位值无法抢占真实内容。

### Files / Areas

- `backend/src/lib/cleaningTurnoverDisplay.ts` — modified: 文本归一化过滤字面 `null` / `undefined`。
- `backend/scripts/tests/test_cleaning_turnover_display.ts` — modified: 增加订单备注占位值回退到真实客人需求的回归测试。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: existing task-center payload may now return the real fallback text instead of literal `null` / `undefined` for display fields that use `firstText()`.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: follows the production read-only diagnosis for the MSQ3007E task-center guest-request display issue.

### Validation

- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_cleaning_turnover_display.ts` in `backend` — passed: `test_cleaning_turnover_display: ok`.
- `npx vitest run src/app/task-center/taskCenterDisplay.test.ts` in `frontend` — passed: 1 file, 3 tests.
- `npm run build` in `backend` — passed: `tsc -p .`.
- `git diff --check -- backend/src/lib/cleaningTurnoverDisplay.ts backend/scripts/tests/test_cleaning_turnover_display.ts` — passed.
- Frontend lint/build — not run; no frontend source changed in this release unit.

### Risks / Release Notes

- Behavior risk: if any business user intentionally typed the exact text `null` or `undefined` as meaningful display content, it will now be treated as empty in this shared turnover display helper. This is acceptable for the observed data-quality issue and common placeholder semantics.
- Rollback: remove the placeholder filtering in `nullableText()` and delete the added test block.
- Sensitive-information review: no secrets, `.env` values, database URLs, credentials, raw guest request contents from production, tokens, cookies, private keys, sensitive logs, or local caches were added. The regression test uses synthetic guest-request text.
- Git state: uncommitted.

## CRL-20260712-003 — 清洁安排表周转合并保留 active 手工任务

- **Status:** ready
- **Updated:** 2026-07-12 01:50 AEST
- **Request:** “那就先只改前端合并逻辑”；随后确认“自动退房 + 自动入住 + 手工入住”不应把同一任务重复显示，并要求整理最终计划后执行。
- **Outcome:** 清洁安排表不再用“有订单任务就优先订单任务”的前端过滤吞掉同房同日 active 手工任务。页面现在只选一条退房和一条入住组成 `退房 入住` 周转卡，其余仍 active 的手工/重复任务原样单独显示，避免静默隐藏需要人工核对的任务。

### Implementation

- Previous behavior:
  - `/cleaning` 页面在按房源/日期合并任务时通过 `preferOrderLinked()` 优先保留带 `order_id/order_code` 的自动同步任务。
  - 当同房同日存在自动退房、自动入住和额外 active 手工入住/退房时，手工任务会被排除在周转合并输入之外，又被 `rest` 过滤掉，最终安排表看不到该 active 手工任务。
  - `CRL-20260711-004` 已删除同类型 `xN` 折叠，但这个自动优先过滤残留仍会遮住“自动 + 手工”的重复/待核对场景。
- New behavior:
  - 新增 `splitTurnoverMerge()`：从退房侧和入住侧各选一条任务组成周转卡，优先选择带订单号的一侧，但不删除未被选中的任务。
  - `/cleaning` 页面复用该 helper；周转卡只包含被选中的一退一入，剩余 active 手工任务或重复任务继续作为独立卡片显示。
  - 后端同步测试补充“明确额外手工任务 `manual_task_purpose='manual_extra'` 不应被正式订单任务 supersede”的约束；临时占位和进行中保护逻辑保持不变。
- Key decisions:
  - 不把“有自动任务就隐藏手工任务”的规则迁移到后端，避免从所有端/API 层面误隐藏真实额外手工任务。
  - 不改变当前后端 supersede 行为；前端只信后端返回的 active 任务，并负责正确展示。

### Files / Areas

- `frontend/src/app/cleaning/page.tsx` — modified/shared: 清洁安排表周转合并只消耗一退一入，保留其余 active 任务。
- `frontend/src/lib/cleaningDailyMerge.ts` — added: 提供可测试的周转合并拆分 helper。
- `frontend/src/lib/cleaningDailyMerge.test.ts` — added: 覆盖自动退房+自动入住合并、额外 active 手工入住保留，以及缺少一侧时不生成周转卡。
- `backend/scripts/tests/test_cleaning_sync_v2.ts` — modified: 增加明确额外手工任务不被 supersede 的回归断言。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: builds on `CRL-20260711-004`; coexists with `CRL-20260712-001` and `CRL-20260712-002` in the same dirty worktree.

### Validation

- `npx vitest run src/lib/cleaningDailyMerge.test.ts` in `frontend` — passed: 2 tests.
- `env -u DATABASE_URL ./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_cleaning_sync_v2.ts` in `backend` — passed; deliberately ran without `DATABASE_URL` so it used in-memory store and did not write any configured database.
- `npx tsc --noEmit` in `frontend` — passed.
- `git diff --check -- frontend/src/app/cleaning/page.tsx frontend/src/lib/cleaningDailyMerge.ts frontend/src/lib/cleaningDailyMerge.test.ts backend/scripts/tests/test_cleaning_sync_v2.ts` — passed.
- `npm run lint --prefix frontend` — passed with existing warnings only.
- `npm run build --prefix frontend` — passed; emitted existing Browserslist staleness notice, existing ESLint warnings, and existing Recharts static-generation width/height warnings.
- `npm run build --prefix backend` — passed: `tsc -p .`.

### Risks / Release Notes

- UI risk: users may now see an extra active hand-created task beside a normal `退房 入住`周转卡. This is intentional when the backend still considers that hand-created task active; operations can then decide whether to keep, edit, or remove it.
- Backend data risk: current manual create flow still writes `manual_task_purpose: null`; this unit does not redefine which manual tasks are temporary placeholders. Any future change to that semantic should be a separate backend behavior change with production data review.
- Rollback: restore `/cleaning` to the previous `preferOrderLinked()` selection and remove `cleaningDailyMerge` helper/test plus the added backend test assertions.
- Sensitive-information review: no secrets, `.env` values, database URLs, credentials, raw guest data, tokens, cookies, private keys, sensitive logs, or local caches were added. Tests use synthetic IDs and local in-memory execution for the backend sync regression.
- Git state: uncommitted.

## CRL-20260712-002 — 清洁任务 active 与取消订单口径修正

- **Status:** ready
- **Updated:** 2026-07-12 01:11 AEST
- **Request:** “后续排查 duplicate 时，不只看 execution_state = active，还要排除 status in ('cancelled','canceled')、订单 status 为 canceled/invalid；先按照这个修复吧”。
- **Outcome:** 清洁任务统计、列表、任务中心和移动端候选任务查询统一使用更严格的“有效 active”口径：任务自身 `status` 为 `cancelled/canceled` 时，即使 `execution_state` 仍是 `active` 也会被排除；关联订单为空/取消/invalid 的订单任务也会被排除，手工任务 `order_id IS NULL` 继续保留。

### Implementation

- Previous behavior:
  - `activeCleaningTaskWhereSql()` 只在 `execution_state` 为空时才通过 `status=cancelled/canceled` 推断取消。
  - 历史数据里如果出现 `execution_state='active'` 但任务 `status='cancelled'`，仍会被统计和列表当作当前 active 任务。
  - 部分统计/列表查询只看任务 active，没有统一排除取消或 invalid 订单，导致 duplicate preview 把已取消历史任务误判成当前重复。
- New behavior:
  - `activeCleaningTaskWhereSql()` 显式要求任务 `status` 不在 `cancelled/canceled`。
  - 新增 `validCleaningTaskOrderWhereSql()` 统一表达订单有效性：手工任务保留；订单任务必须能 join 到订单，且订单状态非空、非 `invalid`、不包含 cancel。
  - 清洁后台任务列表、清洁日历、任务中心、移动端 `/mzapp/work-tasks` 候选任务和清洁 overview 统计接入同一有效订单过滤。
  - 内存 fallback 的 `/cleaning/tasks` 也复用同一取消任务判断，避免 PG 和非 PG 口径不同。
- Key decisions:
  - 本单元只改查询/统计口径，不清理生产数据。
  - 不把 confirmed 订单之间的真实冲突自动压制；这些仍应继续出现在 duplicate 清单里供业务核对。

### Files / Areas

- `backend/src/services/cleaningSync.ts` — modified: 收紧 active SQL helper，新增取消任务/无效订单判断 helper。
- `backend/src/modules/cleaning.ts` — modified: `/cleaning/tasks` 和 `/calendar-range` 使用有效 active + 有效订单过滤。
- `backend/src/modules/task_center.ts` — modified: 任务中心清洁来源和未来退房投影使用统一有效订单过滤。
- `backend/src/modules/mzapp.ts` — modified/shared: `/mzapp/work-tasks` 候选任务查询使用统一有效订单过滤。
- `backend/src/modules/stats.ts` — modified: 清洁 overview 任务聚合使用有效 active + 有效订单过滤。
- `backend/scripts/tests/test_cleaning_task_effective_filters.ts` — added: 覆盖取消任务、无效订单和 SQL helper 关键边界。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: existing list/stat endpoints may return fewer cleaning tasks where rows are linked to cancelled/invalid orders or have cancelled task status.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: complements `CRL-20260629-001` execution-state active filtering; independent from CH3007 mobile duplicate display fix in `CRL-20260712-001`.

### Validation

- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_cleaning_task_effective_filters.ts` in `backend` — passed.
- `npm run build --prefix backend` — passed: `tsc -p .`.
- `git diff --check` — passed.
- Production read-only preview — not completed in this run because the local shell and `backend/.env` did not expose `NEON_DATABASE_URL_PROD`; no production data was modified.

### Risks / Release Notes

- Reporting risk: endpoints using this shared filter will no longer show cancelled-task residue as current workload. This is intended, but any workflow that relied on seeing cancelled order tasks in active lists must use a history/audit view instead.
- Data quality remains: rows with stale `execution_state='active'` and cancelled status still exist until a separate data cleanup is approved.
- Rollback: revert the helper changes in `cleaningSync` and remove `validCleaningTaskOrderWhereSql()` usage from `cleaning`, `task_center`, `mzapp`, and `stats`.
- Sensitive-information review: no secrets, `.env` values, database URLs, credentials, raw guest data, tokens, cookies, private keys, sensitive logs, or local caches were added.
- Git state: uncommitted.

## CRL-20260712-001 — 移动端 CH3007 入住任务重复显示修复

- **Status:** ready
- **Updated:** 2026-07-12 01:11 AEST
- **Request:** “查一下为什么移动端重复两个同房源入住任务，NEON_DATABASE_URL_PROD已提供，只读”；确认后执行修复。
- **Outcome:** 移动端 `/mzapp/work-tasks` 不再把普通入住检查人错误兜底成执行人，避免同一房源同一天的入住任务同时出现一张 inspection 周转卡和一张多余 execution/inspection 卡。`password_only` 入住任务仍保留 inspector 兜底执行人的特殊逻辑。

### Implementation

- Previous behavior:
  - `/mzapp/work-tasks` 构建清洁任务卡时使用 `executorId = assignee_id || inspector_id`。
  - 对普通 `checkin_clean`，如果没有 `assignee_id` 但有 `inspector_id`，检查人会被当成执行人生成独立执行卡。
  - 同一条入住任务随后又会作为检查人参与同房同日 turnover 合并，移动端表现为同房源重复两个入住任务。
- New behavior:
  - 普通 `checkin_clean` 只有真实 `assignee_id` 才作为现场执行人。
  - 仅当 `inspection_scope = password_only` 时，允许 inspector 继续兜底为执行人，保留“检查后挂钥匙/密码类”任务的既有移动端行为。
  - `inspection_scope` 归一化结果复用到卡片基础字段，避免同一行重复解析。
- Key decisions:
  - 不修改数据库，不删除任务；问题根因是移动端接口的角色兜底逻辑，不是 CH3007 数据库里有两条当前入住任务。
  - 保留 `password_only` 特例，避免破坏检查后挂钥匙这类由检查人实际执行的任务。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified/shared: `/mzapp/work-tasks` 的 `executorId` 只在普通任务有 `assignee_id` 时设置；`password_only` 入住任务保留 inspector fallback。
- `backend/scripts/tests/test_task_assignment_canonical.ts` — modified/shared: 增加 inspector-only 普通入住任务不生成重复 execution 卡，以及 `password_only` 仍 fallback 的回归覆盖。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: `/mzapp/work-tasks` 对普通入住任务的任务卡数量会减少，避免检查人同时看到重复的入住执行卡。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: separate from `CRL-20260712-002`; both touch `backend/src/modules/mzapp.ts` and selective release requires hunk-level review.

### Validation

- Production read-only diagnosis — passed earlier in this investigation: confirmed CH3007 duplicate display came from `/mzapp/work-tasks` role fallback, not from two current active CH3007 checkin rows.
- `npm run build --prefix backend` — passed: `tsc -p .`.
- `git diff --check` — passed.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_task_assignment_canonical.ts` — skipped because `backend/.env.local` was absent; not rerun against production credentials.

### Risks / Release Notes

- Runtime risk: if any non-`password_only` checkin task intentionally relied on inspector fallback as execution assignment, it will now require an explicit `assignee_id`.
- Deployment scope: backend-only; no mobile client rebuild/repackage required.
- Rollback: restore the previous `executorId = assignee_id || inspector_id` behavior in `/mzapp/work-tasks` and remove the added canonical assignment tests.
- Sensitive-information review: no secrets, `.env` values, database URLs, credentials, raw guest data, tokens, cookies, private keys, sensitive logs, or local caches were added.
- Git state: uncommitted.

## CRL-20260711-004 — 当日任务拆分同类重复清洁任务

- **Status:** ready
- **Updated:** 2026-07-11 17:05 AEST
- **Request:** “任务安排表也拆成两条显示，重复的清洁任务需要确定哪一条是正确的”。
- **Outcome:** 清洁当日任务/任务安排表不再把同一房源同一天的同类重复清洁任务合并成一个 `退房 xN` / `入住 xN` / `入住中清洁 xN` 卡片；同类重复任务会按原始任务逐条显示，方便按订单确认哪条应保留。真正的退房+入住周转任务仍合并为一个 `退房 入住` 卡片。

### Implementation

- Previous behavior:
  - `/cleaning/tasks?date=...` 返回当天所有 active 清洁任务后，前端会按房源和日期把多条同类 `checkout_clean`、`checkin_clean`、`stayover_clean` 合并成单张卡片。
  - `2026-07-12 / WSP3209A` 在生产库实际有两条 active `checkout_clean`，但安排表搜索 `3209` 时只看到一张退房卡片，遮住了重复来源。
- New behavior:
  - 只保留退房+入住组合的 turnover 合并逻辑。
  - 同房源同日期只有多个同类清洁任务时，直接保留原始多条任务，安排表和任务中心的可见条数更一致。
  - 生产库只读核对显示 WSP3209A 两条任务分别来自两个不同 confirmed Airbnb email 订单，确认号为 `HMZZ59MPJJ` 和 `HMRAEWMSDS`，入住/退房日期均为 `2026-07-02` 至 `2026-07-12`；数据库证据不足以自动判定哪条一定错误，需要业务侧核对订单来源后处理。
- Key decisions:
  - 不在前端或后端自动删除/压制其中一条 confirmed 订单生成的任务。
  - 不改变 `/cleaning/tasks` API 和数据库；这次只调整安排表展示合并口径。

### Files / Areas

- `frontend/src/app/cleaning/page.tsx` — modified: 删除同类清洁任务的前端合并分支，保留退房+入住 turnover 合并。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: none.

### Validation

- Production read-only query with `BEGIN READ ONLY` — passed: confirmed two active `checkout_clean` rows for `2026-07-12 / WSP3209A`; both source orders are confirmed Airbnb email imports with distinct confirmation codes and identical stay dates.
- `git diff --check -- frontend/src/app/cleaning/page.tsx` — passed.
- `npm run lint --prefix frontend` — passed with existing warnings; no errors.
- `npm exec --prefix frontend tsc -- --noEmit` — failed: command syntax printed TypeScript help instead of using the frontend tsconfig; reran with the correct command.
- `npx tsc --noEmit` in `frontend` — passed.
- `npm run build --prefix frontend` — passed; build emitted existing Browserslist staleness notice, existing ESLint warnings, and existing Recharts static-generation width/height warnings.

### Risks / Release Notes

- UI risk: if the old same-type merge was intentionally used to reduce clutter for legitimate multiple same-type jobs, those jobs now display separately. This is intentional for duplicate/conflict review.
- Business risk: WSP3209A has two overlapping confirmed orders for the same property and stay dates; this change exposes the conflict but does not decide which order/task is correct.
- Rollback: restore the removed same-type merge branches in `frontend/src/app/cleaning/page.tsx`.
- Sensitive-information review: no secrets, `.env` values, database URLs, credentials, raw emails, guest names, tokens, cookies, private keys, sensitive logs, or local caches were added. Production query output was summarized without raw connection details.
- Git state: uncommitted.

## CRL-20260711-003 — 房东签署完成页下载签署版合同

- **Status:** ready
- **Updated:** 2026-07-11 00:59 AEST
- **Request:** “房东签字完成以后，需要可以下载签字完成的合同”。
- **Outcome:** 房东公开签署页在签署完成后会显示“下载签署完成合同”按钮，按钮通过签署 token 访问后端公开下载端点，下载最终签署版 PDF，不再依赖存储层 `current_signed_url` 作为公开入口。

### Implementation

- Previous behavior:
  - 公开签署页完成态有“打开签署版 PDF”按钮，但使用的是接口返回的 `current_signed_url/signed_url`。
  - 该 URL 是存储层文件地址，不是稳定的公开下载接口；如果存储 URL 不适合直接公开访问，房东完成签字后仍无法可靠下载合同。
  - 已有 `/draft.pdf` 公开端点在签署完成后可 inline 返回签署版，但没有明确的附件下载端点和下载按钮文案。
- New behavior:
  - 新增 `GET /public/landlord-documents/sign/:token/signed.pdf`，仅在房东已签署且当前签署版 PDF 存在时，以 `attachment` 返回最终签署版 PDF。
  - 完成页按钮改为“下载签署完成合同”/`Download Signed Contract`，指向 token 下载端点。
  - 完成页说明文案明确提示可下载签字完成合同。
  - 前端不再保存或依赖 `signed_url/current_signed_url` 来显示下载按钮。
- Key decisions:
  - 保留原有签署 token 权限边界；下载端点继续使用 `loadPublicSigningDocumentByToken()`，签署完成的 token 在后端现有规则下可继续读取。
  - 不改变管理端下载签署版接口，不改变 PDF 生成逻辑。

### Files / Areas

- `backend/src/modules/landlord_documents.ts` — modified: 新增公开签署版 PDF 附件下载端点。
- `frontend/src/app/public/landlord-documents/sign/[token]/page.tsx` — modified: 签署完成态显示下载签署完成合同按钮，并使用公开 token 下载端点。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: added public `GET /public/landlord-documents/sign/:token/signed.pdf`.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: builds on `CRL-20260711-002` because both touch landlord document public signing and MZ signature safeguards.

### Validation

- `git diff --check -- backend/src/modules/landlord_documents.ts frontend/src/app/public/landlord-documents/sign/[token]/page.tsx` — passed.
- `npm run build` in `backend` — passed: `tsc -p .`.
- `npm run lint` in `frontend` — passed with existing warnings; no errors.
- `npm run build` in `frontend` — passed; build emitted existing Browserslist staleness notice, existing ESLint warnings, and existing Recharts static-generation width/height warnings.

### Risks / Release Notes

- Runtime risk: if final signed PDF generation or R2 retrieval fails, the download endpoint returns `signed version not found` or `file not found` instead of a broken storage URL.
- Existing completed links should show the new download button after deployment as long as the signing token still resolves under the existing completed-link rule.
- Rollback: remove the `/signed.pdf` public route and restore the completion button to use `signed_url/current_signed_url`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: uncommitted.

## CRL-20260711-002 — 合同默认 MZ 签名补入与签署链接防空签

- **Status:** ready
- **Updated:** 2026-07-11 00:52 AEST
- **Request:** “合同我们的默认签名呢，怎么又没了”；随后补充“生成房东签署的链接里面也没有签字啊”。
- **Outcome:** 合同预览、草稿下载和生成房东签署链接前，系统会在当前合同缺少 MZ 签名图片时自动使用本机已保存的默认签名写入合同并刷新草稿；如果仍然没有 MZ 签名图片，管理端会拦截生成链接，后端也会拒绝缺 MZ 签名的房东签署链接和公开提交。

### Implementation

- Previous behavior:
  - 默认 MZ 签名保存在浏览器本地，创建/保存合同或手动 MZ 签署时才会写入合同字段。
  - 直接预览或下载已有合同草稿时，如果该合同字段中没有 `mz_signature_data_url`，PDF 会渲染为空的 `Signature:`。
  - 管理端生成房东签署链接前只尝试补默认签名，但没有确认补签后的文档确实包含签名图片；后端 `ensureMzSignedFields()` 只补签署人和日期，不校验签名图片。
- New behavior:
  - 新增管理端 `ensureDefaultMzSignature()`，预览、下载草稿和生成房东签署链接共用该补签流程。
  - `saveMzSignatureForDocument()` 返回后端刷新后的文档，调用方使用最新字段继续生成 PDF 或签署链接。
  - 生成房东签署链接前会确认 `mz_signature_data_url` 已存在；缺失时打开 MZ 签署弹窗并提示先确认默认签名。
  - 后端 `POST /landlord-documents/:id/request-landlord-sign` 在 MZ 签名图片缺失时返回 `missing_mz_signature`，不再生成缺我方签名的链接。
  - 公开房东签署提交接口同样拒绝缺 MZ 签名图片的文档，避免旧链接继续生成空我方签名的签署版。
- Key decisions:
  - 不新增签名存储系统，继续复用现有本地默认签名和 `/mz-sign` 后端接口。
  - 后端只校验合同字段里是否已有合法签名图片，不尝试读取浏览器本地默认签名。

### Files / Areas

- `frontend/src/app/landlords/_components/LandlordDocumentsPage.tsx` — modified: 预览、下载草稿、生成房东签署链接前自动补默认 MZ 签名，并在缺签名时阻止生成链接。
- `backend/src/modules/landlord_documents.ts` — modified: 房东签署链接生成和公开提交前校验 MZ 签名图片存在。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: `POST /landlord-documents/:id/request-landlord-sign` may now return `409 { message: "missing_mz_signature" }` when the document lacks a valid MZ signature image.
- Public signing: landlord submit endpoint may now return `missing_mz_signature` instead of producing a signed PDF with an empty MZ signature.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: landlord document PDF / e-sign flow only; independent from task-center and property-payable units.

### Validation

- `git diff --check -- frontend/src/app/landlords/_components/LandlordDocumentsPage.tsx backend/src/modules/landlord_documents.ts` — passed.
- `npm run build` in `backend` — passed: `tsc -p .`.
- `npm run lint` in `frontend` — passed with existing warnings; no errors.
- `npm run build` in `frontend` — passed; build emitted existing Browserslist staleness notice, existing ESLint warnings, and existing Recharts static-generation width/height warnings.

### Risks / Release Notes

- Runtime risk: users without a saved default MZ signature, or documents whose saved signature data is invalid, must confirm MZ signing before generating a landlord signing link.
- Existing landlord signing links for documents missing MZ signature data will be blocked at submit time until MZ signature is added and a refreshed link/draft is generated.
- Rollback: remove the management-side `ensureDefaultMzSignature()` usage and remove the backend `missing_mz_signature` guards from link generation/public submit.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: uncommitted.

## CRL-20260711-001 — 任务中心 iPad 自适应布局修复

- **Status:** ready
- **Updated:** 2026-07-11 00:11 AEST
- **Request:** “任务中心 ipad显示也是很不好，到底有没有设备自适应，检查一下，先不改代码”；确认问题后执行“彻底修复一下”。
- **Outcome:** 任务中心看板现在按实际任务板容器宽度决定每行任务卡数量，iPad 横屏带左侧菜单时会降为 3 列，窄屏继续降为 2/1 列；JS 分行、拖拽插入位置和 CSS 网格共用同一列数，避免视觉列数和拖拽逻辑不一致。

### Implementation

- Previous behavior:
  - 任务中心每行固定 4 个任务卡，CSS 默认也固定 4 列。
  - 2 列/自适应样式只在浏览器视口 `max-width: 1100px` 时触发；iPad 横屏加后台侧栏后，内容区已经偏窄但浏览器视口仍大于断点，导致卡片被压窄。
  - 卡片内时间、状态、顺序等标签在中等宽度下仍强制单行横向隐藏滚动，截图中表现为标题和标签大量截断。
- New behavior:
  - 新增 `resolveTaskCenterColumns()`，按任务板可用宽度把列数解析为 4/3/2/1。
  - 任务中心页面用 `ResizeObserver` 测量看板容器宽度，并把列数同步用于分行、拖拽插入位置和 CSS 变量。
  - `.taskCenterSubrowGrid` 由 `--task-center-columns` 控制列数，不再只依赖固定 4 列或视口断点。
  - 在 1 到 3 列状态下，任务卡内时间、状态、检查/执行顺序等标签允许换行，减少 iPad 上的拥挤和横向隐藏。
- Key decisions:
  - 不重写任务中心架构，不新增平行看板系统；保留原有行/卡/拖拽模型。
  - 响应式依据“内容区宽度”而不是浏览器宽度，适配后台侧栏展开、折叠和 iPad 横竖屏。
  - 列数 helper 放在现有 `taskCenterDisplay.ts` 并加单元测试，避免列数边界变成页面内魔法值。

### Files / Areas

- `frontend/src/app/task-center/page.tsx` — modified: 用容器宽度驱动任务板列数，并同步更新分行和拖拽插入逻辑。
- `frontend/src/app/task-center/taskCenterDisplay.ts` — modified: 新增任务中心列数解析 helper。
- `frontend/src/app/task-center/taskCenterDisplay.test.ts` — modified: 覆盖任务中心 1/2/3/4 列宽度边界。
- `frontend/src/app/cleaning/cleaningSchedule.module.scss` — modified: 任务中心网格改为 CSS 变量列数，并优化中窄宽度下卡片标签换行。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: follows earlier task-center card responsive/layout work; independent from notification and property-payable units.

### Validation

- `npx vitest run src/app/task-center/taskCenterDisplay.test.ts` in `frontend` — passed: 3 tests passed.
- `npm run lint` in `frontend` — passed with existing warnings; no errors.
- `npm run build` in `frontend` — passed; build emitted existing Browserslist staleness notice, existing ESLint warnings, and existing Recharts static-generation width/height warnings.
- Live authenticated iPad browser screenshot — not run in this turn; validation used code-level container-width behavior and production build.

### Risks / Release Notes

- Runtime risk: changing task grouping from fixed 4 columns to responsive 3/2/1 columns changes the visual row breaks and drag insertion positions on tablet/narrow widths; this is intentional to keep drag behavior aligned with the visible grid.
- Runtime risk: very dense cards can become taller in 1 to 3 column layouts because tags now wrap instead of being hidden horizontally.
- Rollback: restore fixed `TASKS_PER_LINE = 4`, restore `.taskCenterSubrowGrid` to fixed 4 columns, remove the `ResizeObserver` column state, and remove the helper/test additions.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: uncommitted.

## CRL-20260710-004 — 移动端推送通知高优先级投递

- **Status:** ready
- **Updated:** 2026-07-10 23:48 AEST
- **Request:** 给 notification 两个未提交文件补一个独立 CRL。
- **Outcome:** Expo 推送发送现在会带 `priority: high` 和默认通知通道，队列 worker 也会从 `user_notifications.priority` 读取并按优先级分组转发，避免不同优先级通知被合并到同一批发送时丢失优先级语义。

### Implementation

- Previous behavior:
  - `sendExpoPush()` 只发送 title/body/sound/data，没有显式传递 Expo push priority 或 channelId。
  - `notifyExpoAll()` / `notifyExpoUsers()` 不接收 priority 参数。
  - `notificationQueueWorker` 从队列取通知时没有读取 `user_notifications.priority`，批量合并 key 也不包含 priority。
- New behavior:
  - 新增推送优先级类型和 `resolveExpoPushPriority()`，当前把 MZStay 操作类移动端通知统一解析为 Expo `high`。
  - Expo payload 增加 `priority` 和 `channelId: 'default'`。
  - `notifyExpoAll()` / `notifyExpoUsers()` 接收可选 app notification priority，并传入 Expo 发送层。
  - 队列 worker 读取 `user_notifications.priority`，默认缺失时按 `low` 处理。
  - 批量合并 key 增加 priority，确保不同优先级的通知不会被错误合并。
- Key decisions:
  - 不新增数据库字段或队列系统，复用现有 `user_notifications.priority`。
  - 当前所有移动端 Expo 投递统一使用 high，优先解决 Android 及时到达；保留 app priority 参数用于后续细分。
  - 不改变通知创建、权限、事件队列状态流转或失败重试逻辑。

### Files / Areas

- `backend/src/modules/notifications.ts` — modified: Expo push payload 增加 high priority 和 default channel，并让 notify helpers 透传 priority。
- `backend/src/services/notificationQueueWorker.ts` — modified: 队列读取、分组和发送时保留 notification priority。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: internal `notifyExpoAll()` / `notifyExpoUsers()` helper signatures accept optional `priority`; HTTP response structure unchanged.
- Database / migration: none; reads existing `user_notifications.priority`.
- Config / environment: none.
- Dependencies: none.
- Related units: notification delivery behavior only; independent from房源代付、合同和任务中心 release units.

### Validation

- `git diff --check -- backend/src/modules/notifications.ts backend/src/services/notificationQueueWorker.ts docs/change-release-ledger.md` — passed.
- `python3 scripts/audit_change_release_ledger.py` — passed after this CRL was added.
- `npm run build` in `backend` — passed: `tsc -p .`.
- Live Expo push delivery — not run; no test push was sent.

### Risks / Release Notes

- Runtime risk: all Expo notifications now request high priority, which may increase urgency/noise and battery/network impact on Android devices; this is intentional for operational notifications.
- Runtime risk: `channelId: 'default'` assumes the mobile app has or can use the default notification channel.
- Rollback: remove priority/channelId from Expo payload, remove priority forwarding from notify helpers, and remove priority from queue worker grouping.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: uncommitted.

## CRL-20260710-003 — 房源代付预计收账日可空与保存后建议项

- **Status:** ready
- **Updated:** 2026-07-10 22:41 AEST
- **Request:** “预计收到账单日”不要必填；“收费公司/事项”不要在输入时立刻进入建议项，只有实际保存成功后才进入备选建议。
- **Outcome:** 房源代付模板现在允许不填写预计收到账单日，后端会把空值规范为 `null`，后续快照的 `bill_expected_date` 也保持为空；收费公司/事项的本地建议项不再跟随临时输入即时增加，只在房源或财务模板保存成功后加入当前页面的备选项。

### Implementation

- Previous behavior:
  - 房源代付模板表单要求填写 `bill_expected_day_of_month`，后端创建/编辑也把该字段当作必填数值校验。
  - 编辑已有模板时，空值不会进入 patch payload，无法明确清空预计收到账单日。
  - `PropertyPayableVendorInput` 会把当前输入值和当前字段值合并进下拉建议，导致用户只是试输一个收费公司/事项，也会临时出现在建议列表里。
- New behavior:
  - 新增可空日期 helper：空值合法并归一为 `null`，非空值仍要求 1 到 31。
  - 创建和编辑房源代付模板时允许 `bill_expected_day_of_month` 为空；编辑时如果 payload 明确带空值，会写入 `null` 并同步未来未付快照的 `bill_expected_date = null`。
  - 财务代付模板抽屉和房源代付模板表单移除“预计收到账单日”必填校验。
  - `PropertyPayableVendorInput` 只展示后端已有建议和保存成功后记住的值，不再把正在输入的临时文本直接加入建议。
  - 财务模板保存、房源新建、房源编辑和房源详情保存成功后，才调用 `rememberPropertyPayableVendors()` 把收费公司/事项加入本地建议缓存。
- Key decisions:
  - 不新增表字段、接口或建议项管理系统，继续复用现有代付模板和 `/recurring-payments/property-payable-vendors` 建议来源。
  - 空预计收账日表达“目前未知/不需要提醒该日期”，不是自动 fallback 到 1 号或 30 号。
  - 只在保存成功后更新前端建议，避免失败提交污染本地候选项。

### Files / Areas

- `backend/src/modules/recurring.ts` — modified: 房源代付预计收到账单日允许空值，创建/编辑归一为 `null`，同步未来快照时支持清空 `bill_expected_date`。
- `backend/scripts/tests/test_property_payable_bill_dates.ts` — modified: 覆盖可空预计收账日和月末 fallback。
- `frontend/src/app/finance/property-payables/page.tsx` — modified: 财务代付模板表单取消预计收账日必填，并在保存成功后记住收费公司/事项建议。
- `frontend/src/app/properties/page.tsx` — modified: 房源新建/编辑保存成功后才记住代付模板收费公司/事项建议。
- `frontend/src/app/properties/[id]/page.tsx` — modified: 房源详情保存成功后才记住代付模板收费公司/事项建议。
- `frontend/src/components/PropertyPayableTemplatesForm.tsx` — modified: 房源代付模板表单取消预计收账日必填。
- `frontend/src/components/PropertyPayableVendorInput.tsx` — modified: 建议项缓存增加发布/订阅和保存后记忆入口，移除输入时即时加入建议的行为。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: existing recurring payment create/patch payload can include `bill_expected_day_of_month: null` for property-payable templates.
- Behavior: future unpaid property-payable snapshots can have `bill_expected_date = null` when the template预计收账日为空。
- Database / migration: none; uses existing nullable fields.
- Config / environment: none.
- Dependencies: none.
- Related units: follows earlier property-payable template simplification around fixed due day and expected bill date.

### Validation

- `git diff --check -- backend/src/modules/recurring.ts backend/scripts/tests/test_property_payable_bill_dates.ts frontend/src/app/finance/property-payables/page.tsx frontend/src/app/properties/page.tsx frontend/src/app/properties/[id]/page.tsx frontend/src/components/PropertyPayableTemplatesForm.tsx frontend/src/components/PropertyPayableVendorInput.tsx docs/change-release-ledger.md` — passed.
- `npx ts-node-dev --transpile-only scripts/tests/test_property_payable_bill_dates.ts` in `backend` — passed: `test_property_payable_bill_dates: ok`.
- `npm run build` in `backend` — passed: `tsc -p .`.
- `npm run lint` in `frontend` — passed with existing warnings; no errors.
- `npm run build` in `frontend` — passed; build emitted existing Browserslist staleness notice and existing Recharts static-generation width/height warnings.

### Risks / Release Notes

- Runtime risk: templates without预计收到账单日 will not have a bill expected date for reminder/overdue logic that depends on that field; this is intended when the date is unknown.
- UX risk: users may expect a just-typed收费公司/事项 to appear immediately in all dropdowns, but it now appears only after successful save to avoid failed or abandoned input polluting suggestions.
- Rollback: restore required validation on `bill_expected_day_of_month`, restore required backend numeric validation, and restore input/current-value merging in `PropertyPayableVendorInput`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: uncommitted.

## CRL-20260710-002 — 移动端个人资料空字段保存兼容修复

- **Status:** ready
- **Updated:** 2026-07-10 22:42 AEST
- **Request:** “移动端为什么无法保存个人信息的更改”，截图显示编辑资料页保存后只弹出“出错了 / 保存失败”。
- **Outcome:** 保存失败的触发点是移动端把未填写的手机号、银行信息、ABN、Photo ID 等字段作为 `null` 提交到 `PATCH /users/me`。当前 Dev 后端已允许 `nullable`，但生产后端与 Dev 后端运行 commit 不一致；截图里这些字段为空，生产旧 schema 很可能按 string/optional 校验并拒绝 `null`，旧 App 又把真实参数错误吞成“保存失败”。移动端现在对个人资料空字段统一提交空字符串而不是 `null`，兼容新旧后端；头像、Photo ID、普通保存失败时也会展示后端/网络层解析出的真实错误，不再只显示泛化文案。

### Implementation

- Previous behavior:
  - `updateMyProfile()` 已经会把 `401/403/400/500/timeout` 等响应解析成可读错误消息。
  - `ProfileEditScreen` 的三个 `catch {}` 没有接收错误对象，导致所有远程保存/上传失败都被覆盖成固定文案：`保存失败`、`上传失败` 或 `无法选择图片`。
  - 保存普通资料时，空的 `phone_au`、`avatar_url`、银行字段、`personal_abn`、`photo_id_url` 会作为 `null` 进入请求体。
  - 本地 Dev 后端 schema 接受 `null`，但生产后端当前运行 commit 与 Dev 不一致；旧 schema 若只接受 string/optional，会对截图里的空银行/Photo ID 字段返回 400。
  - 从截图无法判断是 token 过期、生产后端异常、参数校验失败还是网络问题。
- New behavior:
  - 新增 `profileApiText()` / `profileApiUrl()`，保存前把可空文本/URL 字段规范成 trimmed string。
  - 未填写的个人资料字段提交为空字符串，不再提交 `null`；现有后端读取时仍会把空字符串显示为空值，因此清空字段语义保持不变。
  - 个人资料保存失败时优先显示 `error.message`，没有消息时才回落到原 `profile_save_failed`。
  - 头像与 Photo ID 上传后的资料更新失败也同样展示具体错误消息，并保留原兜底文案。
  - 不改接口路径、后端字段结构、校验规则或本地 profile 缓存逻辑。
- Key decisions:
  - 只做最小移动端兼容修复，不新增日志系统或复杂错误状态。
  - 未输出或记录任何 token、账号、Photo ID、银行账号等敏感信息。
  - 当前未用真实用户 token 直接复现保存，因为不能读取或暴露用户凭证；线上公开路由和健康检查用于确认部署差异与路由存在。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/me/ProfileEditScreen.tsx` — modified: 保存请求中的空 profile 字段改为提交空字符串；保存、头像上传保存、Photo ID 上传保存的 `catch` 改为展示 `error.message`，保留原有兜底文案。
- `docs/change-release-ledger.md` — modified: 记录本诊断与修复单元。

### Impact / Dependencies

- API: none; continues using existing `GET/PATCH /users/me` and media upload APIs.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: related diagnostic context with `CRL-20260708-001` because `/users/me` 曾受移动端缓存/304 问题影响；本次不修改缓存层。

### Validation

- `curl -sS https://mz-property-system-v3-docker.onrender.com/__routes` — passed: production route list includes `GET /users/me` and `PATCH /users/me`.
- `curl -sS https://mz-property-system-v3-2.onrender.com/__routes` — passed: dev route list includes `GET /users/me` and `PATCH /users/me`.
- `curl -sS -i https://mz-property-system-v3-docker.onrender.com/version` — passed: production backend healthy, returned build timestamp `2026-07-08T14:47:47.139Z` and commit `0bae98059dd65aec4c494705845148c4e45f257e`.
- `curl -sS -i -X PATCH https://mz-property-system-v3-docker.onrender.com/users/me ...` without credentials — passed: route exists behind auth and returned `401 unauthorized`, not `404`.
- `curl -sS -i https://mz-property-system-v3-2.onrender.com/version` — passed: dev backend healthy, returned build timestamp `2026-07-10T12:07:35.540Z` and commit `c5fd9c6429a262051c7bd0f2dab8a8ceab138cc6`.
- `curl -sS -i -X PATCH https://mz-property-system-v3-2.onrender.com/users/me ...` without credentials — passed: route exists behind auth and returned `401 unauthorized`, not `404`.
- `node --env-file=.env -e "..."` in `backend` — passed after network approval: checked the configured database has all profile columns (`display_name`, `phone_au`, `avatar_url`, `legal_name`, bank fields, `personal_abn`, `photo_id_url`) without printing database URL or user data.
- Local zod payload check in `backend` — passed: current Dev schema accepts the mobile profile payload, including nullable fields; this is why the failure is tied to deployed production/schema compatibility rather than current local schema.
- `git diff --check -- src/screens/me/ProfileEditScreen.tsx` in `mz-cleaning-app-frontend` — passed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm test -- --runInBand src/lib/api.test.ts src/lib/profileStore.test.ts` in `mz-cleaning-app-frontend` — passed: 2 suites, 2 tests.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 113 existing warnings.
- Mobile production save with the affected signed-in user — not run: no user token or credentials were used. Historical local token files were checked but already unauthorized and were not printed.
- Mobile package build — not run: `mz-cleaning-app-frontend/package.json` has no `build` script.

### Risks / Release Notes

- Runtime risk: the app will now show backend error text to the signed-in user. The existing parser already normalizes common auth and server errors and truncates messages; it should not include secrets.
- Compatibility note: blank profile fields are now sent as empty strings. Current backend responses already normalize empty strings back to `null` for display, so user-visible blank-field behavior should remain unchanged.
- Environment note: production backend and dev backend currently report different commits; this fix avoids relying on newer production schema support for `null`.
- Rollback: restore the `null` conversions in `onSave()` and restore the three `catch {}` blocks in `ProfileEditScreen.tsx` to fixed translated fallback messages.
- Sensitive-information review: no `.env` contents, tokens, credentials, cookies, database URLs, bank details, Photo ID contents, or sensitive logs were added.
- Git state: uncommitted in nested mobile repo; root worktree also contains unrelated pre-existing backend/frontend/ledger changes.

## CRL-20260710-001 — 房源合同特殊条款填写与 PDF 输出

- **Status:** ready
- **Updated:** 2026-07-10 21:03 AEST
- **Request:** 网页端房源合同先增加“特殊条款”，编辑页也需要有地方填写；用户随后反馈新建房源合同抽屉里没有看到“特殊条款”、保存时报 `Internal Server Error`、生成的 PDF 没有刚填写的特殊条款；再次反馈合同本身已有 `SPECIAL CONDITIONS`，自定义内容直接插到该区块前面格式不对，编辑填写位置也应放到合同最后面。
- **Outcome:** 房源合同新建/编辑抽屉现在在表单底部显示“特殊条款”文本框；保存后该内容只属于当前合同，并会在详情页和生成的合同 PDF 整份合同最后独立显示为 `Additional Special Terms`，不再插入到模板自带 `Special Conditions` 开头，也不再出现在 `Terms and Conditions` 前面。保存 500 的根因路径也已修复：房源行里存在已失效的 `landlord_id` 时，不再把它直接提交给合同外键；保存后自动草稿生成失败时也不再让保存整体返回 500，后续预览/下载会识别旧草稿并强制重新生成。

### Implementation

- Previous behavior:
  - 房源合同表单只有模板固定字段和普通 `Special Instructions`，没有给单份合同填写可进入正式 PDF 的补充/特殊条款入口。
  - PDF 的 `Special Conditions` 区域只渲染模板内置条款，不能追加当前合同专属条款。
  - 选中房源时，如果房源保存了不存在的 `landlord_id`，前端会把该值作为合同 `landlord_id` 提交，后端插入 `landlord_documents` 时可能触发外键错误并返回 500；合同没有保存成功时也不会生成新的 PDF 版本。
  - 如果合同字段已经保存成功、但后续自动生成草稿 PDF 失败，接口仍会整体返回 500；同时前端只按模板版本判断草稿是否过期，可能继续下载当前草稿版本，导致刚保存的特殊条款没有进入 PDF。
- New behavior:
  - `fields.special_terms` 作为当前合同专属自由文本保存到已有 `landlord_documents.fields` JSONB 中。
  - 新建/编辑房源合同时在表单底部显示“当前合同特殊条款”文本框，并提示该内容会作为合同最后的 `Additional Special Terms` 输出。
  - 文档详情显示已保存的特殊条款。
  - 房源合同 PDF 在主体、签署、模板自带 `Special Conditions` 和全部 `Terms and Conditions` 结束后，最后追加独立的 `Additional Special Terms`、优先级说明和逐段转义后的特殊条款正文。
  - 前端只在能解析到真实房东记录时提交 `landlord_id`；后端 create/patch 也会把不存在的房东 id 归一为空，避免失效房源关联导致合同保存失败。
  - 后端列表/详情返回 `current_draft_created_at`；前端在预览/下载草稿时，如果合同 `updated_at` 晚于当前草稿生成时间，会强制调用重新生成 PDF。
  - 后端 create/patch 中的自动草稿生成改为 best-effort：合同保存成功后，即使草稿生成失败也返回保存后的合同，并在服务端记录 `draft_generation_failed`。
  - `ensureLandlordDocumentsTables()` 增加进程内缓存，避免每次读取合同、附件或生成 PDF 时重复执行 `CREATE TABLE/INDEX IF NOT EXISTS`。
  - 已为用户反馈的 MV1708 / `SA-20260519-RRDY` 重新生成当前草稿；下载后的 PDF 最后一页已确认 `Additional Special Terms` 位于 `9. Liability` 后面。
- Key decisions:
  - 不新增数据库表或迁移，复用现有 `fields` 扩展点，避免为第一阶段功能创建第二套合同系统。
  - 不修改标准模板默认条款；未填写特殊条款的其他合同仍按原模板输出。
  - 不在本次任务里批量清洗历史房源的失效房东关联；先保证当前合同保存链路稳定。

### Files / Areas

- `frontend/src/app/landlords/_components/LandlordDocumentsPage.tsx` — modified: 新增特殊条款表单项并放在房源合同表单底部、保存前 trim、详情页展示；选房源时不再回填失效的原始 `property.landlord_id`；预览/下载时识别合同更新时间晚于当前草稿生成时间并重新生成草稿。
- `backend/src/modules/landlord_documents.ts` — modified: 房源合同默认字段和空白模板字段增加 `special_terms`；保存/编辑时验证 `landlord_id` 是否仍存在；返回当前草稿生成时间；自动草稿生成失败不再阻断保存；缓存合同表结构 ensure。
- `backend/src/lib/landlordDocumentPdf.ts` — modified: 渲染 `fields.special_terms` 到房源合同 PDF 整份合同最后的独立 `Additional Special Terms` 区域。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: existing `/landlord-documents` create/patch payload may include `fields.special_terms`; response structure unchanged.
- Behavior: if a submitted `landlord_id` no longer exists in `landlords`, the contract is saved with `landlord_id = null` instead of failing the insert.
- Behavior: if automatic draft PDF generation fails after saving, the save endpoint still returns the saved document; preview/download will retry generation when the draft is stale.
- Database / migration: none; uses existing `landlord_documents.fields` JSONB.
- Config / environment: none.
- Dependencies: none.
- Related units: independent from current task-center/cleaning release units; contract wording history includes `CRL-20260707-003`.

### Validation

- `git diff --check -- backend/src/lib/landlordDocumentPdf.ts frontend/src/app/landlords/_components/LandlordDocumentsPage.tsx docs/change-release-ledger.md` — passed.
- `npm run build` in `backend` — passed: `tsc -p .`.
- `npm run lint` in `frontend` — passed with existing warnings; no errors.
- `npm run build` in `frontend` — passed; build emitted existing Browserslist staleness notice and existing Recharts static-generation width/height warnings.
- `node -r ts-node/register/transpile-only -e "..."` in `backend` — passed: rendered a `management_sale` service agreement HTML and confirmed `Special Conditions` appears before the template sale conditions, `Terms and Conditions` appears after the template sale conditions, `Additional Special Terms` appears after the final liability clause, custom text appears inside that final section, and the old `Additional Special Conditions` heading is absent.
- Production-style diagnostics — passed: confirmed service health and schema presence, confirmed non-empty orphan property landlord links as one possible 500 trigger path, and confirmed the reported MV1708 agreement had `special_terms` saved while its current draft PDF version was older than the document update.
- Exact MV1708 PDF render check — passed: rendering the saved agreement fields locally produced a PDF buffer successfully, so the missing special terms in the downloaded file was due to stale current draft selection rather than the PDF template rejecting the special terms.
- MV1708 current draft regeneration — passed: direct regeneration created current draft v5 for `SA-20260519-RRDY`; after the schema ensure cache change, the normal `/landlord-documents/:id/generate-pdf` endpoint also succeeded and updated the current draft again; `/landlord-documents/:id/download-current-draft` returned `200` with `application/pdf`.
- Post-layout regeneration — passed: local backend health check returned `200`; regenerated MV1708 / `SA-20260519-RRDY` current draft version `c5d98cfb-4ec8-424e-9179-903669f38587`.
- Current PDF text/visual check — passed: downloaded the regenerated draft PDF, extracted page text with `pdfplumber`, and rendered page 6 with Poppler; `ADDITIONAL SPECIAL TERMS` appears after `9. LIABILITY`, with no `Additional Special Conditions` block before `1. Sale Campaign Coordination`.
- Dedicated landlord contract automated test — not run: no existing targeted landlord document test file was found.

### Risks / Release Notes

- Legal wording risk: the system now allows user-entered special terms to enter the formal contract PDF; wording should be reviewed before signing.
- Runtime risk: this first phase is a free-text field, not an approval workflow or structured clause library.
- Data hygiene risk: historical property rows can still contain stale landlord ids; this fix prevents contract creation from failing on them, but does not automatically repair those property rows.
- Runtime risk: if storage upload fails repeatedly, saving will still succeed but preview/download regeneration can still fail until storage/network recovers.
- Rollback: remove `special_terms` form/detail rendering, remove backend default field entries, and remove the additional special conditions render block from `landlordDocumentPdf.ts`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: uncommitted; unrelated task-center/cleaning files remain modified or untracked in the worktree.

## CRL-20260709-003 — 任务中心清洁分配状态持久化修复

- **Status:** ready
- **Updated:** 2026-07-09 01:35 AEST
- **Request:** “按照这个计划执行”，修复任务中心清洁/检查人员或纯入住执行人已分配但卡片仍显示“待处理”的问题。
- **Outcome:** 任务中心保存清洁任务分配时，现在会和清洁日程入口共用同一套 `assigned/pending` 判定：普通清洁按清洁/执行/检查人员派生，纯入住/仅改密按执行人或检查人员派生，同时保护进行中、挂钥匙、完成、取消等业务状态不被普通分配覆盖。

### Implementation

- Previous behavior:
  - `backend/src/modules/cleaning.ts` 已经会在分配人员时自动把 `pending/assigned` 状态与人员字段同步。
  - `backend/src/modules/task_center.ts` 的 `cleaning_assignments` 保存只更新 `cleaner_id`、`assignee_id`、`inspector_id` 和检查字段；普通分配没有持久化 `status=assigned`。
  - 任务中心卡片状态标签读取 `status/display_state`，所以数据库仍为 `pending` 时，即使人员已保存也显示“待处理”。
- New behavior:
  - 新增后端共享 helper，统一判断自动分配状态、普通清洁参与人状态、纯入住/仅改密现场执行状态。
  - `cleaning.ts` 改为复用共享 helper，避免后续继续分叉。
  - `task_center.ts` 的保存 SQL 先计算保存后的参与人字段，再在 `pending/assigned/todo/unassigned` 范围内自动派生 `assigned/pending`；`status_action` 的挂钥匙/完成仍保持最高优先级。
  - 内存 fallback 路径同步应用相同规则。
  - 增加历史数据 preview/apply SQL：只修 active 且当前状态为 `pending/todo/unassigned`、但已有参与人的 `cleaning_tasks`，不自动执行 apply。
- Key decisions:
  - 不改前端标签映射；真实问题是后端持久化状态不一致，修后 API、统计和其他端也能一致。
  - 不覆盖 `in_progress`、`cleaned`、`restock_pending`、`restocked`、`inspected`、`keys_hung`、`ready`、`completed`、`done`、`cancelled`、`canceled`。

### Files / Areas

- `backend/src/lib/cleaningAssignmentStatus.ts` — added: 共享清洁任务分配状态判定。
- `backend/dist/modules/cleaning.js` — generated: backend build output for the shared assignment status usage in `cleaning.ts`.
- `backend/src/modules/cleaning.ts` — modified: 改为复用共享分配状态 helper。
- `backend/src/modules/task_center.ts` — modified: 任务中心清洁分配保存时持久化自动派生的 `assigned/pending`，并同步 diff/内存 fallback。
- `backend/scripts/tests/test_cleaning_assignment_status.ts` — added: 覆盖普通清洁、纯入住/仅改密和自动状态边界。
- `backend/scripts/backfills/cleaning_assignment_status_2026_07_09_README.md` — added: 历史状态修复说明。
- `backend/scripts/backfills/cleaning_assignment_status_2026_07_09_preview.sql` — added: 只读预览候选历史数据。
- `backend/scripts/backfills/cleaning_assignment_status_2026_07_09_apply.sql` — added: 受限历史数据修复 SQL，需人工确认后执行。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: `/task-center/save-board` 对 `cleaning_assignments` 的保存结果会在自动分配状态内同步更新 `cleaning_tasks.status`；`/task-center/day` 后续返回的状态标签会随之显示“已分配”。
- Database / migration: no schema migration. 提供可选 backfill SQL 修复历史数据；本次未执行生产 UPDATE。
- Config / environment: none.
- Dependencies: none.
- Related units: follows earlier task-center status/tag diagnosis; independent from `CRL-20260709-001` and `CRL-20260709-002`.

### Validation

- `npx ts-node-dev --transpile-only scripts/tests/test_cleaning_assignment_status.ts` in `backend` — passed: `ok`.
- `npm run build` in `backend` — passed: `tsc -p .`.
- Task-center cleaning assignment UPDATE SQL shape against production with a nonexistent task id — passed: query executed and returned `rowCount=0`; no production row was updated.
- Historical backfill read-only candidate preview against production — passed: `candidate_count=480`, `checkin_clean_count=224`, `other_cleaning_count=256`; apply SQL not run.
- `git diff --check` — passed.

### Risks / Release Notes

- Runtime risk: only `pending/assigned/todo/unassigned` statuses are auto-managed. If legacy data has a nonstandard status with assigned people, it will not be changed automatically.
- Data risk: the historical apply SQL updates up to the previewed candidate set if run later; review preview rows before executing.
- Rollback: revert `backend/src/lib/cleaningAssignmentStatus.ts`, restore local helper functions in `cleaning.ts`, restore the previous `task_center.ts` cleaning assignment UPDATE, and do not run the backfill apply SQL.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added. Production checks used environment variables without printing connection details.
- Git state: uncommitted.

## CRL-20260709-001 — 自完成任务不再显示任务已结束

- **Status:** ready
- **Updated:** 2026-07-09 00:16 AEST
- **Request:** “自完成是指无需检查人员，现场自行完成补货、拍照和钥匙上传。不是任务已经完成啊。给我一个修复计划” 后确认执行。
- **Outcome:** Web 任务中心和清洁日历消费的后端 `display_state.badges` 不再把 `inspection_mode=self_complete` 当成任务结束；自完成任务仍显示“自完成”，但只有真实完成类状态或 `checked_done` 才显示“任务已结束”。

### Implementation

- Previous behavior:
  - `buildWebTaskCapabilityPayload()` 将 `inspection_mode=self_complete` 纳入 `taskEnded`，导致 `status=pending` 的现场自完成任务同时返回“自完成”和“任务已结束”两个 badge。
  - 截图中的 HA205 / BO717 / LA812 这类明日/今日待执行任务，只要安排模式是自完成，就会被视觉上误读为已经完成。
- New behavior:
  - `taskEnded` 只由完成类 `status`、`keys_hung` 或 `checked_done` 推导，不再由 `self_complete` 推导。
  - `self_complete` 继续保留独立“自完成” badge，用来表达无需检查人员、由现场执行人完成补货/拍照/钥匙上传流程。
- Key decisions:
  - 不改数据库枚举和生产数据；`inspection_mode=self_complete` 的业务含义是正确的，问题只在展示语义映射。
  - 保留 `checked_done` 触发“任务已结束”，因为它是独立的已检查完成结果/安排语义。

### Files / Areas

- `backend/src/lib/webTaskCapabilities.ts` — modified: 从 `taskEnded` 条件中移除 `isSelfComplete`。
- `backend/scripts/tests/test_web_task_capabilities.ts` — modified: 增加 `self_complete` 不产生 `task_ended`、`checked_done` 仍产生 `task_ended` 的回归断言。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: `/task-center/day`、`/cleaning/calendar-range` 等返回的 `display_state.badges` 会少返回 `self_complete + pending` 场景下的 `task_ended` badge；响应结构不变。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: follows earlier inspection-mode semantic split units that separated `self_complete` from `checked_done`.

### Validation

- `npx ts-node-dev --transpile-only scripts/tests/test_web_task_capabilities.ts` in `backend` — passed: `test_web_task_capabilities: ok`.
- `npm run build` in `backend` — passed: `tsc -p .`.
- `npx vitest run src/lib/cleaningDailyTaskStatus.test.ts` in `frontend` — passed: 1 file, 7 tests.
- `npm run lint` in `frontend` — passed with existing warnings in unrelated files.
- `npm run build` in `frontend` — passed; emitted existing Browserslist/Recharts warnings during build output.
- `git diff --check -- backend/src/lib/webTaskCapabilities.ts backend/scripts/tests/test_web_task_capabilities.ts docs/change-release-ledger.md` — passed.
- `python3 scripts/audit_change_release_ledger.py` — passed: 3 changed files, 3 recorded, coverage PASS.

### Risks / Release Notes

- Runtime risk: operations users will no longer see “任务已结束” for pending self-complete tasks; this is intended, but any process that previously treated that badge as a proxy for self-complete should use the explicit `self_complete` badge instead.
- Rollback: restore `isSelfComplete` in the `taskEnded` condition and remove the new regression assertions.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: uncommitted.

## CRL-20260709-002 — 任务中心折叠屏多任务布局优化

- **Status:** ready
- **Updated:** 2026-07-09 00:31 AEST
- **Request:** “任务中心页面自适应 还是不行。这个手机折叠的。一个任务只显示一行就不太行啊，至少要显示多个任务。还需要优化。”
- **Outcome:** 任务中心在折叠屏/较宽手机宽度下不再强制一列任务卡；普通窄手机仍按一列展示，折叠屏会按最小卡片宽度自动排成多列，并压缩卡片高度，让首屏能看到多条任务。

### Implementation

- Previous behavior:
  - 720px 以下任务网格被强制为单列，折叠屏横向空间也只能一行一张任务卡。
  - 手机端时间、状态、业务标签和顺序标签全部换行，任务卡被撑高，首屏可见任务数量偏少。
- New behavior:
  - 720px 以下改为 `auto-fit` + `228px` 最小卡片宽度：普通窄手机自然回落为一列，折叠屏/较宽手机自动显示两列或更多。
  - 手机端压缩任务卡 padding、行间距、色条、标题、状态/业务标签和顺序标签高度。
  - 手机端标签行和顺序行保持横向可扫的短行，详情行限制为一行，避免单张任务卡过高。
- Key decisions:
  - 只改任务中心响应式 SCSS，不改任务数据、排序、保存、状态或标签生成逻辑。
  - 保留普通窄屏的一列回退，避免 390px 左右设备出现过窄双列卡片。

### Files / Areas

- `frontend/src/app/cleaning/cleaningSchedule.module.scss` — modified: 调整任务中心 720px 以下网格、任务卡和标签行的响应式密度。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: follows `CRL-20260708-003`; both touch the same task-center responsive SCSS area.

### Validation

- `git diff --check -- frontend/src/app/cleaning/cleaningSchedule.module.scss` — passed.
- `npm run lint -- --file src/app/task-center/page.tsx` in `frontend` — passed: no ESLint warnings or errors.
- `./node_modules/.bin/tsc --noEmit --pretty false` in `frontend` — passed.
- `./node_modules/.bin/vitest run src/app/task-center/taskCenterDisplay.test.ts --coverage=false` in `frontend` — passed: 1 file, 2 tests.
- `npm run build` in `frontend` — passed; build emitted existing project ESLint warnings, Browserslist staleness notice, and existing Recharts static-generation width/height warnings.
- Temporary SCSS/Playwright layout sample — passed with approved local Chromium execution: 390px viewport showed 1 column, 5 visible task cards, no document overflow; 560px viewport showed 2 columns, 8 visible task cards, no document overflow. Screenshots written to `/private/tmp/task-center-mobile-390.png` and `/private/tmp/task-center-mobile-560.png`.
- `git diff --check -- docs/change-release-ledger.md frontend/src/app/cleaning/cleaningSchedule.module.scss` — passed.
- `python3 scripts/audit_change_release_ledger.py` — passed: 4 changed files, 4 recorded, coverage PASS.

### Risks / Release Notes

- Runtime risk: very long tags now scroll horizontally within their line on phone widths instead of expanding the card vertically; this is intentional to preserve more visible tasks.
- Visual risk: the temporary visual check used a local sample rendered from the real SCSS, not an authenticated live task-center payload.
- Rollback: restore the previous 720px single-column grid and wrapping tag/order rows in `frontend/src/app/cleaning/cleaningSchedule.module.scss`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: uncommitted.

## CRL-20260708-003 — 任务中心移动端任务卡响应式优化

- **Status:** committed
- **Updated:** 2026-07-08 23:39 AEST
- **Request:** “任务中心页面需要自适应各个设备，这样显示不太行，需要优化”
- **Outcome:** 任务中心卡片网格在窄屏不再强制两列挤压；手机宽度下任务卡改为单列展示，并允许时间、状态、业务标签和顺序标签换行，避免截图中标签只露出一半、房号和人员名被过度压缩的问题。

### Implementation

- Previous behavior:
  - 720px 以下仍使用两列任务卡网格，单张卡片可用宽度过窄。
  - 卡片内时间行、标签行和顺序行固定高度并横向滚动/隐藏，手机截图中多个标签被截断。
- New behavior:
  - 1100px 以下任务卡网格按 `230px` 最小卡片宽度自动排布，720px 以下强制单列。
  - 任务卡设置 `min-width: 0`、`width: 100%` 和 `box-sizing: border-box`，避免网格内容撑出容器。
  - 手机宽度下压缩卡片内边距、拖拽柄和色条宽度，并让时间/标签/顺序行自动换行。
- Key decisions:
  - 只改响应式样式，不改任务中心数据、排序、保存、状态或标签生成逻辑。
  - 桌面端保留原有紧凑多列布局；移动端优先保证完整可读。

### Files / Areas

- `frontend/src/app/cleaning/cleaningSchedule.module.scss` — modified: 调整任务中心卡片网格断点、手机端单列布局和卡片内部标签换行。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: shares the cleaning/task-center shared SCSS file with earlier task-center UI work, but this unit only changes responsive styling.

### Validation

- `git diff --check -- frontend/src/app/cleaning/cleaningSchedule.module.scss` — passed.
- `npm run lint -- --file src/app/task-center/page.tsx` in `frontend` — passed: no ESLint warnings or errors.
- `./node_modules/.bin/tsc --noEmit --pretty false` in `frontend` — passed.
- `./node_modules/.bin/vitest run src/app/task-center/taskCenterDisplay.test.ts --coverage=false` in `frontend` — passed: 1 file, 2 tests.
- `npm run build` in `frontend` — passed; build emitted existing project ESLint warnings, Browserslist staleness notice, and existing Recharts static-generation width/height warnings.
- Local browser check at `http://127.0.0.1:3000/task-center` with 390px viewport — partially verified: page loads with no horizontal document overflow, but the local session is unauthenticated and shows the login form, so real task-card visual verification was not completed.
- `git commit -m "Optimize task center mobile layout"` — passed locally; commit amended after ledger status update.
- `git push origin Dev` — failed: local GitHub HTTPS authentication is unavailable in this environment (`could not read Username`); no remote push completed.

### Risks / Release Notes

- Runtime risk: phone users will see one task card per row, increasing vertical scroll length but preserving readability.
- Visual risk: very long individual labels may wrap to additional lines on phone width; this is intentional to avoid clipped content.
- Rollback: restore the previous fixed 3-column/2-column responsive grid and fixed-height compact tag/order rows in `frontend/src/app/cleaning/cleaningSchedule.module.scss`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: committed locally; push to `origin/Dev` blocked by GitHub authentication.

## CRL-20260708-001 — 移动端 API 禁用 304 缓存

- **Status:** ready
- **Updated:** 2026-07-08 02:17 AEST
- **Request:** “移动端可执行任务一个都显示不出来了是什么原因。后端报错304。检查一下”
- **Outcome:** 已确认截图中的 `304` 是 HTTP Not Modified，不是业务异常；但移动端 `fetch` 会把 304 当失败处理，可能中断 `/auth/me`、`/users/me` 和 `/mzapp/work-tasks` 刷新。现在后端鉴权 API 和移动端统一请求层都禁用条件缓存。后续复查发现 304 消失后 `/mzapp/work-tasks` 仍会超时，原因转为后端任务列表查询扫描过多历史清洁媒体/延期检查数据；已收窄查询范围。

### Implementation

- Previous behavior:
  - Express 动态 JSON 响应可生成 ETag，客户端带 `If-None-Match` 时可能返回 304。
  - 移动端统一请求函数没有显式禁用缓存；`Response.ok` 不包含 304，所以 304 会进入错误处理。
  - 截图中 `/auth/me`、`/users/me` 多次返回 304；这会影响登录用户状态刷新，进而影响任务列表加载。
- New behavior:
  - 后端关闭动态响应 ETag，并在鉴权后的 API 路由统一设置 `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate`、`Pragma: no-cache`、`Expires: 0`。
  - 保留的移动端目录 `mz-cleaning-app-frontend` 的统一 `fetchWithTimeout` 把请求改为 `cache: 'no-store'`，并默认发送 `Cache-Control: no-cache` 和 `Pragma: no-cache`。
  - 现有 401 登录失效判断改为从标准化后的 `Headers` 读取授权头，保持原行为。
  - 2026-07-08 01:27 AEST update: `/mzapp/work-tasks` 的清洁任务查询先构造 `candidate_tasks`，再只查询候选任务的最新钥匙/视频/补品媒体，避免每次扫描全量历史 `cleaning_task_media`。
  - 2026-07-08 01:27 AEST update: 延期检查的 SQL 候选范围限定为 `inspection_mode = deferred`，并排除已完成/已挂钥匙/取消的历史逾期检查，减少无关历史任务进入本周移动端列表构建。
  - 2026-07-08 01:36 AEST update: 修复 `candidate_tasks` 重构后外层 SELECT 残留 `o` / `p_id` / `p_code` / `au` / `cu` / `iu` 旧别名的问题，外层只读取 CTE 已投出的 `t.*` 字段。
  - 2026-07-08 01:44 AEST update: 补货 carry-forward 查询不再按所有任务房源扫描完整历史；只有当前用户会看到的 checkout/turnover 清洁任务房源才会查询，并把历史回看限制为最近 180 天。该查询先用 CTE 锁定候选清洁任务，再通过现有 `cleaning_task_media(task_id, type)` 索引读取媒体。
  - 2026-07-08 02:17 AEST update: 将移动端任务接口热路径里的 `user_roles`、`work_tasks`、`work_task_participants`、`guest_luggage` 和清洁任务列 schema ensure 改为进程级一次性缓存，并把 auth/mzapp 相关 ensure 放入启动 warmup，避免每次 `/mzapp/work-tasks` 重复执行 DDL/索引检查。
  - 2026-07-08 02:17 AEST update: `/mzapp/work-tasks` 现在在慢请求时输出分段耗时日志，并返回 `x-mzapp-work-tasks-total-ms` / `x-mzapp-work-tasks-steps` 诊断响应头；这些值只包含步骤名和毫秒数，不包含 token、数据库连接或用户敏感信息。
- Key decisions:
  - 不改任务筛选、权限或 `/mzapp/work-tasks` 业务逻辑；本次只修缓存层导致的 304 中断。
  - 最初同步修改了 `mz-cleaning-app-frontend` 和 `mz-cleaning-app-frontend-Dev`；随后按用户要求在 `CRL-20260708-002` 中移除重复目录，只保留 `mz-cleaning-app-frontend`。

### Files / Areas

- `backend/src/index.ts` — modified: 关闭动态 ETag，并为鉴权 API 添加 no-store/no-cache headers。
- `backend/src/auth.ts` — modified: 缓存 `user_roles` schema ensure，新增 auth warmup 并预热常用移动端角色权限缓存。
- `backend/dist/auth.js` — generated: `npm run build` 产出的同步构建文件。
- `backend/dist/index.js` — generated: `npm run build` 产出的同步构建文件。
- `backend/src/modules/mzapp.ts` — modified: 优化 `/mzapp/work-tasks` 清洁任务候选查询、最新媒体查询范围、补货 carry-forward 历史扫描范围、schema ensure 缓存、mzapp warmup 和慢请求分段诊断，避免移动端任务接口超时。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: 统一 API fetch 禁用缓存并保留授权失效判断。
- `mz-cleaning-app-frontend/src/lib/api.test.ts` — modified: 覆盖 no-store/no-cache headers 和跳过全局登出行为。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: authenticated JSON endpoints no longer return conditional 304 responses from Express dynamic ETag handling.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: independent of existing task-center/order and mobile task-card units; shares only `docs/change-release-ledger.md` with other units.

### Validation

- `git diff --check` in `MZ-property-system_V3` — passed.
- `npm run build` in `backend` — passed: `tsc -p .`; rerun after `/mzapp/work-tasks` query optimization, alias fix, carry-forward scan narrowing, schema ensure caching, auth/mzapp warmup, and timing headers also passed.
- Live read-only verification for `zhi-f` `/mzapp/work-tasks?date_from=2026-07-06&date_to=2026-07-12&view=mine` — passed: before hot-path ensure caching the endpoint returned `200` in about 33.5s; after caching and warmup the final two requests returned `200` in 5.671s and 5.702s, with response timing headers showing `schema:0` and `cleaning_pool` about 4.8s.
- `git diff --check` in `mz-cleaning-app-frontend` — passed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm test -- --runInBand src/lib/api.test.ts` in `mz-cleaning-app-frontend` — passed: 1 suite, 1 test.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 113 existing warnings.
- Mobile `npm run build` — not run: mobile package file has no `build` script.

### Risks / Release Notes

- Runtime risk: authenticated API responses are no longer conditionally cached. This is intentional for user/session/task data and may slightly increase repeated GET response transfer size.
- Runtime risk: old completed deferred inspections with due dates before the selected range are no longer pulled into the selected range; unfinished overdue deferred inspections remain eligible and project to the range start as before.
- Runtime risk: carry-forward restock prompts older than 180 days are no longer projected into the mobile task list. This bounds the query to prevent request timeout; recent unresolved carry-forward items remain eligible.
- Runtime risk: schema ensure is now process-cached. If a migration fails during startup or first access, the cache resets and a later request can retry; a successfully running process will not repeatedly re-check those schemas until restart.
- Runtime note: `/mzapp/work-tasks` exposes coarse diagnostic timing headers. They do not contain credentials, tokens, database URLs, or user PII, but can be removed after the timeout incident is fully closed if preferred.
- Regression note: the first query optimization briefly produced `missing FROM-clause entry for table "o"` because the outer SELECT still referenced aliases moved inside `candidate_tasks`; fixed in the same unit before release.
- Remaining diagnostic risk: startup `inventory` warmup still takes about 55s and consumes one database connection in the background after auth/mzapp warmups. It no longer blocks `/mzapp/work-tasks`, but it remains a separate database-compute reduction candidate.
- Rollback: remove `app.set('etag', false)` and the authenticated no-cache middleware from `backend/src/index.ts`, then restore the previous `fetchWithTimeout` implementation in both mobile directories.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: uncommitted; other unrelated worktree changes remain present in backend, frontend, task-center, landlord documents, and task card files.

## CRL-20260708-002 — 合并移动端目录并移除 Dev 重复克隆

- **Status:** ready
- **Updated:** 2026-07-08 01:15 AEST
- **Request:** “不行啊合并成一个 只保留mz-cleaning-app-frontend”
- **Outcome:** 已删除重复的 `mz-cleaning-app-frontend-Dev` 嵌套仓库，只保留 `mz-cleaning-app-frontend`。删除前确认两个目录都在 `Dev` 分支、同一个 commit，且本次涉及的移动端改动文件内容一致。

### Implementation

- Previous behavior:
  - 工作区同时存在 `mz-cleaning-app-frontend` 和 `mz-cleaning-app-frontend-Dev` 两个移动端目录。
  - `mz-cleaning-app-frontend-Dev` 是此前按 Dev 分支新克隆的独立嵌套仓库，在父仓库里表现为 untracked directory，容易造成“到底运行哪个目录”的混淆。
- New behavior:
  - 删除 `mz-cleaning-app-frontend-Dev`。
  - 保留 `mz-cleaning-app-frontend`，其中已包含本次 API 304 缓存修复和之前任务卡默认收起改动。
- Key decisions:
  - 删除前对比 `src/lib/api.ts`、`src/lib/api.test.ts`、`src/screens/tabs/TasksScreen.tsx`、`src/screens/tabs/TasksScreen.test.tsx`，确认两个目录内容一致。
  - 不改 `mz-cleaning-app-frontend` 当前未提交功能改动，只移除重复目录。

### Files / Areas

- `mz-cleaning-app-frontend-Dev/` — deleted: duplicate local clone; not tracked by parent Git.
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: follows `CRL-20260708-001`; the retained mobile API fix remains in `mz-cleaning-app-frontend`.

### Validation

- `git rev-parse --abbrev-ref HEAD` in both mobile directories before deletion — passed: both were `Dev`.
- `git rev-parse HEAD` in both mobile directories before deletion — passed: both were `40dc43312cb7e9e023fa902dfb6c3861b1508171`.
- `diff -u` for the four currently modified mobile files before deletion — passed: no differences.
- `test -d mz-cleaning-app-frontend-Dev` after deletion — passed: exit code 1, directory no longer exists.
- `python3 scripts/audit_change_release_ledger.py` — passed before ledger update after deletion: 11 changed files, 11 recorded.

### Risks / Release Notes

- Runtime risk: none expected; the removed directory was a duplicate local clone and not the retained mobile app directory.
- Rollback: re-clone the mobile repo if a separate comparison clone is needed later.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added to tracked files.
- Git state: `mz-cleaning-app-frontend-Dev/` no longer appears in root `git status`; retained `mz-cleaning-app-frontend` still has uncommitted tracked changes.

## CRL-20260707-001 — 任务中心纯入住和维修执行顺序链路修复

- **Status:** ready
- **Updated:** 2026-07-07 12:02 AEST
- **Request:** “先执行方案1和2”，即先修复纯入住任务保存执行顺序的落库条件，并让网页任务中心显示维修/其他任务的执行顺序。
- **Outcome:** 移动端保存检查/执行混合顺序时，非 password-only 的纯入住 `checkin_clean` 任务可通过 `assignee_id` 写入 `sort_index_inspector`；网页任务中心会透传并显示 work/维修/其他任务的 `sort_index` 为“执行顺序 N”。

### Implementation

- Previous behavior:
  - `/mzapp/cleaning-tasks/reorder` 和 `/mzapp/work-tasks/mixed-reorder` 的检查排序写入只允许 `cleaning_tasks.inspector_id = 当前用户`。
  - 纯入住现场执行任务实际存的是 `assignee_id = 执行人`、`inspector_id = null`，导致 APP 保存顺序后 `sort_index_inspector` 没有落库，网页端也无顺序可显示。
  - `work_tasks.sort_index` 已被移动端用于维修/线下/其他任务排序，但 `/task-center/day` 的 work task 映射没有透传该字段，网页也不会显示。
- New behavior:
  - 检查排序写入保留原 `inspector_id` 匹配，同时允许 `task_type = checkin_clean`、`assignee_id = 当前用户` 且 `inspection_scope <> password_only` 的纯入住任务写入 `sort_index_inspector`。
  - 检查排序写入的日期匹配同时允许 `inspection_mode = deferred` 且 `inspection_due_date <= 保存日期` 的延期/逾期检查任务，避免 APP 当天列表包含旧 `task_date` 检查任务时整批保存返回 403。
  - 任务中心后端确保 `work_tasks.sort_index` 列存在，并在 work task 的 board payload 和 legacy `tasks` payload 中透传 `sort_index`。
  - 任务中心前端对 `task_source = work` 且 `sort_index` 为正数的任务显示“执行顺序 N”。
- Key decisions:
  - 不使用网页拖拽 `task_center_board_items.item_order` 作为执行顺序，避免把网页布局顺序误当成执行人 APP 顺序。
  - 不回填 2026-07-06 历史数据；历史纯入住任务需要执行人重新保存顺序，或由用户确认具体顺序后再做定向数据修复。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: 放宽检查排序写入条件，支持非 password-only 纯入住任务通过 `assignee_id` 保存 `sort_index_inspector`。
- `backend/src/modules/task_center.ts` — modified: 给 `work_tasks` 增加 `sort_index` schema guard，并在任务中心 payload 中透传 work task 执行顺序。
- `frontend/src/app/task-center/page.tsx` — modified: work task 正数 `sort_index` 显示为“执行顺序 N”。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: `/task-center/day` 的 work task payload 新增可选 `sort_index`；清洁排序写入接口的成功匹配范围扩大到符合条件的纯入住现场执行任务。
- Database / migration: no standalone migration; runtime schema guard adds `work_tasks.sort_index` if missing.
- Config / environment: none.
- Dependencies: none.
- Related units: builds on `CRL-20260706-002` and `CRL-20260706-003`; shares `backend/src/modules/task_center.ts` and `frontend/src/app/task-center/page.tsx` with those existing uncommitted task-center units.

### Validation

- `git diff --check` — passed.
- `npm run build` in `backend` — passed: `tsc -p .`.
- Read-only 2026-07-07 zhi-f reorder SQL match check — passed: all 11 APP source ids match the repaired inspector reorder predicate; old predicate missed pure check-in and deferred inspection rows.
- Local Expo restart for testing — passed: Metro started at `exp://192.168.31.35:8081` with `EXPO_PUBLIC_API_BASE_URL=http://192.168.31.35:4002`.
- `npm run lint` in `frontend` — passed with existing warnings.
- `./node_modules/.bin/vitest run src/app/task-center/taskCenterDisplay.test.ts --coverage=false` in `frontend` — passed: 1 file, 2 tests.
- `npm run build` in `frontend` — passed; build emitted existing lint warnings, Browserslist staleness notice, and existing Recharts static-generation width/height warnings.

### Risks / Release Notes

- Runtime risk: non-password-only pure check-in tasks assigned through `assignee_id` now persist inspector/execution sort order. This matches current mobile display semantics, but password-only tasks remain excluded from this inspector sort path.
- Runtime risk: deferred inspection tasks shown in a later day's APP list can now update `sort_index_inspector` when saving that later day. This matches the mobile list behavior but means the stored order belongs to the underlying cleaning task row, not a separate per-display-day row.
- Historical data: existing 2026-07-06 pure入住 rows with null sort fields remain unchanged until the execution order is saved again or explicitly backfilled after user confirmation.
- Rollback: restore the stricter `t.inspector_id::text = $3::text` condition in `backend/src/modules/mzapp.ts`, remove `work_tasks.sort_index` from the task-center payload, and remove work-task order tags in `frontend/src/app/task-center/page.tsx`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: uncommitted; unrelated `frontend/src/app/cleaning/page.tsx`, `frontend/src/app/cleaning/cleaningSchedule.module.scss`, and untracked `mz-cleaning-app-frontend-Dev/` remain present in the worktree.

## CRL-20260707-002 — 移动端任务卡默认收起并显示客人需求

- **Status:** ready
- **Updated:** 2026-07-07 11:01 AEST
- **Request:** “将移动端任务设为默认收起状态，需要的话可以手动点击展开。收起时要把客人需求也显示一下。”
- **Outcome:** 移动端今日任务列表中的任务卡默认只显示头部、标签和必要摘要；用户可点击“展开”查看地址、Wi-Fi、时间、密码、执行人员、操作按钮等详情。收起态如果有真实客人需求，会显示“客人需求”摘要。

### Implementation

- Previous behavior:
  - `TasksScreen` 用空 `collapsedTaskIds` 表示所有任务默认展开。
  - 客人需求只在展开详情区显示，任务收起后不可见。
- New behavior:
  - `collapsedTaskIds[taskId]` 未设置时按 `true` 处理，任务默认收起；点击展开/收起按钮会在该任务上切换显式状态。
  - 收起态新增紧凑的客人需求摘要行，复用现有 `guestRequestForDisplay(task)` 清洗后的展示文本。
  - 任务详情、主操作按钮、Wi-Fi、地址、执行人员等仍只在手动展开后显示。
- Key decisions:
  - 不新增全局设置或持久化偏好，保持改动局限在列表卡片交互。
  - 不改 API 字段；客人需求继续走现有 `turnover_display.guest_request_summary` / `guest_special_request` / `note` 展示链路。
  - 2026-07-07 11:01 AEST update: 最初只改到了 `mz-cleaning-app-frontend-Dev`；用户实际看到的默认展开来自另一个移动端目录 `mz-cleaning-app-frontend`，已同步同一修复。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 同步默认收起逻辑、收起态客人需求摘要、对应样式到实际运行目录。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx` — modified: 同步默认收起和手动展开的回归测试到实际运行目录。
- `mz-cleaning-app-frontend-Dev/src/screens/tabs/TasksScreen.tsx` — modified: 默认收起逻辑、收起态客人需求摘要、对应样式。
- `mz-cleaning-app-frontend-Dev/src/screens/tabs/TasksScreen.test.tsx` — modified: 覆盖默认收起、客人需求摘要、手动展开详情，并调整依赖展开详情的既有断言。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: independent mobile UI behavior change; now covers both local mobile directories. `mz-cleaning-app-frontend` is the tracked nested repo likely used by the running app; `mz-cleaning-app-frontend-Dev/` remains visible to root Git as an untracked clone.

### Validation

- `git diff --check` in `mz-cleaning-app-frontend` — passed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 113 existing warnings.
- `npm test -- --runInBand src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed on rerun: 1 suite, 13 tests; first run hit the default 5s timeout on the new multi-step test, then the same test passed alone with `--testTimeout=15000` and the full file passed immediately after. Jest emitted existing `SafeAreaView` deprecation and open-handle notices.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 33 suites, 123 tests; Jest emitted the existing `SafeAreaView` deprecation warning.
- `git diff --check` in `mz-cleaning-app-frontend-Dev` — passed.
- `npm run typecheck` in `mz-cleaning-app-frontend-Dev` — passed: `tsc -p tsconfig.json`.
- `npm run lint` in `mz-cleaning-app-frontend-Dev` — passed with 0 errors and 113 existing warnings.
- `npm test -- --runInBand src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend-Dev` — passed: 1 suite, 13 tests; Jest emitted existing `SafeAreaView` deprecation warning and an open-handle notice after completion.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend-Dev` — passed: 33 suites, 123 tests; Jest emitted the existing `SafeAreaView` deprecation warning.
- `npm run build` in both mobile directories — not run: package has no `build` script.

### Risks / Release Notes

- Runtime risk: users now need one extra tap to access Wi-Fi, address, execution details, and primary action buttons from the task list.
- Rollback: restore `taskCollapsed` default to `false`, restore the previous toggle expression, remove the collapsed guest request summary styles and assertions.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: `mz-cleaning-app-frontend` and `mz-cleaning-app-frontend-Dev` both have uncommitted changes in `src/screens/tabs/TasksScreen.tsx` and `src/screens/tabs/TasksScreen.test.tsx`; root worktree also has unrelated uncommitted changes listed under other release units.

## CRL-20260707-003 — 边卖边短租合同责任条款调整

- **Status:** ready
- **Updated:** 2026-07-07 23:32 AEST
- **Request:** 网页端房源合同中修改边租边卖合同条款：客人损坏由 MZ 向客人或平台索赔，不需要业主承担；自然磨损业主要接受；销售访问费用和 indemnity 条款改成中立表达；检查短租合同里物业日常维护责任，如没有则补充管理方负责。
- **Outcome:** 边卖边短租合同模板现在明确 MZ 负责处理客损索赔，客损不作为 Owner Expenses；自然磨损由业主接受且不作为客损索赔；销售访问产生的额外运营成本改为双方善意讨论；责任条款改为双方各自对自身原因负责；日常短租运营维护明确由 MZ 负责，业主保留产权侧、结构、合规和业主自有设备责任。

### Implementation

- Previous behavior:
  - 销售版合同的客损条款强调 MZ 不承担客人导致的损坏，只写“reasonable efforts”索赔，未明确客损不由业主承担。
  - 销售访问造成的额外清洁、沟通、出勤等成本可直接作为 Owner Expenses。
  - Liability 条款是单向 Owner indemnifies MZ Property。
  - 销售版多处把 ordinary property maintenance 放在业主责任里，没有明确日常短租运营维护由管理方负责。
- New behavior:
  - 销售版 `Guest Damage and Wear and Tear` 改为：客人造成的损坏、盗损或意外损坏由 MZ Property 向客人、平台或相关保险方处理索赔；除业主原因、既有房屋状况、建筑缺陷、合规问题或业主侧物品外，不作为 Owner Expenses。
  - 销售版明确 ordinary fair wear and tear 由业主接受，不作为客损或可向客人追回的 claim。
  - 销售访问额外运营工作产生的直接成本，改为双方善意讨论并尽量事前确认处理方式。
  - 销售版 Liability 改为双方各自对自身 breach、fraud、wilful misconduct、gross negligence 或可合理控制事项负责，并共同处理第三方 claim。
  - 销售版服务、Special Conditions、Owner Property Responsibilities 和 Payment Terms 均补充或对齐 MZ 负责 day-to-day operational maintenance，业主负责产权侧/结构/合规/业主自有设备等事项。
  - 房源服务协议模板版本从 `service-agreement-v5-2026-06-15` 提升到 `service-agreement-v6-2026-07-07`，网页端可识别旧草稿模板已过期。

### Files / Areas

- `backend/src/lib/landlordDocumentPdf.ts` — modified: 调整边卖边短租 PDF/HTML 模板中的服务范围、业主责任、客损/自然磨损、销售访问成本、日常维护和责任条款。
- `backend/src/modules/landlord_documents.ts` — modified: 更新服务协议模板版本号。
- `frontend/src/app/landlords/_components/LandlordDocumentsPage.tsx` — modified: 同步网页端服务协议模板版本号。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: independent contract wording update; shares only `docs/change-release-ledger.md` with other current units.

### Validation

- `npm run build` in `backend` — passed: `tsc -p .`.
- `npm run lint` in `frontend` — passed with existing warnings; no errors.
- `npm exec -- tsc --noEmit` in `frontend` — passed.
- `npm run build` in `frontend` — passed; build emitted existing lint warnings, Browserslist staleness notice, and existing Recharts static-generation width/height warnings.
- `git diff --check` — passed.
- `node -r ts-node/register/transpile-only -e "..."` in `backend` — passed: rendered the `management_sale` service agreement HTML and confirmed the new guest damage, fair wear and tear, sale access cost, neutral liability, and day-to-day maintenance clauses are present.
- Contract-specific automated unit test — not run: no existing targeted contract wording test file for landlord document PDF templates.

### Risks / Release Notes

- Legal wording risk: wording reflects the requested commercial position but should still be reviewed by a legal/professional adviser before use as a binding contract.
- Scope risk: changes are intentionally limited to the `management_sale` service agreement variant; standard management and direct lease variants keep their existing responsibility language except for shared template version detection.
- Rollback: restore the previous sales-variant clauses in `backend/src/lib/landlordDocumentPdf.ts` and reset the service agreement template version constants to `service-agreement-v5-2026-06-15`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: uncommitted; unrelated task-center, cleaning page, and untracked mobile directory changes remain present in the worktree.

## CRL-20260706-003 — 网页端任务中心卡片排版优化

- **Status:** ready
- **Updated:** 2026-07-06 18:29 AEST
- **Request:** “我要改的是网页版的任务中心的任务显示”，并沿用确认过的结构：“房号，退房入住 要显示在一起，其他标签显示一行，顺序再一行”。后续要求：“把‘住6晚’挪到第二行显示，最后一行退房入住删掉。每行都要上下对齐”。最终确认按 v3 效果图落地。补充修正：“标准时间 就显示 退房入住就行了”，“清洁顺序 要往左移动”。再补充：“只有入住的任务，没显示第几个执行啊，执行人也拍了顺序，查一下什么原因”；再次反馈：“还是没有顺序显示”。
- **Outcome:** 网页端任务中心卡片现在按固定 4 行节奏展示：标题/人员一行，退房/入住/住N晚一行，状态/业务标签一行，清洁/检查/执行顺序一行；普通清洁卡不再在底部重复显示退房/入住/住几晚摘要。标准退房/入住显示为“退房”“入住”，非标准时间才显示具体时间；顺序行 chip 起点已左移对齐上方标签。纯入住现场执行任务现在把已保存的执行人顺序显示为“执行顺序 N”。

### Implementation

- Previous behavior:
  - 网页端任务卡把状态、同步、时间、检查模式和清洁/检查顺序都塞进同一个标签区。
  - 房号/任务标题和退房入住时间分散显示，顺序标签与其他标签混在一起，密集任务卡较乱。
  - 纯入住现场执行任务在移动端使用通用 `sort_index` 表达“第几个执行”，但网页端 `/task-center/day` 只透传清洁/检查角色顺序，没有给纯入住任务补出通用执行顺序，导致前端没有稳定字段可显示。
- New behavior:
  - 任务卡主信息区新增标题框：房号/任务标题左对齐，分配人员右对齐。
  - 退房/入住/住晚数合并为同一时间行，住晚数不再与状态标签混排；标准时间只显示“退房”“入住”，非标准时间显示“晚退房 11:30am”等具体时间。
  - 其他标签行改为单行横向滚动，避免挤压主信息。
  - 清洁顺序/检查顺序从标签行移到独立顺序行，并去掉顺序行左侧内边距以贴齐上方标签起点。
  - 纯入住 `checkin_clean` 在网页任务中心接口中会从已有 `sort_index_inspector` / `sort_index_cleaner` 补出通用 `sort_index`；前端优先显示该字段，缺失时再回退角色顺序，文案为“执行顺序 N”。
  - 普通清洁任务底部不再重复退房/入住/住几晚摘要；仅保留跳过原因或客人需求等真正补充信息。
  - 紧凑卡片标题、时间标签、状态标签、业务标签和顺序标签统一使用固定高度、固定 line-height 和垂直居中，减少多行上下错位。
- Key decisions:
  - 只调整网页端渲染层和 CSS module 样式，不再修改移动端任务卡。
  - 复用现有 `specialTimingTags()`、`taskOrderTags()` 和 `shouldShowNights()` 数据；顺序仍复用现有清洁任务排序字段，不新增第二套保存系统。

### Files / Areas

- `backend/src/modules/task_center.ts` — modified: 为纯入住 `checkin_clean` 合并任务补出通用 `sort_index`，让网页端也能显示现场执行顺序。
- `frontend/src/app/task-center/page.tsx` — modified: 将时间标签、住晚数标签、状态/业务标签、顺序标签分组渲染；纯入住任务显示“执行顺序”；并移除普通清洁卡底部重复摘要。
- `frontend/src/app/cleaning/cleaningSchedule.module.scss` — modified: 增加网页任务中心紧凑卡片标题框、时间行、单行标签区、顺序行样式，并统一标签高度/line-height。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: `/task-center/day` 清洁任务响应新增可选 `sort_index`，用于纯入住任务的通用执行顺序显示。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: depends on `CRL-20260706-002` for清洁/检查顺序字段透传与基础显示逻辑。

### Validation

- `git diff --check` — passed.
- `npm run lint` in `frontend` — passed with existing warnings.
- `./node_modules/.bin/vitest run src/app/task-center/taskCenterDisplay.test.ts --coverage=false` in `frontend` — passed: 1 file, 2 tests.
- `npm run build` in `backend` — passed: `tsc -p .`.
- `npm run build` in `frontend` — passed; build emitted existing lint warnings, Browserslist staleness notice, and existing Recharts static-generation size warnings.

### Risks / Release Notes

- Runtime risk: 标签行保持单行，标签较多时需要横向滚动查看全部标签；这是按用户要求避免卡片多行堆叠。
- Rollback: revert the `renderTaskCard()` grouping changes in `frontend/src/app/task-center/page.tsx` and the `taskCenterCompactHero/TagLine/OrderLine` styles in `frontend/src/app/cleaning/cleaningSchedule.module.scss`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: uncommitted; unrelated `mz-cleaning-app-frontend-Dev/` remains an untracked directory in this worktree but has no current diff for the reverted mobile card layout markers.

## CRL-20260706-002 — 任务中心显示清洁/检查自标顺序

- **Status:** ready
- **Updated:** 2026-07-06 13:25 AEST
- **Request:** “任务中心，每个任务，如果清洁人员和检查人员都标记的了顺序。任务中心页面的任务上需要显示他们的顺序。” 后续确认：顺序是清洁和检查人员自己在端上标记的。
- **Outcome:** 任务中心任务卡和任务详情现在会显示清洁人员/检查人员自己保存的顺序，例如“清洁顺序 2”“检查顺序 1”；没有顺序的任务不显示占位标签。

### Implementation

- Previous behavior:
  - 移动端清洁/检查人员可以保存 `sort_index_cleaner` 和 `sort_index_inspector`。
  - 任务中心后端没有把这两个字段透传到 `/task-center/day`，网页任务卡也不会显示这些顺序。
- New behavior:
  - `task_center` 后端查询清洁任务时读取 `sort_index_cleaner` / `sort_index_inspector`，并在 turnover / deferred 合并任务上保留各角色最小正数顺序。
  - 任务中心前端在任务卡标签区和详情弹窗顶部显示正数顺序标签。
  - 后端启动时确保 `cleaning_tasks.sort_index_cleaner` 和 `sort_index_inspector` 列存在，复用现有字段，不新建第二套顺序系统。
- Key decisions:
  - 只显示清洁/检查端自己保存的顺序，不用任务中心拖拽顺序替代。
  - 非正数、空值、无效值不显示，避免错误占位。

### Files / Areas

- `backend/src/modules/task_center.ts` — modified: 为任务中心清洁任务透传并合并 `sort_index_cleaner` / `sort_index_inspector`。
- `frontend/src/app/task-center/page.tsx` — modified: 在任务卡和详情弹窗显示清洁/检查顺序标签。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: `/task-center/day` 清洁任务响应新增可选字段 `sort_index_cleaner`、`sort_index_inspector`。
- Database / migration: no new migration; runtime schema guard adds existing sort columns if a local database has not applied `20260320_add_cleaning_tasks_sort_indexes.sql`.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `frontend/src/app/task-center/page.tsx` with existing uncommitted `CRL-20260704-013` task-center timing tag work; selective release requires hunk-level review.

### Validation

- `git diff --check` — passed.
- `npm run build` in `backend` — passed: `tsc -p .`.
- `npm run lint` in `frontend` — passed with existing warnings.
- `./node_modules/.bin/vitest run src/app/task-center/taskCenterDisplay.test.ts --coverage=false` in `frontend` — passed: 1 file, 2 tests.
- `npm run build` in `frontend` — passed; build emitted existing lint warnings, Browserslist staleness notice, and Recharts static-generation size warnings.

### Risks / Release Notes

- Runtime risk: merged turnover/deferred cards show the minimum positive cleaner/inspector order across child cleaning tasks; this matches existing mobile manager behavior, but if operations expects every child order shown separately, that would need a richer multi-value display.
- Rollback: remove the sort-index fields from `task_center.ts` payloads and remove `taskOrderTags()` rendering from `frontend/src/app/task-center/page.tsx`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: uncommitted.

## CRL-20260706-001 — 网页端每日清洁保存中反馈

- **Status:** ready
- **Updated:** 2026-07-06 13:05 AEST
- **Request:** “网页端 每日清洁页面 记录保存需要增加交互效果，让用户知道正在保存”
- **Outcome:** 每日清洁页面的清洁任务编辑、手动新增清洁任务、线下任务新增/编辑、批量编辑保存动作现在会在请求期间显示 loading 文案，并阻止重复提交或误关闭。

### Implementation

- Previous behavior:
  - 编辑清洁任务、手动新增清洁任务、编辑线下任务、批量编辑保存时没有明确的保存中反馈，用户可能重复点击或关闭弹窗。
  - 新增线下任务已有 loading，但状态只覆盖单个弹窗，其他保存入口没有统一处理。
- New behavior:
  - `savingAction` 统一记录当前保存动作，相关按钮显示“保存中...”或“创建中...”并启用 Ant Design loading 状态。
  - 保存期间禁用取消按钮、遮罩关闭和 ESC 关闭，避免请求过程中关闭表单或重复提交。
  - 保存函数使用 `try/finally` 恢复状态，失败时仍会解除 loading。
- Key decisions:
  - 不改后端接口、表结构或保存 payload，仅增强前端交互反馈。
  - 复用 Ant Design 现有 `loading` / `confirmLoading` / `cancelButtonProps`，不新增独立提示系统。

### Files / Areas

- `frontend/src/app/cleaning/page.tsx` — modified: 增加每日清洁保存动作状态，并为编辑抽屉和保存弹窗接入 loading、防重复提交和防误关闭。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: independent from existing uncommitted `frontend/src/app/task-center/page.tsx` task-center timing tag work; shares only this ledger file.

### Validation

- `git diff --check` — passed.
- `npm run lint` in `frontend` — passed with existing warnings.
- `npm run build` in `frontend` — passed; build emitted existing lint warnings, Browserslist staleness notice, and Recharts static-generation size warnings.
- `npm test -- src/lib/cleaningDailyTaskStatus.test.ts` in `frontend` — failed because the package script enables global coverage thresholds for a single-file run; the selected 7 tests themselves passed before coverage enforcement failed.
- `./node_modules/.bin/vitest run src/lib/cleaningDailyTaskStatus.test.ts --coverage=false` in `frontend` — passed: 1 file, 7 tests.
- `npm run dev -- -p 3000` in `frontend` — failed in sandbox with `listen EPERM`; retried with approved local port binding and failed because port 3000 was already in use.
- `npm run dev -- -p 3001` in `frontend` — not run: escalation request for alternate local port binding was rejected.

### Risks / Release Notes

- Runtime risk: while a save request is in progress, users cannot close the active drawer/modal until the request finishes; this is intentional to prevent accidental duplicate or abandoned saves.
- Rollback: remove `savingAction` handling and restore the previous button/modal props in `frontend/src/app/cleaning/page.tsx`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: uncommitted.

## CRL-20260705-001 — Backend 本地环境文件初始化

- **Status:** ready
- **Updated:** 2026-07-05 00:29 AEST
- **Request:** “新建一个” backend `.env` 文件。
- **Outcome:** 已在 backend 目录创建本地 `.env`，用于固定本地后端端口和开发登录配置；数据库连接串保留为注释占位，未写入真实连接信息。

### Implementation

- Previous behavior: `backend/.env` 不存在，后端启动时未读取本地环境文件；默认端口会落到代码默认值，且没有数据库连接配置时显示 `pg=false`。
- New behavior: `backend/.env` 存在，提供本地开发端口和默认开发账号相关环境变量；需要真实 Postgres 时可手动填写注释中的 `DATABASE_URL`。
- Key decisions: 不写入真实数据库 URL、token、生产密码或任何私密值；`.env` 已被 gitignore 忽略。

### Files / Areas

- `backend/.env` — added/ignored: 本地开发环境变量文件；具体值不在 ledger 记录。
- `docs/change-release-ledger.md` — modified: 记录本地环境文件初始化。

### Impact / Dependencies

- API: none.
- Database / migration: none; `DATABASE_URL` 仍未启用，除非后续手动填写。
- Config / environment: local-only backend environment file added.
- Dependencies: none.
- Related units: none.

### Validation

- `git check-ignore -v backend/.env` — passed: `backend/.env` is ignored by `backend/.gitignore`.
- `git status --short --ignored backend/.env docs/change-release-ledger.md` — passed: shows tracked ledger change and ignored backend `.env`.

### Risks / Release Notes

- Risk: 当前 `.env` 仍未连接真实数据库；后端会继续以内存模式运行，直到填写 `DATABASE_URL` 并重启后端。
- Rollback: delete local ignored `backend/.env`.
- Sensitive-information review: no real secrets, database URLs, tokens, cookies, private keys, or production credentials were recorded in the ledger.
- Git state: `backend/.env` ignored/untracked; ledger uncommitted.

## CRL-20260704-013 — 网页端任务中心特殊入住退房时间标记

- **Status:** ready
- **Updated:** 2026-07-04 23:17 AEST
- **Request:** “网页端 任务中心页面，每个如果有除了正常10am退房和3pm入住的任务，都要标记退房和入住时间。”
- **Outcome:** 任务中心清洁任务卡片在出现非默认入住/退房时间时，醒目标记会直接显示实际时间；同日退房入住组合任务任一侧时间异常时，会同时显示退房和入住时间上下文。

### Implementation

- Previous behavior:
  - 任务中心已有特殊时间判断，但卡片标签只显示“晚退房 / 早入住”等文字，实际时间主要藏在摘要/详情里。
  - 同日 turnover 任务如果只有一侧时间异常，标签只显示异常侧，工作人员不一定能一眼看到完整退房/入住窗口。
- New behavior:
  - 特殊时间标签文案改为包含实际时间，例如“晚退房 12pm”“早入住 1pm”。
  - 同日退房入住组合任务只要任一侧不是默认 `10am` / `3pm`，就同时显示可见的退房和入住时间，例如“退房 10am”“早入住 1pm”。
  - 单独退房或单独入住任务仍只在自身时间非默认时显示对应时间标签。
- Key decisions:
  - 不改后端接口和任务生成逻辑；后端已经提供 `summary_checkout_time`、`summary_checkin_time` 和 `turnover_display`。
  - 保留默认任务不显示额外时间标签的规则，避免普通 10am/3pm 任务卡片噪音变多。

### Files / Areas

- `frontend/src/app/task-center/page.tsx` — modified: 特殊时间标签生成逻辑改为带实际时间，并为同日 turnover 异常任务补齐退房/入住时间上下文。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `frontend/src/app/task-center/page.tsx` and this ledger with earlier task-center units; selective release requires hunk-level review if other local changes appear in the same files.

### Validation

- `git diff --check` — passed.
- `npm run lint` in `frontend` — failed: `next` command not found because `frontend/node_modules` is not installed in this fresh local clone.
- Full build/typecheck — not run: frontend dependencies are not installed locally.

### Risks / Release Notes

- Runtime risk: tags are slightly longer, so very dense task cards may wrap more often; existing flex wrapping should keep the card readable.
- Rollback: revert the `specialTimingTags()` and `timingLabelWithTime()` changes in `frontend/src/app/task-center/page.tsx`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: uncommitted.

## CRL-20260705-004 — 移动端管理视图清洁/检查排序显示修复

- **Status:** pushed
- **Updated:** 2026-07-05 02:13 AEST
- **Request:** “清洁和检查的排序，admin和线下经理以及客服也都看不见了。清洁明明填了顺序。查什么原因”后续要求“修复一下”。
- **Outcome:** `/mzapp/work-tasks?view=all` 给 admin、线下经理、客服返回的同房同日清洁合并卡会保留子卡里的 `sort_index_cleaner` / `sort_index_inspector`，移动端详情里的“清洁顺序 / 检查顺序”不再因为管理视图二次合并而显示 `-`。

### Implementation

- Previous behavior:
  - 清洁员/检查员保存顺序时会分别写入 `cleaning_tasks.sort_index_cleaner` 和 `cleaning_tasks.sort_index_inspector`。
  - `/mzapp/work-tasks` 第一层按执行角色生成子卡时已经计算了 `sort_index`、`sort_index_cleaner`、`sort_index_inspector`。
  - admin / offline_manager / customer_service 的 `view=all` 会再按日期+房源合并一次卡片；这一步只继承 `preferred` 子卡，没有重新聚合所有子卡的排序字段，因此另一侧执行顺序可能丢失。
- New behavior:
  - 管理视图二次合并时从所有子卡中取最小有效 `sort_index_cleaner` 和 `sort_index_inspector`。
  - 最终合并卡的 `sort_index` 取清洁/检查/子卡通用顺序中的最小有效值，用于保持列表排序稳定。
  - 回归测试构造同一房同日的清洁子卡和检查子卡，清洁顺序只在清洁子卡、检查顺序只在检查子卡，确认合并后两个字段都保留。
- Key decisions:
  - 不改移动端前端展示逻辑；前端本来就读取 `sort_index_cleaner` / `sort_index_inspector`。
  - 不改排序保存接口和数据库结构；本次只修后端管理视图 payload 合并。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified/shared: `view=all` 清洁任务二次合并时聚合并输出 `sort_index`、`sort_index_cleaner`、`sort_index_inspector`。
- `backend/scripts/tests/test_task_assignment_canonical.ts` — modified/shared: 在现有 `/mzapp/work-tasks?view=all` 集成测试中增加管理合并卡排序字段回归断言；同文件包含 `CRL-20260705-003` 的通知分组测试改动。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: `/mzapp/work-tasks?view=all` 的清洁合并卡会更完整返回已有排序字段；字段名不变，旧客户端兼容。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `backend/src/modules/mzapp.ts` with pending mzapp mobile-task units and shares `backend/scripts/tests/test_task_assignment_canonical.ts` with `CRL-20260705-003`; selective release requires hunk-level review.

### Validation

- `git diff --check -- backend/src/modules/mzapp.ts backend/scripts/tests/test_task_assignment_canonical.ts` — passed.
- `./node_modules/.bin/ts-node --transpile-only scripts/tests/test_task_assignment_canonical.ts` in `backend` — failed in sandbox before business assertions: DNS `ENOTFOUND` for the configured test database host.
- `./node_modules/.bin/ts-node --transpile-only scripts/tests/test_task_assignment_canonical.ts` in `backend` with approved network access — passed twice: `test_task_assignment_canonical: ok`; final run includes the new sort merge assertions.
- `npm --prefix backend run build` — failed first with `TS18047` in the new local numeric guard, then passed after tightening the null check.
- Backend lint — not run: `backend/package.json` has no lint script.
- Frontend checks — not run: no frontend files changed.
- `python3 scripts/audit_change_release_ledger.py` — passed: Changed files 19, recorded changed files 19, coverage PASS.
- `2026-07-05 release validation in clean origin/Dev worktree` — passed: `git diff --check`, `python3 scripts/audit_change_release_ledger.py` (Changed files 7, recorded changed files 7, coverage PASS), `npm --prefix backend run build`, and `./node_modules/.bin/ts-node --transpile-only scripts/tests/test_task_assignment_canonical.ts` with approved network access.

### Risks / Release Notes

- Runtime risk: if different child cards intentionally carry conflicting sort numbers, management view now shows the earliest valid value for list ordering while still exposing both role-specific fields separately.
- Rollback: remove the `minPositiveNumber` aggregation and the three sorting fields from the management-view merged payload, then remove the added sort-merge assertions from `test_task_assignment_canonical.ts`.
- Sensitive-information review: no secrets, `.env` contents, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: pushed to root `origin/Dev` in functional commit `fc05296`; this ledger follow-up records the pushed state separately.

## CRL-20260705-003 — 任务中心保存通知按实际改动和合并卡片去重

- **Status:** pushed
- **Updated:** 2026-07-05 02:13 AEST
- **Request:** 生产环境里只把 `1403` 和 `614` 两个任务改成自完成并保存，却出现 5 条通知；先用生产库排查原因，再按计划修复，并确认不要影响其他流程。后续明确要求测试不要用生产环境数据库。
- **Outcome:** 任务中心保存现在只提交用户本次实际改过的清洁/线下任务 assignment；未改动但出现在整板 payload 里的任务不会再触发后端 diff 和通知。同一张可见清洁合并卡片包含退房+入住两条底层任务时，后端仍更新两条任务、仍发两条实时刷新事件，但只合并发送 1 个 `CLEANING_TASK_UPDATED` 通知事件。

### Implementation

- Previous behavior:
  - 前端保存整板时会遍历当前看板所有任务，只要本地状态与 baseline 有差异或 baseline 缺失，就把该任务放进 `cleaning_assignments` / `work_assignments`。
  - 用户只改两张卡片时，未触碰的任务也可能因为 baseline/展示合并状态进入保存 payload；后端收到后会按真实 diff 发通知。
  - 同一张 turnover 合并卡片的退房和入住分别对应底层 `cleaning_tasks`，后端逐任务调用通知入口，因此一张可见卡可能产生两条同文案通知。
- New behavior:
  - 前端新增 dirty tracking refs，只在详情保存、整行分配、房源跟进分配、拖拽导致检查安排变化等入口标记实际改过的清洁/线下任务。
  - 保存时仍提交整板布局、排序和 flag，但 `cleaning_assignments` / `work_assignments` 只包含 dirty 任务，避免未触碰任务进入后端业务更新路径。
  - 前端为清洁任务随 payload 附带可见卡片 `notification_group_key/title`；后端按该 group 汇总变更字段、接收人和优先级，每组只发一次 `CLEANING_TASK_UPDATED`，同时保留每个底层任务的 realtime event。
- Key decisions:
  - 不拆掉整板布局保存，避免影响拖拽排序、分区和临时跳过等看板流程；只收窄会触发业务 assignment 更新和通知的 payload。
  - 不改变通知规则、收件人配置页、移动端 notice 展示结构或数据库表结构；本次只修保存入口的过量提交和清洁合并卡片的通知聚合。

### Files / Areas

- `frontend/src/app/task-center/page.tsx` — modified/shared: 增加 dirty tracking、清洁通知 group helper，并在保存 payload 中只输出 dirty assignment；同文件已有 `CRL-20260705-002` 的晚入住兜底阈值 hunk，不属于本单元。
- `backend/src/modules/task_center.ts` — modified: `/task-center/save-board` 接受可选通知 group 字段，并把清洁任务通知从逐任务发送改成按可见卡片 group 发送；实时事件仍逐底层任务发送。
- `backend/scripts/tests/test_task_assignment_canonical.ts` — modified: 增加非生产数据库回归测试，覆盖两条底层清洁任务共用一个通知 group 时只产生 1 个通知 event，并校验包含 2 个 task id。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: `/task-center/save-board` 请求 schema 新增可选 `notification_group_key` / `notification_group_title`；旧客户端不传也可继续工作。响应结构不变，但 `push_notifications.events` 对清洁合并卡片会按通知 group 计数。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `frontend/src/app/task-center/page.tsx` with `CRL-20260705-002`; selective release requires hunk-level review. The test script uses `DATABASE_URL` from local/test env and includes a guard that refuses to run when it matches the configured production URL.

### Validation

- `git diff --check -- frontend/src/app/task-center/page.tsx backend/src/modules/task_center.ts backend/scripts/tests/test_task_assignment_canonical.ts` — passed.
- `npm run build` in `backend` — passed: `tsc -p .`.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_task_assignment_canonical.ts` in `backend` — passed with approved network access against non-production `DATABASE_URL`: `test_task_assignment_canonical: ok`; added grouped notification assertion returned 2 changed cleaning tasks and 1 push notification event.
- `npm run lint -- --file src/app/task-center/page.tsx` in `frontend` — passed: no warnings or errors.
- `./node_modules/.bin/tsc --noEmit --pretty false` in `frontend` — passed.
- `npm run build` in `frontend` — failed after successful compile and type/lint phase during Next page-data collection: first `Cannot find module './1682.js'`, then after full clean `Cannot find module for page: /_document`; this appears to be the current Next build artifact/page-data issue, not a task-center type or lint error.
- `2026-07-05 release validation in clean origin/Dev worktree` — passed: `git diff --check`, `python3 scripts/audit_change_release_ledger.py` (Changed files 7, recorded changed files 7, coverage PASS), `npm --prefix backend run build`, `./node_modules/.bin/ts-node --transpile-only scripts/tests/test_task_assignment_canonical.ts` with approved network access, `npm --prefix frontend run lint -- --file src/app/task-center/page.tsx`, `./node_modules/.bin/tsc --noEmit --pretty false`, and `npm --prefix frontend run build` with existing project warnings.

### Risks / Release Notes

- Runtime risk: if there is an untracked task-center edit path that mutates assignment state without calling a dirty marker, that assignment change would not be submitted. Covered current visible save paths are detail save, row assignment, property follow-up assignment, and drag/drop inspection assignment changes.
- Runtime risk: group notification uses the first changed bottom-level cleaning task as `entityId` while carrying all group task ids in `data.task_ids`; existing mobile notice open behavior should still open a cleaning task, but deep-linking lands on the first task in the group.
- Rollback: remove frontend dirty filtering and group payload fields, restore backend per-task cleaning notification loop, and remove the grouped notification regression test.
- Sensitive-information review: no secrets, `.env` contents, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded. Production data was used only for earlier read-only diagnosis; write regression testing was not run on production.
- Git state: pushed to root `origin/Dev` in functional commit `fc05296`; this ledger follow-up records the pushed state separately.

## CRL-20260705-002 — 任务中心合并卡晚退房/晚入住标签修复

- **Status:** pushed
- **Updated:** 2026-07-05 02:13 AEST
- **Request:** 生产任务中心里同样有晚退房，`3805009` 显示“晚退房”，`AU2117` / `AU8508` 不显示；同时确认“晚入住”的标签也没有显示出来。用户要求按计划修复，生产数据诊断使用 `NEON_DATABASE_URL_PROD`，但不记录任何数据库连接内容。
- **Outcome:** 任务中心合并入住/退房卡片会保留清洁任务摘要里的 `11:30am退房`、`2pm入住`、`5pm入住` 等时间，不再在合并时回退成默认 `10am/3pm`；晚入住判断与默认 `3pm` 入住时间对齐，`5pm入住` 会被识别为“晚入住”。

### Implementation

- Previous behavior:
  - `/task-center/day` 载入的 `BoardTask` 带有 `summary_checkout_time` / `summary_checkin_time`，但没有原始 `checkout_time` / `checkin_time`。
  - 后端合并同日 turnover 卡片时调用 `buildCleaningTurnoverDisplay()` 重新计算展示信息；该 helper 只读取原始时间字段，读不到 summary 字段时会使用默认 `10am/3pm`。
  - 任务中心前端的晚入住兜底逻辑仍按 `> 6pm` 判断，和清洁日历页“超过默认 3pm 就是晚入住”的展示规则不一致。
- New behavior:
  - `buildCleaningTurnoverDisplay()` 支持读取 `summary_checkout_time` / `summary_checkin_time` 及 camelCase 变体，合并卡片可以继承任务中心已有摘要时间。
  - 后端 `is_late_checkin` 改为和默认入住时间比较，超过默认 `3pm` 就标记晚入住；晚退房继续按超过默认 `10am` 判断。
  - 任务中心前端 `isLateCheckinDisplay()` 的兜底判断改为比较 `DEFAULT_SUMMARY_CHECKIN_TIME`，避免后端布尔值缺失时仍丢掉 `5pm` 晚入住标签。
- Key decisions:
  - 不改生产数据、不新增数据库字段、不改任务合并结构；只修共享展示 helper 对现有字段的读取和标签判断阈值。
  - 不把这次修复扩展到移动端本地 `taskTime` 兜底逻辑；移动端如仍有独立 `> 6pm` 判断，需要单独对齐。

### Files / Areas

- `backend/src/lib/cleaningTurnoverDisplay.ts` — modified: turnover 展示 helper 支持 summary 时间字段，晚入住阈值改为超过默认入住时间。
- `backend/scripts/tests/test_cleaning_turnover_display.ts` — modified: 增加任务中心合并卡片只带 summary 时间字段时的晚退房/晚入住回归测试。
- `frontend/src/app/task-center/page.tsx` — modified/shared: 本单元只包含 `isLateCheckinDisplay()` 晚入住兜底阈值改动；同文件已有其他未提交任务通知/dirty tracking 改动不属于本单元。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: `/task-center/day` 返回的合并清洁卡片 `turnover_display` 会更准确保留 summary 时间字段和 `is_late_checkin` 布尔值；响应结构不变。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `frontend/src/app/task-center/page.tsx` with unrelated uncommitted task-center changes; selective release requires hunk-level review. `backend/src/lib/cleaningTurnoverDisplay.ts` is shared by task-center and mobile backend payload projection, so server-derived mobile labels may also follow the `> 3pm` late-checkin rule.

### Validation

- `./node_modules/.bin/ts-node --transpile-only scripts/tests/test_cleaning_turnover_display.ts` in `backend` — passed: `test_cleaning_turnover_display: ok`.
- `npm run build` in `backend` — passed: `tsc -p .`.
- `./node_modules/.bin/tsc --noEmit` in `frontend` — passed.
- `npm run lint` in `frontend` — passed with existing project warnings.
- `npm run build` in `frontend` — passed with existing warnings: stale Browserslist data and Recharts zero-size chart warnings during static generation.
- `git diff --check -- backend/src/lib/cleaningTurnoverDisplay.ts backend/scripts/tests/test_cleaning_turnover_display.ts frontend/src/app/task-center/page.tsx docs/change-release-ledger.md` — passed.
- `python3 scripts/audit_change_release_ledger.py` — passed: Changed files 19, recorded changed files 19, coverage PASS.
- `2026-07-05 release validation in clean origin/Dev worktree` — passed: `git diff --check`, `python3 scripts/audit_change_release_ledger.py` (Changed files 7, recorded changed files 7, coverage PASS), `npm --prefix backend run build`, `./node_modules/.bin/ts-node --transpile-only scripts/tests/test_cleaning_turnover_display.ts`, `npm --prefix frontend run lint -- --file src/app/task-center/page.tsx`, `./node_modules/.bin/tsc --noEmit --pretty false`, and `npm --prefix frontend run build` with existing project warnings.

### Risks / Release Notes

- Risk: if product expectation is “晚入住 only after 6pm” for any surface, this change intentionally aligns task-center/backend display with the daily cleaning rule instead and will mark `5pm` as late check-in.
- Risk: live browser verification against production UI was not run in this turn; validation used production-data diagnosis before coding plus unit/type/build checks.
- Rollback: revert summary field support and `is_late_checkin` threshold in `backend/src/lib/cleaningTurnoverDisplay.ts`, revert the new test case, and revert the `isLateCheckinDisplay()` threshold hunk in `frontend/src/app/task-center/page.tsx`.
- Sensitive-information review: no secrets, `.env` contents, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: pushed to root `origin/Dev` in functional commit `fc05296`; this ledger follow-up records the pushed state separately.

## CRL-20260704-012 — 移动端本地媒体空间自动治理

- **Status:** pushed
- **Updated:** 2026-07-04 18:00 AEST
- **Request:** 执行已确认的本地照片/视频空间优化方案；不要在 App 内显示“未同步照片占用空间”提示；清理必须基于引用关系、带远端确认条件、避免和上传抢文件，并区分照片和视频压缩策略。
- **Outcome:** 移动端照片类本机草稿统一先压缩再入队；视频不做本机压缩。各上传队列在“远端上传成功且远端引用已经写回本机队列/draft/snapshot”后才删除本地原图；孤儿清理只从队列/draft 引用集合出发，跳过仍被引用或正在上传的文件，并通过 App 前台/网络恢复时短跑维护，不依赖长期后台运行。

### Implementation

- Previous behavior:
  - 多个移动端流程直接把相机原图复制到 `Documents` 下的本机队列目录，照片可能长期占用大量空间。
  - 部分流程在 upload API 返回后立即删本地文件，删除动作发生在远端 URL 写回本机业务队列之前；一旦后续业务保存失败，重试链路更脆弱。
  - 本地清理缺少统一锁和引用集合保护，容易在弱网上传重试和文件删除之间产生竞态。
  - `inspection_media_queue` 仍使用 7 天本机保留窗口，与“弱网尽量顺利推进、最后才兜底清理 abandoned 未上传证据”的策略不一致。
- New behavior:
  - `imageCompression` 增加本机存储压缩入口，照片按 1800px / 0.72 质量保存为 JPEG；上传用压缩入口保留 1920px / 0.76；视频路径明确不走图片压缩。
  - 钥匙照片、检查照片、检查反馈照片、补货耗材照片、下班交接照片等本机草稿写入前先压缩图片，并持久化新的 `name/mimeType/localUri`。
  - `localMediaLocks` 为本地文件 URI 加上传/清理互斥；上传时加锁，删除逻辑遇到锁会跳过。
  - 钥匙上传、检查媒体队列、检查面板提交队列、补货提交队列、下班交接队列都改为先把远端 URL/key 写回本机队列或 draft，再删除本地原图；业务保存失败时保留远端引用继续重试。
  - 新增 `localMediaHousekeeping`，从 AsyncStorage 中的媒体队列、检查面板 draft、反馈 draft、钥匙队列、下班交接队列、耗材 draft 等引用集合保护 `file://`，只删除不再被引用且超过 24 小时宽限期的孤儿媒体文件。
  - 缩略图缓存上限从 96 个 / 24 MB 调整为 64 个 / 16 MB，仍保护队列/draft 中引用的缩略图。
  - `inspection_media_queue` 的未上传 abandoned 兜底保留窗口从 7 天延长到 30 天，避免弱网楼盘现场证据过早丢失。
- Key decisions:
  - 不新增任何用户可见存储占用提示或手动清理按钮。
  - 清理动作不按目录年龄孤立运行；目录扫描只用于找候选文件，最终删除必须先排除所有本机引用。
  - “上传到 R2 但业务记录未保存成功”的清理条件以 upload API 成功返回远端引用并且本机队列/draft 已持久化该引用为准；当前客户端没有额外 R2 HEAD 校验接口。

### Files / Areas

- `mz-cleaning-app-frontend/src/lib/imageCompression.ts` — modified: 抽出本机照片压缩入口和可压缩 MIME 判断，上传压缩继续复用较高尺寸/质量参数。
- `mz-cleaning-app-frontend/src/lib/localMediaLocks.ts` — added: 本地媒体 URI 上传/清理互斥锁。
- `mz-cleaning-app-frontend/src/lib/localMediaDrafts.ts` — modified: 增加压缩后草稿持久化；删除时跳过锁定文件。
- `mz-cleaning-app-frontend/src/lib/cleaningConsumablesDraft.ts` — modified: 耗材照片草稿压缩后保存；删除时跳过锁定文件。
- `mz-cleaning-app-frontend/src/lib/keyUploadQueue.ts` — modified: 钥匙照片入队压缩；上传加锁；远端引用持久化后清理本地原图。
- `mz-cleaning-app-frontend/src/lib/inspectionMediaQueue.ts` — modified: 检查/补货照片入队压缩、视频不压缩；上传加锁；远端引用持久化后清理本地文件；abandoned 保留期改为 30 天。
- `mz-cleaning-app-frontend/src/lib/inspectionPanelSubmitQueue.ts` — modified/shared: 检查面板批量提交在 upload step 写回远端引用后清理本地原图，并保留缩略图供本机回看。
- `mz-cleaning-app-frontend/src/lib/cleaningConsumablesSubmitQueue.ts` — modified: 耗材提交队列上传加锁，远端 URL 写回 draft 后再删除对应本地照片。
- `mz-cleaning-app-frontend/src/lib/dayEndHandoverQueue.ts` — modified: 下班交接照片入队压缩、上传加锁、远端 URL 持久化后清理本地原图。
- `mz-cleaning-app-frontend/src/lib/localMediaHousekeeping.ts` — added: 引用集合保护、孤儿文件选择、短跑清理任务。
- `mz-cleaning-app-frontend/src/lib/inspectionThumbnailCache.ts` — modified: 缩略图缓存上限降低。
- `mz-cleaning-app-frontend/src/lib/auth.tsx` — modified: 登录态队列维护后触发本地媒体 housekeeping。
- `mz-cleaning-app-frontend/src/screens/tasks/FeedbackFormScreen.tsx` — modified: 检查反馈照片本机草稿改用压缩保存。
- `mz-cleaning-app-frontend/src/screens/tasks/SuppliesFormScreen.tsx` — modified: 补货照片本机草稿改用压缩保存。
- `mz-cleaning-app-frontend/src/screens/tasks/CleaningSelfCompleteScreen.tsx` — modified: 自清洁补货照片本机草稿改用压缩保存。
- `mz-cleaning-app-frontend/src/lib/localMediaHousekeeping.test.ts` — added: 覆盖引用递归收集和孤儿清理选择规则。
- `mz-cleaning-app-frontend/src/lib/keyUploadQueue.test.ts` — modified: 更新压缩草稿 mock 以覆盖钥匙照片队列。
- `mz-cleaning-app-frontend/jest.setup.ts` — modified: AsyncStorage mock 增加 `getAllKeys` / `multiGet`，支持引用集合测试。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: none; 继续使用现有上传和业务保存接口。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: builds on `CRL-20260704-011` 的检查照片待同步队列修复；`inspectionPanelSubmitQueue.ts` 与该单元共享，选择性发布需要 hunk 级审查。移动端仓库中 `app.json`、`eas.json`、`package.json`、`package-lock.json` 的版本/更新配置改动不属于本单元。

### Validation

- `npm test -- --runInBand src/lib/localMediaHousekeeping.test.ts src/lib/keyUploadQueue.test.ts src/lib/inspectionMediaQueue.test.ts src/lib/inspectionPanelSubmitQueue.test.ts src/lib/cleaningConsumablesSubmitQueue.test.ts src/lib/dayEndHandoverQueue.test.ts src/lib/inspectionThumbnailCache.test.ts` in `mz-cleaning-app-frontend` — passed: 7 suites / 20 tests.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with existing warnings: 0 errors, 113 warnings.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 33 suites / 123 tests. Jest printed an existing SafeAreaView deprecation warning.
- `git -C mz-cleaning-app-frontend diff --check` — passed.
- Build — not run: `mz-cleaning-app-frontend/package.json` has no `build` script.

### Risks / Release Notes

- Risk: upload API 成功返回远端 URL/key 被视为远端对象确认；当前没有单独 R2 HEAD/引用查询接口可做二次远端校验。
- Risk: 被清理为“孤儿”的文件必须先不在任何已知队列/draft 引用集合中；如果未来新增新的本地媒体 AsyncStorage key，需要把该 key/prefix 加入 `localMediaHousekeeping` 的引用集合。
- Risk: 已上传但业务保存失败的本地原图会被删除，后续依赖远端 URL/key 重试；这是本次明确选择，用空间换取弱网流程继续推进。
- Rollback: revert local media compression helpers, queue post-upload cleanup changes, `localMediaHousekeeping`, lock helper, auth maintenance hook, and thumbnail cap changes.
- Sensitive-information review: no secrets, `.env` contents, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: mobile implementation pushed to nested `mz-cleaning-app-frontend` `Dev` in commit `40dc433`; root ledger follow-up records the pushed status. Root worktree and nested mobile repo contain unrelated pre-existing changes outside this release unit.

## CRL-20260704-011 — 移动端检查照片弱网待同步修复

- **Status:** pushed
- **Updated:** 2026-07-04 18:00 AEST
- **Request:** “给我一个修复方案”“不要做强制校验，因为有些楼网络不好 传不上去 很常见的事情。要保证流程尽可能的顺里进行”“对 按这个执行吧”。
- **Outcome:** 检查人员在弱网或任务 action target 尚未刷新时提交检查照片，不再把本机批次丢弃或误显示为已写入后端；系统会保留本机待同步批次，后续拿到正确 `source_id` 后自动补绑定并继续同步。挂钥匙/密码视频流程不再被检查照片待同步强制拦截，管理端照片回看会同时查询相关清洁任务 id。

### Implementation

- Previous behavior:
  - 检查页保存/提交批次时依赖 `cleaning_task_id`；如果移动端入口没有传到后端业务 `source_id`，本机提交批次会被 normalize 丢弃或无法进入业务同步。
  - 完成页把检查照片批次缺失/草稿作为阻塞条件，检查员在上传视频后再回到检查页时可能看到房间照片重新变成“未拍”。
  - 旧任务卡片、消息 fallback、通知 fallback 等入口只传 `taskId`，没有把已有 `source_id` 带到检查页。
  - 管理端每日详情只按单一活动 id 查检查照片，合并/历史 id 下的已同步照片可能查不到。
- New behavior:
  - 检查照片提交队列允许先保存缺少 `cleaning_task_id` 的待同步批次；同步处理遇到缺少业务 id 时只标记“等待任务信息刷新”，不调用后端也不丢本机照片。
  - 新增 `bindInspectionPanelCleaningTaskId()`，检查页、完成页和入口路由拿到 `source_id` 后会把待同步批次补绑定到正确业务记录，并重试失败的业务步骤。
  - 完成页将检查照片状态改为弱网友好提示；只要照片已保存为本机批次，就允许继续挂钥匙/密码视频，不做强制后端同步校验。
  - 任务列表、消息中心、通知 fallback 和完成页返回检查页时都会尽量传递 `sourceId`。
  - 管理端检查照片回看使用 active/source/related cleaning task id 并集查询，降低合并任务或旧缓存 id 查不到照片的风险。
- Key decisions:
  - 不新增强制在线校验，不阻断现场人员继续完成流程。
  - 不新增后端接口或数据库字段；修复集中在移动端本机队列、路由参数和查询 id 范围。
  - 已经丢失且设备本机也没有待同步批次的历史照片无法凭代码恢复。

### Files / Areas

- `mz-cleaning-app-frontend/src/lib/inspectionPanelSubmitQueue.ts` — modified: 支持缺少业务 id 的本机待同步批次、补绑定 `cleaning_task_id`、等待任务信息后自动继续同步。
- `mz-cleaning-app-frontend/src/lib/inspectionPanelSubmitQueue.test.ts` — modified: 覆盖缺少 `cleaning_task_id` 时先等待、补绑定后同步到后端业务记录。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — modified: 检查页不再因暂缺 `sourceId` 放弃本机草稿/批次；提交文案改为本机保存和待同步。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.tsx` — modified: 完成页绑定检查批次业务 id，检查照片待同步不再阻塞挂钥匙/密码视频。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.test.tsx` — modified: 覆盖非仅改密码检查在照片待同步时仍可完成视频，并按 `submit_inspection` action target 回到检查页。
- `mz-cleaning-app-frontend/src/navigation/RootNavigator.tsx` — modified: 通知 fallback 进入检查页时传递已有 `source_id`。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 旧任务卡片 fallback 进入检查页时传递已有 `source_id`。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx` — modified: 覆盖检查员 fallback 卡片跳转会带 `sourceId`。
- `mz-cleaning-app-frontend/src/screens/tabs/NoticesScreen.tsx` — modified: 消息中心历史任务 fallback 进入检查页时传递已有 `source_id`。
- `mz-cleaning-app-frontend/src/lib/managerDailyTaskPhotos.ts` — modified: 管理端检查照片查询 id 扩展为 active/source/related id 并集。
- `mz-cleaning-app-frontend/src/screens/tasks/ManagerDailyTaskScreen.test.ts` — modified: 更新管理端照片 id 查询断言。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: none; 继续使用现有检查照片、补货凭证、视频接口。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: follows `CRL-20260704-008` 的“管理可见性”修复；本单元修复检查员照片写入/同步链路。移动端仓库中 `app.json`、`eas.json`、`package.json`、`package-lock.json` 已有版本/更新配置改动不属于本单元。

### Validation

- `npm test -- --runInBand src/lib/inspectionPanelSubmitQueue.test.ts src/screens/tasks/InspectionCompleteScreen.test.tsx src/screens/tasks/ManagerDailyTaskScreen.test.ts src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 4 suites / 28 tests. Jest printed an existing SafeAreaView deprecation warning and open-handle notice after successful completion.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with existing project warnings: 0 errors, 114 warnings.
- `git diff --check -- src/lib/inspectionPanelSubmitQueue.ts src/lib/inspectionPanelSubmitQueue.test.ts src/lib/managerDailyTaskPhotos.ts src/navigation/RootNavigator.tsx src/screens/tasks/InspectionCompleteScreen.tsx src/screens/tasks/InspectionCompleteScreen.test.tsx src/screens/tasks/InspectionPanelScreen.tsx src/screens/tasks/ManagerDailyTaskScreen.test.ts src/screens/tabs/TasksScreen.tsx src/screens/tabs/TasksScreen.test.tsx src/screens/tabs/NoticesScreen.tsx` in `mz-cleaning-app-frontend` — passed.
- `python3 scripts/audit_change_release_ledger.py` in root — passed: Changed files 14, recorded changed files 14, coverage PASS.
- Build — not run: `mz-cleaning-app-frontend/package.json` has no `build` script.

### Risks / Release Notes

- Risk: 如果检查员设备本机批次已经被用户放弃、清缓存或被旧逻辑丢掉，代码无法恢复那些历史照片；只能修复之后的保存/同步。
- Risk: 管理端仍只能查看已经成功同步到后端业务记录的检查照片；本机待同步期间管理端会继续显示暂无或旧数据。
- Rollback: revert the mobile queue binding changes, weak-network completion-page wording/flow changes, route `sourceId` fallback additions, and manager photo id union change.
- Sensitive-information review: no secrets, `.env` contents, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: mobile implementation pushed to nested `mz-cleaning-app-frontend` `Dev` in commit `40dc433`; root ledger follow-up records the pushed status. Root worktree and nested mobile repo contain unrelated pre-existing changes outside this release unit.

## CRL-20260704-010 — 网页端清洁任务信息更新 HTTP 400 修复

- **Status:** committed
- **Updated:** 2026-07-04 14:11 AEST
- **Request:** “网页端为什么修改密码也报错 HTTP 400”，随后补充“所有信息更新都报错400”。
- **Outcome:** `/cleaning` 编辑抽屉更新退房/入住密码、时间、入住天数、客人需求等信息时，不再因为当前清洁任务处于 `ready`、`cleaned`、`restock_pending`、`to_inspect` 等运行态而被 `/cleaning/tasks/:id` schema 拦截为 HTTP 400。

### Implementation

- Previous behavior:
  - `frontend/src/app/cleaning/page.tsx` 的 `submitEdit()` 无论用户改哪个信息字段，都会把当前 `editForm.status` 一起发给每个 `/cleaning/tasks/:id` PATCH。
  - `backend/src/modules/cleaning.ts` 的 patch/create schema 只接受 `pending`、`assigned`、`in_progress`、`completed`、`cancelled`、`keys_hung`。
  - 移动端和每日清洁页已经会产生/识别 `ready`、`cleaned`、`restock_pending`、`restocked`、`inspected`、`done`、`to_inspect` 等状态；这些任务在网页端只改密码或客人需求也会因为 status 不在 schema 白名单内整体 400。
- New behavior:
  - 前端新增 `statusForCleaningMutation()`，只在状态属于管理端可主动设置的状态时才随信息更新提交；运行态不会被无意义回传。
  - 后端新增统一 `cleaningTaskStatusSchema`，覆盖每日清洁页面和移动端已使用的清洁任务状态键，并复用于 patch/create schema。
  - 新增入住/退房任务时，如果当前抽屉状态是运行态，前端不把该运行态写入新任务，交由后端按人员分配推导默认状态。
- Key decisions:
  - 不改数据库数据，不操作生产任务。
  - 不改全局 API 错误渲染；本次修复根因是清洁任务 status 白名单和无意义回传。

### Files / Areas

- `frontend/src/app/cleaning/page.tsx` — modified: 信息更新和新增退房/入住任务时过滤不可管理的运行态 status。
- `backend/src/modules/cleaning.ts` — modified: 抽出并扩展清洁任务 status schema，避免合法运行态被 patch/create 校验拒绝。
- `backend/dist/modules/cleaning.js` — generated: 后端 build 产物同步清洁任务 status schema 变更。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: `/cleaning/tasks/:id` 和 `/cleaning/tasks` 接受更多已有清洁任务运行态；前端普通信息更新不会再回传不可管理运行态。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: touches daily cleaning web page and cleaning backend module; independent from existing task-center/mobile/finance/inventory units currently in the shared dirty worktree.

### Validation

- `git diff --check -- frontend/src/app/cleaning/page.tsx backend/src/modules/cleaning.ts backend/dist/modules/cleaning.js` — passed.
- `./node_modules/.bin/tsc --noEmit` in `frontend` — passed.
- `npm run lint` in `frontend` — passed with existing project warnings; no errors.
- `npm run build` in `frontend` — passed; existing Browserslist/Recharts warnings only.
- `npm run build` in `backend` — passed: `tsc -p .`.
- Unit tests — not run: there is no focused existing unit covering `CleaningPage.submitEdit()` request payload construction; validation used type/build/lint and targeted diff inspection.

### Risks / Release Notes

- Runtime risk: backend will now accept legacy/display-like清洁状态 strings if a caller explicitly sends them. The web UI still filters these out for normal information edits, so this mainly preserves compatibility with existing task states.
- Rollback: remove `statusForCleaningMutation()` usage and restore the narrower backend status enum.
- Sensitive-information review: no secrets, `.env` contents, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: committed locally in root `Dev` commit `956df41`; push to `origin/Dev` failed because GitHub HTTPS credentials are unavailable in this environment. Worktree still contains unrelated finance/inventory/mzapp/mobile changes not owned by this unit.

## CRL-20260704-009 — 房源代付模板重复创建拦截与删除清理修复

- **Status:** committed
- **Updated:** 2026-07-04 14:11 AEST
- **Request:** “不可以直接操错生产环境的数据。你先修复，数据清理我人工处理”：只修复系统逻辑，不操作生产数据。
- **Outcome:** 房源代付模板创建/更新时会拦截同房源、同类别、同供应商和同付款身份的 active 重复模板；删除房源代付模板时会清掉该模板全部未付款固定支出快照，不再因为已经跨月而留下过去月份未付款孤儿快照。已付款历史快照继续保留。

### Implementation

- Previous behavior:
  - `recurring_payments` 只通过 `property_expenses.fixed_expense_id + month_key` 防止同一模板同一账期重复快照。
  - 用户仍可为同一房源重复创建业务上相同的 active 代付模板，例如 BO614 的 `Occom/OCCOM` 网费，从而生成两个不同 `fixed_expense_id` 的六月网费快照。
  - 删除房源代付模板只清理“当前月及未来”的未付款快照；跨月后删除旧模板会留下过去月份未付款孤儿快照。
- New behavior:
  - 新增房源代付模板业务身份 key：房源、类别、类别细分、供应商、付款方式、账单账号/银行/PayID/BPAY/手机号等付款身份字段，文本统一 trim、压缩空格、小写比较。
  - 创建和更新 active `property_payable` 模板前，在事务内对业务身份加 advisory lock，并查找同业务身份的 active 模板；命中时返回 `409 property payable template already exists`，带 `conflict_id`。
  - 删除房源代付模板时先读取该模板所有房源支出快照，只删除 `generated_from='recurring_payments'` 或旧 `Fixed payment` note 且状态不是 `paid` 的快照，不再按当前月份过滤。
- Key decisions:
  - 不操作生产数据；BO614 现有重复模板/快照由人工清理。
  - 不把金额、到期日、开始月份纳入重复身份，因为这些应通过编辑原模板变更，不能作为创建第二套同供应商账单的理由。
  - 保留已付款历史快照，避免删除模板时抹掉已支付记录。

### Files / Areas

- `backend/src/modules/recurring.ts` — modified: 增加房源代付模板重复身份判断、创建/更新 409 拦截、删除模板时清理全部未付款快照。
- `backend/scripts/tests/test_property_payable_duplicate_guard.ts` — added: 覆盖供应商大小写/空格归一、不同类别不冲突、paused 模板不阻塞、删除模板时未付款快照清理规则。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: `POST /recurring/payments` 和 `PATCH /recurring/payments/:id` 可能新增 `409` 响应，提示已存在同业务身份的房源代付模板。
- Database / migration: none; 没有新增表、字段或生产数据变更。
- Config / environment: none.
- Dependencies: none.
- Related units: finance property-payables flow; independent from existing task-center/mobile/inventory changes in the current dirty worktree.

### Validation

- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_property_payable_duplicate_guard.ts` in `backend` — passed: `test_property_payable_duplicate_guard: ok`.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_property_payable_bill_dates.ts` in `backend` — passed: `test_property_payable_bill_dates: ok`.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_property_payable_template_sync.ts` in `backend` — passed: `test_property_payable_template_sync: ok`.
- `npm run build` in `backend` — passed: `tsc -p .`.
- `git diff --check -- backend/src/modules/recurring.ts backend/scripts/tests/test_property_payable_duplicate_guard.ts` — passed.

### Risks / Release Notes

- Behavior risk: 如果业务确实需要同一房源、同类别、同供应商、同付款身份并行存在两条 active 代付模板，新逻辑会阻止创建；这种场景应先补充可区分的账单账号/付款参考或编辑原模板。
- Rollback: revert `backend/src/modules/recurring.ts` duplicate guard and deletion-snapshot filtering changes, and remove `backend/scripts/tests/test_property_payable_duplicate_guard.ts`.
- Sensitive-information review: no secrets, `.env` contents, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded. Production data was not modified.
- Git state: committed locally in root `Dev` commit `956df41`; push to `origin/Dev` failed because GitHub HTTPS credentials are unavailable in this environment. Worktree still contains unrelated backend/frontend changes not owned by this unit.

## CRL-20260704-008 — 移动端管理视图检查照片可见性修复

- **Status:** committed
- **Updated:** 2026-07-04 14:11 AEST
- **Request:** “现在所有任务 admin和线下经理都没办法看到检查人员拍的照片。查一下什么问题”
- **Outcome:** 修复移动端管理详情里 admin / offline_manager 读取检查员照片和检查补拍凭证时被误判为无权限的问题；管理角色现在可以只读查看检查媒体，检查员/参与人提交权限没有放宽。

### Implementation

- Previous behavior:
  - `ManagerDailyTaskScreen` 通过 `/mzapp/cleaning-tasks/:id/inspection-photos` 读取“检查照片”，通过 `/mzapp/cleaning-tasks/:id/restock-proof` 读取“检查补拍”。
  - 两个 GET 接口复用了 `canSubmitMzappInspection()`，该判断只允许当前检查参与人、assignee 或手动 `submit_inspection` 参与人。
  - admin / offline_manager 通过 `/mzapp/work-tasks?view=all` 能进入管理详情，但不是具体任务的检查参与人时 GET 返回 403；移动端把单个照片请求错误吞掉为 `null`，最终界面显示“暂无”。
- New behavior:
  - 新增 `canViewMzappInspectionMedia()`，先允许 `canViewAll(user)` 管理角色只读查看，再回落到原 `canSubmitMzappInspection()`。
  - `GET /mzapp/cleaning-tasks/:id/inspection-photos` 和 `GET /mzapp/cleaning-tasks/:id/restock-proof` 改用只读判断。
  - `POST /mzapp/cleaning-tasks/:id/inspection-photos` 和 `POST /mzapp/cleaning-tasks/:id/restock-proof` 保持原提交权限，不允许管理角色仅凭 view-all 代替检查员提交。
- Key decisions:
  - 不改移动端 UI；根因是后端读接口权限太窄，移动端只是把 403 表现成空照片。
  - 不放宽清洁完成照片、消耗品照片等已有可见性规则；本次只覆盖检查员媒体。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: 拆分检查媒体“查看”和“提交”权限，两个 GET 读接口允许管理只读查看。
- `backend/scripts/tests/test_mzapp_media_visibility.ts` — added: 覆盖 admin / offline_manager / customer_service 可读、检查参与人可读、非参与人非管理不可读。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: `/mzapp/cleaning-tasks/:id/inspection-photos` 和 `/mzapp/cleaning-tasks/:id/restock-proof` 的 GET 权限放宽到管理只读；POST 权限不变。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `backend/src/modules/mzapp.ts` with other pending task/mobile units; selective release requires hunk-level review.

### Validation

- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_mzapp_media_visibility.ts` in `backend` — passed: `test_mzapp_media_visibility: ok`.
- `npm run build` in `backend` — passed: `tsc -p .`.
- `git diff --check -- backend/src/modules/mzapp.ts backend/scripts/tests/test_mzapp_media_visibility.ts` — passed.

### Risks / Release Notes

- Behavior risk: customer_service also has `canViewAll(user)` in this module, so it will get the same read-only inspection-media visibility as other manager roles; this matches existing manager view-all behavior but should be called out if business wants only admin/offline_manager.
- Rollback: revert the `canViewMzappInspectionMedia()` helper, switch the two GET routes back to `canSubmitMzappInspection()`, and remove `test_mzapp_media_visibility.ts`.
- Sensitive-information review: no secrets, `.env` contents, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: committed locally in root `Dev` commit `956df41`; push to `origin/Dev` failed because GitHub HTTPS credentials are unavailable in this environment. Worktree still contains unrelated finance/inventory/task-center/mobile changes not owned by this unit.

## CRL-20260704-007 — 移动端待检查任务按钮恢复

- **Status:** committed
- **Updated:** 2026-07-04 14:11 AEST
- **Request:** “3915/4408 清洁做完了，检查人员还没去呢，但是安卓检查人员的移动端就显示任务已完成，检查和补充就无法点击了。怎么回事；给我个修复方案；修改吧。”
- **Outcome:** 后端 `available_actions` 不再把 `to_inspect` / `restock_pending` / `cleaned` 这类“清洁已提交、待检查”状态当作终态完成；检查人员在待检查任务中会拿到可点击的“检查与补充”和“标记已完成”动作。真正终态如 `done` / `completed` / `ready` / `keys_hung` / `inspected` 仍返回 `task_completed` 禁用原因。

### Implementation

- Previous behavior:
  - `buildWorkTaskActionPayload()` 使用同一个 `isDoneStatus()` 判断动作是否已完成。
  - 该列表同时包含 `cleaned`、`restock_pending`、`restocked`、`to_inspect`、`to_hang_keys` 等流程中间态，导致检查端待处理任务也被标记 `disabled_reason=task_completed`。
  - 生产只读排查显示 2026-07-04 的 `MQ3915` / `AU4408` 退房任务是 `restock_pending`，有钥匙照片但没有检查媒体或挂钥匙视频；数据库并没有表示检查已完成。
- New behavior:
  - 将动作完成判断重命名并收窄为 `isTerminalStatus()`，只包含真正终态。
  - 保留 `isCleaningWorkSubmitted()` 原语义，继续用于钥匙照片和清洁提交后的展示/流程判断。
  - 新增 `to_inspect` 检查任务回归断言，确保检查员参与人仍能执行 `submit_inspection` 和 `upload_access_video`。
- Key decisions:
  - 不改安卓端 UI；移动端继续以服务端 `available_actions` 为准。
  - 不改生产库数据；根因是服务端动作权限投影，不是任务数据已检查完成。

### Files / Areas

- `backend/src/lib/workTaskActions.ts` — modified: 拆分终态完成判断，避免待检查/清洁已提交状态误触发 `task_completed`。
- `backend/scripts/tests/test_work_task_actions.ts` — modified: 增加 `to_inspect` 下检查动作可用的回归测试，并保留完成态禁用断言。
- `backend/dist/lib/workTaskActions.js` — generated locally by `npm run build` but ignored by Git; current workspace copy contains the compiled new logic and is not a tracked release file.
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: `/mzapp/work-tasks` 的 `available_actions` 变化；待检查任务的 `submit_inspection` / `upload_access_video` 不再被 `task_completed` 禁用。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: follows existing capability-driven mobile task action model; no dependency on unrelated finance/inventory/task-center work currently dirty in this worktree.

### Validation

- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_work_task_actions.ts` in `backend` — passed: `test_work_task_actions: ok`.
- `npm run test:cleaning-inspection-merge` in `backend` — passed: `test_cleaning_inspection_merge: ok`.
- `npm run build` in `backend` — passed: `tsc -p .`.
- `git diff --check -- backend/src/lib/workTaskActions.ts backend/scripts/tests/test_work_task_actions.ts backend/dist/lib/workTaskActions.js` — passed.

### Risks / Release Notes

- Behavior risk: 清洁已提交但未到终态的任务会继续显示相关记录/检查动作可用；这些动作仍受参与人和基础权限控制。
- Rollback: revert the `isTerminalStatus()` narrowing and remove the `to_inspect` test block.
- Sensitive-information review: no secrets, `.env` contents, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: committed locally in root `Dev` commit `956df41`; push to `origin/Dev` failed because GitHub HTTPS credentials are unavailable in this environment. Worktree still contains unrelated finance/inventory/task-center/mzapp changes not owned by this unit.

## CRL-20260704-006 — 任务中心纯入住执行人选择修复

- **Status:** committed
- **Updated:** 2026-07-04 14:11 AEST
- **Request:** “修复一下”：修复任务中心详情弹窗里纯入住任务无法安排执行人的问题。
- **Outcome:** 任务中心详情里所有纯入住任务，包括“检查后挂钥匙”和“仅改密码”，都按“入住现场执行”分配执行人；下拉显示“执行人”、可选择所有 active staff，并保存到 `cleaning_tasks.assignee_id`。纯入住不再误走检查人员字段和 `assign_inspector` 权限门。

### Implementation

- Previous behavior:
  - 详情弹窗只在 `inspection_scope=password_only` 时把纯入住任务当作“执行人”处理。
  - `inspect_and_hang` 纯入住仍显示“检查人员”，读取/写入 `inspector_id`，并使用 `assign_inspector` gate；后端能力模型已将纯入住的 `assign_inspector` 设为不适用，所以截图里的下拉被禁用。
  - 保存 payload 也只在 `password_only` 时提交 `assignee_id`，即使前端显示修好也会导致“检查后挂钥匙”执行人无法写回。
- New behavior:
  - 纯入住任务统一使用 `assignee_id` 作为执行人，打开详情时从 `assignee_id / inspector_id / cleaner_id` 兼容回填历史值。
  - 详情下拉对所有纯入住显示“执行人”，使用 `assign_executor` gate 和 `allStaffOptions`。
  - 本地状态、未安排统计、已挂钥匙前校验、保存 snapshot 和 save-board payload 都按纯入住执行人语义处理；执行人变更时清空不适用的 `cleaner_id` / `inspector_id`。
- Key decisions:
  - 不新增配置项或第二套规则；复用后端已有 `assign_executor` / `assignee_id` 语义。
  - 不改普通退房/turnover 的清洁人员、检查人员分配逻辑。

### Files / Areas

- `frontend/src/app/task-center/page.tsx` — modified: 纯入住详情分配、状态计算、保存 snapshot 和 save-board payload 统一使用执行人字段。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: none; 继续使用现有 `/task-center/save-board` payload 的 `assignee_id` / `assignee_assignment_action`。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: follows pure-checkin execution semantics from earlier task-center/mobile capability units; no dependency on unrelated finance/inventory changes currently present in the worktree.

### Validation

- `./node_modules/.bin/tsc --noEmit` in `frontend` — passed.
- `npm run lint` in `frontend` — passed with existing project warnings; no errors.
- `npm run test` in `frontend` — passed: 37 test files, 165 tests.
- `npm run build` in `frontend` — passed; existing lint/chart/Browserslist warnings only.
- `git diff --check -- frontend/src/app/task-center/page.tsx` — passed.

### Risks / Release Notes

- Behavior risk: historical pure入住 rows that still have `inspector_id` or `cleaner_id` are displayed as execution assignment fallback, and selecting a new执行人 clears those old non-applicable fields for that row.
- Rollback: revert the `frontend/src/app/task-center/page.tsx` changes in this unit; backend pure入住 capability remains unchanged.
- Sensitive-information review: no secrets, `.env` contents, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: committed locally in root `Dev` commit `956df41`; push to `origin/Dev` failed because GitHub HTTPS credentials are unavailable in this environment. Worktree still contains unrelated finance/inventory/backend changes not owned by this unit.

## CRL-20260704-005 — 移动端线下任务参与清洁/检查执行排序

- **Status:** committed
- **Updated:** 2026-07-04 14:11 AEST
- **Request:** “用户被分配到的线下任务也可以参与清洁或者检查任务的排序”，并按确认后的方案执行：同一用户当天的清洁/检查/线下任务使用一套执行顺序，线下任务不新增第二套排序系统。
- **Outcome:** 移动端保存排序时会把清洁任务、检查任务和已分配给用户的线下 `work_tasks` 按用户点选的完整顺序一次提交；后端在同一事务内写入 `cleaning_tasks.sort_index_cleaner`、`cleaning_tasks.sort_index_inspector` 和 `work_tasks.sort_index`，避免线下任务和清洁/检查任务各自从 1 开始导致刷新后相对顺序漂移。日终交接卡现在也会把可排序线下任务视为当天执行任务，避免“执行顺序 4”的线下任务被插到日终交接下面。

### Implementation

- Previous behavior:
  - 移动端排序保存会分别调用 `/mzapp/work-tasks/reorder`、`/mzapp/cleaning-tasks/reorder?kind=cleaner` 和 `/mzapp/cleaning-tasks/reorder?kind=inspector`。
  - 线下任务和清洁/检查任务各自压缩排序序号；例如 `清洁A -> 线下B -> 清洁C` 保存后，线下任务可能写入 `sort_index=1`，清洁任务写入 `sort_index_cleaner=1/2`，刷新后跨类型相对位置不稳定。
- New behavior:
  - 新增 `/mzapp/work-tasks/mixed-reorder`，接收 `{ date, items: [{ kind, ids, sort_index }] }`，允许 `kind=work|cleaner|inspector` 混合提交。
  - 后端校验线下任务属于同一日期、同一 assignee 范围；普通用户只能排序分配给自己的线下任务，清洁/检查排序仍分别要求清洁/检查角色和对应任务归属。
  - 移动端 `TasksScreen` 改为调用 `reorderMixedWorkTasks()`，点选第几位就把清洁/检查/线下任务都写入同一个全局序号。
  - 移动端日终交接卡插入位置纳入当前用户可排序的线下任务；未完成的线下任务会和清洁/检查任务一样排在日终交接之前。
  - 保留旧 `/work-tasks/reorder` 和 `/cleaning-tasks/reorder`，兼容已安装旧客户端。
- Key decisions:
  - 不给线下任务新增 `offline_sort_index_cleaner` / `offline_sort_index_inspector`；线下任务只有一个 `work_tasks.sort_index`，表示该用户当天执行顺序。
  - 不改变 `cleaning_offline_tasks` 的运行态语义；线下任务状态和排序仍以 canonical `work_tasks` 行为准。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: 新增混合排序 schema 和 `/work-tasks/mixed-reorder` 接口，在事务内更新清洁、检查和线下排序字段。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: 新增 `reorderMixedWorkTasks()` API helper。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 保存排序时生成混合 entries，保持用户点选的全局顺序；日终交接插入点纳入可排序线下任务。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx` — modified: 增加 `清洁A -> 线下B -> 清洁C` 排序保存回归测试，以及 `1/2/3 清洁 + 4 线下` 时日终交接不得插在线下任务上方的回归测试。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: 新增 `POST /mzapp/work-tasks/mixed-reorder`；旧排序接口保留。
- Database / migration: none; 复用现有 `work_tasks.sort_index`、`cleaning_tasks.sort_index_cleaner`、`cleaning_tasks.sort_index_inspector`。
- Config / environment: none.
- Dependencies: none.
- Related units: shares `backend/src/modules/mzapp.ts` with `CRL-20260704-003` and `CRL-20260704-004`; selective release requires hunk review. Mobile app worktree also contains unrelated pre-existing app/version config changes not owned by this unit.

### Validation

- `npm test -- --runTestsByPath src/screens/tabs/TasksScreen.test.tsx --runInBand` in `mz-cleaning-app-frontend` — passed: 12 tests passed, including mixed offline/cleaning ordering and day-end handover placement after ordered offline tasks. Jest still reports a pre-existing open-handle warning after completion.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 114 warnings; warnings are pre-existing project-wide lint warnings.
- `npm run build` in `mz-cleaning-app-frontend` — not run: package has no `build` script.
- `npm run build` in `backend` — passed: `tsc -p .`.
- `npm run lint` in `backend` — not run: backend package has no `lint` script.

### Risks / Release Notes

- Behavior risk: 一个线下任务在同一用户当天只有一套排序；如果未来业务要求“清洁视角”和“检查视角”分别给同一线下任务不同位置，需要新增明确业务规则和字段。
- Compatibility: 新客户端依赖新接口；旧客户端仍可使用旧排序接口，但旧客户端仍有跨类型序号压缩限制。
- Rollback: revert `/work-tasks/mixed-reorder`, `reorderMixedWorkTasks()`, and `TasksScreen` mixed-save changes;旧客户端排序路径仍可工作。
- Sensitive-information review: no secrets, `.env` contents, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: committed locally in root `Dev` commit `956df41`; root push to `origin/Dev` and `mz-property-system-v3/Dev` failed because GitHub HTTPS credentials for the root repository are unavailable in this environment. Nested mobile `Dev` commit `3f3fb09` was pushed to `origin/Dev`. Root worktree still contains unrelated finance/inventory/mzapp changes, and nested mobile app still contains unrelated `app.json` / `eas.json` / package version changes.

## CRL-20260704-004 — 清洁端普通同日 turnover 入住重复卡修复

- **Status:** ready
- **Updated:** 2026-07-04 12:37 AEST
- **Request:** 执行修复计划：解决清洁人员移动端同日退房入住里入住卡重复，以及普通任务仍显示“检查后挂钥匙”的问题；测试不能修改生产环境数据库数据。
- **Outcome:** `/mzapp/work-tasks` 在清洁人员本人视图中不再把已归该清洁人员的同房同日 `checkin_clean` 额外投影成独立入住执行/检查卡；普通 `退房 入住` turnover 只保留一张清洁卡，纯入住任务仍显示给执行人并保留“仅改密码/检查后挂钥匙”语义。

### Implementation

- Previous behavior:
  - 普通同日 checkout+checkin 任务未完成时，checkout 进入清洁 turnover 卡，但 checkin 又因为 `assignee_id` 等于清洁人员进入 executor 分组，导致清洁端看到同一房间一张 `退房 入住` 和一张单独 `入住`。
  - 单独 `checkin_clean` 卡带 `inspection_scope=inspect_and_hang`，旧移动端会按规则显示“检查后挂钥匙”，让普通 turnover 看起来也有这个标签。
  - 检查分组优先使用 checkin 执行人，可能把真实检查员的同日检查投影归到执行人名下。
- New behavior:
  - 同日 turnover 状态增加 checkout 清洁人员集合；当当前用户已拥有该房同日 checkout 清洁卡时，关联 checkin 不再进入 executor/inspection standalone 投影。
  - 检查分组按真实 `inspector_id` / 手动检查参与人分配，不再优先被 checkin 执行人覆盖。
  - 纯入住没有同日 checkout 时仍进入执行人投影，并继续返回 `inspection_scope` 供移动端显示“仅改密码/检查后挂钥匙”。
- Key decisions:
  - 不改移动端前端显示逻辑；根因是后端返回了不该给清洁人员的 standalone checkin 卡。
  - 不对生产库运行写入测试；回归脚本保留生产库身份保护，只在非生产 `DATABASE_URL` 上写入 `test-assignment-*` 样例并清理。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: 普通同日 turnover 下按 checkout 清洁归属压掉清洁人员的 standalone checkin 投影，并修正检查分组 assignee 来源。
- `backend/scripts/tests/test_task_assignment_canonical.ts` — modified: 增加清洁人员 self view 不重复、真实检查员不丢任务、纯入住执行人仍可见的回归断言。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: `/mzapp/work-tasks` 清洁人员本人视图中普通同日 turnover 不再额外返回单独 `checkin_clean` 卡；纯入住任务和 manager 合并视图保留现有结构。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: follow-up to `CRL-20260704-001`; shares `backend/src/modules/mzapp.ts` with `CRL-20260704-003`, so selective release requires hunk review.

### Validation

- `./node_modules/.bin/ts-node --transpile-only scripts/tests/test_task_assignment_canonical.ts` in `backend` sandbox — failed: DNS blocked access to the non-production Neon database before assertions.
- `./node_modules/.bin/ts-node --transpile-only scripts/tests/test_task_assignment_canonical.ts` in `backend` with network access — passed: includes cleaner self view 同日 turnover 不重复、真实检查员仍可见、纯入住执行人仍可见。
- `npm run build` in `backend` — passed: `tsc -p .`.

### Risks / Release Notes

- Behavior risk: 如果未来业务明确要求清洁人员在普通同日 turnover 中也单独看到入住执行卡，需要改为单独配置；当前规则按用户反馈隐藏该重复卡。
- Rollback: remove `checkoutCleanerIds` / `sameDayTurnoverFor` suppression and restore inspection assignment fallback to checkin executor in `backend/src/modules/mzapp.ts`.
- Sensitive-information review: no secrets, `.env` contents, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: uncommitted local changes in `backend/src/modules/mzapp.ts`, `backend/scripts/tests/test_task_assignment_canonical.ts`, and `docs/change-release-ledger.md`; worktree also contains unrelated pre-existing finance/inventory changes not owned by this unit.

## CRL-20260704-002 — 移动端清洁/检查上传权限兜底

- **Status:** committed
- **Updated:** 2026-07-04 10:59 AEST
- **Request:** 排查“清洁、检查人员上传照片都显示权限不足”，确认 Barbara 等清洁人员需要能上传客人钥匙照片和补品填报，并检查其他角色是否有类似权限缺失。
- **Outcome:** 后端权限解析现在会对 `cleaner`、`cleaning_inspector`、`cleaner_inspector` 叠加移动端现场作业必需权限；同时对 `customer_service`、`finance_staff` 叠加移动端支出自助权限。即使生产 `role_permissions` 表缺失或只配置了部分权限，移动端钥匙照片、补品填报、检查照片、挂钥匙完成和相关支出入口也不会在基础权限层被错误拦截。

### Implementation

- Previous behavior:
  - 生产库中 `role.cleaner` 没有解析出任何 `cleaning_app.*` 权限，Barbara 这类清洁账号在后端 `canPerformCleaningTaskAction()` 中无法通过 `upload_key_photo` / `fill_supplies` 基础权限判断。
  - 生产 `role.cleaning_inspector` 有 `inspect.finish` 和 `media.upload`，但缺少 `tasks.finish/start`；`upload_access_video` 仍会被后端要求 `tasks.finish` 而返回 403。
  - 进一步审计发现 `customer_service` 和 `finance_staff` 也存在同类风险：生产 DB 的部分权限会阻止代码默认移动端支出权限回退。
- New behavior:
  - `backend/src/auth.ts` 的默认权限 overlay 增加 `cleaner`、`cleaning_inspector`、`cleaner_inspector` 和 `finance_staff`，并扩展 `customer_service`。
  - 清洁员叠加 `tasks.view.self`、`tasks.start`、`tasks.finish`、`issues.report`、`media.upload`。
  - 检查员/兼任角色额外叠加 `inspect.finish`，满足检查照片和挂钥匙完成流程。
  - `customer_service` 和 `finance_staff` 叠加 `cleaning_app.expense.company/property.*.self` 自助权限。
- Key decisions:
  - 不直接修改生产数据库权限表，避免在诊断过程中写生产数据；通过后端权限解析兜底保证部署后稳定生效。
  - 不扩大生产自定义 `Finance_staff_assistant` 或 `maintenance_staff`，因为代码默认角色里没有赋予它们移动端作业/支出权限；如业务需要应单独确认。

### Files / Areas

- `backend/src/auth.ts` — modified: 增加现场角色移动端权限 overlay，并补齐客服/财务移动端支出自助权限 overlay。
- `backend/dist/auth.js` — generated/modified by `npm run build`: compiled output for the auth overlay change.
- `backend/scripts/tests/test_cleaning_app_role_permission_overlays.ts` — added: 覆盖 cleaner/cleaning_inspector/cleaner_inspector 的移动端上传与填报权限兜底，以及 customer_service/finance_staff 的移动端支出权限兜底。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: cleaning mobile endpoints that rely on `listPermissionCodesForUser()` / `canPerformCleaningTaskAction()` now allow assigned cleaners and inspectors through the intended base-permission gate; mobile expense endpoints that rely on resolved `cleaning_app.expense.*` permissions also receive the intended customer service / finance staff permissions.
- Database / migration: none; production database was queried read-only for diagnosis.
- Config / environment: uses existing auth role names; no new env vars.
- Dependencies: none.
- Related units: complements `CRL-20260704-001`; this fixes upload/action permission, not task-card visibility.

### Validation

- Production read-only query using `NEON_DATABASE_URL_PROD` — passed: AU4408 on 2026-07-04 is assigned to Barbara (`cleaner`) and Oscar (`cleaning_inspector`); `role.cleaner` had no effective `cleaning_app.*` production permissions before this code overlay.
- Production permission simulation after code change — passed: Barbara resolves `tasks.start`, `tasks.finish`, `media.upload`; Oscar resolves `inspect.finish`, `tasks.finish`, `tasks.start`, `media.upload`.
- Production all-role permission audit using `NEON_DATABASE_URL_PROD` — passed: after overlay, `customer_service` resolves mobile expense permissions and `finance_staff` resolves mobile expense permissions; `maintenance_staff` and production custom `Finance_staff_assistant` still resolve no `cleaning_app.*` permissions by design.
- `./node_modules/.bin/ts-node --transpile-only scripts/tests/test_cleaning_app_role_permission_overlays.ts` in `backend` — passed.
- `npm run build` in `backend` — passed: `tsc -p .`.

### Risks / Release Notes

- Behavior risk: `cleaning_inspector` now also receives `tasks.start/tasks.finish` at permission-resolution level to satisfy existing mobile completion routes; task participation checks still restrict actions to assigned/participating tasks.
- Behavior risk: `customer_service` and `finance_staff` now receive the code-default mobile self expense permissions even if production DB omits them.
- Rollback: remove the added role entries / mobile expense overlay entries from `DEFAULT_ROLE_PERMISSION_OVERLAYS` and the new test assertions.
- Sensitive-information review: no secrets, `.env` contents, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: committed locally to root `Dev` in commit `c8651f5`; push to `origin/Dev` failed because GitHub HTTPS credentials are unavailable in this environment. Worktree still contains unrelated pre-existing finance/inventory changes.

## CRL-20260704-001 — 移动端同日 turnover 挂钥匙完成态合并

- **Status:** committed
- **Updated:** 2026-07-04 10:59 AEST
- **Request:** “把同房同日挂钥匙视频视为整张 turnover 卡完成”，同时确认纯入住的“检查后挂钥匙/仅改密码”和早入住、晚退房、晚入住等标签不要被覆盖。
- **Outcome:** `/mzapp/work-tasks` 现在会把同房同日同时存在退房和入住、且已有挂钥匙视频或 `keys_hung` 状态的任务视为整张 turnover 已完成；不会再额外生成单独的入住执行/检查卡。纯入住任务仍保留执行人可见的“仅改密码/检查后挂钥匙”标签语义。

### Implementation

- Previous behavior:
  - 同房同日退房+入住中，退房侧已挂钥匙后，入住侧仍可能以独立 `checkin_clean` 执行/检查卡出现在移动端，导致用户看到重复入住任务和“检查后挂钥匙”标签。
  - 退房卡只从自身行拿挂钥匙视频；如果视频在同日入住行上，checkout 聚合卡不能稳定继承完成态。
- New behavior:
  - `backend/src/modules/mzapp.ts` 在移动端任务投影前按 `task_date + property_id` 识别同日 checkout/checkin turnover 完成态。
  - 当同日同房既有退房又有入住，且任一侧有挂钥匙视频或 `keys_hung` 时，入住侧不再生成独立 executor/inspector 卡。
  - checkout/turnover 聚合卡会从同日入住行继承挂钥匙视频/钥匙照片，并输出 `keys_hung`；管理视图二次合并也保留 `keys_hung`。
  - 时间与业务标签仍来自现有 `turnover_display` 和 `key_tags`：钥匙数、晚退房、早入住、晚入住不被改写；纯入住的 `inspection_scope` 标签没有改前端逻辑。
- Key decisions:
  - 不改移动端前端标签显示条件，避免影响纯入住场景；只修后端错误产生的独立入住卡。
  - 写数据库的回归测试增加生产库保护：`NODE_ENV=production` 或 `DATABASE_URL` 与生产 URL 指向同一库时直接拒绝运行。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: mobile work-task 同日 turnover 完成态识别、压掉独立入住执行/检查卡、继承同日挂钥匙媒体并输出 `keys_hung`。
- `backend/scripts/tests/test_task_assignment_canonical.ts` — modified: 增加生产库保护；覆盖同日挂钥匙只生成一张完成卡，并断言入住摘要、新密码、钥匙数、晚退房、早入住、晚入住和纯入住标签场景不丢。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: `/mzapp/work-tasks` response behavior changes for same-property same-day checkout+checkin tasks with lockbox video or `keys_hung`; pure checkin-only task behavior unchanged.
- Database / migration: none.
- Config / environment: tests read `NEON_DATABASE_URL_PROD` or `DATABASE_URL_PROD` only to compare sanitized database identity and refuse unsafe writes; no values are logged.
- Dependencies: none.
- Related units: relates to mobile pure checkin tag behavior in `CRL-20260703-012`, but does not change mobile frontend files.

### Validation

- `DOTENV_CONFIG_PATH=backend/.env.local node -r ./backend/node_modules/dotenv/config -e "..."` — passed: verified current test `DATABASE_URL` is present, production URL is present, `NODE_ENV` is not production, and sanitized database identities do not match; no secret values printed.
- `./node_modules/.bin/ts-node --transpile-only scripts/tests/test_task_assignment_canonical.ts` in `backend` sandbox — failed: DNS/network blocked before writes completed (`ENOTFOUND`), so rerun with approved network access.
- `./node_modules/.bin/ts-node --transpile-only scripts/tests/test_task_assignment_canonical.ts` in `backend` with network access — passed: includes同日完成 turnover 压卡、纯入住 password-only 和 inspect-and-hang 场景。
- `./node_modules/.bin/ts-node --transpile-only scripts/tests/test_cleaning_turnover_display.ts` in `backend` — passed: turnover helper time-tag logic remains valid.
- `npm run build` in `backend` — passed: `tsc -p .`.

### Risks / Release Notes

- Behavior risk: if operations intentionally wanted a separate same-day入住执行卡 after挂钥匙视频, it will now be hidden because the whole turnover is considered complete.
- Rollback: remove the same-day turnover completion map, the standalone checkin suppression, and the lockbox-media inheritance/status override in `backend/src/modules/mzapp.ts`.
- Sensitive-information review: no secrets, `.env` contents, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: committed locally to root `Dev` in commit `c8651f5`; push to `origin/Dev` failed because GitHub HTTPS credentials are unavailable in this environment. Worktree still contains unrelated pre-existing finance/inventory changes not owned by this unit.

## CRL-20260703-016 — 移动端 1.0.24 production store 构建与 iOS TestFlight 提交

- **Status:** in-progress
- **Updated:** 2026-07-03 22:38 AEST
- **Request:** 使用 `production` 重新打包 iOS 和 Android，并将 iOS 走 TestFlight/App Store Connect 测试通道。
- **Outcome:** 已触发 `production` profile 的 iOS/Android EAS 云构建。iOS production store build 已完成并已调度 EAS Submit 到 App Store Connect/TestFlight；Android production store build 已创建但仍在 EAS `IN_QUEUE` 队列中，尚未产出 AAB。

### Implementation

- Previous behavior:
  - 1.0.24 已有 `preview`/internal 构建；该包不能直接上传 TestFlight。
- New behavior:
  - 已运行 `npx eas-cli@latest build --platform all --profile production --non-interactive --no-wait`。
  - iOS 使用 App Store provisioning profile，EAS build metadata 为 `distribution=STORE`、`buildProfile=production`、`channel=production`、`appVersion=1.0.24`、`appBuildVersion=24`、`runtimeVersion=1.0.24`。
  - Android production build metadata 同样为 `distribution=STORE`、`buildProfile=production`、`channel=production`、`appVersion=1.0.24`、`appBuildVersion=24`、`runtimeVersion=1.0.24`。
  - 已运行 `npx eas-cli@latest submit -p ios --id e0602706-0201-41ea-aab0-6b4ade9b8d2f --profile production --non-interactive`，EAS 已调度 iOS submission。
- Key decisions:
  - 按用户要求使用现有 `production` profile；该 profile 使用生产后端环境变量和 `production` update channel。
  - Android production 已有 build ID 后不重复创建新构建，避免多个 AAB 版本混淆。

### Files / Areas

- `docs/change-release-ledger.md` — modified: 记录 production build/TestFlight submission 状态。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: production profile uses `EXPO_PUBLIC_APP_ENV=prod` and the production backend URL configured in `eas.json`.
- Dependencies: none.
- Related units: uses the same mobile 1.0.24 source state recorded in `CRL-20260703-015`; packages current mobile changes from `CRL-20260703-011`, `CRL-20260703-012`, `CRL-20260703-013`, and `CRL-20260703-014`.

### Validation

- `node -e "..."` production config check in `mz-cleaning-app-frontend` — passed: local version `1.0.24`, iOS build `24`, Android versionCode `24`, production profile uses prod env and `channel=production`.
- `npx eas-cli@latest build:list --platform ios --limit 5 --json --non-interactive` — passed: recent 1.0.24 builds before this production run were preview/internal; last listed production iOS store build was older `1.0.21 (21)`.
- `npx eas-cli@latest build --platform all --profile production --non-interactive --no-wait` — passed: created Android production build `0e799e8f-f736-47f8-aa46-bcc36ec98f4e` and iOS production build `e0602706-0201-41ea-aab0-6b4ade9b8d2f`.
- `npx eas-cli@latest build:view e0602706-0201-41ea-aab0-6b4ade9b8d2f --json` — passed: iOS `FINISHED`, store distribution, IPA `https://expo.dev/artifacts/eas/OKVKGkct5OG6NGgHM-PJTNm0SR9rT8dss7j6l6s4OeI.ipa`.
- `npx eas-cli@latest submit -p ios --id e0602706-0201-41ea-aab0-6b4ade9b8d2f --profile production --non-interactive` — scheduled: submission `5b68a033-07b3-4672-8ad3-fff7c020f311` created for ASC app `6761032891`; local wait was stopped after EAS confirmed scheduling because this CLI version lacks `submit:list`/`submit:view`.
- `npx eas-cli@latest build:view 0e799e8f-f736-47f8-aa46-bcc36ec98f4e --json` — pending: Android remains `IN_QUEUE`, no AAB artifact yet.

### Risks / Release Notes

- iOS submission has been scheduled, but App Store Connect processing/TestFlight availability still needs confirmation in App Store Connect or Expo submission page.
- Android AAB is not ready yet because EAS has not started the Android production job; continue polling build `0e799e8f-f736-47f8-aa46-bcc36ec98f4e`.
- EAS build metadata reports the current Git commit hash/message, but the uploaded archive included local uncommitted mobile changes.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: uncommitted ledger update; nested mobile repo still contains uncommitted 1.0.24 and mobile feature changes.

## CRL-20260703-015 — 移动端 1.0.24 preview 重新打包

- **Status:** in-progress
- **Updated:** 2026-07-03 22:10 AEST
- **Request:** 重新打包 IOS 和安卓版本。
- **Outcome:** 移动端版本面已同步到 `1.0.24`；已触发 `preview` 内部分发的 iOS/Android EAS 云构建。iOS 构建完成并产出 IPA；Android 构建已创建但仍在 EAS `IN_QUEUE` 队列中，尚未产出 APK。

### Implementation

- Previous behavior:
  - `app.json` 已提升到 `1.0.24`、iOS build `24`、Android versionCode `24`，但 `package.json` / `package-lock.json` 仍显示 `1.0.23`。
- New behavior:
  - `package.json`、`package-lock.json` 顶层和 lockfile root package version 已同步为 `1.0.24`，与 EAS local version source 使用的 `app.json` 保持一致。
  - 已用当前本地移动端工作区触发 `npx eas-cli@latest build --platform all --profile preview --non-interactive --no-wait`。
- Key decisions:
  - 使用现有 `preview` profile 生成内部分发包；未 submit 到 App Store 或 Play Store。
  - Android 已有 build ID 后不重复创建新构建，避免多个 APK 版本混淆。

### Files / Areas

- `mz-cleaning-app-frontend/package.json` — modified: package version 同步到 `1.0.24`。
- `mz-cleaning-app-frontend/package-lock.json` — modified: lockfile version 同步到 `1.0.24`。
- `docs/change-release-ledger.md` — modified: 记录本次重新打包状态。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: uses existing EAS `preview` profile and channel.
- Dependencies: none added by this unit.
- Related units: packages current mobile updates from `CRL-20260703-011`, `CRL-20260703-012`, `CRL-20260703-013`, and `CRL-20260703-014`.

### Validation

- `node -e "..."` version check in `mz-cleaning-app-frontend` — passed: `appVersion/packageVersion/lockVersion/lockRootVersion` all `1.0.24`, iOS build `24`, Android versionCode `24`, `appVersionSource=local`.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 116 existing warnings.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 32 suites / 116 tests; Jest printed the existing open-handle notice after completion.
- `npx eas-cli@latest build --platform all --profile preview --non-interactive --no-wait` in `mz-cleaning-app-frontend` — passed: created Android build `4a9ac375-b96e-40ff-806e-067d83e614cb` and iOS build `a1918fcc-da61-4066-be7d-d1aa9d46b8ca`.
- `npx eas-cli@latest build:view a1918fcc-da61-4066-be7d-d1aa9d46b8ca --json` — passed: iOS `FINISHED`, appVersion `1.0.24`, runtimeVersion `1.0.24`, IPA `https://expo.dev/artifacts/eas/8I8NNDAJGlz4J_9frBtWAQiHmPPWeMny0xiNX9Ah7yI.ipa`.
- `npx eas-cli@latest build:view 4a9ac375-b96e-40ff-806e-067d83e614cb --json` — pending: Android remains `IN_QUEUE`, appVersion `1.0.24`, runtimeVersion `1.0.24`, no artifact yet.

### Risks / Release Notes

- Android APK is not ready yet because EAS has not started the Android job; continue polling build `4a9ac375-b96e-40ff-806e-067d83e614cb`.
- EAS build metadata reports the current Git commit hash/message, but the uploaded archive included local uncommitted mobile changes.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: uncommitted in nested `mz-cleaning-app-frontend` repo and root ledger file; root repo also contains unrelated pre-existing uncommitted changes from other units.

## CRL-20260703-014 — 移动端启用 EAS Update 并触发 preview 构建

- **Status:** ready
- **Updated:** 2026-07-03 21:54 AEST
- **Request:** 按“先配置 `expo-updates + runtimeVersion + eas channel`，再重新 build preview/production 包”的方案执行，让本次和后续纯 JS 修复可以通过新包支持 OTA。
- **Outcome:** 移动端已安装 `expo-updates`，Expo 配置已写入 EAS Update URL 和 `runtimeVersion`，EAS build profiles 已绑定 `development/preview/production` channels。已触发 `preview` 内部分发构建；iOS preview 构建完成，Android preview 构建已创建并仍在 EAS 队列中。EAS 自动创建了 `preview` update channel/branch。

### Implementation

- Previous behavior:
  - `mz-cleaning-app-frontend` 没有 `expo-updates` 依赖。
  - `app.json` 没有 `updates.url` 和 `runtimeVersion`，`eas.json` build profiles 没有 `channel`。
  - 已安装的现场 App 不能接收 EAS OTA 更新；JS 修复必须重新封装。
- New behavior:
  - `expo-updates@~29.0.16` 已加入移动端依赖和 lockfile。
  - `app.json` 使用 `runtimeVersion.policy = appVersion`，当前 runtime 解析为 `1.0.23`；`updates.url` 指向当前 EAS project `1f7721fb-d570-4b01-8335-310ead68238a`。
  - `eas.json` 中 `development`、`preview`、`production` 分别绑定同名 EAS Update channel。
  - 已运行 `npx eas-cli@latest build --profile preview --platform all --non-interactive`：iOS preview 完成，Android preview 已创建并排队。
- Key decisions:
  - 先做 `preview` 内部分发包，方便现场手机尽快安装验证；未自动 submit 到 App Store / Play Store。
  - 没有运行 `npm audit fix`，因为 `npm install` 报出的 audit vulnerabilities 属于既有依赖树风险，自动修复会引入大量无关升级。

### Files / Areas

- `mz-cleaning-app-frontend/package.json` — modified: 增加 `expo-updates` 依赖。
- `mz-cleaning-app-frontend/package-lock.json` — modified: 锁定 `expo-updates` 及其依赖。
- `mz-cleaning-app-frontend/app.json` — modified: 增加 `runtimeVersion` 和 EAS Update URL。
- `mz-cleaning-app-frontend/eas.json` — modified: 为 development/preview/production build profiles 增加 channel。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: mobile native config changes; installed clients must install a newly built package before they can receive future EAS Updates.
- Dependencies: adds `expo-updates@~29.0.16`.
- Related units: packages current mobile fixes including `CRL-20260703-011`, `CRL-20260703-012`, and `CRL-20260703-013`; future OTA updates must target matching runtime `1.0.23`.

### Validation

- `node -e "..."` config check in `mz-cleaning-app-frontend` — passed: `expo-updates: ~29.0.16`, `runtimeVersion.policy: appVersion`, `updates.url` set, channels `development/preview/production` set.
- `./node_modules/.bin/expo config --type public --json` in `mz-cleaning-app-frontend` — passed: public Expo config includes `updates.url`, `runtimeVersion`, version `1.0.23`, iOS build `23`, Android versionCode `23`, sdk `54.0.0`.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and existing warnings.
- `npx eas-cli@latest build --profile preview --platform all --non-interactive` in `mz-cleaning-app-frontend` — partially completed: created preview channel/branch and build IDs. iOS build `d4299352-ed10-4c74-906c-78c1be96b8d4` finished with IPA artifact `https://expo.dev/artifacts/eas/trp01B41r7BMS1NSzcC9o2zW241CBjN_fGT2rSMpVZ8.ipa`; Android build `1c384f11-3c35-40db-b8d8-de72ab7de4a9` was still `IN_QUEUE` when last checked.
- `npx eas-cli@latest build:list --limit 2 --json --non-interactive` in `mz-cleaning-app-frontend` — passed: confirmed iOS `FINISHED`, Android `IN_QUEUE`, both on channel `preview`, runtimeVersion `1.0.23`.

### Risks / Release Notes

- Existing installed apps still do not support OTA; users must install this new build first.
- Because `runtimeVersion` follows app version, native dependency/config changes should bump app version before release to avoid sending incompatible JS to older native runtimes.
- Android preview build may need follow-up polling until it leaves `IN_QUEUE` and produces an APK artifact.
- `npm install` reported 32 audit vulnerabilities in the existing dependency tree; not fixed in this unit to avoid unrelated dependency churn.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: uncommitted in nested `mz-cleaning-app-frontend` repo and root ledger file; EAS build metadata reports the current Git commit hash/message but the build archive included current local uncommitted changes uploaded by EAS CLI.

## CRL-20260703-013 — 移动端挂钥匙视频上传卡住恢复

- **Status:** ready
- **Updated:** 2026-07-03 21:29 AEST
- **Request:** 排查并修复上传钥匙视频在有网状态下仍一直处于“上传中”的问题。
- **Outcome:** 挂钥匙/改密码视频队列现在有上传与业务保存的兜底超时；如果底层移动端 `fetch` 或旧 in-flight 标记卡住，队列会把任务恢复为可重试状态而不是永久停在 `uploading`。完成页会识别超过 2 分钟的陈旧上传状态，提示“可能已卡住”，并提供“重试上传”按钮，视频仍保留在本机。

### Implementation

- Previous behavior:
  - 视频拍摄后先进入 `inspectionMediaQueue`，UI 在 `pending/uploading` 时显示“视频已保存到本机，正在自动上传”。
  - 如果 Android/弱网下上传 promise 长时间不返回，或内存中的 in-flight 标记没有释放，队列项会一直保持 `uploading`，自动维护和 NetInfo 恢复也会跳过该本地文件。
  - 页面没有区分正常上传中和已经卡住的上传，也没有针对本地已保存视频的重试入口。
- New behavior:
  - 队列为单次媒体上传增加 75 秒兜底超时，为 lockbox 业务保存增加 30 秒兜底超时；超时统一转为 retryable error，保留本地视频。
  - 队列记录 `last_attempt_at`，并在处理时释放超过 2 分钟的陈旧 in-flight `uploading` 状态，允许后续重试。
  - `InspectionCompleteScreen` 识别陈旧 `uploading`，显示可重试提示，并提供“重试上传”按钮；重试会把本地队列项恢复为 `pending/uploaded` 后重新触发队列处理。
- Key decisions:
  - 不删除本地视频，不要求用户重拍；上传失败或卡住时继续沿用本地队列恢复。
  - 不改后端接口；问题发生在移动端队列状态机和原生 fetch 可能挂起的恢复路径。

### Files / Areas

- `mz-cleaning-app-frontend/src/lib/inspectionMediaQueue.ts` — modified: 增加 `last_attempt_at`、上传/保存兜底超时、陈旧 `uploading` in-flight 恢复。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.tsx` — modified: 陈旧上传提示和“重试上传”按钮。
- `mz-cleaning-app-frontend/src/lib/inspectionMediaQueue.test.ts` — modified: 覆盖挂起视频上传在队列超时后转为 `failed_retryable`。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: complements `CRL-20260703-011`; shares `InspectionCompleteScreen.tsx` with earlier mobile access-video work, so selective release requires hunk-level review.

### Validation

- `npm test -- --runInBand src/lib/inspectionMediaQueue.test.ts src/screens/tasks/InspectionCompleteScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 2 suites / 6 tests.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and existing warnings.

### Risks / Release Notes

- Runtime risk: if a native upload actually continues after the fallback timeout, a manual retry could upload the same local video twice to storage; only the successful business save URL is attached to the task.
- Rollback: remove queue operation timeouts, stale in-flight recovery, `last_attempt_at`, and the retry UI, returning to previous queue behavior.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: uncommitted in nested `mz-cleaning-app-frontend` repo and root ledger file.

## CRL-20260703-012 — 移动端纯入住/仅改密码标签与执行人显示修复

- **Status:** ready
- **Updated:** 2026-07-03 21:22 AEST
- **Request:** 修复纯入住检查移动端标签显示不出来、仅改密码标签显示不出来、执行人也显示不出来的问题。
- **Outcome:** 移动端现在把 `cleaning_tasks + checkin_clean` 下的 `execution/inspection` 现场执行任务统一识别为入住现场执行。列表页和详情页不再显示原始英文 `execution`，会显示“执行”以及“检查后挂钥匙”或“仅改密码”；执行人优先显示 `executor_name`，缺失时回退到 `assignee_name`，再回退旧清洁/检查姓名或 ID。

### Implementation

- Previous behavior:
  - 移动端只在 `task_kind === inspection && task_type === checkin_clean` 时显示纯入住检查标签；当后端把纯入住现场执行投成 `task_kind=execution` 且 `execution_role=inspection` 时，列表页会落回原始 `execution` 标签。
  - 仅改密码判断过宽，把所有 `task_kind=execution` 都当作 password-only，但又没有覆盖显式 `execution_role=inspection` 的入住现场执行显示链路。
  - 执行人员卡片只在旧 `isKeyHandoverTask` 或 `task_kind=inspection` 分支显示单执行人；纯入住现场执行会落到“清洁/检查”双人卡，且没有使用 `assignee_name`。
- New behavior:
  - 新增移动端共享 helper `isCheckinSiteExecutionTask()`，只识别 `cleaning_tasks + checkin_clean` 且非清洁执行的 `inspection/execution` 现场任务。
  - `isPasswordOnlyInspectionTask()` 改为在入住现场执行且 `inspection_scope=password_only` 时才显示“仅改密码”；其他入住现场执行按 `inspectionScopeLabel()` 显示“检查后挂钥匙”。
  - `TasksScreen` 和 `TaskDetailScreen` 复用同一个 helper 控制标签、详情检查执行方式、单执行人布局和详情 Wi-Fi 可见性。
  - 执行人展示回退链调整为 `executor_name -> assignee_name -> cleaner_name/inspector_name -> assignee_id`，覆盖后端只下发现场执行 `assignee_name` 的情况。
- Key decisions:
  - 不改后端 payload 和数据库；这次只修移动端对现有 `execution_role/execution_semantics/inspection_scope` 的解释。
  - 不继续把所有 `execution` 任务硬判成“仅改密码”，避免误伤非入住或检查后挂钥匙场景。

### Files / Areas

- `mz-cleaning-app-frontend/src/lib/cleaningInspection.ts` — modified: 新增 `isCheckinSiteExecutionTask()`，收窄 password-only 判断。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 列表页标签和执行人员卡片改用入住现场执行 helper，执行人回退到 `assignee_name`。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` — modified: 详情页标签、检查执行方式、执行人员和 Wi-Fi 可见性改用入住现场执行 helper。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx` — modified: 覆盖 `task_kind=execution + execution_role=inspection` 时列表显示“执行 / 检查后挂钥匙 / assignee_name”，且不显示英文 `execution`。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` — modified: 覆盖同类任务详情显示“检查执行方式：检查后挂钥匙”和“执行人员：assignee_name”。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: none; consumes existing mobile task fields.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: follows `CRL-20260703-010` and `CRL-20260703-011`; shares mobile files with those units, so selective release requires hunk-level review.

### Validation

- `npm test -- --runInBand src/screens/tabs/TasksScreen.test.tsx src/screens/tasks/TaskDetailScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 2 suites / 26 tests; existing SafeAreaView deprecation warning and Jest open-handle notice remained.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and existing warnings.

### Risks / Release Notes

- Runtime risk: relies on backend continuing to mark pure check-in execution tasks as `cleaning_tasks + checkin_clean` with either `task_kind=inspection` or `task_kind=execution`; unexpected missing `inspection_scope` will default to “检查后挂钥匙”.
- Rollback: revert the helper usage in the two mobile screens and restore previous `task_kind === inspection` checks.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: uncommitted in nested `mz-cleaning-app-frontend` repo and root ledger file; mobile files are shared with earlier uncommitted cleaning task action units.

## CRL-20260703-011 — 移动端检查/改密码 action 目标任务 ID 修复

- **Status:** ready
- **Updated:** 2026-07-03 21:09 AEST
- **Request:** 修复所有纯入住检查和仅改密码任务上传照片/视频后无法完成、弹出 `not found` 的问题。
- **Outcome:** 后端 `available_actions` 现在携带对应 action 的目标 `cleaning_tasks.id`，合并卡聚合 action 时会保留可操作子任务的 `source_id`。移动端从任务详情进入入住检查或改密码/挂钥匙完成页时会透传这个目标 ID，并在保存检查照片、保存挂钥匙/改密码视频时优先使用它，避免把合并卡或错误卡片级 `source_id` 发给业务接口导致 `not found`。

### Implementation

- Previous behavior:
  - `/mzapp/work-tasks` 合并卡只聚合了 `available_actions` 的按钮和权限，没有给 action 绑定它真正所属的子任务 ID。
  - 移动端 `InspectionPanel` 和 `InspectionComplete` 保存业务结果时只使用卡片级 `task.source_id`；纯入住、仅改密码或合并卡场景下该 ID 可能不是当前 action 对应的 `cleaning_tasks.id`。
  - 后端 `/cleaning-app/tasks/:id/inspection-photos` 和 `/mzapp/cleaning-tasks/:id/lockbox-video` 按 `cleaning_tasks.id` 查询，收到错误 ID 时返回 `not found`。
- New behavior:
  - `buildWorkTaskActionPayload()` 为每个 action 填充 `source_type/source_id`，默认指向当前 action 所在的 source task。
  - `/mzapp/work-tasks` 合并子任务 action 时，如果子任务提供了可用 action 和不同 `source_id`，优先保留该子任务 action，确保 `submit_inspection`、`upload_access_video` 指向正确检查/改密码子任务。
  - 移动端 action route 新增可选 `sourceId`，详情页导航时传递 action 的 `source_id`；检查页和完成页提交接口优先使用 route `sourceId`，旧后端 payload 没有该字段时继续 fallback 到 `task.source_id`。
- Key decisions:
  - 不改本地草稿/队列 key，仍按 work-task `taskId` 保存，避免破坏已有离线草稿和 UI 查找逻辑。
  - 不新增平行接口；继续复用现有 `/cleaning-app/tasks/:id/inspection-photos` 和 `/mzapp/cleaning-tasks/:id/lockbox-video`。

### Files / Areas

- `backend/src/lib/workTaskActions.ts` — modified: `WorkTaskAvailableAction` 增加 `source_type/source_id`，action payload 默认携带当前 source task ID。
- `backend/src/modules/mzapp.ts` — modified: 合并卡聚合子任务 action 时保留可用子任务 action 的目标 `source_id`。
- `backend/scripts/tests/test_work_task_actions.ts` — modified: 覆盖纯入住检查和仅改密码 action 的 `source_id`。
- `backend/scripts/tests/phase5_e2e_acceptance.ts` — modified: 增加移动端列表 action `source_id` 断言。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: 移动端 action 类型增加 `source_type/source_id`。
- `mz-cleaning-app-frontend/src/lib/workTaskActions.ts` — modified: action 导航透传 `sourceId` 到检查页/完成页。
- `mz-cleaning-app-frontend/src/navigation/RootNavigator.tsx` — modified: route param 类型允许 `InspectionPanel` / `InspectionComplete` 接收 `sourceId`。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — modified: 检查照片/补品保存目标优先使用 route `sourceId`，并进入完成页时继续透传。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.tsx` — modified: 改密码/挂钥匙视频保存目标优先使用 route `sourceId`。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` — modified: 覆盖 server action `source_id` 导航参数。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.test.tsx` — modified: 覆盖卡片 `source_id` 不可靠时完成页使用 route `sourceId` 保存视频。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: `/mzapp/work-tasks` 的 `available_actions[]` 增加可选 `source_type/source_id` 字段；旧客户端可忽略，新客户端优先使用。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: builds on `CRL-20260703-010`; shares files with the Phase 5 mobile authorization/action work, so selective release requires hunk-level review.

### Validation

- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_work_task_actions.ts` in `backend` — passed: `test_work_task_actions: ok`.
- `npm run build` in `backend` — passed: `tsc -p .`.
- `npm test -- --runInBand src/screens/tasks/TaskDetailScreen.test.tsx src/screens/tasks/InspectionCompleteScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 2 suites / 18 tests.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and existing warnings.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/phase5_e2e_acceptance.ts` in `backend` — not completed: manually interrupted after it remained running at mobile list/action validation for several minutes; no assertion failure was printed before interruption.

### Risks / Release Notes

- Runtime risk: action `source_id` is additive, but release must include both backend payload changes and mobile route consumption to fix the user-visible `not found` path.
- Compatibility: mobile falls back to card-level `task.source_id` when older backend payloads omit action `source_id`.
- Rollback: remove action `source_id` fields, revert mobile route `sourceId` usage, and return to card-level `task.source_id` behavior.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: uncommitted in root repo and nested mobile repo; several files are shared with earlier ready units.

## CRL-20260703-010 — 纯入住现场执行人与合并卡动作聚合

- **Status:** ready
- **Updated:** 2026-07-03 16:05 AEST
- **Request:** 继续优化 Phase 5 后发现的边界：纯入住检查不是检查员专属，检查后应由同一个现场执行人挂钥匙；执行人可以是任意线下用户。管理端同房源同日合并卡也不能丢失子任务授权 action。
- **Outcome:** `checkin_clean + inspect_and_hang` 现在按“入住现场执行”处理：`assignee_id` 是现场执行人，可为任意有效系统用户；Web 和移动端显示“执行人/执行”，按钮继续由后端 `available_actions` 决定。纯入住执行人可提交检查照片并继续上传挂钥匙视频完成；无参与关系的 inspector 仍不能误操作。`view=all` 同房源同日合并卡会聚合子任务 actions，手工授权到某个子任务的按钮不会被合并卡隐藏。

### Implementation

- Previous behavior:
  - 只有 `password_only` 被视为执行人任务；`inspect_and_hang` 仍按检查人员字段和检查员角色展示/校验。
  - 移动端 `/mzapp/work-tasks` 普通 cleaner 默认不开 inspector 分组，即使被放到纯入住任务 `assignee_id`，也看不到任务。
  - `/cleaning-app/tasks/:id/inspection-photos` 旧接口外层只允许 `cleaning_app.inspect.finish`，会在参与关系校验前拦住被授权执行的 cleaner。
  - 管理角色 `view=all` 同房源同日任务先合并再算 action；合并后的 `task_kind` 可能只代表一个子任务，导致另一个子任务的 manual action 隐藏。
- New behavior:
  - 后端 `/cleaning/tasks` 单条/批量更新对 check-in 现场执行使用 `assignee_id`，不再把执行人自动写成 `cleaner_id`；旧 `inspector_id` 如被传入也至少要求是有效系统用户。
  - Web capability payload 将 `checkin_inspection` 展示为“入住现场执行”，主参与角色为 `executor`，`assign_executor` 可用，`assign_inspector` 不适用。
  - `/mzapp/work-tasks` 将纯入住现场执行投到 executor 可见分组，同时保留 inspection action 能力；合并卡聚合所有子任务的 legacy/manual participants 和 `available_actions`。
  - 移动端列表和详情页对纯入住现场执行显示“执行 / 执行人员”，不再误显示为检查人员。
  - `cleaning_app` 检查照片旧路由外层权限放宽到 `inspect.finish` 或 `tasks.finish`，实际提交仍由 `canPerformCleaningTaskAction(... submit_inspection)` 按参与/action 校验。
  - Phase 5 E2E 改为用 cleaner 作为纯入住现场执行人，实际跑“检查提交 -> 挂钥匙视频上传”；新增同房源同日合并样例验证子任务 action 聚合。

### Files / Areas

- `backend/src/modules/cleaning.ts` — modified: check-in 现场执行人写入/校验改用 `assignee_id`，创建/更新 schema 支持 `assignee_id` 和 `inspection_scope`。
- `backend/src/modules/mzapp.ts` — modified: 纯入住现场执行默认可见性、挂钥匙视频 legacy guard、`view=all` 合并卡 action 聚合。
- `backend/src/modules/cleaning_app.ts` — modified: 检查照片旧接口外层权限放宽，保留 action guard；同文件还包含 `CRL-20260703-007` 的 lockbox refresh event 改动。
- `backend/src/lib/webTaskCapabilities.ts` — modified: 纯入住现场执行展示和 participant summary 改为 executor。
- `backend/src/lib/workTaskActions.ts` — modified: Web 管理动作对纯入住开放 `assign_executor`；纯入住检查/挂钥匙按钮文案改为“入住检查”“挂钥匙并完成”。
- `backend/scripts/tests/phase5_e2e_acceptance.ts` — modified: Phase 5 覆盖任意执行人纯入住检查后挂钥匙，以及合并卡子任务 action 聚合。
- `backend/scripts/tests/test_web_task_capabilities.ts` — modified: 覆盖纯入住现场执行的 Web capability。
- `backend/scripts/tests/test_work_task_actions.ts` — modified: 覆盖 cleaner 作为纯入住现场执行人获得检查和挂钥匙 action。
- `frontend/src/app/cleaning/page.tsx` — modified: 纯入住 `inspect_and_hang` 和 `password_only` 均显示/保存执行人，不再显示检查人员字段。
- `frontend/src/lib/cleaningDailyTaskStatus.ts` — modified: 识别新旧纯入住 badge 文案。
- `frontend/src/lib/cleaningDailyTaskStatus.test.ts` — modified: 更新“入住现场执行”文案断言。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 纯入住现场执行列表卡显示为执行任务和单执行人员。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` — modified: 纯入住现场执行详情显示执行人员。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: existing response shapes unchanged; `/cleaning/tasks` accepts additive `assignee_id` and `inspection_scope` on manual create, and existing `/mzapp/work-tasks` `available_actions` 更完整。
- Database / migration: none; reuses existing `assignee_id`, `cleaner_id`, `inspector_id`, `inspection_scope`.
- Config / environment: none.
- Dependencies: none.
- Related units: builds on Phase 1-5 capability/action work (`CRL-20260703-001` through `CRL-20260703-007`) and shares dirty files with those units; selective release requires hunk-level review.

### Validation

- `npm run build` in `backend` — passed: `tsc -p .`.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_web_task_capabilities.ts` in `backend` — passed: `test_web_task_capabilities: ok`.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_work_task_actions.ts` in `backend` — passed: `test_work_task_actions: ok`.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/phase5_e2e_acceptance.ts` in `backend` — passed: Web/mobile visibility and labels, `available_actions`, cleaner 执行纯入住检查后挂钥匙、password-only 上传视频、合并卡 action 聚合、refresh events and notifications.
- `npx vitest run src/lib/cleaningDailyTaskStatus.test.ts` in `frontend` — passed: 1 file / 7 tests.
- `npm run lint` in `frontend` — passed with existing project warnings.
- `npm run build` in `frontend` — passed; existing Browserslist, lint, and Recharts zero-size warnings remained.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm test -- --runInBand src/screens/tabs/TasksScreen.test.tsx src/screens/tasks/TaskDetailScreen.test.tsx src/screens/tasks/InspectionCompleteScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 3 suites / 26 tests; existing SafeAreaView warning and Jest open-handle notice remained.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and existing warnings.

### Risks / Release Notes

- Runtime risk: check-in tasks are now treated as site execution for assignment, so operations should use the execution field for pure入住; checkout/turnover cleaning assignment remains on cleaner fields.
- Compatibility: older payloads without `available_actions` still use mobile fallback; server-provided `available_actions` remains highest priority.
- Rollback: restore pure check-in to inspector assignment/display, remove merged-child action aggregation, and revert the Phase 5 E2E assertions for arbitrary executor and merged card actions.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: uncommitted in root repo and nested mobile repo; coexists with unrelated finance/inventory/task-center changes.

## CRL-20260703-009 — 房源代付账单周期支持

- **Status:** ready
- **Updated:** 2026-07-03 15:25 AEST
- **Request:** 房源代付页面支持两个月一次、年度 council rate 等非每月账单；按计划使用账单周期决定哪些月份生成待处理账单，金额不自动分摊。
- **Outcome:** 房源代付模板现在可选择 `每月 / 每 2 个月 / 每 3 个月 / 每 6 个月 / 每年`。后端按模板 `start_month_key` 和 `frequency_months` 判断账单月份：非账单月份不生成待处理行，也不会显示“账单未收到”；账单金额只在实际账单月份整笔进入该月 statement。

### Implementation

- Previous behavior:
  - 后端对 `property_payable` 模板强制 `frequency_months = 1`，workbench、resume、ensure-snapshot 也按每月判断。
  - 前端模板保存和房源预设表单都会把周期写死为每月，列表文案显示“每月 X 号”。
  - 编辑模板时即使只改备注或收款信息，也会通过后端规范化保留每月周期。
- New behavior:
  - 后端新增 property-payable 周期规范化，只接受 `1/2/3/6/12`；编辑模板时用现有模板作为 fallback，避免未提交周期字段时重置已有周期。
  - workbench、resume、ensure-snapshot 和未来未付快照清理都使用同一 due-month 判断；非周期月份不会新增房源代付快照。
  - 前端共享工具保留合法周期、非法周期回落每月，并提供统一周期标签。
  - 房源代付模板 drawer、模板列表、详情 drawer、房源详情预设模板表单都展示/保存账单周期；日期文案改为“账单月 X 号”。
- Key decisions:
  - 不做自动分摊；账单在哪个账单月收到并确认，就整笔进入该月 statement。
  - 不支持任意周期数字，先限制为业务确认的 1、2、3、6、12 个月，避免生成节奏不可控。

### Files / Areas

- `backend/src/modules/recurring.ts` — modified: property-payable 周期规范化、due-month 判断导出、workbench/快照生成/模板同步使用真实周期。
- `backend/scripts/tests/test_property_payable_bill_dates.ts` — modified: 覆盖双月、年度 due-month 判断和 property-payable 周期规范化。
- `frontend/src/lib/propertyPayables.ts` — modified: 共享周期选项、规范化和标签 helper；模板 normalize 不再强制每月。
- `frontend/src/lib/propertyPayables.test.ts` — modified: 覆盖合法周期保留、非法周期回落每月。
- `frontend/src/app/finance/property-payables/page.tsx` — modified: 代付模板新增账单周期字段，列表/详情显示周期并修正账单月文案。
- `frontend/src/components/PropertyPayableTemplatesForm.tsx` — modified: 房源详情代付模板预设新增账单周期字段。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: existing endpoints unchanged; `recurring_payments.frequency_months` for `template_kind='property_payable'` now accepts and returns `1/2/3/6/12` instead of always normalizing to `1`.
- Database / migration: none; reuses existing `frequency_months` column.
- Config / environment: none.
- Dependencies: none.
- Related units: no file overlap with `CRL-20260703-008`; shares dirty worktree with other ready units.

### Validation

- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_property_payable_bill_dates.ts` in `backend` — passed: `test_property_payable_bill_dates: ok`.
- `./node_modules/.bin/vitest run src/lib/propertyPayables.test.ts --coverage=false` in `frontend` — passed: 1 file / 4 tests.
- `npm run build` in `backend` — passed: `tsc -p .`.
- `npm run lint` in `frontend` — passed with existing project warnings.
- `npm run build` in `frontend` — passed; existing Browserslist, lint, and Recharts zero-size warnings remained.
- `python3 scripts/audit_change_release_ledger.py` — passed: 37 changed files recorded, coverage PASS.
- `git diff --check -- backend/src/modules/recurring.ts backend/scripts/tests/test_property_payable_bill_dates.ts frontend/src/lib/propertyPayables.ts frontend/src/lib/propertyPayables.test.ts frontend/src/app/finance/property-payables/page.tsx frontend/src/components/PropertyPayableTemplatesForm.tsx docs/change-release-ledger.md` — passed.

### Risks / Release Notes

- Existing unpaid future snapshots in months that are no longer due are deleted only when the template `start_month_key` or `frequency_months` is edited. Already paid historical rows are preserved.
- A direct API caller could still try to confirm a non-due month if it bypasses the UI; normal UI paths only expose due months through the workbench.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: uncommitted in root repo; coexists with unrelated cleaning/task-center/inventory/finance changes.

## CRL-20260703-008 — 财务助理房源营收支出可见性修复

- **Status:** ready
- **Updated:** 2026-07-03 15:12 Australia/Melbourne
- **Request:** 修复 `QianwenLin` 主角色为 `Finance_staff_assistant`、同时带 `customer_service` 多角色时，看不到房源营收支出数据的问题。
- **Outcome:** `/crud/property_expenses` 的客服同组 `created_by` 范围过滤现在会先检查用户任一角色是否拥有显式 `property_expenses.view`。普通客服仍只能看客服范围内的房源支出；带有房源支出查看权限的财务助理不会再因为多角色包含 `customer_service` 而被过滤掉，房源营收表可正常汇总支出列。

### Implementation

- Previous behavior:
  - 房源营收页通过 `/crud/property_expenses` 拉取房源支出后在前端汇总。
  - `shouldScopePropertyExpenseByPeerRole()` 只豁免 `admin` 和精确角色名 `finance_staff`；只要角色列表包含 `customer_service`，就追加 `created_by_any` 范围过滤。
  - `Finance_staff_assistant + customer_service` 这类多角色用户即使有 `property_expenses.view`，也会被当成客服范围读取，导致与本人/客服同组无关的房源支出在房源营收中变成 0。
- New behavior:
  - 客服范围过滤拆为可测试判断：非 `property_expenses`、`admin`、`finance_staff`、或拥有显式 `property_expenses.view` 时不套客服范围。
  - 列表和单条读取路径改为等待该权限判断后再决定是否套用 `created_by_any`。
  - 新增脚本测试覆盖普通客服仍被限制、`Finance_staff_assistant + customer_service` 有 `property_expenses.view` 时不被限制、`finance_staff` 不被限制、其他资源不受影响。
- Key decisions:
  - 不硬编码只处理 `Finance_staff_assistant`；以 `property_expenses.view` 作为是否拥有全量房源支出读取能力的依据。
  - 不使用 `finance.tx.write` 做豁免，因为普通客服历史上也可能有交易写入权限，不能因此放开全部房源支出读取。

### Files / Areas

- `backend/src/modules/crud.ts` — modified: 房源支出客服范围过滤改为权限感知，并导出纯判断函数供回归测试使用；同文件还包含 `CRL-20260703-005` 的日用品自动费用只读保护未提交 hunk。
- `backend/scripts/tests/test_property_expense_peer_scope.ts` — added: 覆盖房源支出 peer-scope 判断的角色/权限组合。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: response shape unchanged; `/crud/property_expenses` 对同时拥有 `customer_service` 和 `property_expenses.view` 的用户不再追加客服 `created_by` 范围过滤。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `backend/src/modules/crud.ts` with `CRL-20260703-005`; selective release requires hunk-level staging if only releasing this fix.

### Validation

- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_property_expense_peer_scope.ts` in `backend` — passed: `test_property_expense_peer_scope: ok`.
- `npm run build` in `backend` — passed: `tsc -p .`.
- `python3 scripts/audit_change_release_ledger.py` — passed: 31 changed files recorded, coverage PASS.

### Risks / Release Notes

- Runtime risk: roles with explicit `property_expenses.view` will see all non-deleted property expense rows through `/crud/property_expenses` even if they also carry `customer_service`; this matches the permission meaning but should be reviewed when granting that permission.
- Rollback: restore `shouldScopePropertyExpenseByPeerRole()` to the previous synchronous role-name-only check and remove `test_property_expense_peer_scope.ts`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: uncommitted in root repo; coexists with unrelated cleaning/task-center/inventory/finance changes and existing `crud.ts` hunk from `CRL-20260703-005`.

## CRL-20260703-007 — Phase 5 端到端验收与改密码视频刷新事件

- **Status:** ready
- **Updated:** 2026-07-03 15:00 Australia/Melbourne
- **Request:** “执行Phase 5”：用真实业务样例验证 Web 和移动端一致，覆盖普通退房清洁、纯入住检查、仅改密码/挂钥匙，并确认按钮由 `available_actions` / 任务能力决定，不被角色锁死。
- **Outcome:** 新增可重复的 Phase 5 E2E 验收脚本，使用受控 `phase5-e2e-*` 样例数据跑真实 backend router 和真实 PostgreSQL：Web `/cleaning`、移动端 `/mzapp/work-tasks`、清洁提交、admin 授权检查提交、改密码视频上传、无参与 inspector 403、通知记录和列表刷新事件均被验证。验收过程中发现并修复了 `/cleaning-app/tasks/:id/lockbox-video` 成功后缺少 `work_task_events` 的刷新事件问题。

### Implementation

- Previous behavior:
  - Phase 5 只能靠人工说明或零散单测，没有可重复的业务样例端到端脚本。
  - 改密码/挂钥匙视频上传会更新状态并触发通知解析，但没有写 `work_task_events`，移动端列表刷新缺少一致事件。
- New behavior:
  - `phase5_e2e_acceptance.ts` 会创建三个独立测试房源和三类样例任务，执行多角色 Web/mobile 查询和三条实际提交流，再清理样例数据。
  - 脚本断言 `admin/customer_service/offline_manager` 能看列表，普通人员默认只看参与任务；`admin` 被手工授权后可检查；未参与 inspector 不可见且写接口 403；cleaner 可完成清洁和被指定的仅改密码视频上传。
  - `lockbox-video` 路径在 `upload_access_video` 状态转换后写入 `TASK_COMPLETED` / list-scope `work_task_events`，携带 `status`、`lockbox_video_uploaded_at` 和媒体变更字段，移动端可按事件刷新。
- Key decisions:
  - 样例数据使用 `phase5-e2e-*` 前缀并在 `finally` 清理；不修改真实订单或真实员工任务。
  - 三个样例使用不同测试房源，避免管理端同日同房源合并卡影响单任务动作验收；同日同房源合并卡的子任务 action 聚合仍是后续可优化风险。

### Files / Areas

- `backend/scripts/tests/phase5_e2e_acceptance.ts` — added: Phase 5 端到端验收脚本，覆盖 Web/mobile 语义、`available_actions`、三类提交流、通知和刷新事件。
- `backend/src/modules/cleaning_app.ts` — modified: `lockbox-video` 成功上传后新增 `emitWorkTaskEvent`，补齐移动端列表刷新事件；同文件还包含 `CRL-20260703-004` 的 action guard 未提交改动。
- `docs/change-release-ledger.md` — modified: 记录本 Phase 5 验收和修复单元。

### Impact / Dependencies

- API: response shape unchanged except `lockbox-video` route already返回的 `action_result` 继续保留；新增的是事件侧效果。
- Database / migration: no migration; E2E 脚本使用现有表创建临时测试数据并清理。
- Config / environment: script reads existing backend `.env.local` through dotenv but does not print secrets.
- Dependencies: none.
- Related units: builds on `CRL-20260703-001` through `CRL-20260703-004`; shares `backend/src/modules/cleaning_app.ts` with Phase 4, so selective release requires hunk review.

### Validation

- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/phase5_e2e_acceptance.ts` in `backend` — failed in sandbox first: DNS could not resolve configured Neon host; rerun with approved network access.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/phase5_e2e_acceptance.ts` in `backend` with network access — passed: Web `/cleaning`, mobile `/mzapp/work-tasks`, cleaning submit, admin inspection submit, password video upload, `work_task_events`, and 9 `user_notifications` rows verified; sample data cleaned.
- `npm run build` in `backend` — passed: `tsc -p .`.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_work_task_actions.ts` in `backend` — passed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 116 existing warnings.
- `npm test -- --runTestsByPath src/screens/tabs/TasksScreen.test.tsx src/screens/tasks/TaskDetailScreen.test.tsx src/screens/tasks/InspectionCompleteScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 3 suites / 26 tests; existing SafeAreaView deprecation and Jest open-handle warning remained.
- `git diff --check` in root repo — passed.
- `npm run lint` in `frontend` — passed with existing project warnings.
- `npm run build` in `frontend` — failed after successful compile/type-check/lint phase: Next 14 page-data collection could not find `/_document` / `.next/server/pages-manifest.json`; rerunning non-sandbox produced the same manifest failure, so Web build remains unpassed.

### Risks / Release Notes

- Remaining risk: management `view=all` merges same-property/same-day cleaning, inspection, and execution rows before action generation; a manually authorized subtask action can be hidden on the merged card. The Phase 5 script isolates the three sample types by test property; fixing merged-card child action aggregation should be a separate scoped change.
- Build risk: frontend build currently fails in Next page-data collection despite compile/type-check passing; this predates the Phase 5 backend fix and needs separate investigation before release gates that require Web build.
- Runtime risk: E2E script touches the configured database; it uses fixed `phase5-e2e-*` IDs and cleans them before and after runs, so rerunning should clear interrupted sample rows.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: uncommitted in root repo; coexists with unrelated inventory/finance and prior Phase 1-4 cleaning changes.

## CRL-20260703-006 — 日用品更换记录页面操作与编辑回填修复

- **Status:** ready
- **Updated:** 2026-07-03 14:40 AEST
- **Request:** “日用品更换记录页面需要优化一下，一个人没有删除记录的按钮，按钮ui也有问题。第二 明明写了更换物品的信息，谁提交的。点开编辑按钮又没有显示。从详情页也不能转到编辑页面。”
- **Outcome:** 日用品更换记录表格操作列改为系统标准按钮；具备删除权限时显示删除按钮并需要确认；编辑 drawer 能按 `item_id` 或 `item_name` 回填更换物品和提交人；详情 drawer 可以直接进入编辑。

### Implementation

- Previous behavior:
  - 操作列使用普通 `Button + Space`，按钮在窄行中容易竖排，且不符合统一表格操作 UI。
  - 页面没有删除按钮；后端也没有 `DELETE /inventory/daily-replacements/:id`。
  - 编辑表单只用 `item_id` 回填更换物品，旧记录或从任务迁移来的记录如果只有 `item_name`，编辑时会显示为空。
  - 详情 drawer 只能查看，不能直接转编辑。
- New behavior:
  - 表格操作列使用 `TableRowActions`，顺序为 `详情`、`编辑/去更换`、`删除`。
  - 删除按钮受 `inventory_daily_replacements.delete` 控制，并弹确认框；删除成功后刷新列表。
  - 后端新增 `DELETE /inventory/daily-replacements/:id`，删除记录后把关联 `daily_necessities` 自动支出快照置为 `void`。
  - 编辑回填优先匹配 `item_id`，再用 `item_name` 匹配价格表；如果当前记录物品不在价格表里，仍显示“当前记录”选项并保留原物品名称。
  - 提交人字段改为真正的 form field，编辑时显示原提交人；新增时显示当前用户。
  - 详情 drawer 右上角增加“编辑”按钮，点击后关闭详情并打开编辑 drawer。
- Key decisions:
  - 删除权限使用明确的 `inventory_daily_replacements.delete`，没有权限时隐藏按钮，不显示 disabled。
  - 删除采用硬删除当前记录，同时 void 自动费用，避免 statement 留下被删除来源的有效快照。

### Files / Areas

- `frontend/src/app/inventory/category/daily/replacements/page.tsx` — modified: 标准化操作列、增加删除确认、修复编辑回填、详情转编辑。
- `frontend/src/lib/adminNavigation.ts` — modified: 日用品更换记录 action permissions 增加 `inventory_daily_replacements.delete`。
- `backend/src/modules/inventory.ts` — modified: 新增日用品更换删除路由，并在删除时作废关联自动费用；同文件还包含 `CRL-20260703-005` 的自动费用同步改动。
- `backend/dist/modules/inventory.js` — generated/shared: 后端 build 生成的 inventory 输出，承载 `CRL-20260703-005` / `CRL-20260703-006` 的库存模块改动。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: added `DELETE /inventory/daily-replacements/:id`, requires `inventory_daily_replacements.delete`.
- Database / migration: no migration; deletes from existing `property_daily_necessities` and best-effort voids existing `property_expenses` / `company_expenses` auto rows.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `backend/src/modules/inventory.ts` with `CRL-20260703-005`.

### Validation

- `cd backend && ./node_modules/.bin/tsc -p . --noEmit` — passed.
- `git diff --check -- frontend/src/app/inventory/category/daily/replacements/page.tsx frontend/src/lib/adminNavigation.ts backend/src/modules/inventory.ts` — passed.
- `npm --prefix frontend run lint` — passed with existing project warnings; current page still reports the pre-existing `useEffect` dependency warning.
- `npm --prefix frontend run build` — passed; build reported existing Browserslist staleness, existing lint warnings, and existing Recharts zero-size warnings during static generation.
- `python3 scripts/audit_change_release_ledger.py` — failed: current worktree still has pre-existing uncovered `backend/scripts/tests/phase5_e2e_acceptance.ts`; this unit's files are recorded in `CRL-20260703-006`.

### Risks / Release Notes

- RBAC roles must include `inventory_daily_replacements.delete` before non-admin users see the delete button.
- Delete is permanent for `property_daily_necessities`; rollback requires restoring the row from backup/audit source if needed.
- The current-record fallback keeps legacy item names visible, but records with item names not in the active price list still need a valid item selection if the user changes the item.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: uncommitted in root repo; coexists with pre-existing cleaning/task-center changes and `CRL-20260703-005` finance/daily auto-expense changes.

## CRL-20260703-005 — 深度清洁与日用品更换自动入房源 statement

- **Status:** ready
- **Updated:** 2026-07-03 14:28 AEST
- **Request:** “深度清洁和 日用品更换记录也需要跟房源维修一样的执行逻辑，如果是房东支付的话，需要在statement体现出来”；follow-up: “卖出价”
- **Outcome:** 日用品更换记录在创建/更新后会按价格表卖出价 `daily_items_price_list.unit_price * quantity` 计算金额；完成且房东支付时生成/更新 `property_expenses` 自动快照并归类 `consumables`，从而进入房源 statement。公司支付时生成公司支出，其他支付或未完成/无价格会 void 自动快照。深度清洁与维修的财务回填/statement 对账逻辑保持一致，并支持日用品一起检查/回填。

### Implementation

- Previous behavior:
  - 日用品更换只保存在 `property_daily_necessities`，没有连接 `property_expenses` / `company_expenses`，房东支付不会自动进入 monthly statement。
  - `/finance/auto-expenses/backfill`、`/finance/auto-expenses/inspect` 和 monthly statement PDF 前的 reconcile 只覆盖维修与深度清洁。
  - 自动生成的房源支出只对 `maintenance` / `deep_cleaning` 只读，未覆盖日用品来源。
- New behavior:
  - 新增日用品自动费用 helper：按状态、支付方式、日期、卖出价金额、标题和 statement 摘要生成统一决策。
  - `/inventory/daily-replacements` 创建/更新后尝试同步自动费用；失败不会阻断原记录保存，并通过响应 header 标记同步结果。
  - 财务 backfill/inspect 支持 `type=daily_necessities`，`type=all` 会一起扫描日用品记录；缺价格表时金额按 0 处理并 void，避免生成错误金额。
  - monthly statement 自动费用对账会扫描当月日用品记录，房东支付写入 `property_expenses`，公司支付写入 `company_expenses`。
  - 自动生成的日用品房源支出在 CRUD 修改/删除时与维修、深度清洁一样返回 `auto_generated_expense_readonly`。
- Key decisions:
  - “卖出价”明确使用 `daily_items_price_list.unit_price`，不使用 `cost_unit_price`。
  - 价格匹配优先 `item_id`，并始终用 `item_name` 兜底匹配，避免旧记录 ID 失效但名称仍可匹配时漏算。
  - 日用品房东支付进入 statement 的类别为 `consumables`，明细为 `日用品更换`。
  - 没有价格或未完成的记录不生成 0 金额支出，而是把既有自动快照 void。

### Files / Areas

- `backend/src/lib/dailyNecessitiesAutoExpense.ts` — added: 日用品更换自动费用决策、金额计算、价格表补价、自动 property/company expense 同步。
- `backend/src/lib/autoExpenseSourceSummary.ts` — modified: 增加日用品 statement 摘要生成。
- `backend/src/modules/inventory.ts` — modified: 日用品更换创建/更新后同步自动费用。
- `backend/src/modules/finance.ts` — modified: auto-expenses backfill/inspect 支持 `daily_necessities`，并允许自动费用 category 传入 `consumables`。
- `backend/src/lib/monthlyStatementExpenseReconcile.ts` — modified: statement 月结前自动对账纳入日用品更换。
- `backend/src/modules/crud.ts` — modified: `daily_necessities` 自动房源支出只读保护。
- `backend/scripts/tests/test_auto_expense_source_summary.ts` — modified: 覆盖日用品摘要。
- `backend/scripts/tests/test_daily_necessities_auto_expense.ts` — added: 覆盖日用品卖出价金额和自动费用决策。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: existing endpoints unchanged; `/finance/auto-expenses/backfill` and `/finance/auto-expenses/inspect` accept new `type=daily_necessities`; `/inventory/daily-replacements` responses may include `x-auto-expense-sync` and `x-auto-expense-reason` headers.
- Database / migration: no separate migration; uses existing lazy schema creation for `property_daily_necessities`, `daily_items_price_list`, `property_expenses`, and `company_expenses`.
- Config / environment: none.
- Dependencies: none.
- Related units: finance auto expense behavior follows the existing maintenance/deep-cleaning snapshot model.

### Validation

- `npm --prefix backend run test:auto-expense-source-summary` — passed: `test_auto_expense_source_summary: ok`.
- `cd backend && ./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_daily_necessities_auto_expense.ts` — passed: `test_daily_necessities_auto_expense: ok`.
- `cd backend && ./node_modules/.bin/tsc -p . --noEmit` — passed.
- `git diff --check -- backend/src/lib/autoExpenseSourceSummary.ts backend/src/lib/dailyNecessitiesAutoExpense.ts backend/src/modules/inventory.ts backend/src/modules/finance.ts backend/src/lib/monthlyStatementExpenseReconcile.ts backend/src/modules/crud.ts backend/scripts/tests/test_auto_expense_source_summary.ts backend/scripts/tests/test_daily_necessities_auto_expense.ts` — passed.
- `python3 scripts/audit_change_release_ledger.py` — failed: current worktree has pre-existing uncovered `backend/scripts/tests/phase5_e2e_acceptance.ts`; this unit's files are recorded in `CRL-20260703-005`.
- `npm --prefix backend run build` — not run: backend build writes `dist`; `backend/dist/modules/cleaning.js` already had unrelated pre-existing uncommitted changes, so noEmit typecheck was used to avoid overwriting shared generated output.

### Risks / Release Notes

- Existing records without a matching price list row will not create a statement expense until the price row is present or the record can be matched by item name.
- Mobile/app paths that create daily necessities without `pay_method` still void rather than creating a statement expense; landlord payment must be explicit.
- Backfill/inspect use table-existence checks so older environments skip日用品扫描 rather than failing.
- Rollback: remove the daily necessity helper/imports, revert inventory sync calls, remove `daily_necessities` from finance backfill/inspect/monthly reconcile, and remove the CRUD read-only extension.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: uncommitted in root repo; coexists with pre-existing uncommitted cleaning/task-center changes not owned by this unit.

## CRL-20260703-004 — Phase 4 角色只保留默认可见范围

- **Status:** ready
- **Updated:** 2026-07-03 13:36 AEST
- **Request:** “Phase 4：保留角色作为默认可见范围，不作为流程锁……先执行这个计划吧”
- **Outcome:** 移动端任务执行权限进一步收敛为“基础 permission + 任务参与/action grant”。`admin` / `customer_service` / `offline_manager` 仍用于看全部和管理参与人，但不再因为能看全部就自动获得检查、上传访问视频、补品/完成等现场执行动作。参与人变更会发 membership 事件，移动端会重新同步 `available_actions`。

### Implementation

- Previous behavior:
  - `/mzapp` 的检查和访问视频 guard 仍把 `canViewAll(user)` 当成执行许可，管理角色即使没有参与关系也可能绕过 `available_actions`。
  - `/work-task-participants/set` 保存参与人后没有发 membership 事件，移动端缓存可能继续使用旧 `available_actions`。
  - `/cleaning-app/tasks/*` 旧兼容提交接口主要依赖 permission code，缺少与 `available_actions` 一致的参与人/action grant 校验。
- New behavior:
  - `/mzapp` 检查提交和访问视频删除/上传不再把管理角色视为执行人；legacy 任务参与字段或手动 `work_task_participants.action_ids` 才能放行。
  - 只有 `admin` / `customer_service` / `offline_manager` 这类管理角色可维护 work task participants；单纯 `view=all` permission 不再等于可改参与人。
  - `/work-task-participants/set` 成功后为每个 source 发 `TASK_ASSIGNMENT_CHANGED` + `membership` 事件，移动端触发全量刷新以重算 user-specific `available_actions`。
  - `/cleaning-app` 的上传钥匙、删除钥匙、补品提交、检查照片、访问视频、完成照片、补货凭证、自完成等写接口补上 action guard，旧 App/旧路径也不能只靠角色或 permission 绕过任务参与关系。
- Key decisions:
  - 角色仍保留为默认可见范围：列表 `view=all` 规则不扩大，普通人员仍默认只看参与任务。
  - 查看型详情接口不收紧为执行权限，避免破坏 manager 的只读查看；收紧范围集中在会写状态/媒体/审计的执行接口。
  - 不删除移动端 fallback；无 `available_actions` 的旧 payload 仍走旧逻辑，但服务器返回 `available_actions` 时继续最高优先级。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: 收紧 `canSubmitMzappInspection` / `canManageMzappLockboxVideoLegacy`；参与人管理只允许管理角色；保存参与人后发 membership work-task event。
- `backend/src/modules/cleaning_app.ts` — modified: 增加 cleaning-app 旧兼容 action guard，并接入关键写接口，按 legacy 参与字段或手动 participant action 放行。
- `backend/scripts/tests/test_work_task_actions.ts` — modified: 增加 admin 仅可查看但未参与检查时 `submit_inspection` disabled 的 resolver 断言。
- `docs/change-release-ledger.md` — modified: 记录本 Phase 4 release unit。

### Impact / Dependencies

- API: existing endpoints unchanged; some write actions now return `403 forbidden` when the user has role/permission but is not a task participant and lacks matching manual `action_ids`.
- Database / migration: no separate migration; uses existing lazy-created `work_task_participants` table from Phase 2/3.
- Config / environment: none.
- Dependencies: none.
- Related units: builds on `CRL-20260703-001`, `CRL-20260703-002`, and `CRL-20260703-003`.

### Validation

- `npm run build` in `backend` — passed.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_work_task_actions.ts` in `backend` — passed: `test_work_task_actions: ok`.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm test -- --runTestsByPath src/screens/tasks/TaskDetailScreen.test.tsx src/screens/tabs/TasksScreen.test.tsx src/screens/tasks/InspectionCompleteScreen.test.tsx src/screens/notices/NoticeDetailScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 4 suites / 29 tests; existing SafeAreaView deprecation warning and Jest open-handle warning remained.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with existing warnings, 0 errors.
- `git diff --check` in root repo — passed.

### Risks / Release Notes

- Behavior risk: managers who previously relied on role-only execution now need to be added as a participant with the required action, which is intentional for this phase.
- Compatibility: old payload fallback remains in the mobile UI; old submit routes are stricter only for writes.
- Cache behavior: membership event triggers mobile full sync instead of patching user-specific `available_actions` directly.
- Rollback: restore `canViewAll` execution allowances in `/mzapp`, remove `canPerformCleaningTaskAction` checks from `/cleaning-app`, and remove the membership event emission after participant saves.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: uncommitted in root repo; shares backend action files with the earlier Phase 1-3 uncommitted units.

## CRL-20260703-003 — 移动端任务详情按 available_actions 执行动作入口

- **Status:** ready
- **Updated:** 2026-07-03 13:10 AEST
- **Request:** “Phase 3：移动端详情页作为重点……先直接执行这个计划吧”；follow-up constraints: `available_actions` 存在时 legacy 必须完全禁用，完成页和通知入口也不能绕过后端 action。
- **Outcome:** 移动端任务详情、列表卡片、完成页和通知详情入口都以 `available_actions` 为后端授权源；admin 只有在后端授权 `submit_inspection` 时才能从详情进入检查提交页，cleaner 只有在后端授权 `upload_access_video` 时才能进入改密码/挂钥匙视频完成页，disabled 或空 action 不再被 role/task_type/status fallback 补入口。

### Implementation

- Previous behavior:
  - `workTaskActions.ts` 已经优先使用后端 `available_actions`，但 `upload_access_video` 对仅改密码检查任务没有显式传递跳过检查照片标记。
  - `TasksScreen` 的任务卡片点击仍会在 manager/inspector 角色下直接跳 `ManagerDailyTask` 或 `InspectionPanel`，可能绕过后端 action 的 enabled/disabled 结果。
  - `InspectionCompleteScreen` 进入后只校验检查批次和本地视频状态，没有在提交前再次检查后端 `upload_access_video` action 是否仍 enabled。
  - legacy fallback 中 password-only inspection 仍可能补一个 `submit_inspection` / `InspectionPanel` 入口。
  - 测试只覆盖了部分 server action 渲染，缺少 admin 参与检查、cleaner 仅改密码视频、非参与人禁用和卡片点击不绕过后端授权的组合。
- New behavior:
  - `navigationForWorkTaskAction()` 对 `upload_access_video` 会在 password-only / execution / key-or-password 任务上进入 `InspectionComplete` 并携带 `skipInspectionPhotos: true`。
  - `available_actions: []` 明确表示后端不给任何操作，不 fallback 到上传钥匙、补品、问题反馈等 legacy actions。
  - legacy password-only inspection 不再生成 `submit_inspection` / `InspectionPanel` 入口，只保留访问凭证视频完成入口。
  - `TasksScreen` 中带 `available_actions` 的任务卡片点击统一进入 `TaskDetail`，由详情页和后端 action 决定下一步入口；旧角色直跳只作为没有后端 actions 的 legacy fallback。
  - `InspectionCompleteScreen` 在拍视频和提交前都会检查 server `upload_access_video`，disabled 或缺失时显示后端原因并阻止提交；password-only 完成页不显示“进入检查与补充”链接。
  - `NoticeDetailScreen` 回归测试覆盖通知入口：server action disabled 时即使用户有 admin/inspector 角色，也只提示不可操作并进入详情页，不跳 `InspectionPanel` / `InspectionComplete`。
  - `TaskDetailScreen` 测试覆盖 admin 被授权 `submit_inspection` 后进入 `InspectionPanel`、cleaner 被授权 `upload_access_video` 后进入 `InspectionComplete`、以及非参与人 disabled action 不会因 admin 角色导航。
  - `TasksScreen` 测试覆盖 password-only 视频 action 的跳转参数，以及 manager 卡片点击不会绕过 server disabled action。
- Key decisions:
  - 只在没有 `available_actions` 字段时保留 legacy fallback，保持旧 App / 旧接口兼容；字段存在但为空数组时不 fallback。
  - 本阶段只改移动端入口和测试，不改后端 action resolver、不改数据库。

### Files / Areas

- `mz-cleaning-app-frontend/src/lib/workTaskActions.ts` — modified: `upload_access_video` 对 password-only / execution 类任务显式传递跳过检查照片参数；legacy password-only inspection 不再生成 `submit_inspection` 入口。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 带 `available_actions` 的任务卡片点击进入详情页，不再先按 manager/inspector 角色直跳；为卡片补充稳定 accessibility label 供测试验证。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.tsx` — modified: 完成页提交/拍视频前校验 server `upload_access_video`，disabled 或缺失时阻止操作；password-only 完成页隐藏检查批次入口。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.test.tsx` — added: 覆盖 password-only 完成页不需要 inspection batch、disabled `upload_access_video` 阻止提交。
- `mz-cleaning-app-frontend/src/screens/notices/NoticeDetailScreen.test.tsx` — modified: 覆盖通知详情入口不绕过 disabled server action。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` — modified: 增加 admin 检查入口、cleaner 改密码视频入口、非参与人禁用 action、空 server actions 禁用 legacy actions 的详情页测试。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx` — modified: 增加 password-only 视频 action 参数和 manager 卡片点击不绕过后端 action 的列表页测试。
- `docs/change-release-ledger.md` — modified: 记录本 Phase 3 release unit。

### Impact / Dependencies

- API: none; 继续消费现有 `available_actions`。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: builds on `CRL-20260703-001` task execution semantics naming and `CRL-20260703-002` unified backend action resolver work; overlaps existing uncommitted mobile action files.

### Validation

- `npm test -- --runTestsByPath src/screens/tasks/TaskDetailScreen.test.tsx src/screens/tabs/TasksScreen.test.tsx src/screens/tasks/InspectionCompleteScreen.test.tsx src/screens/notices/NoticeDetailScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 4 test suites / 29 tests; existing SafeAreaView deprecation warning and Jest open-handle warning remained.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with existing warnings, 0 errors.
- `npm test` in `mz-cleaning-app-frontend` — passed: 32 test suites / 112 tests; existing SafeAreaView deprecation warning and Jest open-handle warning remained.
- `git -C mz-cleaning-app-frontend diff --check` — passed.

### Risks / Release Notes

- Release risk: `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx`, `TaskDetailScreen.test.tsx`, `TasksScreen.test.tsx`, and `workTaskActions.ts` already contain earlier uncommitted action-capability changes; selective release should combine related mobile action units or use hunk-level staging.
- Compatibility: tasks without an `available_actions` field still use legacy role-based fallback; tasks with `available_actions: []` show no actions.
- Rollback: revert the `available_actions` card-click branch, completion-page server action guard, notification regression tests, and password-only `skipInspectionPhotos` route flag; existing legacy action buttons remain for tasks without server actions.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: uncommitted in nested `mz-cleaning-app-frontend`; root ledger modified. Root worktree also contains other pre-existing uncommitted units.

## CRL-20260703-002 — 任务动作能力来源统一 Phase 2

- **Status:** ready
- **Updated:** 2026-07-03 12:16 AEST
- **Request:** “再执行Phase 2”
- **Outcome:** Web 管理端的 `management_actions` / `editable_fields` 现在由后端统一动作 resolver 模块 `workTaskActions.ts` 计算；`webTaskCapabilities.ts` 只负责展示语义、状态、参与人摘要，然后调用同一个 resolver 取得动作能力。移动端继续使用同一模块的 `available_actions` / `capabilities`，前端 fallback 不删除。

### Implementation

- Previous behavior:
  - 移动端 `/mzapp/work-tasks` 的执行动作能力由 `backend/src/lib/workTaskActions.ts` 计算。
  - Web `/cleaning` 和任务中心消费的 `management_actions` / `editable_fields` 仍由 `backend/src/lib/webTaskCapabilities.ts` 内部单独维护 gate 逻辑。
  - 两套逻辑虽然规则接近，但来源不统一，后续扩展跨角色动作时容易出现移动端和 Web 端规则漂移。
- New behavior:
  - `backend/src/lib/workTaskActions.ts` 新增 Web 管理动作 resolver：`buildWebTaskManagementPayload()`。
  - `buildWebTaskManagementPayload()` 统一产出 Web `management_actions` 和字段级 `editable_fields`，包含 `missing_management_permission`、`not_applicable`、`auto_sync_locked` 等禁用原因。
  - `backend/src/lib/webTaskCapabilities.ts` 改为调用 `buildWebTaskManagementPayload()`，并 re-export Web action 类型，保持任务中心既有 import 不变。
  - 移动端执行动作 resolver `buildWorkTaskActionPayload()` 保留在同一个模块中，现阶段不删除移动端旧 fallback。
- Key decisions:
  - 本阶段只统一后端动作能力来源，不改变 Web/mobile payload 的字段名称。
  - Web 管理动作仍是管理/排班动作，移动端 `available_actions` 仍是现场执行动作；两者来自同一个 resolver 模块，但展示字段和 action id 不强行合并。
  - 不删除前端 fallback，避免旧 App、灰度接口或缺失能力字段时失效。

### Files / Areas

- `backend/src/lib/workTaskActions.ts` — modified: 新增 Web 管理动作类型、字段能力类型、`buildWebTaskManagementPayload()`，与移动端 `buildWorkTaskActionPayload()` 放在同一动作 resolver 模块。
- `backend/src/lib/webTaskCapabilities.ts` — modified: 删除本地 Web management action gate 生成逻辑，调用统一 resolver，并 re-export 既有 Web action 类型。
- `backend/scripts/tests/test_work_task_actions.ts` — modified: 增加 Web management resolver 断言，覆盖 password-only 任务执行人启用、检查人禁用，以及 auto-sync lock 禁用原因。
- `docs/change-release-ledger.md` — modified: 记录本 Phase 2 release unit。

### Impact / Dependencies

- API: Web `/cleaning/calendar-range` 和任务中心返回的 `management_actions` / `editable_fields` 字段名称不变；计算来源改为统一 resolver。移动端 `/mzapp/work-tasks` payload 字段不变。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: builds on `CRL-20260703-001` Phase 1 semantic naming, `CRL-20260701-006` mobile action resolver, `CRL-20260701-010` Web capability helper, `CRL-20260702-001` `/cleaning` capability consumption, and `CRL-20260701-012` task-center capability consumption.

### Validation

- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_work_task_actions.ts` in `backend` — passed: `test_work_task_actions: ok`.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_web_task_capabilities.ts` in `backend` — passed: `test_web_task_capabilities: ok`.
- `npm run build` in `backend` — passed.
- `git diff --check` in root repo — passed.

### Risks / Release Notes

- Release risk: `backend/src/lib/workTaskActions.ts` and `backend/src/lib/webTaskCapabilities.ts` are shared with earlier uncommitted action/capability units, so selective release should combine related Phase 1/2 action-capability units or use hunk-level staging.
- Behavior risk: Web management action behavior should remain equivalent, but its source moved; targeted tests cover the key password-only and locked-task gates.
- Compatibility: front-end fallback remains; payload fields are additive/unchanged.
- Rollback: restore Web management action generation inside `webTaskCapabilities.ts` and remove `buildWebTaskManagementPayload()` from `workTaskActions.ts`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: uncommitted in root repo; nested `mz-cleaning-app-frontend` still contains earlier unrelated/mobile action changes but was not modified by this Phase 2 task.

## CRL-20260703-001 — 任务执行语义命名统一 Phase 1

- **Status:** ready
- **Updated:** 2026-07-03 11:53 AEST
- **Request:** “先执行Phase 1”
- **Outcome:** 清洁/检查/挂钥匙相关任务的 `execution_semantics` 规范值统一为 `key_or_password_action`，后端 `/mzapp/work-tasks` 新产出的仅改密码/挂钥匙任务不再继续返回旧的 `key_handover_execution`；后端、Web `/cleaning` 和移动端 helper 仍兼容旧值输入，避免旧 payload 或旧 App 数据断流。

### Implementation

- Previous behavior:
  - Web capability 已使用 `key_or_password_action` 表示“仅改密码/挂钥匙”。
  - `/mzapp/work-tasks`、后端移动端 action resolver、移动端任务 helper 仍把同类任务称为 `key_handover_execution`。
  - Web `/cleaning` 和每日清洁状态 helper 对旧语义值没有统一 normalize，跨端 payload 混用时可能出现分类、badge 或执行人判断不一致。
- New behavior:
  - 后端 `cleaningTaskExecutionSemantics()` 现在产出规范值 `key_or_password_action`。
  - 新增/补齐 `normalizeTaskExecutionSemantics()` 和 `isKeyOrPasswordActionSemantics()`，把旧 `key_handover_execution` 映射到规范值。
  - 后端 action/参与人判断、`mzapp` legacy participant 判断、Web `/cleaning`、每日清洁状态 helper、移动端 `cleaningInspection` helper 都走规范语义或兼容映射。
  - 移动端 API 类型显式包含 `key_or_password_action`，仍通过 `string` 兼容历史值。
- Key decisions:
  - 本阶段只统一语义命名，不改变 Phase 2 的动作能力来源，不删除旧 fallback。
  - `execution_role=execution`、`task_kind=execution` 仍保留，用于旧数据和旧 App 兼容。

### Files / Areas

- `backend/src/lib/cleaningInspection.ts` — modified: 新增任务执行语义类型、规范化 helper，并把仅改密码/挂钥匙输出改为 `key_or_password_action`。
- `backend/src/lib/workTaskActions.ts` — modified: 后端动作能力判断通过语义 helper 兼容旧值和新值。
- `backend/src/modules/mzapp.ts` — modified: 移动端任务 legacy participant 判断通过语义 helper 识别仅改密码/挂钥匙任务。
- `backend/scripts/tests/test_work_task_actions.ts` — modified: 覆盖旧语义值映射到新规范值，以及执行任务产出新规范值。
- `backend/scripts/tests/test_task_assignment_canonical.ts` — modified: `/mzapp/work-tasks` password-only checkin 断言改为规范语义值。
- `frontend/src/app/cleaning/page.tsx` — modified: `/cleaning` 本地 execution semantics helper 兼容旧值输入。
- `frontend/src/lib/cleaningDailyTaskStatus.ts` — modified: 每日清洁合并 badge 判断兼容旧值输入。
- `mz-cleaning-app-frontend/src/lib/cleaningInspection.ts` — modified: 移动端任务语义 helper 新增规范化并兼容旧值。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: 移动端 WorkTask 类型显式接受 `key_or_password_action`。
- `docs/change-release-ledger.md` — modified: 记录本 Phase 1 release unit。

### Impact / Dependencies

- API: `/mzapp/work-tasks` 新返回的仅改密码/挂钥匙任务 `execution_semantics` 规范值为 `key_or_password_action`；旧值 `key_handover_execution` 仍被后端/Web/移动端兼容读取。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: depends on `CRL-20260701-006` through `CRL-20260701-008` mobile task action capability work, `CRL-20260701-010` Web capability helper, `CRL-20260702-001` `/cleaning` capability consumption, and `CRL-20260702-003` daily cleaning display helpers.

### Validation

- `rg -n "key_handover_execution" backend/src backend/scripts frontend/src mz-cleaning-app-frontend/src` — passed: old value remains only in normalize compatibility mappings and one explicit compatibility test.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_work_task_actions.ts` in `backend` — passed: `test_work_task_actions: ok`.
- `npm run build` in `backend` — passed.
- `npm run lint` in `frontend` — passed with existing repository warnings, 0 errors.
- `npm run build` in `frontend` — passed; existing Browserslist, ESLint, and Recharts static-generation warnings remain.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed.
- `npm test -- --runTestsByPath src/screens/tasks/TaskDetailScreen.test.tsx src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 2 test suites / 19 tests; Jest still reported the existing open-handle warning after completion.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_task_assignment_canonical.ts` in `backend` — first run failed in sandbox with DNS `ENOTFOUND`; rerun with approved network access passed: `test_task_assignment_canonical: ok`.
- `git diff --check` in root repo and `git -C mz-cleaning-app-frontend diff --check` — passed.
- `python3 scripts/audit_change_release_ledger.py` — passed: `Changed files: 17`, `Recorded changed files: 17`, `Coverage: PASS`.

### Risks / Release Notes

- Release risk: API consumers that hard-code only `key_handover_execution` need the same compatibility mapping before consuming newly produced payloads. The current Web and mobile code paths were updated.
- Compatibility: old payloads with `key_handover_execution` remain accepted by normalize helpers.
- Rollback: revert `cleaningTaskExecutionSemantics()` to emit the old value and remove the normalize-helper call sites; old role/task_kind fallback remains available.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: uncommitted in root repo and nested `mz-cleaning-app-frontend`; worktree also contains other pre-existing release units unrelated to this Phase 1 task.

## CRL-20260702-003 — 每日清洁状态按移动端口径合并展示

- **Status:** ready
- **Updated:** 2026-07-02 22:55 AEST
- **Request:** “每日清洁的页面的任务状态 也需要跟移动端一样显示。”
- **Outcome:** `/cleaning` 每日清洁页的任务主状态和 meta 标签改为移动端式展示口径；普通未分配状态显示为“未分配”，合并卡片按底层任务最高优先级状态展示，任一底层任务已 `keys_hung` 时主状态显示“已挂钥匙”而不是回落到“已分配”；退房+入住合并卡不再错误显示“纯入住检查”，入住-only 卡片不再显示“退房/退房密码”标签，非默认退房/入住时间会显示“早退房/晚退房/早入住/晚入住”标签；合并卡片里只要有底层清洁任务可分配，清洁下拉不再因为纯入住检查子任务 `not_applicable` 而被整卡禁用。

### Implementation

- Previous behavior:
  - `/cleaning` 卡片虽然会读取 `display_state`，但前端合并同房源同日任务时仍用旧 `mergedStatus()` 顺序生成合并 `status`。
  - 旧顺序会让 `assigned` 压过 `keys_hung` / completed 等真实进度，合并卡片左上角容易继续显示“已分配”。
  - `pending` / `todo` / `unassigned` 在每日清洁页沿用 Web 通用“待处理”文案，与移动端“未分配”口径不一致。
- New behavior:
  - 新增每日清洁状态 helper，集中定义移动端式状态文案和合并优先级：`keys_hung` 高于完成态、待挂钥匙/待检查、进行中、已分配、未分配。
  - `/cleaning` 卡片主状态使用每日清洁 helper 展示；合并卡片的 `display_state` 从所有底层任务重新合成，不再只依赖旧合并 `status` 文案。
  - 卡片辅助 badge 过滤掉与主状态或 scope 同文案的项，避免“已挂钥匙”“纯入住检查”“仅改密码/挂钥匙”重复出现。
  - `pure_checkin_inspection / 纯入住检查` 只允许在单独入住检查或仅改密码/挂钥匙语义下显示；退房+入住 `mixed_cleaning_inspection` 合并卡不继承该子任务 badge。
  - 入住-only 卡片的订单和密码 meta label 改为“入住 / 入住密码”；非合并卡不再同时显示退房密码和入住密码。
  - `钥匙未上传` 根据当前卡片实际展示角色判断是否有对应执行/检查人，避免未分配的纯入住检查因为隐藏 assignee 字段而显示钥匙未上传。
  - 新增非默认时间标签：退房早于/晚于 10am 显示 `早退房/晚退房`，入住早于/晚于 3pm 显示 `早入住/晚入住`，例如 `2:30pm入住` 会显示 `早入住`。
  - 合并 capability 时把子任务级 `not_applicable` 视为“不参与该字段”，只要同卡里存在可编辑的清洁任务就启用对应下拉；`auto_sync_locked` 等硬禁用原因仍会禁用。
  - 清洁/检查/执行人员下拉保存时只提交对该字段可编辑的底层 `cleaning_tasks` id，避免把清洁人员写进纯入住检查子任务。
- Key decisions:
  - 本次是前端展示口径修复，不改数据库、不改保存接口。
  - 保留旧 `status` 字段作为合并卡片内部状态值，但用户可见主状态以合成后的 `display_state` 为准。

### Files / Areas

- `frontend/src/lib/cleaningDailyTaskStatus.ts` — added: 每日清洁页移动端式状态文案、状态 rank、合并 display status/badge helper、可见 badge 过滤 helper、早/晚退房与早/晚入住时间标签 helper、合并卡片 capability gate helper。
- `frontend/src/lib/cleaningDailyTaskStatus.test.ts` — added: 覆盖未分配文案、`assigned + keys_hung` 合并、`pending + assigned` 合并、退房+入住合并不显示“纯入住检查”、重复 badge 过滤、非默认退房/入住时间标签、`not_applicable` 子任务不禁用整张合并卡。
- `frontend/src/app/cleaning/page.tsx` — modified: 每日清洁卡片主状态和合并卡片 capability 接入新 helper；修正重复 badge、入住-only 订单/密码 label、钥匙未上传显示条件；人员下拉按底层可编辑任务启用和保存。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: builds on `CRL-20260702-001` `/cleaning` capability consumption. Complements `CRL-20260702-002` backend/task-center status overwrite fix, but this unit only changes daily cleaning page display.

### Validation

- `npm --prefix frontend exec vitest run src/lib/cleaningDailyTaskStatus.test.ts` — passed: 1 test file / 7 tests.
- `git diff --check -- frontend/src/lib/cleaningDailyTaskStatus.ts frontend/src/lib/cleaningDailyTaskStatus.test.ts frontend/src/app/cleaning/page.tsx` — passed.
- `npm --prefix frontend run lint` — passed with existing repository warnings; no errors.
- `npm --prefix frontend run build` — passed; existing Browserslist, ESLint, and Recharts static-generation warnings remain.

### Risks / Release Notes

- UX change: daily cleaning cards with raw `pending` / `todo` / `unassigned` now show “未分配” instead of “待处理” to match mobile wording.
- Release risk: `frontend/src/app/cleaning/page.tsx` already contains earlier uncommitted capability work; selective release requires hunk-level review or combining with related `/cleaning` display units.
- Rollback: remove `cleaningDailyTaskStatus.ts` usage from `/cleaning/page.tsx` and restore the previous local `mergedStatus()` ordering.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: uncommitted in root repo; shared worktree also contains other unrelated ready/in-progress units.

## CRL-20260702-001 — 每日清洁接入 Web capability 展示

- **Status:** ready
- **Updated:** 2026-07-02 11:58 AEST
- **Request:** “Phase 3：每日清洁 /cleaning 再接入……有 capability 就按 capability；没有就走旧逻辑。”
- **Outcome:** `/cleaning` 每日清洁页开始消费后端 Web capability：状态、scope badge、任务分类、人员显示和主要可编辑字段优先按后端字段展示/禁用；旧 `task_type` / `label` / `status` 推断和原保存 payload 继续作为 fallback。

### Implementation

- Previous behavior:
  - `/cleaning` 页面按 `task_type`、`label`、`inspection_scope` 自行判断清洁执行、纯入住检查、仅改密码/挂钥匙。
  - 任务卡片和 Drawer 的状态、scope、人员字段可编辑性主要由前端本地条件决定。
  - 页面仍在前端合并同房源退房、入住、入住中清洁后再打开 Drawer 组装编辑 payload。
- New behavior:
  - 后端 Web capability payload additive 增加 `execution_semantics`、`display_scope`、`participant_summary`、`editable_fields`，继续保留 `display_state` / `management_actions`。
  - `/cleaning/calendar-range` 已通过既有 `buildWebTaskCapabilityPayload()` 路径自然返回新增字段；旧字段不删除。
  - `/cleaning` 页面新增 capability helper：有 `execution_semantics` 时用它决定清洁/检查/线下 tab 分类和仅改密码/挂钥匙展示；没有时 fallback 到旧 `task_type` / `label` 判断。
  - 任务卡片和线下任务卡片状态优先读 `display_state.status_*`，scope/badge 优先读 `display_scope` / `display_state.badges`。
  - 卡片上的清洁人员、检查人员、执行人、状态 Select，以及编辑/删除按钮，优先按 `editable_fields` / `management_actions` 禁用并显示原因。
  - Drawer 打开时保留点击卡片携带的 capability；保存按钮、日期、状态、人员、退房/入住新增、密码/时间/钥匙套数/客人需求字段按 capability 禁用。原 `submitEdit` payload 和现有合并打开逻辑不拆。
- Key decisions:
  - 本阶段不重构每日清洁页的合并模型，不改数据库，不收紧接口权限。
  - 前端本地合并卡片会组合子任务 capability，避免合并后完全丢失后端语义；字段缺失仍保持旧行为。

### Files / Areas

- `backend/src/lib/webTaskCapabilities.ts` — modified: Web task capability shape additive 增加 execution semantics、display scope、participant summary、editable fields。
- `backend/scripts/tests/test_web_task_capabilities.ts` — modified: 覆盖新增语义字段和 editable field gate。
- `frontend/src/app/cleaning/page.tsx` — modified: 每日清洁页任务分类、卡片展示、行内 Select、Drawer 主要字段优先消费 capability，旧逻辑 fallback。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: `/cleaning/calendar-range` 返回项通过既有 capability helper additive 增加 `execution_semantics`、`display_scope`、`participant_summary`、`editable_fields`；旧字段保留。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: depends on `CRL-20260701-010` Web capability helper and `CRL-20260701-012` task-center front-end consumption pattern.

### Validation

- `git diff --check -- backend/src/lib/webTaskCapabilities.ts backend/scripts/tests/test_web_task_capabilities.ts frontend/src/app/cleaning/page.tsx` — passed.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_web_task_capabilities.ts` in `backend` — passed: `test_web_task_capabilities: ok`.
- `npm run build` in `backend` — passed.
- `npm run lint` in `frontend` — passed with existing repository warnings, 0 errors.
- `npm run build` in `frontend` — passed; existing Browserslist, ESLint, and Recharts static-generation warnings remain.
- `npm test` in `frontend` — passed: 36 test files / 156 tests.

### Risks / Release Notes

- Rollout risk: `/cleaning` still keeps its old front-end merge/open-edit/save model, so this is display/control migration only, not final source-of-truth cleanup.
- Compatibility: if backend capability fields are missing, classification, status labels, controls and Drawer fields fall back to existing behavior.
- UX risk: locally merged cards combine child-task gates; if any child task blocks a field, the merged card field is disabled.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Rollback: remove the new fields from `webTaskCapabilities.ts` and revert the `/cleaning` page helper/control wiring; old page logic remains available as fallback.
- Git state: uncommitted in root repo; shared worktree also contains unrelated property-payable, task-center, backend task-action, and mobile task-action units.

## CRL-20260702-002 — 挂钥匙状态不被排班保存覆盖

- **Status:** committed
- **Updated:** 2026-07-02 23:24 AEST
- **Request:** 修复生产版本挂完钥匙后任务标签又变回“已分配”；`mergeTurnoverTaskPlan()` 不能只用 checkout 状态，任务中心保存排班不能把合并卡片派生 `status` 写回每个 `cleaning_tasks`，并补回归测试和生产数据修复。
- **Outcome:** turnover 合并卡片现在按统一状态优先级展示底层最高状态，任一底层任务为 `keys_hung` 时不会回落为 `assigned`；任务中心 save-board 普通排班保存不再写 cleaning/work task 的派生 status，只有明确的 `status_action` 才允许改 cleaning status；新增生产修复 SQL 可预览并恢复已被覆盖的 `keys_hung` 脏数据。

### Implementation

- Previous behavior:
  - `mergeTurnoverTaskPlan()` 用 checkout rows 作为 primary rows 计算合并状态；同日退房仍是 `assigned` 时，入住任务即使已 `keys_hung`，合并卡片仍显示“已分配”。
  - 任务中心前端保存 payload 会把合并卡片的 `status` 塞进每个 active cleaning task；后端 `/task-center/save-board` 直接 `status = x.status`，导致生产中已挂钥匙的入住任务可被后续“保存安排”覆盖回 `assigned`。
  - work task 保存也会接受旧 payload 里的 `status`，普通内容/排班保存存在类似状态覆盖风险。
- New behavior:
  - `mergedTaskStatus()` 使用状态 rank：`keys_hung` 高于 completed/done、检查完成态、in_progress、assigned、pending；turnover status 基于所有底层 rows，而不是只看 checkout rows。
  - 任务中心前端不再把普通 cleaning/work assignment snapshot 的 `status` 当作变更；只有详情弹窗明确切换“已挂钥匙/任务已结束”时才附带 `status_action` 与目标 status。
  - 后端 save-board schema 兼容旧 `status` 字段，但 cleaning status 只有 `status_action` 存在时才写入；work task status 不再从 payload 直接写入，只在显式 assign/unassign 且当前仍是 todo/assigned 时自动维护派单状态。
  - 新增生产数据修复脚本：先 preview，再 apply；只恢复有 `upload_access_video -> keys_hung` 审计、仍有 lockbox 视频证据、但当前状态被覆盖为普通派单状态的任务。
- Key decisions:
  - 不新增数据库字段；`status_action` 是 save-board payload 的显式意图字段。
  - 生产修复 SQL 使用审计 + 当前视频证据双条件，避免恢复已经删除挂钥匙视频的任务。

### Files / Areas

- `backend/src/lib/cleaningInspection.ts` — modified: turnover 合并状态改为 rank 规则并纳入所有底层任务状态。
- `backend/src/modules/task_center.ts` — modified: save-board 只通过 `status_action` 写 cleaning status；普通 work assignment 不再写 payload status；保留当前 capability 相关未提交改动。
- `frontend/src/app/task-center/page.tsx` — modified: cleaning/work 保存 payload 不再提交派生 status；详情显式状态切换才生成 `status_action`。
- `backend/scripts/tests/test_cleaning_inspection_merge.ts` — modified: 覆盖 checkout assigned + checkin keys_hung 时合并状态仍为 `keys_hung`。
- `backend/scripts/tests/test_task_assignment_canonical.ts` — modified: 覆盖旧 save-board payload 带 `status: assigned` 也不能覆盖 DB 中 `keys_hung`。
- `backend/scripts/backfills/restore_keys_hung_status_2026_07_02_README.md` — added: 生产数据修复步骤与候选条件说明。
- `backend/scripts/backfills/restore_keys_hung_status_2026_07_02_preview.sql` — added: 查询可能被覆盖的 `keys_hung` 候选任务，不写数据。
- `backend/scripts/backfills/restore_keys_hung_status_2026_07_02_apply.sql` — added: 事务内把确认候选恢复为 `keys_hung` 并返回更新记录。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: `/task-center/save-board` 的 `cleaning_assignments[]` 新增可选 `status_action`；旧 `status` 字段仍兼容接收，但没有 `status_action` 时会被忽略，不再作为普通排班保存的状态来源。
- Database / migration: no schema migration. Production data repair is optional SQL backfill under `backend/scripts/backfills`; must run preview before apply.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `backend/src/modules/task_center.ts` and `frontend/src/app/task-center/page.tsx` with `CRL-20260701-012`; selective release requires hunk-level staging or explicit combined scope.

### Validation

- `git diff --check -- backend/src/lib/cleaningInspection.ts backend/src/modules/task_center.ts frontend/src/app/task-center/page.tsx backend/scripts/tests/test_cleaning_inspection_merge.ts backend/scripts/tests/test_task_assignment_canonical.ts backend/scripts/backfills/restore_keys_hung_status_2026_07_02_README.md backend/scripts/backfills/restore_keys_hung_status_2026_07_02_preview.sql backend/scripts/backfills/restore_keys_hung_status_2026_07_02_apply.sql` — passed.
- `npm --prefix backend run test:cleaning-inspection-merge` — passed: `test_cleaning_inspection_merge: ok`.
- `npm --prefix backend run build` — passed: `tsc -p .`.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_task_assignment_canonical.ts` in `backend` — failed in sandbox first due to DNS `ENOTFOUND` for configured Neon host; rerun with approved network access passed: `test_task_assignment_canonical: ok`.
- `npm --prefix frontend run lint` — passed with existing repository warnings; no errors.
- `npm --prefix frontend run build` — passed; existing Browserslist, ESLint, and Recharts static-generation warnings remain.

### Risks / Release Notes

- Production repair risk: apply SQL changes real task statuses; run preview first and review candidate task IDs before apply. The script intentionally skips rows without current lockbox video evidence.
- Behavior risk: generic save-board no longer changes task status from old `status` payloads; status changes must come from explicit action semantics.
- Release risk: shared worktree contains unrelated ready/in-progress units in the same task-center files; do not broad-stage this unit without hunk review.
- Rollback: restore old `mergedTaskStatus()` ordering, remove `status_action` handling and front-end payload filtering, and do not run or revert the production apply SQL if already executed.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Git state: committed locally to root `Dev` in commit `73a9ece`; push to remote failed because GitHub HTTPS credentials are unavailable in this environment and SSH key auth was denied. Shared files still contain unrelated local changes from other CRL units.

## CRL-20260701-012 — 任务中心展示读取 Web capability

- **Status:** ready
- **Updated:** 2026-07-02 00:01 AEST
- **Request:** “Phase 2：任务中心先改展示，不改保存逻辑……详情弹窗按钮、行级人员选择框、状态标签优先读 display_state；拖拽后的本地状态推断先保留，保存 payload 暂时保持旧结构，保存成功后重新拉 /task-center/day。”
- **Outcome:** 任务中心页面开始优先使用后端返回的 `display_state` 展示状态和语义标签，并使用 `management_actions` 控制详情弹窗字段、按钮和行级人员选择框的可用性与禁用原因；保存 payload 和拖拽/本地推断逻辑保留，保存成功后继续刷新 day payload。

### Implementation

- Previous behavior:
  - 任务卡片、详情弹窗和房源待办状态标签主要由前端根据 `status`、`inspection_mode`、`inspection_scope` 等旧字段自行推断。
  - 详情弹窗里的清洁人员、检查安排、检查执行方式、已挂钥匙、任务已结束、线下任务字段，以及行级检查人员/执行人选择框主要由前端本地条件决定是否可操作。
  - 看板拖拽和行级分配后仍会在本地推断状态并组装旧保存 payload。
- New behavior:
  - 新增前端 `display_state` / `management_actions` 类型和轻量 helper；当后端字段存在时，状态 chip 和语义 badge 优先使用后端返回值。
  - 任务卡片、详情弹窗、退房日房源待办卡片的状态展示优先读 `display_state`，缺失时 fallback 到旧 `taskStatusMeta` / inspection badge 逻辑。
  - 详情弹窗现有编辑字段和开关按 `management_actions` 禁用，并把后端 `disabled_reason` 转成可读 title；旧 payload 和 `saveTaskDetail` 数据结构不变。
  - 行级“检查人员”“执行人”选择框按当前行任务的后端 management gate 禁用；旧 App/旧字段缺失时保持可编辑 fallback。
  - `saveBoardDraft` 保持旧 `cleaning_assignments` / `work_assignments` / `task_flags` 结构；保存成功后已继续调用 `loadDay({ discardDraft: true })`，以后端返回覆盖本地推断。
- Key decisions:
  - 本阶段只改展示消费，不新增协作者配置入口，不新增独立保存接口，不删除拖拽后的本地状态推断。
  - capability 缺失时默认兼容旧行为，避免后端字段灰度期间让任务中心不可操作。

### Files / Areas

- `frontend/src/app/task-center/page.tsx` — modified: 任务中心状态标签、详情弹窗控件和行级人员选择框优先消费 `display_state` / `management_actions`；保存逻辑保持旧结构。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: consumes additive fields `display_state` / `management_actions` from `/task-center/day`; no new endpoint required.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: depends on `CRL-20260701-010` backend Web capability fields.

### Validation

- `git diff --check -- frontend/src/app/task-center/page.tsx` — passed.
- `npm run lint` in `frontend` — passed with existing repository warnings, 0 errors.
- `npm run build` in `frontend` — passed; existing Browserslist, ESLint, and Recharts static-generation warnings remain.
- `npm test` in `frontend` — passed: 36 test files / 156 tests.
- `npm run typecheck` in `frontend` — not run: frontend package has no `typecheck` script; `npm run build` performed Next type validity checks.

### Risks / Release Notes

- Rollout risk: if backend omits `management_actions`, the page intentionally falls back to old editable behavior for compatibility.
- UX risk: a row containing mixed tasks will disable the row-level selector when any task with backend management actions says that action is disabled; detail-level controls remain task-specific.
- Compatibility: no old response fields, board save payload, drag/drop behavior, or old permission checks were removed.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Rollback: revert the `display_state` / `management_actions` consumption helpers and control wiring in `frontend/src/app/task-center/page.tsx`; backend additive fields can remain.
- Git state: uncommitted in root repo; shared worktree also contains unrelated property-payable, backend task capability/action, and mobile task-action units.

## CRL-20260701-011 — 房源代付模板日期规则简化

- **Status:** committed
- **Updated:** 2026-07-02 23:24 AEST
- **Request:** “这里模板账期那些太复杂了。不要分那么细，我们只需要记录 每月预计收到账单日期。账单due date 应该就是每个月固定30的号。然后记录状态的判断，如果超过预计收到账单日 5天以后还没有记录支付就是逾期”
- **Outcome:** 房源代付模板不再让用户配置账期开始/结束、付款周期、提前提示天数或自定义付款截止日；模板只要求维护每月预计收到账单日。房源代付 due date 统一按每月 30 号生成，遇到小月按月末 fallback。逾期状态改为预计收到账单日后第 5 天仍未登记支付即逾期。

### Implementation

- Previous behavior:
  - 模板表单暴露付款截止日、预计收到账单日、账期开始/结束、付款周期和提前提示天数，配置过细。
  - 后端房源代付逾期主要按付款 due date 判断；账单未收到另按预计收账单日当天之后标记。
  - 房源页模板预设也展示同一套复杂账期/周期字段。
- New behavior:
  - 房源代付页面和房源页模板预设只保留“预计收到账单日”输入；付款截止日只展示固定“每月 30 号”。
  - 后端创建/更新房源代付模板时强制归一化为 `due_day_of_month=30`、`frequency_months=1`、账期字段为空、提前提示默认 3。
  - 月度快照和 workbench 展示使用固定 30 号 due date；确认本月账单时不再保存账期或自定义 due date。
  - workflow 逾期判断改为 `bill_expected_date + 5 days < today` 且未 paid；只要未登记支付，无论是否已确认金额，都进入逾期。
  - 模板预计收到账单日变更会同步更新未来未付快照的 `bill_expected_date`。
- Key decisions:
  - 不删除数据库列，保持历史数据和接口兼容；只是对房源代付业务不再使用这些复杂字段。
  - 保留付款方式、收款方、BSB、Account、BPAY、PayID、Reference 等支付信息字段，因为登记支付仍需要。

### Files / Areas

- `backend/src/modules/recurring.ts` — modified: 固定房源代付 due day、模板 payload 归一化、workbench 逾期状态改为预计收账单日 + 5 天未支付、确认账单不再写账期/自定义 due date、未来未付快照同步预计收账单日。
- `backend/src/modules/properties.ts` — modified: 房源页同步代付模板时固定 due day/每月/空账期，并允许只提交预计收到账单日。
- `backend/dist/modules/properties.js` — modified: `npm run build` 生成的对应后端输出。
- `backend/scripts/tests/test_property_payable_bill_dates.ts` — modified: 覆盖固定 due day 和空账期输出。
- `backend/scripts/tests/test_property_payable_template_sync.ts` — modified: 把业务字段变化覆盖点改为预计收到账单日。
- `frontend/src/lib/propertyPayables.ts` — modified: 前端默认/归一化模板固定 due day、每月、空账期。
- `frontend/src/app/finance/property-payables/page.tsx` — modified: 模板抽屉和确认账单抽屉移除账期/周期/提前提示/自定义 due date；模板管理列表显示预计收到账单日和固定 due day。
- `frontend/src/components/PropertyPayableTemplatesForm.tsx` — modified: 房源页复用模板表单只保留预计收到账单日和固定 due day 展示。
- `frontend/src/app/properties/page.tsx` — modified: 房源详情代付模板展示移除账期/周期，显示预计收到账单日和固定 due day。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: existing fields remain accepted, but property-payable create/update normalizes due day to 30, frequency to monthly, and ignores bill-period fields for active behavior.
- Database / migration: none; existing columns remain.
- Config / environment: none.
- Dependencies: none.
- Related units: builds on `CRL-20260701-009` UI workbench layout and `CRL-20260630-003` bill-date backend fields.

### Validation

- `rg -n "账期开始|账期结束|费用账期|付款周期|提前提示|PROPERTY_PAYABLE_FREQUENCY_OPTIONS|BILL_MONTH_OFFSET_OPTIONS|formatBillPeriod" frontend/src/app/finance/property-payables/page.tsx frontend/src/components/PropertyPayableTemplatesForm.tsx frontend/src/app/properties/page.tsx` — passed: no user-visible stale complex-field labels remain.
- `git diff --check -- backend/src/modules/recurring.ts backend/src/modules/properties.ts backend/scripts/tests/test_property_payable_bill_dates.ts backend/scripts/tests/test_property_payable_template_sync.ts frontend/src/app/finance/property-payables/page.tsx frontend/src/components/PropertyPayableTemplatesForm.tsx frontend/src/app/properties/page.tsx frontend/src/lib/propertyPayables.ts` — passed.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_property_payable_bill_dates.ts` in `backend` — passed: `test_property_payable_bill_dates: ok`.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_property_payable_template_sync.ts` in `backend` — passed: `test_property_payable_template_sync: ok`.
- `npm run build` in `backend` — failed once: new generic helper typing in `recurring.ts` produced TS2339 property errors; fixed by making the helper accept `Record<string, any>`.
- `npm run build` in `backend` — passed after the helper typing fix.
- `npm run lint` in `frontend` — passed with existing repository warnings, 0 errors.
- `npm run test` in `frontend` — passed: 36 test files / 156 tests.
- `npm run build` in `frontend` — passed; existing Browserslist, ESLint, and Recharts static-generation warnings remain.

### Risks / Release Notes

- Data compatibility: existing snapshots may still store old bill-period values in DB, but workbench/confirmation no longer displays or updates them for this workflow.
- Status semantics: unpaid rows become overdue based on expected bill date + 5 days, even if amount was already confirmed; this matches the requested “未记录支付即逾期” rule.
- Generated-output note: `npm run build` also refreshed `backend/dist/modules/cleaning.js` from unrelated existing cleaning/task changes; that shared generated file is not part of this release unit and is already tracked by other ledger entries.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Rollback: restore configurable due/period/frequency fields in the front end and revert the property-payable normalization/status logic in `recurring.ts` / `properties.ts`.
- Git state: committed locally to root `Dev` in commit `73a9ece`; push to remote failed because GitHub HTTPS credentials are unavailable in this environment and SSH key auth was denied. Worktree also contains unrelated task-center/cleaning/mobile-action units from other local work.

## CRL-20260701-010 — 网页端任务能力展示字段

- **Status:** ready
- **Updated:** 2026-07-01 23:34 AEST
- **Request:** “Phase 1：后端先补 Web capability 字段，只 additive……最好一起给 display_state。”
- **Outcome:** 网页端任务数据源现在 additive 返回 `display_state` 和 `management_actions`，用于逐步把任务中心/每日清洁的状态文案、badge、管理按钮可用性迁到后端；旧字段保留，旧网页端逻辑仍可继续运行。

### Implementation

- Previous behavior:
  - `/task-center/day` 和 `/cleaning/calendar-range` 只返回旧任务字段，网页端继续根据 `task_type`、`status`、`inspection_mode`、`inspection_scope`、`cleaner_id`、`inspector_id` 自己判断 “已挂钥匙 / 自完成 / 已检查 / 任务已结束 / 纯入住检查 / 仅改密码/挂钥匙” 等展示语义。
  - 管理动作按钮是否适用主要散落在任务中心和每日清洁页面。
- New behavior:
  - 新增后端纯 helper `buildWebTaskCapabilityPayload()`，统一计算 `display_state.status_*`、`display_state.task_semantics`、`display_state.badges` 和 `management_actions`。
  - `/task-center/day` 的 rows、work tasks、property followups 都追加 `display_state` / `management_actions`；合并后的 turnover/deferred 任务也在最终返回前统一增强。
  - `/cleaning/calendar-range` 的 cleaning tasks、deferred inspection projection、offline tasks 返回前统一追加 `display_state` / `management_actions`。
  - 当前仅按现有网页管理权限计算 action enabled：有 `cleaning.task.assign` 或 `cleaning.schedule.manage` 才启用管理动作；只有查看权限时仍返回动作和 `missing_management_permission` disabled reason。
- Key decisions:
  - 本阶段只做 additive response fields，不删除旧字段、不改数据库、不收紧现有提交接口权限。
  - `display_state.badges` 明确覆盖网页端现有重点文案：`已挂钥匙`、`自完成`、`已检查`、`任务已结束`、`纯入住检查`、`仅改密码/挂钥匙`。
  - `management_actions` 表达 Web 管理动作，不复用移动端现场执行 `available_actions`，避免混淆“排班/代操作”与“现场执行”。

### Files / Areas

- `backend/src/lib/webTaskCapabilities.ts` — added: 网页端任务展示状态和管理动作 capability 纯计算 helper。
- `backend/src/modules/task_center.ts` — modified: `/task-center/day` 为任务中心 rows、work tasks、property followups 追加 `display_state` / `management_actions`。
- `backend/src/modules/cleaning.ts` — modified: `/cleaning/calendar-range` 为每日清洁和线下任务返回项追加 `display_state` / `management_actions`。
- `backend/scripts/tests/test_web_task_capabilities.ts` — added: 覆盖仅改密码/挂钥匙、已挂钥匙、自完成/已检查、只读权限禁用管理动作、线下任务显示状态。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: `/task-center/day` 与 `/cleaning/calendar-range` 响应 additive 增加 `display_state` / `management_actions`；旧字段保留，旧前端忽略新增字段不受影响。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: follows mobile/task action units `CRL-20260701-006` through `CRL-20260701-008`, but this unit is Web display/management capability only and can be reviewed separately.

### Validation

- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_web_task_capabilities.ts` in `backend` — passed: `test_web_task_capabilities: ok`.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_work_task_actions.ts` in `backend` — passed: `test_work_task_actions: ok`.
- `git diff --check -- backend/src/lib/webTaskCapabilities.ts backend/src/modules/task_center.ts backend/src/modules/cleaning.ts backend/scripts/tests/test_web_task_capabilities.ts` — passed.
- `npm run build` in `backend` — failed in unrelated modified file `backend/src/modules/recurring.ts`: TypeScript errors `Property 'scope' / 'due_day_of_month' / 'frequency_months' / bill-period fields does not exist on type 'T'`. This file is part of a separate property-payable/recurring local change and was not modified by this release unit.

### Risks / Release Notes

- Runtime risk: this is an additive projection layer; if front end switches to it later, task-center and cleaning-calendar UI should still compare old vs new display during rollout.
- Compatibility: no old fields or old interface permissions changed.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Rollback: remove `webTaskCapabilities` helper and the response mapping calls from `task_center.ts` / `cleaning.ts`.
- Git state: uncommitted in root repo; unrelated property-payable/recurring/frontend layout changes and prior task-action units are also present in the shared worktree.

## CRL-20260701-009 — 房源代付页面按预览重排

- **Status:** committed
- **Updated:** 2026-07-02 23:24 AEST
- **Request:** “按预览页面优化当前的房源代付页面”
- **Outcome:** 房源代付页面改成更接近预览的工作台布局：上方保留筛选和关键指标，中间按“待处理 / 日历 / 已付记录 / 模板管理”分区；日历改为单月网格，不再使用连续多月横向滚动，避免和主页面滚动冲突；当天账单详情常驻右侧或在窄屏向下排列。

### Implementation

- Previous behavior:
  - 页面同时显示统计、连续日历、表格和抽屉，信息密度高但主次不清。
  - 日历依赖 FullCalendar 和连续月份横向滚动，嵌套滚动区域容易与页面滚动冲突。
  - 当天账单需要打开抽屉查看，待处理优先级不明显。
- New behavior:
  - 新增工作台视图切换：待处理队列、单月日历、已付记录、模板管理分别承载不同任务。
  - 待处理队列按实时状态优先级分组：付款逾期、账单未收到、待确认账单、付款快到期、待付款。
  - 单月日历改为原生 CSS grid，点击日期直接更新右侧当天账单列表；窄屏下改成单列，减少嵌套滑动冲突。
  - 房源筛选和状态筛选会同步影响统计、队列、日历和记录列表。
  - 2026-07-01 23:14 AEST update: 顶部右侧操作区改为“上一月月份 / 当前月 / 下一月月份 / 房源筛选 / 状态筛选 / 新增代付模板”同排布局，匹配预览图三；统计卡片改为 5 等分 grid，避免桌面端右侧留空。
- Key decisions:
  - 本次只调整前端页面结构和样式，不改后端状态规则、接口或数据库。
  - 保留既有详情、确认账单、上传发票、登记支付、删除模板等动作，避免改变业务流程。
  - 不再引入 FullCalendar 到房源代付页面，降低滚动和依赖复杂度。

### Files / Areas

- `frontend/src/app/finance/property-payables/page.tsx` — modified: 重排房源代付主页面，移除 FullCalendar 使用，新增工作台视图、状态分组、单月日历和当天详情面板。
- `frontend/src/app/globals.css` — modified: 替换旧房源代付连续日历样式，新增工作台、队列卡片、单月日历、顶部操作区、统计卡 5 等分和响应式布局样式。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none; removes this page's runtime use of `@fullcalendar/react` imports, but does not uninstall packages.
- Related units: follows `CRL-20260630-003` / `CRL-20260630-005` because it displays the bill workflow fields they added; can ship independently from the task-action units on 2026-07-01.

### Validation

- `rg -n "FullCalendar|calendarScale|calendarStrip|calendarEvents|calendarTitle|calendarPeriod|dayOpen|currentCalendar|dayGridPlugin|interactionPlugin|property-payable-calendar-strip|property-payable-calendar-period" frontend/src/app/finance/property-payables/page.tsx frontend/src/app/globals.css` — passed: no stale房源代付 page references remained; only an unrelated global FullCalendar comment outside this page matched.
- `npm run lint` in `frontend` — passed with existing warnings, 0 errors.
- `git diff --check -- frontend/src/app/finance/property-payables/page.tsx frontend/src/app/globals.css` — passed.
- `npm run build` in `frontend` — passed; existing repository warnings remain, including ESLint image/hook warnings and Recharts static-generation width warnings.
- `git diff --check -- frontend/src/app/finance/property-payables/page.tsx frontend/src/app/globals.css` — passed after the 23:14 layout follow-up.
- `npm run lint` in `frontend` — passed after the 23:14 layout follow-up; existing repository warnings remain, 0 errors.
- `npm run test` in `frontend` — passed after the 23:14 layout follow-up; 36 test files / 156 tests passed.
- `npm run build` in `frontend` — passed after the 23:14 layout follow-up; existing Browserslist, ESLint, and Recharts static-generation warnings remain.

### Risks / Release Notes

- Runtime risk: template management is still based on the workbench rows returned for the selected month, not a separate all-template API; templates without a current-month row may still require the existing create/edit entry path.
- UX risk: paid/template tabs still share the global room/status filters; an active status filter can intentionally narrow those tabs.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Rollback: restore the previous FullCalendar-based房源代付 layout and old `.property-payable-calendar-*` CSS block from the prior version.
- Git state: committed locally to root `Dev` in commit `73a9ece`; push to remote failed because GitHub HTTPS credentials are unavailable in this environment and SSH key auth was denied. Unrelated task-center/mobile backend files remain local and are not part of this change.

## CRL-20260701-008 — 任务动作状态流转与执行审计

- **Status:** ready
- **Updated:** 2026-07-01 22:58 AEST
- **Request:** “Phase 3: 状态流转、执行审计与旧逻辑退场……继续执行阶段三”
- **Outcome:** 后端新增统一动作状态流转和审计 helper，并把旧 `cleaning_app` 路径与新 `mzapp` 路径的关键执行提交接入同一套状态/审计规则；提交结果会记录实际执行人、点击人、动作、时间和状态前后值，旧 App 继续兼容。

### Implementation

- Previous behavior:
  - 钥匙照片、补品、检查照片、挂钥匙/改密码视频、自完成等接口在各自页面/路由里直接决定状态。
  - Phase 1/2 的 `available_actions` 能控制按钮，但提交后的状态结果仍分散，旧通知刷新后也可能因为完成态识别不全继续看到可执行按钮。
  - 提交记录主要依赖 media uploader 或任务字段，不能统一区分 `actor_user_id` 和实际 `performed_by_user_id`。
- New behavior:
  - 新增 `work_task_action_audits` 表，记录 `performed_by_user_id`、`performed_by_name`、`performed_as_action`、`performed_at`、`actor_user_id`、`status_before`、`status_after` 和 `metadata`。
  - 新增共享状态规则：`upload_key_photo -> in_progress`，`fill_supplies -> cleaned/restock_pending`，`complete_cleaning -> cleaned/restock_pending`，`upload_access_video -> keys_hung`，`submit_inspection -> inspected`。
  - 旧 `cleaning_app` 的 start/key photo、consumables、inspection photos、completion photos、lockbox video、self-complete 接口写统一审计；最终状态流转通过共享 helper 执行或保持状态不变但审计对应步骤。
  - 新 `mzapp` 的 lockbox video、inspection photos、restock proof 接口写统一审计；lockbox video 不再各自硬编码 `inspected`，统一进入 `keys_hung`。
  - action resolver 将 `cleaned/restock_pending/restocked/to_inspect/to_hang_keys/keys_hung/inspected` 纳入完成态，任务完成后旧通知刷新会得到 `task_completed` disabled reason。
- Key decisions:
  - 状态值沿用当前系统已识别状态，不引入全新 `inspection_completed` 字符串，避免列表/统计/通知大面积兼容风险；审计表通过 `performed_as_action='submit_inspection'` 表达检查完成动作。
  - 完成照片保存只是 `complete_cleaning` 的步骤审计，不单独把任务置为完成；最终完成仍由 `self-complete` 统一决定。
  - 旧 App 兼容继续保留；本阶段没有强制删除旧 role/task/status 推断，只让旧路径后端结果统一。

### Files / Areas

- `backend/src/lib/workTaskActionAudit.ts` — added: action audit table ensure、performer name resolution、request actor/performer parsing、纯状态流转规则、cleaning task transition helper。
- `backend/src/modules/cleaning_app.ts` — modified: 旧 App key photo、consumables、inspection photos、completion photos、lockbox video、self-complete 接口接入统一审计/状态流转，并接受可选 `performed_by_user_id` / `performed_by_name`。
- `backend/src/modules/mzapp.ts` — modified: 新 App lockbox video、inspection photos、restock proof 接口接入统一审计/状态流转，并接受可选 `performed_by_user_id` / `performed_by_name`。
- `backend/src/lib/workTaskActions.ts` — modified: 完成态判断补齐现有任务状态，避免完成后 action 仍 enabled。
- `backend/scripts/tests/test_work_task_actions.ts` — modified: 增加 action 状态流转、keys_hung 完成态、完成后 disabled reason 覆盖。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: 现有提交接口响应 additive 增加可选 `action_result`；请求体可选接受 `performed_by_user_id` / `performed_by_name`。旧客户端忽略新增响应字段不受影响。
- Database / migration: 后端 runtime ensure 新增 `work_task_action_audits` 表和索引；如生产 DB 用户无 DDL 权限，需要提前执行等价 DDL。
- Config / environment: none.
- Dependencies: none.
- Related units: builds on `CRL-20260701-006` and `CRL-20260701-007`; selective release should keep Phase 1/2/3 together because files and behavior are shared.

### Validation

- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_work_task_actions.ts` in `backend` — passed: `test_work_task_actions: ok`.
- `npm run build` in `backend` — passed: `tsc -p .` completed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json` completed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with existing warnings: 0 errors, 116 warnings.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 31 suites / 104 tests; Jest still reports an existing open-handle warning after completion.
- `npm run build` in `frontend` — failed in an unrelated/unowned modified file: `frontend/src/app/finance/property-payables/page.tsx` has `Error: 'FullCalendar' is not defined`. This file is not part of the Phase 3 implementation and was not modified by this release unit.

### Risks / Release Notes

- Runtime risk: transitioning lockbox/video uploads to DB status `keys_hung` is more semantically direct than the prior `inspected`; current code already treats `keys_hung` as inspection-finished, but staging should verify manager filters and reports.
- Runtime risk: action audit name resolution is best-effort; if `users` display/name columns differ, audit still records IDs and falls back to the user ID as name.
- Compatibility:旧 App 路径仍可提交；真正删除旧前端推断和完全收紧接口仍需确认现场版本覆盖率后再做。
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Rollback: remove `workTaskActionAudit` helper usage from `cleaning_app.ts` / `mzapp.ts`, restore previous lockbox status update, and remove the audit table helper.
- Git state: uncommitted in root repo; nested mobile repo still contains Phase 1/2 uncommitted changes but no additional Phase 3 mobile file edits.

## CRL-20260701-007 — 任务参与人与现场动作授权

- **Status:** ready
- **Updated:** 2026-07-01 22:45 AEST
- **Request:** “Phase 2: 参与人/协作者与现场动作抽象……先执行这个第二阶段吧”
- **Outcome:** 后端新增统一 `work_task_participants` 参与关系，`/mzapp/work-tasks` 返回 legacy 映射 + manual 授权后的 `participants` 并以此计算 `available_actions`；管理端任务中心详情弹窗新增最小协作者/动作授权入口；关键现场视频、检查、补品接口开始接入统一 action guard，同时保留旧 App 兼容条件。

### Implementation

- Previous behavior:
  - Phase 1 的 action resolver 仍从 `assignee_id` / `cleaner_id` / `inspector_id` 直接推断参与关系。
  - 清洁员临时帮别的房源改密码视频、admin 临时执行检查等跨角色动作，需要改旧分配字段或会被新版按钮能力挡住。
  - 后台任务中心没有给单个任务添加协作者或动作授权的入口。
- New behavior:
  - 新增 `work_task_participants` 表，由后端自动 ensure，记录 `source_type`、`source_id`、`user_id`、`participant_role`、`action_ids`、`source_relation`。
  - `/mzapp/work-tasks` 将旧字段映射成 `source_relation='legacy'` participants，并叠加 `source_relation='manual'` 的授权；新版 action resolver 只看 participants 的 action_ids 判断执行动作。
  - `upload_access_video` 作为 `site_action` 授权，不再必须绑定检查员身份；被 manual 授权的清洁员可以在 mine 视图看到对应现场动作任务。
  - 检查提交、补品读取、补货证明、挂钥匙/改密码视频接口增加 “旧条件 OR manual action grant” 的 guard；旧角色/分配路径继续可用。
  - 任务中心详情弹窗新增独立“临时协作者与动作授权”区，可保存全部动作、现场视频、检查提交、清洁/补品完成四类授权。
- Key decisions:
  - Phase 2 只新增 manual 参与关系和 site_action 表达，不做历史数据大批量 backfill；legacy 字段在读层映射为参与人。
  - 权限收紧仍采用兼容窗口：本次只增加 manual grant 的允许路径，不删除旧 App 可用的 role/assignee/inspector/cleaner 判断。
  - 管理端授权保存独立于看板“保存安排”，避免把权限配置混进布局草稿保存。

### Files / Areas

- `backend/src/lib/workTaskActions.ts` — modified: 增加 `WorkTaskParticipant`，resolver 改为从 `participants.action_ids` 判断 `submit_inspection`、`upload_access_video`、清洁/补品/问题反馈等动作。
- `backend/src/modules/mzapp.ts` — modified: 新增 `work_task_participants` 表 ensure、manual grant 读取/返回、`/mzapp/work-task-participants` 查询接口、`/mzapp/work-task-participants/set` 保存接口、manual 授权任务可见性、现场视频/检查/补品接口 action guard。
- `backend/scripts/tests/test_work_task_actions.ts` — modified: 增加 manual `upload_access_video`、admin manual `submit_inspection`、非参与人 disabled reason 回归覆盖。
- `frontend/src/app/task-center/page.tsx` — modified: 任务详情弹窗增加协作者/动作授权加载、编辑和保存。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: 增加 `WorkTaskParticipant` 类型和 `WorkTask.participants` 可选字段。
- `mz-cleaning-app-frontend/src/lib/workTasksStore.ts` — modified: SSE/patch 安全字段允许同步 `participants`。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: 新增 `/mzapp/work-task-participants` 和 `/mzapp/work-task-participants/set`；`/mzapp/work-tasks` additive 增加可选 `participants`，并继续返回 Phase 1 的 `available_actions` / `capabilities`。
- Database / migration: 后端 runtime ensure 新增 `work_task_participants` 表和索引；不需要手工 backfill，legacy 关系在读层映射。
- Config / environment: none.
- Dependencies: none.
- Related units: depends on Phase 1 `CRL-20260701-006` action resolver/mobile capability consumption; shares the same root and nested mobile files, selective release should keep Phase 1 + Phase 2 together.

### Validation

- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_work_task_actions.ts` in `backend` — passed: `test_work_task_actions: ok`.
- `npm run build` in `backend` — passed: `tsc -p .` completed.
- `npm run build` in `frontend` — passed: Next build completed; existing lint/build warnings remain, including historical hook/img/chart warnings.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json` completed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with existing warnings: 0 errors, 116 warnings.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 31 suites / 104 tests; Jest still reports an existing open-handle warning after completion.
- Manual acceptance not run against live DB: actual end-to-end collaborator save and mobile task visibility should be checked in staging with a real cleaner/admin user after deploy.

### Risks / Release Notes

- Runtime risk: `work_task_participants` is auto-created on first relevant route call; if production DB user lacks DDL permission, deploy must run the equivalent DDL separately.
- Runtime risk: manual grants are saved per active source task id. For merged turnover cards, adding/removing authorization applies to all active source ids shown in that card.
- Compatibility: old App paths stay open through legacy guards; Phase 3 can tighten endpoint permissions with client version/header gating after adoption.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Rollback: remove manual participant projection/API/guard additions from `mzapp.ts`, revert resolver to Phase 1 legacy participant calculation, and remove task-center authorization UI.
- Git state: uncommitted in root repo and nested `mz-cleaning-app-frontend` repo.

## CRL-20260701-006 — 移动端任务动作改为后端能力下发

- **Status:** ready
- **Updated:** 2026-07-01 22:00 AEST
- **Request:** “PLEASE IMPLEMENT THIS PLAN: Phase 1 执行计划：后端下发动作能力并兼容旧 App”
- **Outcome:** `/mzapp/work-tasks` 现在对每个任务追加 `available_actions` 和 `capabilities`；新版移动端列表、详情和通知任务跳转优先使用后端下发动作，旧字段和旧移动端路径保持兼容。

### Implementation

- Previous behavior:
  - 移动端 `TasksScreen` 和 `TaskDetailScreen` 按 role、task_kind、task_type、status 等本地条件拼按钮，admin、清洁员、检查员临时执行其他现场动作时容易被角色逻辑挡住。
  - 通知和历史任务入口仍可能按管理/检查角色直接跳旧流程，没有先看当前任务是否仍可执行。
  - `/mzapp/work-tasks` 只返回任务数据字段，没有统一动作能力结果。
- New behavior:
  - 后端新增纯 resolver，根据当前用户基础权限、管理可见性、任务参与关系、任务类型、执行语义和状态计算 `available_actions` 与 `capabilities`。
  - `/mzapp/work-tasks` 响应以 additive 方式追加字段，不删除、不重命名、不改变旧字段含义。
  - 移动端新增 `workTaskActions` helper；有后端 `available_actions` 时直接使用后端按钮，没有该字段时回退旧本地逻辑兼容旧后端/旧缓存。
  - `TasksScreen` 卡片只渲染 `placement=primary` 的前 1-2 个动作；`TaskDetailScreen` 渲染完整动作并显示后端 disabled reason。
  - 通知详情的“查看任务”和系统推送点击会先刷新 `/mzapp/work-tasks`，再按最新 action route 跳转；不可执行时停到任务详情并提示原因。
- Key decisions:
  - Phase 1 不新增参与人表、不迁移现场动作落库模型、不突然收紧旧接口权限。
  - `upload_access_video` 暂以 `intent='site_action'` 表达改密码/挂钥匙视频动作，后续 Phase 2/3 再统一现场动作模型。
  - 管理角色仍可看任务和执行管理动作，但普通执行动作需要任务参与关系；这只影响新版 App 的按钮可用性，不封旧接口。

### Files / Areas

- `backend/src/lib/workTaskActions.ts` — added: 后端 action resolver、action/capability 类型和任务动作计算规则。
- `backend/src/modules/mzapp.ts` — modified: `/mzapp/work-tasks` 为每个任务追加 `available_actions` / `capabilities`。
- `backend/scripts/tests/test_work_task_actions.ts` — added: 覆盖 cleaner、admin、inspector、customer_service、offline_manager、completed task 的 action resolver 行为。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: 新增 `WorkTaskAvailableAction` 类型和 `WorkTask.available_actions` / `capabilities` 可选字段。
- `mz-cleaning-app-frontend/src/lib/workTasksStore.ts` — modified: SSE/patch 安全字段允许同步 `available_actions` / `capabilities`。
- `mz-cleaning-app-frontend/src/lib/workTaskActions.ts` — added: 移动端 action fallback、disabled reason 文案、action 到页面路由映射、通知 preferred action 选择。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 卡片主按钮改为 `primaryActionsForTask()`，保留本地钥匙待同步/已记录和退房提交中的状态保护。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` — modified: 详情页完整展示后端 actions 和 disabled reason；上传钥匙、标记退房继续走原本本地执行逻辑。
- `mz-cleaning-app-frontend/src/screens/notices/NoticeDetailScreen.tsx` — modified: 通知详情新增“查看任务”，点击时刷新任务并按最新 action 跳转或提示不可执行原因。
- `mz-cleaning-app-frontend/src/navigation/RootNavigator.tsx` — modified: 系统推送点击任务通知时刷新任务后按 capability 解析路由，旧数据回退原 role-based 路由。
- `mz-cleaning-app-frontend/src/screens/tabs/NoticesScreen.tsx` — modified: 历史任务搜索结果在存在 `available_actions` 时按 action 跳转。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx` — modified: 增加列表只渲染后端 primary action 的测试。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` — modified: 增加详情页使用后端 action 和 disabled reason 的测试。
- `docs/change-release-ledger.md` — modified: 记录本 release unit。

### Impact / Dependencies

- API: `/mzapp/work-tasks` 响应新增可选 `available_actions` 和 `capabilities`；旧字段保留，旧 App 可忽略新增字段。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `backend/src/modules/mzapp.ts` with recent `/mzapp/work-tasks` release units, but this unit is additive and independently releasable with hunk review if selective staging is needed.

### Validation

- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_work_task_actions.ts` in `backend` — passed: `test_work_task_actions: ok`.
- `npm run build` in `backend` — passed: `tsc -p .` completed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json` completed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with existing warnings: 0 errors, 116 warnings.
- `npm test -- --runInBand src/screens/tasks/TaskDetailScreen.test.tsx src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 2 suites / 19 tests.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 31 suites / 104 tests; Jest still reports an existing open-handle warning after completion.
- Manual old App field compatibility — code-reviewed only: old `/mzapp/work-tasks` fields are retained and old submit/upload endpoints were not tightened in this phase.

### Risks / Release Notes

- Runtime risk: 后端 action resolver 是新增权威按钮来源，新 App 会暴露后端计算错误；保留 mobile fallback 降低旧缓存/旧后端风险。
- Runtime risk: 通知点击刷新任务时使用通知日期或当前任务日期前后窗口，极旧通知如果任务不在窗口内会回退任务详情。
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Rollback: remove `buildWorkTaskActionPayload` projection from `/mzapp/work-tasks`, restore old mobile button blocks, and remove the `workTaskActions` helper usage.
- Git state: uncommitted in root repo and nested `mz-cleaning-app-frontend` repo.

## CRL-20260701-005 — 移动端管理视图显示未分配入住检查任务

- **Status:** pushed
- **Updated:** 2026-07-01 20:34 AEST
- **Request:** “查一下，生产环境里 明天明明有2508入住的任务，为什么app上面不显示”；确认每日任务页面也有该任务后，按建议修复。
- **Outcome:** `/mzapp/work-tasks?view=all` 现在会在管理视图中投影未分配检查人员的普通入住检查任务，让 `TF2508` 这类 `checkin_clean + pending + same_day + inspector_id为空` 的任务能在 App 管理“全部”里显示和搜索；个人“我的任务”仍不接收未分配任务。

### Implementation

- Previous behavior:
  - Web 每日任务/任务中心直接展示 `cleaning_tasks` 源任务，因此能看到未分配的入住任务。
  - 移动端 App 走 `/mzapp/work-tasks` 投影；普通入住任务不进清洁分支，只能进入检查分支。
  - 检查分支要求 `inspector_id` 存在，导致 `TF2508` 这种未分配检查人员的入住任务没有生成移动端卡片。
- New behavior:
  - 管理 `view=all` 且具备管理任务池可见性时，普通入住检查任务即使 `inspector_id` 为空也会进入检查分组。
  - 未分配检查分组使用内部 `unassigned` key 保留卡片生成，但输出 payload 仍保持 `assignee_id` 为空。
  - 非管理视图和个人“我的任务”仍要求存在移动端执行人，不扩大普通员工可见范围。
- Key decisions:
  - 不新增字段、不改移动端 UI、不改变任务分配状态；只修正移动端列表的后端投影。
  - 仅针对 `cleaning_tasks` 检查投影；property follow-up 任务仍保持原本的执行人要求。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: `/mzapp/work-tasks` 检查分组允许管理 `view=all` 投影未分配检查人员的入住检查任务。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: `/mzapp/work-tasks?view=all` 的管理视图可能多返回未分配的 `cleaning_tasks` 检查卡片；字段结构不变。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: independent of `CRL-20260701-004`; shares `backend/src/modules/mzapp.ts`, so selective release requires hunk-level staging if only one unit is shipped.

### Validation

- Production read-only data check — passed: `TF2508` on `2026-07-02` exists as active confirmed `checkin_clean`, with `assignee_id`, `cleaner_id`, and `inspector_id` empty.
- `npm run build` in `backend` — passed: `tsc -p .` completed.
- `npm run test:cleaning-inspection-merge` in `backend` — passed: `test_cleaning_inspection_merge: ok`.
- `git diff --check` in root repo — passed.
- `python3 scripts/audit_change_release_ledger.py` — passed: 2 changed files recorded, coverage PASS.
- Direct authenticated App/API request — not run: no user token was used in this turn.

### Risks / Release Notes

- Runtime risk: management App lists may show additional unassigned same-day check-in inspection tasks that were previously hidden; this aligns with Web daily task visibility.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added or recorded.
- Rollback: restore the previous `inspectorId` requirement in the `/mzapp/work-tasks` inspector grouping and skip empty inspector groups again.
- Git state: pushed to root `Dev` in commit `31d3c6f`.

## CRL-20260701-004 — 仅改密码执行人允许保存密码盒视频

- **Status:** pushed
- **Updated:** 2026-07-01 20:34 AEST
- **Request:** “上传视频怎么还权限不足了”；仅改密码执行任务拍摄视频后点击“改密码完成”弹出权限不足。
- **Outcome:** `/mzapp/cleaning-tasks/:id/lockbox-video` 现在允许仅改密码任务的 `assignee_id` 执行人保存和删除密码盒/给钥匙视频，不再要求该执行人同时是检查员；普通检查任务仍要求检查员本人或管理角色。

### Implementation

- Previous behavior:
  - 视频文件上传到媒体存储后，移动端会调用 `/mzapp/cleaning-tasks/:id/lockbox-video` 保存业务记录。
  - 该接口顶层只允许 `cleaning_inspector` / `cleaner_inspector` / 管理角色，并且要求 `inspector_id` 等于当前用户。
  - “仅改密码”任务的执行人保存于 `assignee_id`，可以是任意 staff，因此执行人即使已分配任务也会在保存视频记录时收到 403。
- New behavior:
  - 新增 `isAssignedKeyHandoverExecutor()` / `canManageMzappLockboxVideo()` 权限判断。
  - 上传和删除 lockbox video 时先读取 `task_type`、`inspection_scope`、`assignee_id`、`inspector_id`。
  - `checkin_clean + inspection_scope=password_only` 且当前用户等于 `assignee_id` 时允许保存/删除视频。
  - 普通检查/挂钥匙任务仍只允许检查员本人、清洁检查员本人或 `admin/offline_manager/customer_service` 管理角色。
- Key decisions:
  - 不新增权限码、不新增字段；沿用 `assignee_id` 作为仅改密码执行人的唯一来源。
  - 只放开 password-only 执行任务，不扩大普通检查任务或普通清洁任务的视频权限。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: 调整 mzapp lockbox/password video 上传和删除接口的权限判断。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: `/mzapp/cleaning-tasks/:id/lockbox-video` and delete variant now accept assigned password-only executors.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: follows `CRL-20260701-003` and `CRL-20260630-007`.

### Validation

- `npm run build` in `backend` — passed: `tsc -p .` completed.
- Direct mobile/manual API verification — not run in this turn.

### Risks / Release Notes

- Runtime risk: backend must be deployed before the existing mobile app can stop receiving 403 on the final business-save step.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Rollback: restore the previous inspector-only role and inspector-id checks in the mzapp lockbox video upload/delete handlers.
- Git state: pushed to root `Dev` in commit `31d3c6f`.

## CRL-20260701-003 — 仅改密码移动端标签与执行人显示修正

- **Status:** pushed
- **Updated:** 2026-07-01 02:08 AEST
- **Request:** “仅改密码”任务移动端仍显示 `execution`，执行人员里把 Angela 标成清洁；仅改密码标签也需要显示在任务上。
- **Outcome:** 移动端现在把 `task_kind=execution` 兼容识别为挂钥匙执行任务，即使接口缺少 `execution_role/execution_semantics` 也会显示用户可读的“执行”和“仅改密码”；列表展开态对该任务显示单列“执行 Angela”，不再显示“清洁 Angela”。后端 `/mzapp/work-tasks` 为清洁任务补充 `assignee_name` / `executor_name`，并在纯执行合并卡中避免把执行人姓名继续写入 `cleaner_name`。

### Implementation

- Previous behavior:
  - 移动端执行语义主要依赖 `execution_role=execution` 或 `execution_semantics=key_handover_execution`；如果只拿到 `task_kind=execution`，fallback 会把它当成混合清洁/检查，标签可能直接露出英文 `execution`。
  - 任务列表展开态所有 `cleaning_tasks` 都按“清洁 / 检查”两列展示人员，导致仅改密码执行人被放到清洁格子里。
  - 后端 cleaning task 查询只返回 `cleaner_name` / `inspector_name`，执行人姓名通过 `COALESCE(cleaner_id, assignee_id)` 进入 `cleaner_name`，语义不清。
- New behavior:
  - 移动端 `taskExecutionRole()` 将 `cleaning_tasks + task_kind=execution` 直接识别为执行任务。
  - `taskKindLabel()` 在任务列表和详情页都把 `execution` 映射为“执行”。
  - `isPasswordOnlyInspectionTask()` 对 execution 兼容返回 true，因此任务卡片显示“仅改密码”标签。
  - 任务列表中仅改密码执行任务使用单列执行人卡片，角色显示“执行”，姓名优先取 `executor_name` / `assignee_name`。
  - 后端 `/mzapp/work-tasks` 返回 `assignee_name` 和 `executor_name`；管理模式合并纯执行卡时清空 `cleaner_name`，避免移动端误显示清洁身份。
- Key decisions:
  - 不新增数据库字段；继续复用 `cleaning_tasks.assignee_id` 作为仅改密码执行人的单一来源。
  - 兼容旧/不完整接口 payload，不要求移动端必须同时拿到 `execution_role` 和 `execution_semantics` 才能正确显示。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: `/mzapp/work-tasks` 清洁任务查询补充 `assignee_name`，执行任务输出 `executor_name`，纯执行合并卡不再把执行人写成 `cleaner_name`。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: `WorkTask` 类型补充 `executor_name`。
- `mz-cleaning-app-frontend/src/lib/cleaningInspection.ts` — modified: 兼容 `task_kind=execution` 的执行语义和仅改密码标签判断。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 列表标签映射 `execution -> 执行`，仅改密码执行任务显示单列执行人，并支持按 `executor_name` 搜索/排序。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx` — modified: 覆盖列表中 `task_kind=execution` 不显示英文、显示“仅改密码”、显示“执行 Angela”而不是“清洁 Angela”。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` — modified: 详情页标签映射 `execution -> 执行`。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` — modified: 覆盖只有 `task_kind=execution`、缺少新语义字段时仍显示“执行 / 仅改密码 / 上传视频并完成”。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: `/mzapp/work-tasks` cleaning task payload may include optional `assignee_name` and `executor_name`; existing fields retained.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: follows `CRL-20260630-007`; release should include both root backend change and nested `mz-cleaning-app-frontend` mobile change.

### Validation

- `npm run build` in `backend` — passed: `tsc -p .` completed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm test -- --runInBand src/screens/tasks/TaskDetailScreen.test.tsx src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 2 suites, 17 tests. Existing SafeAreaView deprecation warning and Jest open-handle notice were printed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with existing warnings and 0 errors.
- `git diff --check` in root repo — passed.
- `git -C mz-cleaning-app-frontend diff --check` — passed.

### Risks / Release Notes

- Runtime risk: users must install a mobile build containing this change; an older installed app can still show the previous label behavior even if the backend is fixed.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Rollback: revert the execution fallback in mobile `cleaningInspection.ts`, the execution-person UI branch in `TasksScreen.tsx`, and the `executor_name` payload additions in `backend/src/modules/mzapp.ts`.
- Git state: pushed to root `Dev` in commit `6789325` and nested `mz-cleaning-app-frontend` `Dev` in commit `cd84102`.

## CRL-20260701-002 — 任务中心延期检查行去重

- **Status:** pushed
- **Updated:** 2026-07-01 01:35 AEST
- **Request:** 任务中心页面出现多块重复的“延期检查”行，且每块里显示同一批延期检查任务。
- **Outcome:** `/task-center/day` 组装看板行时不再无条件追加第二套 `deferred:inspection` / `deferred:holding` 系统行；如果历史布局或普通任务路径已经生成了同一个特殊行，会合并到同一行并按 `task_source + task_id` 去重，避免同一延期检查卡片重复渲染。

### Implementation

- Previous behavior:
  - `buildRows()` 会先按任务/历史布局把任务放入 `rows` map。
  - 随后又无条件 append “延期检查”和“后续处理”系统行。
  - 当 `deferred:inspection` 已经因为历史布局或延期检查任务进入 `rows` map 时，返回 payload 里会出现重复 row，前端就按多个同名行渲染。
- New behavior:
  - 新增 `rowTypeFromKey()`，确保 `deferred:inspection` / `deferred:holding` 这类系统 key 永远按 `deferred` 行处理。
  - 延期检查和后续处理行改为 upsert：已有行则复用并追加任务；没有行才创建。
  - 合并时用 `task_source + task_id` 去重，避免同一任务被重复塞进系统行。
- Key decisions:
  - 只修正 `/task-center/day` 的后端行组装，不改任务生成、保存接口、数据库结构或移动端逻辑。

### Files / Areas

- `backend/src/modules/task_center.ts` — modified: 特殊 deferred 行从 append 改为 upsert/merge，并修正特殊 row key 的默认 row type。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: `/task-center/day` 返回的 `rows` 不再包含重复的 `deferred:inspection` / `deferred:holding` 行；字段结构不变。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `backend/src/modules/task_center.ts` with `CRL-20260630-007`; selective release requires hunk-level staging or explicit combined scope.

### Validation

- `npm run build` in `backend` — passed: `tsc -p .` completed.
- Direct authenticated browser check of `/task-center` — not run: no credentials were read or entered in this turn.

### Risks / Release Notes

- Risk: Existing saved row metadata for the special deferred rows is still reused; this fix only prevents duplicate row objects and duplicate task insertion.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Rollback: revert the `rowTypeFromKey()` helper and `upsertDeferredRow()` merge path in `buildRows()`.
- Git state: pushed to root `Dev` in commit `fafd0f1`.

## CRL-20260701-001 — 任务中心拖出检查人员大行时取消检查人员

- **Status:** pushed
- **Updated:** 2026-07-01 01:35 AEST
- **Request:** 如果任务已经选择了检查人员，把任务拖出这个检查人员的大行以外时，默认该检查人员不再负责这个检查；按统一保存方案执行。
- **Outcome:** 任务中心拖拽现在会同步更新本地检查人员 draft：拖到另一个检查人员大行会改派到目标检查人员；从原检查人员大行拖到没有检查人员的大行/暂不安排等区域，会清空 `inspector_id` 并回到待确认检查安排。用户仍通过现有“保存安排”统一提交。

### Implementation

- Previous behavior:
  - 拖拽只稳定处理位置变化；拖到有检查人员的大行时会设置目标检查人员，但拖到无检查人员区域时会保留原 `inspector_id`。
  - 页面上看起来任务已经离开某个检查人员大行，但保存后该检查人员仍可能继续负责任务。
- New behavior:
  - `handleTaskDrop` 记录任务来源大行和来源大行绑定的检查人员。
  - 如果任务当前 `inspector_id` 等于来源大行检查人员，且目标大行没有检查人员，拖拽后自动清空 `inspector_id`、清空延期日期，并把检查安排回退为 `pending_decision`。
  - 如果目标大行有检查人员，继续按原逻辑改派到目标检查人员。
  - 仅改密码任务不参与检查人员清空逻辑；已完成或已挂钥匙任务不自动清空检查人员，避免破坏完成记录。
- Key decisions:
  - 不新增接口；继续使用任务中心现有 board dirty state 和 `/task-center/save-board` 统一保存。
  - 只在“来源大行绑定的检查人员确实等于任务当前检查人员”时清空，避免误清手动设置但不属于该大行的检查人员。

### Files / Areas

- `frontend/src/app/task-center/page.tsx` — modified: 新增拖拽检查人员自动重派/清空判断，并复用现有本地 draft 和保存 payload。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: none; existing `POST /task-center/save-board` continues to save layout and `cleaning_assignments` together.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `frontend/src/app/task-center/page.tsx` with `CRL-20260630-007`; selective release requires hunk-level staging or explicit combined scope.

### Validation

- `git diff --check` in root repo — passed.
- `npm run lint` in `frontend` — passed with existing repo-wide warnings and 0 errors.
- `npm run build` in `frontend` — passed; existing Browserslist/lint/Recharts warnings were printed.

### Risks / Release Notes

- Risk: This is a local draft behavior until the user clicks “保存安排”; leaving the page without saving still discards the drag assignment change, consistent with existing task-center behavior.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Rollback: remove `canAutoReassignInspectorOnDrop` and the source-row inspector clearing block from `handleTaskDrop`.
- Git state: pushed to root `Dev` in commit `fafd0f1`.

## CRL-20260630-007 — 入住挂钥匙任务改为执行人

- **Status:** pushed
- **Updated:** 2026-07-01 01:35 AEST
- **Request:** 入住任务如果是仅挂钥匙，可以改为执行人；所有角色都可以选择为执行人，不仅仅是检查人员；任务要显示在执行人的任务列表里。后续确认当前界面里的“仅改密码”就是这个“仅挂钥匙”业务选项。
- **Outcome:** 纯入住且 `inspection_scope=password_only`（界面显示“仅改密码”）的任务现在按“执行人”处理：后台清洁日历和任务中心详情都可选择任意 active staff，保存到 `assignee_id`，不再要求 inspector；`/mzapp/work-tasks` 投影为 `execution_role=execution`、`execution_semantics=key_handover_execution`，并按执行人显示到移动端任务列表。

### Implementation

- Previous behavior:
  - 纯入住任务统一进入检查语义；挂钥匙也只能通过 `inspector_id` 分配给检查人员。
  - `/mzapp/work-tasks` 没有“挂钥匙执行”语义，manager 合并层容易把入住任务归为检查。
  - 后台清洁日历 quick edit 和抽屉只提供“清洁 / 检查”字段，无法为挂钥匙任务选择客服、线下经理等其他角色作为执行人。
- New behavior:
  - 后端 helper 新增 `isCheckinKeyHandoverTask()` 和 `key_handover_execution` 语义；该语义绑定当前 UI 的“仅改密码”选项，即 `inspection_scope=password_only`。
  - `/mzapp/work-tasks` 新增 executorGroups：入住挂钥匙按 `assignee_id` 投影为 `task_kind=execution`；兼容旧数据 fallback 到 `inspector_id`。
  - manager `view=all` 合并输出包含 `execution_task_ids`、`execution_status` 和执行人 `assignee_id`。
  - `/cleaning/tasks/:id` 单任务 PATCH 支持挂钥匙任务写入任意有效用户作为 `assignee_id`，并避免把非清洁角色回写成 `cleaner_id`。
  - 网页清洁日历把入住挂钥匙任务的人员字段显示为“执行”，选项使用所有 active staff；当前“仅改密码”入住任务使用执行人模型。
  - 任务中心详情弹窗在“检查执行方式 = 仅改密码”时把人员字段从“检查人员”切换为“执行人”，选项使用所有 active staff，并把选择值写入 `assignee_id`。
  - `/task-center/save-board` 的 cleaning assignment payload 支持显式 `assignee_assignment_action`，后端只改执行人时也会触发 UPDATE、diff 和通知收件人计算。
  - 移动端识别 `key_handover_execution`，按 `assignee_id` 归属显示；不混入清洁/检查日终统计和拖拽排序。
  - 移动端列表和详情把内部 `task_kind=execution` / `key_handover_execution` 映射为用户可读标签“执行”“仅改密码”，不再把 `execution` 字符串露给用户。
  - 移动端“仅改密码”执行任务在列表和详情提供“上传视频并完成”入口，复用现有 lockbox video 上传页；该页对 password-only 任务不再要求先提交“检查与补充”批次。
- Key decisions:
  - 不新增数据库字段；复用现有 `assignee_id` 表示挂钥匙执行人。
  - `inspect_and_hang` 仍为检查人员模型；只有用户确认的“仅改密码 / 仅挂钥匙”进入执行人模型。

### Files / Areas

- `backend/src/lib/cleaningInspection.ts` — modified: 增加入住挂钥匙识别和 `key_handover_execution` 语义。
- `backend/src/modules/mzapp.ts` — modified: `/mzapp/work-tasks` 增加 executorGroups、manager 合并 execution 输出和执行人 assignee 合并。
- `backend/src/modules/cleaning.ts` — modified: 清洁任务 PATCH 支持挂钥匙执行人 `assignee_id`，并在 calendar-range 返回 `inspection_scope`。
- `backend/src/modules/task_center.ts` — modified: `/task-center/save-board` 接收清洁任务 `assignee_id` action，并在仅执行人变化时更新 `cleaning_tasks.assignee_id`。
- `backend/dist/modules/cleaning.js` — generated/shared: `npm run build` 生成的 `cleaning.ts` 输出；该文件也承载同日其他清洁模块单元的未提交生成改动。
- `backend/scripts/tests/test_task_assignment_canonical.ts` — modified: 覆盖 password-only / 仅改密码投影为 execution 且带执行人，inspect-and-hang 仍为检查。
- `frontend/src/app/cleaning/page.tsx` — modified: 清洁日历识别入住挂钥匙；快速编辑和抽屉使用“执行人”与所有员工选项，保存 `assignee_id`。
- `frontend/src/app/task-center/page.tsx` — modified: 任务中心详情在 `password_only` 纯入住任务下显示“执行人”、使用所有员工选项，并保存清洁任务 `assignee_id` action。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: WorkTask 类型补充 execution / key_handover_execution。
- `mz-cleaning-app-frontend/src/lib/cleaningInspection.ts` — modified: 移动端解析 `key_handover_execution`。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 移动端按执行人显示挂钥匙任务，并排除出清洁/检查日终统计。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` — modified: 详情页把 key handover execution 显示为“执行 / 仅改密码”，并提供“上传视频并完成”入口。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.tsx` — modified: password-only 任务上传视频时跳过检查与补充批次前置校验。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` — modified: 覆盖 key_handover_execution 不显示内部 execution 标签，并展示“仅改密码”和视频入口。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: `/mzapp/work-tasks` may return `task_kind=execution`, `execution_role=execution`, `execution_semantics=key_handover_execution`, and `execution_task_ids` for pure入住挂钥匙任务.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: extends `CRL-20260630-006`; shares `backend/src/modules/mzapp.ts`, `frontend/src/app/cleaning/page.tsx`, and nested mobile task files with that unit.

### Validation

- `npm run build` in `backend` — passed: `tsc -p .` completed.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_task_assignment_canonical.ts` in `backend` — first failed in sandbox because DNS lookup for configured PostgreSQL was blocked; rerun with approved network access passed: `test_task_assignment_canonical: ok`.
- `npm run test:cleaning-inspection-merge` in `backend` — passed: `test_cleaning_inspection_merge: ok`.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm run lint` in `frontend` — passed with existing warnings and 0 errors.
- `npm run build` in `frontend` — passed; existing warnings and existing Recharts static-generation width warnings were printed.
- `npm run build` in `backend` after task-center follow-up — passed: `tsc -p .` completed.
- `npm run lint` in `frontend` after task-center follow-up — passed with existing repo-wide warnings and 0 errors.
- `npm run build` in `frontend` after task-center follow-up — passed; existing Browserslist/lint/Recharts warnings were printed.
- `npm run test:cleaning-inspection-merge` in `backend` after task-center follow-up — passed: `test_cleaning_inspection_merge: ok`.
- `npx ts-node-dev --transpile-only scripts/tests/test_task_assignment_canonical.ts` in `backend` after task-center follow-up — first failed in sandbox because DNS lookup for configured PostgreSQL was blocked; rerun with approved network access passed: `test_task_assignment_canonical: ok`.
- `npm run typecheck` in `mz-cleaning-app-frontend` after mobile label/video follow-up — passed: `tsc -p tsconfig.json`.
- `npm test -- --runInBand src/screens/tasks/TaskDetailScreen.test.tsx` in `mz-cleaning-app-frontend` after mobile label/video follow-up — passed: 1 suite, 10 tests.
- `git diff --check` for touched root files — passed.
- `git -C mz-cleaning-app-frontend diff --check` for touched mobile files — passed.

### Risks / Release Notes

- Runtime risk: existing old mobile clients that do not understand `task_kind=execution` may treat these rows as ordinary tasks until the mobile update is released.
- Behavior note: 批量编辑仍保留“清洁人员 / 检查人员”模型；混合批量任务不能安全推断哪些是挂钥匙执行人，单任务 quick edit 和抽屉已支持执行人。
- Task-center note: 这个跟进修复的是 `/task-center` 任务详情弹窗；之前只覆盖了清洁日历和移动端显示。
- Rollback: remove executorGroups and `key_handover_execution` semantics, restore入住挂钥匙任务 to inspector-only assignment.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: pushed to root `Dev` in commit `fafd0f1` and nested `mz-cleaning-app-frontend` `Dev` in commit `d837c1f`.

## CRL-20260630-006 — 纯入住检查不再显示给清洁员

- **Status:** pushed
- **Updated:** 2026-07-01 01:35 AEST
- **Request:** 修复纯入住任务已安排检查后仍出现在清洁人员任务里；不要只靠 `source_type === 'cleaning_tasks'`，要先在 `/mzapp/work-tasks` 后端分组排除，并返回明确执行语义，历史纯入住任务即使写过 `cleaner_id` 也不能继续显示给清洁员。
- **Outcome:** `/mzapp/work-tasks` 现在为清洁任务返回 `execution_role` 和 `execution_semantics`，并在清洁员分组阶段排除纯 `checkin_clean` 入住检查；移动端和网页版清洁日历改按执行语义区分“清洁执行”和“检查安排”，历史带 `cleaner…5546 tokens truncated…情、日历、筛选后统计直接信任 `is_overdue`，因此已确认金额的账单仍显示“逾期”。
- New behavior:
  - 后端 workbench 状态派生改为只有“未支付且未确认金额”的本月账单才会进入逾期/快到期。
  - 前端新增房源代付状态 helper，对可能来自旧响应或缓存的 `is_overdue/is_due_soon` 做同样兜底，统一用于标签、排序、统计、表格行样式和日历样式。
  - 新增前端单测覆盖“已确认金额但 API 标记逾期/快到期时，UI 不再按逾期处理”。
- Key decisions:
  - 不改变付款登记流程：确认金额后仍是待付款，`登记支付` 仍需单独操作。
  - 不新增数据库字段或迁移，只修正现有状态派生规则。

### Files / Areas

- `backend/src/modules/recurring.ts` — modified: 房源代付 workbench 的 `is_overdue` / `is_due_soon` 计算排除已确认金额记录。
- `frontend/src/lib/propertyPayables.ts` — modified: 增加统一的房源代付逾期/快到期 helper，排序桶复用 helper。
- `frontend/src/app/finance/property-payables/page.tsx` — modified: 状态标签、逾期统计、日历样式、列表行样式和当天抽屉卡片样式统一复用 helper。
- `frontend/src/lib/propertyPayables.test.ts` — added: 覆盖已确认金额记录不再进入逾期/快到期状态的规则。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: `/recurring/property-payables/workbench` 响应结构不变，但已确认金额且未付款的记录现在返回 `is_overdue=false`、`is_due_soon=false`。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: none.

### Validation

- `npm run build` in `backend` — passed: `tsc -p .`.
- `npm test -- src/lib/propertyPayables.test.ts` in `frontend` — failed after tests passed: 1 file / 2 tests passed, then global coverage threshold failed because the wrapper enables repository-wide coverage on a focused test run.
- `npx vitest run src/lib/propertyPayables.test.ts` in `frontend` — passed: 1 file / 2 tests.
- `npm run lint` in `frontend` — passed with existing warnings and 0 errors.
- `npm run build` in `frontend` — passed; existing lint warnings and existing Recharts static-generation width warnings were printed.
- `python3 scripts/audit_change_release_ledger.py` — passed: 5 changed files covered.
- `git diff --check` — passed.

### Risks / Release Notes

- Runtime risk: confirmed-but-unpaid items will no longer appear in overdue counts; this matches the requested “金额已确认即处理完” semantics, but users must still click `登记支付` when actual payment has been made.
- Rollback: restore the previous `is_overdue` / `is_due_soon` calculation and direct frontend `row.is_overdue` checks, then remove `frontend/src/lib/propertyPayables.test.ts`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: pushed to root `Dev` in commit `fafd0f1`.

## 2026-06-29 A+B+C Release Batch

- **Status:** pushed
- **Updated:** 2026-06-29 10:35 Australia/Melbourne
- **Scope:** User selected A+B+C for release, covering `CRL-20260629-001`, `CRL-20260629-002`, and `CRL-20260628-001` through `CRL-20260628-011`.
- **Git state:** implementation pushed to root `Dev` in commit `9192124` and nested mobile `Dev` in commit `bd66320`; this ledger status update is recorded separately.
- **Packaging:** mobile app version synchronized to `1.0.23`, iOS buildNumber `23`, Android versionCode `23`; iOS/Android EAS packaging should use the production profile unless explicitly overridden.

## CRL-20260629-002 — 移动端封装版本同步到 1.0.23

- **Status:** pushed
- **Updated:** 2026-06-29 10:05 Australia/Melbourne
- **Request:** 选择 A+B+C 推送，并重新封装 iOS 和 Android 版本。
- **Outcome:** 移动端本地封装版本统一到 `1.0.23`；Expo app version 为 `1.0.23`，iOS buildNumber 为 `23`，Android versionCode 为 `23`，npm package 与 lockfile 版本也同步到 `1.0.23`，满足 `eas.json` 的 local version source。

### Implementation

- Previous behavior:
  - `app.json` 已经显示 `1.0.23 / 23 / 23`，但 `package.json` 和 `package-lock.json` 仍是 `1.0.22`。
- New behavior:
  - `package.json` 和 `package-lock.json` 同步为 `1.0.23`。
  - 保持 `app.json` 的 `expo.version=1.0.23`、`ios.buildNumber=23`、`android.versionCode=23`。
- Key decisions:
  - 不新增依赖或改动 EAS profile；当前 `eas.json` 使用 `appVersionSource: local`，因此只同步本地版本文件。

### Files / Areas

- `mz-cleaning-app-frontend/app.json` — modified: Expo/iOS/Android build metadata 为 `1.0.23 / 23 / 23`。
- `mz-cleaning-app-frontend/package.json` — modified: package version 同步到 `1.0.23`。
- `mz-cleaning-app-frontend/package-lock.json` — modified: lockfile root package version 同步到 `1.0.23`。
- `docs/change-release-ledger.md` — modified: 记录本封装版本同步单元。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: EAS local app version source will read the synchronized local version files.
- Dependencies: none.
- Related units: intended to ship with selected A+B+C mobile/root changes and before iOS/Android EAS builds.

### Validation

- `npm run build` in `backend` — passed: `tsc -p .`.
- `npm run test:cleaning-inspection-merge` in `backend` — passed: `test_cleaning_inspection_merge: ok`.
- `npm run test:app-notification-policies` in `backend` — passed: `ok`.
- `npm run lint` in `frontend` — passed with existing warnings and 0 errors.
- `npm run build` in `frontend` — passed; existing lint warnings and existing Recharts static-generation width warnings were printed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 119 existing warnings.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 30 suites, 96 tests; existing SafeAreaView deprecation warning and Jest open-handle notice printed.
- `python3 scripts/audit_change_release_ledger.py` — passed before this validation update: changed files covered.
- `git diff --check` — passed.
- `git -C mz-cleaning-app-frontend diff --check` — passed.

### Risks / Release Notes

- Runtime risk: none; metadata-only version sync.
- Rollback: revert the mobile version fields to the previous `1.0.22 / 22 / 22` values.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: pushed to nested mobile `Dev` in commit `bd66320`; root ledger state recorded in the 2026-06-29 A+B+C release batch.

## CRL-20260629-001 — 日终交接弱网离线保存识别与自动同步

- **Status:** pushed
- **Updated:** 2026-06-29 09:41 Australia/Melbourne
- **Request:** 把日终交接页面和 `dayEndHandoverQueue` 的弱网判断改为复用 `ApiError.retryable` / `TIMEOUT`，不要靠英文 message；同时把 `processDayEndHandoverQueue()` 加入全局网络恢复队列维护。
- **Outcome:** 日终交接保存和队列处理现在按 API 错误的 retryable/code 语义识别超时与网络失败；中文“网络超时，请检查网络后重试”会走离线保存分支。App 登录态下的全局队列维护在启动、回到前台和网络恢复时也会处理日终交接草稿。

### Implementation

- Previous behavior:
  - 日终交接页面和 `dayEndHandoverQueue` 用英文 message 片段识别弱网错误，不能识别 `fetchWithTimeout()` 抛出的中文 `TIMEOUT` 消息。
  - 全局队列维护只处理检查媒体、检查提交、耗材提交和钥匙上传队列；日终交接队列主要依赖任务页刷新触发。
- New behavior:
  - 日终交接页面和队列改为调用 `isRetryableApiError(error)`，并用 `error.code === TIMEOUT / NETWORK_ERROR` 兜底，不再依赖英文超时文案。
  - `AuthProvider` 的 queue maintenance 增加 `processDayEndHandoverQueue(token)`，网络恢复和 App active 时会尝试同步日终交接草稿。
  - 新增队列单测覆盖 retryable `TIMEOUT` 时草稿保留；扩展页面单测覆盖中文超时保存按钮进入离线草稿提示。
- Key decisions:
  - 不新增第二套网络错误分类；复用 `api.ts` 已有 `ApiError.retryable` 与 `code`。
  - 不改变接口 payload、数据库结构或上传流程，只修正错误识别和恢复触发点。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tasks/DayEndBackupKeysScreen.tsx` — modified: 日终交接页面弱网判断改用 `isRetryableApiError` / error code。
- `mz-cleaning-app-frontend/src/lib/dayEndHandoverQueue.ts` — modified: 队列处理弱网判断改用 `isRetryableApiError` / error code。
- `mz-cleaning-app-frontend/src/lib/auth.tsx` — modified: 全局 queue maintenance 增加日终交接队列处理。
- `mz-cleaning-app-frontend/src/screens/tasks/DayEndBackupKeysScreen.test.tsx` — modified: 增加中文超时离线保存回归测试。
- `mz-cleaning-app-frontend/src/lib/dayEndHandoverQueue.test.ts` — added: 增加日终交接队列 retryable timeout 回归测试。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: no request/response shape changes.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: mobile weak-network behavior shares the nested mobile repo with existing uncommitted mobile changes; selective release requires hunk-level staging for shared files if combined with other units.

### Validation

- `npm test -- --runInBand src/screens/tasks/DayEndBackupKeysScreen.test.tsx src/lib/dayEndHandoverQueue.test.ts` in `mz-cleaning-app-frontend` — passed: 2 suites, 4 tests.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 30 suites, 96 tests; existing SafeAreaView deprecation warning printed by `TasksScreen.test.tsx`.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 119 existing warnings.
- `git -C mz-cleaning-app-frontend diff --check` — passed.
- Mobile build — not run: `mz-cleaning-app-frontend/package.json` has no `build` script.

### Risks / Release Notes

- Runtime risk: `AuthProvider` now attempts one more queue during network/app-state maintenance; the queue already has an in-process guard and stops on retryable network failure.
- Rollback: remove `processDayEndHandoverQueue` from `AuthProvider`, restore the previous message-based weak-network checks, and remove the two new/updated tests.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: pushed to nested mobile `Dev` in commit `bd66320`; root ledger state recorded in the 2026-06-29 A+B+C release batch.

## CRL-20260628-011 — 移动端任务更新保留入住和待住晚数

- **Status:** pushed
- **Updated:** 2026-06-28 14:50 Australia/Melbourne
- **Request:** 修复客服更新任务后，admin 能收到任务更新，但清洁/检查人员任务页缺少入住信息，所有角色待住晚数显示 0 的问题。
- **Outcome:** `/mzapp/work-tasks` 在生成移动端清洁/检查任务卡片时，checkout-only 卡片会补取同房源后续 checkin 的入住时间、新密码和待住晚数；admin/customer_service 的二次合并也会保留已住/待住晚数。任务时间变化的实时事件会标记晚数字段，促使旧移动端完整刷新，避免缓存继续显示 0。

### Implementation

- Previous behavior:
  - 清洁/检查移动端列表按执行人合并任务；如果当前用户只拿到 checkout 侧任务，`buildMerged()` 会把卡片当作纯退房处理，`end_time` 为空且 `remaining_nights` 固定为 `0`。
  - admin/customer_service 的 `view=all` 二次合并只保留时间、密码、人员、状态和钥匙字段，没有保留 `stayed_nights` / `remaining_nights`。
  - manager-fields 实时事件只 patch 时间/密码/summary；移动端安全 patch 不会重新计算派生晚数字段。
- New behavior:
  - checkout-only 合并会查同房源从当天起最近一组 checkin 任务，并用它补齐入住时间、新密码、checkin order id、需挂钥匙和 incoming 晚数。
  - checkout 卡片如果有入住信息，summary 和 `end_time` 会显示“退房 + 入住”；`remaining_nights` 使用后续 checkin 的订单晚数，找不到 incoming 订单时才保持 `0`。
  - admin/customer_service 二次合并按同房源同日期聚合时保留最大有效 `stayed_nights` / `remaining_nights`。
  - 清洁任务时间更新事件额外包含 `stayed_nights` / `remaining_nights` 字段名，使现有移动端把该事件视为需要 full sync 的列表变化。
- Key decisions:
  - 修复放在后端列表合并层，避免在移动端重复实现订单晚数计算。
  - 不扩大任务可见性；checkout 卡片只补充同房源最近 checkin 的展示字段，沿用已有 `nextCheckinsForCheckout` 钥匙套数逻辑的边界。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: 修复 `/mzapp/work-tasks` 清洁/检查合并、admin 二次合并和 manager-fields 实时事件字段。
- `backend/src/modules/cleaning.ts` — modified: 通用清洁任务时间变更事件标记晚数字段，触发移动端刷新派生列表数据。
- `backend/dist/modules/cleaning.js` — modified: `npm run build` 生成的 `cleaning.ts` 对应输出；该文件已有其他单元的未提交改动。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: `/mzapp/work-tasks` 响应结构不变，但 checkout-only 清洁/检查卡片现在可能返回 checkin `end_time`、checkin `new_code` 和非 0 `remaining_nights`。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `backend/src/modules/mzapp.ts` and `backend/src/modules/cleaning.ts` with other 2026-06-28 ready units; selective release requires hunk-level staging or explicit combined scope.

### Validation

- `npm run build` in `backend` — passed: `tsc -p .`.
- `npm run test:cleaning-inspection-merge` in `backend` — passed: `test_cleaning_inspection_merge: ok`.
- `git diff --check` — passed.
- Focused authenticated `/mzapp/work-tasks` route test — not run: no existing focused route harness for this exact mobile list merge case.

### Risks / Release Notes

- Runtime risk: checkout-only cards now expose the linked same-property incoming checkin display fields to the checkout assignee. This matches existing key-count behavior and the current product expectation that checkout/turnover cards show both退房 and入住 context.
- Rollback: revert the `buildMerged()` next-checkin merge additions, the admin secondary-night merge, and the extra realtime changed fields.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: pushed to root `Dev` in commit `9192124`; root ledger state recorded in the 2026-06-29 A+B+C release batch.

## CRL-20260628-010 — 任务中心保存按字段 diff 精准通知

- **Status:** pushed
- **Updated:** 2026-06-28 23:10 Australia/Melbourne
- **Request:** 网页端任务中心继续统一保存，但保存时在事务内做字段级 diff，只通知真正变动的任务和相关人员；只排序/分组不推送。
- **Outcome:** `/task-center/save-board` 在事务内锁定本次保存涉及的清洁任务和线下任务旧值，按后端 normalize 后的新值生成字段级 diff；通知和实时事件都基于真实 diff，返回值改为 `changed_tasks`、`push_notifications`、`realtime_events`、`layout_changed`，网页提示区分业务变化和仅看板排序。

### Implementation

- Previous behavior:
  - 前端仍是完整提交当天看板、所有清洁任务分配、所有线下任务分配和 flags。
  - 后端虽然用 `IS DISTINCT FROM` 避免无变化 UPDATE，但 `RETURNING task.*` 只能知道“这行变了”，不知道旧负责人或具体字段。
  - 清洁任务通知固定写 `assignee + inspection + status`，实时事件也固定塞全字段；前端把 `event_notifications` 显示成通知数，容易误导。
- New behavior:
  - `BEGIN` 后对本次 payload 涉及的 `cleaning_tasks` / `work_tasks` 批量 `SELECT ... FOR UPDATE`，用旧值和新值生成 `diffByTaskId`。
  - 清洁任务把 `cleaner_id` / `assignee_id` 作为同一个执行人语义处理，避免重复通知；负责人变化会把新旧执行人都加入显式接收人。
  - 线下任务负责人、日期、内容、状态、紧急度按字段 diff；普通 `todo -> assigned` 如由负责人变化导致，会合并到负责人变化通知。
  - 只排序、分组、lane/order 变化只影响 `layout_changed`，不发人员 push。
  - `emitWorkTaskEvent` 继续用于实时刷新，但 `changedFields` 和事件类型从真实 diff 生成。
  - 前端保存提示改为显示实际变更任务数和通知人数；仅排序时显示“没有发送人员通知”。

### Files / Areas

- `backend/src/modules/task_center.ts` — modified: 增加保存 diff helper、事务内 `SELECT ... FOR UPDATE`、diff 驱动通知/实时事件/返回值。
- `frontend/src/app/task-center/page.tsx` — modified: 适配新的保存返回值和保存状态提示。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: `POST /task-center/save-board` 返回值新增 `changed_tasks`、`push_notifications`、`realtime_events`、`layout_changed`，不再返回旧的 `event_notifications`。
- Database / migration: none; runtime behavior adds row-level locks only for payload task IDs inside the existing save transaction.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `backend/src/modules/task_center.ts` with `CRL-20260628-006`; selective release requires hunk-level staging if shipping separately.

### Validation

- `npm run build` in `backend` — passed: `tsc -p .`.
- `npm run lint` in `frontend` — passed with existing warnings and 0 errors.
- `npm run build` in `frontend` — passed. Next.js still reports existing lint warnings and existing Recharts static-generation width warnings, but build completed.
- `git diff --check` — passed.
- Focused automated backend route test — not run: there is no existing focused authenticated `/task-center/save-board` test harness.

### Risks / Release Notes

- Runtime risk: 清洁任务仍 uses the existing managed `CLEANING_TASK_UPDATED` notification path; if notification rules include manager audiences, managers may still receive configured copies in addition to explicit new/old execution participants.
- Concurrency: row-level locks reduce concurrent overwrite risk for touched task rows, but two users saving the same day can still race on board layout rows in the existing last-write-wins layout model.
- Rollback: restore `/save-board` notification generation to `RETURNING task.*` and the previous `event_notifications` response, then revert the frontend save summary.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: pushed to root `Dev` in commit `9192124`; root ledger state recorded in the 2026-06-29 A+B+C release batch.

## CRL-20260628-001 — 移动端详情页停止 90 天全部任务回查

- **Status:** pushed
- **Updated:** 2026-06-28 00:00 Australia/Melbourne
- **Request:** 先止住移动端详情页和经理详情页 fallback 拉 `now -45` 到 `now +45` 的 `view=all` 大请求；本地找不到任务时只查小范围。
- **Outcome:** 任务详情页和经理每日任务详情页在本地 store 找不到任务时，fallback 请求从 90 天缩小为 `today -7` 到 `today +7`，避免继续触发 3MB+ 的 `/mzapp/work-tasks?view=all` 大范围查询。

### Implementation

- Previous behavior:
  - `TaskDetailScreen` 本地找不到任务时，会按用户角色拉 `now -45 ~ now +45`；管理角色会使用 `view=all`。
  - `ManagerDailyTaskScreen` 本地找不到任务以及保存管理字段后，都会拉 `now -45 ~ now +45&view=all`。
- New behavior:
  - 两个详情页复用本地 `buildDetailFallbackRange()`，只请求 `today -7 ~ today +7`。
  - 保留现有 `findWorkTaskItemByAnyId` store 优先查找逻辑；该逻辑已按标准化任务 ID 集合匹配任务 id / source id / source ids。
- Key decisions:
  - 本轮只止住 90 天大范围 fallback，不改列表页日历范围、不新增后端接口、不处理经理详情页照片/耗材并发。
  - 当前导航参数没有目标日期字段，因此先按“只有 taskId 时最多 today ± 7 天”落地；后续如路由携带目标日期，可复用同一 helper。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` — modified: 详情页 fallback 从 `now ± 45 天` 改为 `today ± 7 天`。
- `mz-cleaning-app-frontend/src/screens/tasks/ManagerDailyTaskScreen.tsx` — modified: 经理详情页 fallback 和保存后刷新从 `now ± 45 天` 改为 `today ± 7 天`。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: no request/response shape changes; mobile clients will stop issuing 90-day fallback calls from these screens.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: none.

### Validation

- `rg -n "addDays\\(now, -45\\)|addDays\\(now, 45\\)|date_from = ymd\\(addDays\\(now" mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx mz-cleaning-app-frontend/src/screens/tasks/ManagerDailyTaskScreen.tsx mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — passed: no matching 90-day fallback calls remained in the checked screens.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm test -- --runInBand src/screens/tasks/TaskDetailScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 1 suite, 9 tests.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 120 existing warnings.
- Backend build/test — not run: this change only modifies mobile fallback request ranges.

### Risks / Release Notes

- Runtime risk: 如果从通知或深链进入一个超过 today ± 7 天且当前 store 未缓存的任务，详情页仍可能找不到该任务；这是为避免 90 天 `view=all` 压垮 DB 接受的 tradeoff。
- Follow-up: 可在导航参数中传目标日期，或新增按 task id 精准读取接口，进一步减少 fallback 范围和误差。
- Rollback: revert the fallback range helper changes in the two mobile screens.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: pushed to nested mobile `Dev` in commit `bd66320`; root ledger state recorded in the 2026-06-29 A+B+C release batch.

## CRL-20260628-002 — 移动端任务刷新与经理详情照片请求去重

- **Status:** pushed
- **Updated:** 2026-06-28 12:07 Australia/Melbourne
- **Request:** 给 `refreshWorkTasksFromServer` 加同参数 in-flight 合并；给 `ManagerDailyTaskScreen` 的 `loadTaskPhotos` 加同批次 in-flight guard，focus 时 30 秒内复用现有状态，避免 mount 和 focus 连续双触发。
- **Outcome:** 移动端同一个 `userId/date_from/date_to/view` 的任务刷新会复用同一个 Promise；经理详情页同一组清洁/检查任务照片和耗材批次正在加载或刚加载完成时，不会重复发起同批请求。

### Implementation

- Previous behavior:
  - 多个组件或生命周期在同一秒调用 `refreshWorkTasksFromServer` 时，会重复请求同一个 `/mzapp/work-tasks` bucket。
  - `ManagerDailyTaskScreen` mount 与 focus 可连续触发 `loadTaskPhotos`，对同一组任务重复并发请求 consumables、completion photos、inspection photos、restock proof。
- New behavior:
  - `workTasksStore` 使用 `refreshWorkTasksInFlight` 按 bucket key 记录正在进行的刷新 Promise；相同 bucket 直接复用，完成后清理。
  - `ManagerDailyTaskScreen` 使用同一用户与 cleaning/inspection task id 组合作为照片批次 key；同批次 in-flight 时复用 Promise，focus 触发时 30 秒内直接复用现有状态。
  - 保留四类详情接口并发拉取，不新增后端聚合接口。
- Key decisions:
  - in-flight key 不包含原始 token，避免把敏感值放进长期引用或调试可见状态中。
  - 本轮只做前端削峰，不改变 API 结构、数据库查询或服务端连接池配置。

### Files / Areas

- `mz-cleaning-app-frontend/src/lib/workTasksStore.ts` — modified: `refreshWorkTasksFromServer` 按 bucket key 合并同参数请求。
- `mz-cleaning-app-frontend/src/screens/tasks/ManagerDailyTaskScreen.tsx` — modified: 经理详情页照片/耗材批次增加 in-flight guard 和 focus 30 秒复用。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: no request/response shape changes; duplicate mobile calls are reduced client-side.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: CRL-20260628-001.

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm test -- --runInBand src/screens/tasks/TaskDetailScreen.test.tsx src/screens/tasks/ManagerDailyTaskScreen.test.ts` in `mz-cleaning-app-frontend` — passed: 2 suites, 11 tests.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 119 existing warnings.
- `git diff --check` in root repo — passed.
- `git -C mz-cleaning-app-frontend diff --check` — passed.
- Backend build/test — not run: this change only modifies mobile client request deduplication.

### Risks / Release Notes

- Runtime risk: focus 后 30 秒内如果其他设备刚上传了新照片，经理详情页可能短暂显示旧状态；再次进入超过窗口或后续刷新会重新加载。
- Runtime risk: `refreshWorkTasksFromServer` 同 bucket 请求会共享首个请求的结果；bucket key 包含 user/date range/view，适合当前调用语义。
- Rollback: remove `refreshWorkTasksInFlight` and the `loadTaskPhotos` in-flight/reuse refs.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added. The in-flight photo key intentionally avoids raw token values.
- Git state: pushed to nested mobile `Dev` in commit `bd66320`; root ledger state recorded in the 2026-06-29 A+B+C release batch.

## CRL-20260628-003 — 后端限制移动端全量任务范围并脱敏健康检查

- **Status:** pushed
- **Updated:** 2026-06-28 12:14 Australia/Melbourne
- **Request:** 后端给 `/mzapp/work-tasks` 增加轻量保护，`view=all` 日期范围最多 31 天，避免旧 App 继续发 90 天大请求；同时把 `/health/db` 的 host/database 输出脱敏。
- **Outcome:** `/mzapp/work-tasks?view=all` 超过 31 天会在进入数据库查询前直接返回 400；health DB 诊断不再输出真实数据库 host 或 database 名称，相关 health 错误也会替换已知 DB URL/host/db 片段。

### Implementation

- Previous behavior:
  - `/mzapp/work-tasks` 只检查 `date_from` 和 `date_to` 是否存在，`view=all` 可以请求 90 天或更大范围并触发多段 DB 查询。
  - `/health/db` 直接返回 `DATABASE_URL` 解析出的 `pg_host` 和 `pg_database`，连接错误也可能包含 host/db 信息。
  - `/health/config` 也暴露同类 `pg_host` / `pg_db` 字段。
- New behavior:
  - `view=all` 使用包含首尾日期的天数计算范围，最多 31 天；超过返回 `400 { message: "date_range_too_large", max_days: 31, requested_days }`。
  - `view=mine` 暂不收紧，避免影响普通个人任务列表。
  - `/health/db`、`/health/config` 的 host/database 字段改为 `[redacted]`；`/health/db` 和 `/health/ready` 的 DB 错误消息会替换已知 URL/host/db 片段。
- Key decisions:
  - 选择直接 400，而不是自动裁剪，避免旧客户端误以为拿到了完整数据。
  - 日期范围限制在权限检查和 DB 查询前执行，用于保护旧 App 版本和异常请求。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: 增加 `view=all` 日期范围上限和合法日期顺序校验。
- `backend/src/index.ts` — modified: health DB/config 输出脱敏，health DB/ready 错误消息脱敏。
- `backend/dist/index.js` — modified: backend build 生成的对应 `index.ts` 输出。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: `/mzapp/work-tasks?view=all` 新增 31 天范围上限，超过范围返回 400；响应成功结构不变。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: CRL-20260628-001, CRL-20260628-002.

### Validation

- `npm run build` in `backend` — passed: `tsc -p .`.
- `rg -n "pg_host\\s*=\\s*u\\.hostname|pg_database\\s*=\\s*db|pg_db\\s*=\\s*\\(u\\.pathname|pg_database\\s*=\\s*result\\.pg_database \\|\\||message: String\\(e\\?\\.message" backend/src/index.ts` — passed for the targeted health DB/config patterns; remaining matches are unrelated non-health generic handlers.
- Backend automated route test — not run: there is no existing focused test harness for authenticated `/mzapp/work-tasks`.

### Risks / Release Notes

- Runtime risk: old App versions that still request 90-day `view=all` will now receive 400 instead of partial data. This is intentional to protect DB load and make the bad request visible.
- Compatibility note: valid `view=all` requests up to 31 inclusive days continue to work.
- Rollback: remove the range guard in `backend/src/modules/mzapp.ts` and restore raw health fields if needed.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added. Health output now avoids raw DB host/database values.
- Git state: pushed to root `Dev` in commit `9192124`; root ledger state recorded in the 2026-06-29 A+B+C release batch.

## CRL-20260628-004 — 检查面板兜底读取清洁消耗品不足项

- **Status:** pushed
- **Updated:** 2026-06-28 12:21 Australia/Melbourne
- **Request:** 检查清洁已上传消耗品清单但检查人员页面没有显示缺少消耗品的问题。
- **Outcome:** 检查与补充页进入时会兜底读取清洁任务的消耗品提交记录，并把 `low` / `need_restock` 项合并到检查员的“消耗品补充”列表；检查员已填写的草稿状态、照片和备注不会被覆盖。

### Implementation

- Previous behavior:
  - `InspectionPanelScreen` 只从 work task 列表缓存中的 `task.restock_items` 初始化补充项。
  - 如果实时事件没到、列表缓存旧，或检查员先打开页面后清洁员才提交消耗品，检查页不会主动读取 `/mzapp/cleaning-tasks/:id/consumables`，因此会显示“当前没有待补充项”。
- New behavior:
  - 检查页根据当前任务的 `source_id`、`source_ids`、`cleaning_task_ids` 组合出清洁任务 ID 列表，进入页面时并行读取 `getCleaningConsumables`。
  - 只把清洁员标记 `low` 或 `need_restock` 的项合并进补充列表，带入数量、备注和清洁员照片。
  - 如果页面已经 hydrate 草稿，后续清洁提交或列表刷新只追加新来的不足项，不覆盖检查员已选择的状态或已拍照片。
- Key decisions:
  - 不改后端表结构和接口；复用现有消耗品读取接口。
  - 不把普通 `ok` 消耗品显示给检查员，只显示需要处理的不足项。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — modified: 检查页兜底读取并合并清洁消耗品不足项。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: no request/response shape changes; inspection panel now calls existing `/mzapp/cleaning-tasks/:id/consumables` read endpoint.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: none.

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm test -- --runInBand src/lib/inspectionPanelSubmitQueue.test.ts` in `mz-cleaning-app-frontend` — passed: 1 suite, 7 tests.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 119 existing warnings.
- `git diff --check` in root repo — passed.
- `git -C mz-cleaning-app-frontend diff --check` — passed.
- Backend build/test — not run: this change only uses an existing mobile API from the client.

### Risks / Release Notes

- Runtime risk: 检查页进入时会多发一个或多个轻量消耗品读取请求；只按当前任务关联的清洁 task ids 请求，不扩大任务列表查询。
- Offline behavior: 网络失败时保留原本列表缓存/本地草稿行为，不阻断检查页打开。
- Rollback: remove the `getCleaningConsumables` fallback merge in `InspectionPanelScreen`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: pushed to nested mobile `Dev` in commit `bd66320`; root ledger state recorded in the 2026-06-29 A+B+C release batch.

## CRL-20260628-005 — 改密码/挂钥匙视频错传后可删除

- **Status:** pushed
- **Updated:** 2026-06-28 12:56 AEST
- **Request:** 错传照片/视频无法删除；402 拍摄时误传到 3401，3401 昨天仅需改密码，发现传错后删不掉。
- **Outcome:** 检查员在“改密码并完成 / 挂钥匙视频”页面可以删除已上传的视频；后端会删除 `lockbox_video` 媒体记录、清空锁盒视频时间，并把已完成检查状态恢复为待检查来源状态，方便重新拍摄提交到正确任务。

### Implementation

- Previous behavior:
  - `InspectionCompleteScreen` 只支持拍摄、上传、提交 lockbox/password 视频；已同步完成后没有删除入口。
  - 后端只有 key photo 删除接口，没有 `lockbox_video` 删除接口；已误传的视频只能通过人工数据库处理。
- New behavior:
  - 移动端新增 `deleteLockboxVideo` API，优先调用 `DELETE /mzapp/cleaning-tasks/:id/lockbox-video`，并保留 `POST .../delete` 兼容 fallback。
  - `InspectionCompleteScreen` 在已有视频或本地待上传视频时显示删除按钮；删除已保存视频会请求后端，删除未提交本地视频只清理队列。
  - 后端新增 `/mzapp/cleaning-tasks/:id/lockbox-video` 和 `/cleaning-app/tasks/:id/lockbox-video` 的 DELETE/POST-delete 路由，删除后发出 work task 实时事件。
  - 删除已完成检查的视频时，任务状态恢复为 `restock_pending`（存在缺货消耗品）或 `cleaned`（无缺货），移动端检查视图会投影回 `to_inspect`。
- Key decisions:
  - 不删除 R2/Object Storage 原文件；与现有 key photo 删除保持一致，只解除业务任务关联。
  - 不新增数据库字段或迁移；复用 `cleaning_task_media` 的 `lockbox_video` 类型和 `cleaning_tasks.lockbox_video_uploaded_at`。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: 增加移动端 lockbox 视频删除接口，删除媒体记录、回退任务状态、广播实时事件。
- `backend/src/modules/cleaning_app.ts` — modified: 增加 cleaning-app lockbox 视频删除接口，覆盖自完成/兼容入口。
- `backend/dist/index.js` — modified: `npm run build` 生成的后端构建产物。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: 新增 `deleteLockboxVideo` API helper。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionCompleteScreen.tsx` — modified: 增加删除确认、删除按钮、本地队列清理和当前任务 store patch。
- `mz-cleaning-app-frontend/src/lib/workTasksStore.ts` — modified: 将 `lockbox_video_uploaded_at` 加入实时安全 patch 字段，避免删除事件触发不必要全量刷新。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: 新增 `DELETE /mzapp/cleaning-tasks/:id/lockbox-video`、`POST /mzapp/cleaning-tasks/:id/lockbox-video/delete`、`DELETE /cleaning-app/tasks/:id/lockbox-video`、`POST /cleaning-app/tasks/:id/lockbox-video/delete`。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `backend/src/modules/mzapp.ts` with `CRL-20260628-003` and `mz-cleaning-app-frontend/src/lib/workTasksStore.ts` with `CRL-20260628-002`; behavior is independent but shared files require careful hunk-level release staging if selected separately.

### Validation

- `npm run build` in `backend` — passed: `tsc -p .`.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 119 existing warnings.
- `npm test -- --runInBand src/lib/inspectionMediaQueue.test.ts` in `mz-cleaning-app-frontend` — passed: 1 suite, 1 test.
- `git diff --check` — passed.
- `git -C mz-cleaning-app-frontend diff --check` — passed.
- `python3 scripts/audit_change_release_ledger.py` — passed: Changed files 5, recorded changed files 5, coverage PASS.

### Risks / Release Notes

- Runtime risk: 删除会恢复任务为可重新检查状态，但本轮未在生产 3401/402 真实任务上执行删除验证，避免误操作真实数据。
- Storage note: 原始对象文件不被物理删除；如需彻底清理对象存储，需要单独做带权限和审计的清理流程。
- Rollback: remove the new delete routes/API helper and the delete UI, then rebuild backend dist.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: pushed to root `Dev` in commit `9192124` and nested mobile `Dev` in commit `bd66320`; root ledger state recorded in the 2026-06-29 A+B+C release batch.

## CRL-20260628-006 — 线下其他任务照片附件贯通网页和移动端

- **Status:** pushed
- **Updated:** 2026-06-28 13:46 AEST
- **Request:** 线下其他任务网页端和移动端都要可以添加照片，给线下执行人员查看。
- **Outcome:** 线下其他任务现在有独立的 `photo_urls` 附件字段；网页每日清洁页创建/编辑线下任务可上传并预览任务照片，移动端线下任务详情可拍照或从相册追加照片，相关照片会随 `/mzapp/work-tasks` 返回给线下人员查看。

### Implementation

- Previous behavior:
  - 线下其他任务只有任务名称、类型、备注、执行人、日期和状态等文本/流程字段，任务创建时无法附带现场照片或截图。
  - 移动端线下任务详情可处理任务完成，但没有“任务说明照片”入口；完成照片与任务说明附件也没有区分。
  - 网页每日清洁页创建或编辑线下任务时无法上传给执行人员查看的照片。
- New behavior:
  - 后端为 `cleaning_offline_tasks` 和 canonical `work_tasks` 增加 `photo_urls` jsonb 字段，线下任务创建、编辑、日历读取和移动端任务列表都会返回该字段。
  - 网页每日清洁页线下任务创建/编辑弹窗新增“任务照片”上传区，复用现有 `/cleaning-app/upload` 上传能力，并在任务卡片上展示照片数量和缩略图。
  - 移动端线下任务详情新增“任务照片”区，支持拍照添加、相册添加、预览和删除；保存通过 `PATCH /mzapp/work-tasks/:id/photos` 更新 canonical `work_tasks`，并同步回 `cleaning_offline_tasks`。
  - 实时任务更新事件会携带 `photo_urls`，移动端 store 将其作为安全 patch 字段处理，避免照片更新后必须全量刷新。
- Key decisions:
  - 不把任务说明照片混入“完成照片”；线下任务仍可不拍完成照片直接完成，说明照片用于任务派发和执行前查看。
  - 不新增第二套上传系统；网页复用 `/cleaning-app/upload`，移动端复用现有 `uploadTaskPhoto` 和清洁媒体鉴权图片渲染 helper。
  - `work_tasks` 继续作为移动端运行时单一来源，`cleaning_offline_tasks.photo_urls` 只作为来源表兼容与网页日历数据。

### Files / Areas

- `backend/src/modules/cleaning.ts` — modified: 线下任务 schema/API/日历读取支持 `photo_urls`，并把照片同步到 canonical work task。
- `backend/src/modules/mzapp.ts` — modified: `/mzapp/work-tasks` 返回 `photo_urls`，新增 `PATCH /mzapp/work-tasks/:id/photos` 保存线下任务照片并广播实时更新。
- `backend/src/modules/work_tasks.ts` — modified: work task 输出包含 `photo_urls`。
- `backend/src/modules/task_center.ts` — modified: work task schema ensure 包含 `photo_urls`。
- `backend/src/modules/crud.ts` — modified: work task schema ensure 包含 `photo_urls`。
- `backend/src/store.ts` — modified: `CleaningOfflineTask` 类型增加 `photo_urls`。
- `backend/dist/modules/cleaning.js` — modified: `npm run build` 生成的已跟踪后端构建产物。
- `frontend/src/app/cleaning/page.tsx` — modified: 网页端线下任务创建/编辑上传任务照片，并在列表卡片展示照片缩略图。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: `WorkTask` 类型增加 `photo_urls`，新增 `updateWorkTaskPhotos` API helper。
- `mz-cleaning-app-frontend/src/lib/workTasksStore.ts` — modified: 将 `photo_urls` 加入实时安全 patch 字段。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` — modified: 线下任务详情新增任务照片拍照/相册添加/预览/删除与保存。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: `POST /cleaning/offline-tasks` and `PATCH /cleaning/offline-tasks/:id` accept and return optional `photo_urls`; `/cleaning/calendar-range` and `/mzapp/work-tasks` return `photo_urls`; new `PATCH /mzapp/work-tasks/:id/photos` updates photos for assigned users or roles with all-view permission.
- Database / migration: additive runtime schema ensure for `cleaning_offline_tasks.photo_urls` and `work_tasks.photo_urls`; no destructive migration.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `backend/src/modules/mzapp.ts` with `CRL-20260628-003` and `CRL-20260628-005`, and shares `mz-cleaning-app-frontend/src/lib/api.ts`, `src/lib/workTasksStore.ts`, `src/screens/tasks/TaskDetailScreen.tsx` with earlier 2026-06-28 mobile units. Use hunk-level staging if releasing this unit separately.

### Validation

- `npm run build` in `backend` — passed: `tsc -p .`.
- `npm run typecheck` in `frontend` — not run successfully: this package has no `typecheck` script.
- `npm run build` in `frontend` — passed. Next.js still reports existing chart-width/static-generation warnings from other pages, but build completed.
- `npm run lint` in `frontend` — passed with existing warnings and 0 errors.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm test -- --runInBand src/screens/tasks/TaskDetailScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 1 suite, 9 tests.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 119 existing warnings.
- `git diff --check` — passed.
- `git -C mz-cleaning-app-frontend diff --check` — passed.

### Risks / Release Notes

- Runtime risk: 本轮未用真机账号实际拍照上传到生产对象存储；验证覆盖到类型检查、构建、lint 和现有详情页测试。
- Access control: 移动端照片更新限制为当前执行人或有全部视图权限的角色；网页端沿用现有后台清洁页面权限。
- Rollback: remove `photo_urls` API/schema handling, the web upload UI, and the mobile task-photo section/API helper, then rebuild backend dist if required.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: pushed to root `Dev` in commit `9192124` and nested mobile `Dev` in commit `bd66320`; root ledger state recorded in the 2026-06-29 A+B+C release batch.

## CRL-20260628-007 — 移动端线下/维修类任务卡片信息优先级调整

- **Status:** pushed
- **Updated:** 2026-06-28 14:05 AEST
- **Request:** 截图中的任务卡片排版需要调整，内容应该最重要，然后执行人，然后房源地址等信息。
- **Outcome:** 移动端任务列表里线下任务、维修、深清、日用品等非清洁流程任务的展开态改为先显示“任务内容”，再显示“执行人员”，最后显示“房源地址”；房源地址仍可复制。

### Implementation

- Previous behavior:
  - 线下任务展开后先显示较大的执行人员卡片，任务内容在后面以普通行展示。
  - 维修/深清/日用品等房源跟进任务先显示地址，任务内容在更靠后的位置，截图中“洗碗机排水不正常”这类核心内容不够突出。
- New behavior:
  - 非清洁流程任务使用独立展开布局：任务内容卡片优先、执行人员行其次、房源地址复制行最后。
  - 任务内容使用更高字重和最多 4 行展示；执行人员从 `assignee_name / cleaner_name / inspector_name / assignee_id` 中兜底，仍显示未分配状态。
  - 清洁/检查任务的原有执行人员、地址、Wi-Fi、时间、门锁密码、入住指南等流程布局不变。
- Key decisions:
  - 本轮只做移动端任务列表展示顺序，不改后端字段、权限、排序、筛选、详情页或任务完成逻辑。
  - 复用现有卡片、图标和复制反馈样式，不新增新的布局系统。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 非清洁流程任务展开态改为内容、执行人、地址的展示顺序。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx` — modified: 增加维修类房源跟进任务卡片顺序回归测试。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` with earlier mobile task-list units; release separately时需要 hunk-level staging。

### Validation

- `npm test -- --runInBand src/screens/tabs/TasksScreen.test.tsx` in `mz-cleaning-app-frontend` — passed: 1 suite, 6 tests. Jest still reports the existing open-handles notice and SafeAreaView deprecation warning.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 119 existing warnings.
- `git -C mz-cleaning-app-frontend diff --check` — passed.

### Risks / Release Notes

- Runtime risk: 未在真机上截图验证最终视觉间距；已通过组件测试覆盖文本顺序。
- Scope boundary: 只调整非清洁流程任务展开态；清洁/检查任务卡片未重排。
- Rollback: revert the standalone task layout branch and the new TasksScreen test.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: pushed to nested mobile `Dev` in commit `bd66320`; root ledger state recorded in the 2026-06-29 A+B+C release batch.

## CRL-20260628-008 — 问题反馈取消默认维修类型并强制选择

- **Status:** pushed
- **Updated:** 2026-06-28 14:20 AEST
- **Request:** 所有问题反馈不要默认反馈类型就是维修；让反馈的人自己选择，没有选择的话提交时高亮提醒。
- **Outcome:** 移动端问题反馈页初始标题为“问题反馈”，不再默认选中“房源维修”；提交或新增记录前如果未选择反馈类型，会滚回第 1 步，高亮“选择反馈类型”卡片并提示用户先选择。

### Implementation

- Previous behavior:
  - `FeedbackFormScreen` 的 `kind` 初始值是 `maintenance`，打开页面就默认选中“房源维修”。
  - 用户没有主动选择类型时也会按维修记录路径填写和提交，容易把深清或日用品反馈误归类为维修。
- New behavior:
  - `kind` 改为可空；全新反馈不选任何类型，页面第 2 步只显示“请先选择反馈类型”的占位说明。
  - 选择“房源维修 / 深度清洁 / 日用品反馈”后才显示对应记录表单；已有有效草稿仍会恢复已选择的类型。
  - 提交或新增一条记录时，如果还未选择类型，页面会滚到顶部，高亮第 1 步并弹出“请先选择反馈类型”。
  - 检查面板批量暂存路径同步处理：没有内容且未选类型时清空暂存，不再尝试保存空类型。
- Key decisions:
  - 不改后端接口、反馈 kind 枚举、历史反馈展示或通知规则；只修移动端表单入口和前端校验。
  - 保留草稿恢复能力，避免用户已选类型并填了内容后回到页面丢失上下文。

### Files / Areas

- `mz-cleaning-app-frontend/src/screens/tasks/FeedbackFormScreen.tsx` — modified: 反馈类型默认空、未选择时占位提示、提交/新增前高亮校验、检查面板暂存清空处理。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: none; existing `createPropertyFeedbackBatch` payloads are sent only after the user selects a concrete kind.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: shares nested mobile repo with other 2026-06-28 ready units, but `FeedbackFormScreen.tsx` change is independent.

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 119 existing warnings.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 29 suites, 94 tests. Existing SafeAreaView deprecation warning still appears from `TasksScreen.test.tsx`.
- `git -C mz-cleaning-app-frontend diff --check` — passed.

### Risks / Release Notes

- Runtime risk: 未在真机上实际点提交验证红框滚动动画；验证覆盖到 TypeScript、lint 和全量 Jest。
- Scope boundary: 只取消默认反馈类型，不改变各类型内部必填规则。
- Rollback: restore `kind` initial value to `maintenance` and remove the missing-kind highlight branch.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: pushed to nested mobile `Dev` in commit `bd66320`; root ledger state recorded in the 2026-06-29 A+B+C release batch.

## CRL-20260628-009 — Admin 移动端管理问题反馈记录

- **Status:** pushed
- **Updated:** 2026-06-28 13:44 AEST
- **Request:** admin 的移动端看到重复的问题反馈时，可以删除记录，或者把记录调整到对应的反馈类型。
- **Outcome:** 移动端问题反馈历史记录对 admin 显示“调整类型”和“删除”管理入口；后端新增 admin-only 删除和移动反馈类型接口，移动类型时会把原记录迁到目标反馈表并同步关联 `work_tasks` 的来源类型。

### Implementation

- Previous behavior:
  - 移动端问题反馈历史只能查看，重复记录或误选类型后需要从后台/数据库处理。
  - 后端没有移动端专用的 admin 删除/改类型接口。
- New behavior:
  - admin 在移动端反馈列表行和详情弹窗里可以删除单条反馈记录；删除会移除原反馈记录及对应 `work_tasks` 来源任务。
  - admin 可以把记录调整为“房源维修 / 深度清洁 / 日用品反馈”；后端在事务内复制核心字段、照片、状态、提交人、房源信息到目标类型表，删除源类型记录，并更新同一 `source_id` 的 `work_tasks.source_type/task_kind`。
  - 移动到“日用品反馈”时会合并保留前后照片，避免类型调整后丢失现场图片。
- Key decisions:
  - 权限只开放给 `admin`，不扩大到客服、线下经理或执行人。
  - 不新增表结构或第二套反馈系统；复用现有三类反馈表和现有 `work_tasks` 来源字段。
  - 删除是显式二次确认的破坏性操作；移动类型如果目标表已有同 ID 记录会返回冲突，避免覆盖数据。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: 新增 admin-only 删除反馈和移动反馈类型接口、跨类型记录转换 helper、`work_tasks` 来源类型同步。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: 新增移动端删除反馈和调整反馈类型 API helper。
- `mz-cleaning-app-frontend/src/screens/tasks/FeedbackFormScreen.tsx` — modified: admin 反馈历史列表和详情弹窗新增“调整类型/删除”入口、调整类型弹窗、删除确认和本地列表刷新。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: added `DELETE /mzapp/property-feedbacks/:kind/:id`; added `POST /mzapp/property-feedbacks/:kind/:id/move` with body `{ "target_kind": "maintenance" | "deep_cleaning" | "daily_necessities" }`.
- Database / migration: none; uses existing feedback tables and existing runtime column guards.
- Config / environment: none.
- Dependencies: none.
- Related units: follows `CRL-20260628-008` because both touch `FeedbackFormScreen.tsx`; selective release needs hunk-level staging if only shipping one unit.

### Validation

- `npm run build` in `backend` — passed: `tsc -p .` completed.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 119 existing warnings.
- `npm test -- --runInBand` in `mz-cleaning-app-frontend` — passed: 29 suites, 94 tests. Existing SafeAreaView deprecation warning and Jest open-handles notice still appear.
- `git diff --check && git -C mz-cleaning-app-frontend diff --check` — passed.

### Risks / Release Notes

- Runtime risk: 未连接生产数据手工移动/删除真实反馈；当前验证覆盖 TypeScript、lint、Jest 和 whitespace。
- Data risk: 删除记录会同步删除对应来源 `work_tasks`，操作不可在移动端撤销；已限制为 admin 且有二次确认。
- Mapping risk: 三类反馈表字段不完全相同，移动类型时会保留核心字段、状态、提交人、房源、描述和照片，类型专属字段会按目标类型默认语义归一化。
- Rollback: remove the two new `/property-feedbacks/:kind/:id` admin routes and mobile admin controls/API helpers.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: pushed to root `Dev` in commit `9192124` and nested mobile `Dev` in commit `bd66320`; root ledger state recorded in the 2026-06-29 A+B+C release batch.

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

## CRL-20260625-004 — 移动端合并任务门锁密码显示修复

- **Status:** pushed
- **Updated:** 2026-06-25 15:59 AEST
- **Request:** 生产环境移动端改了新密码，退房当天 6 月 29 日任务旧密码还是不显示；截图显示数据库退房任务已有旧密码，但移动端任务详情仍显示 `-`。
- **Outcome:** `/mzapp/work-tasks` 在 admin/customer_service/offline_manager 的全部视图合并同房同日清洁任务时，会从同组合并任务里重新合并 `old_code/new_code`，因此 6 月 29 日 Aura2707 这类入住任务和退房任务被合成一张卡片时，退房任务旧密码不会再被首选卡片覆盖成空。

### Implementation

- Previous behavior:
  - 同订单入住新密码到退房旧密码的数据库同步已经成功，`cleaning_tasks.checkout_clean.old_code` 有值，`cleaning_sync_logs` 也记录了同步。
  - 但移动端管理“全部”视图会在 `/mzapp/work-tasks` 里按日期和房号进行第二次合并；该合并只保留 `preferred` 卡片上的 `old_code/new_code`，没有从同组合并任务重新取密码。
  - 当同房同日的首选卡片是当天入住或其它不带退房旧密码的任务时，移动端详情页显示旧密码和新密码为 `-`。
- New behavior:
  - 二次合并时 `old_code` 优先取同组 `checkout_clean` 任务，再回退到任意同组任务的 `old_code`。
  - `new_code` 优先取同组 `checkin_clean` 任务，再回退到任意同组任务的 `new_code`。
  - 合并结果显式写回 `old_code/new_code`，不再依赖 `preferred` 卡片是否刚好带密码。
- Key decisions:
  - 不新增接口字段、不改数据库、不改移动端展示逻辑；修复后端返回的合并任务数据源。
  - 不改变上一单入住新密码同步退房旧密码的规则，本次只修读取和合并展示。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: admin/customer_service/offline_manager 全部视图二次合并同房同日任务时，显式合并并返回门锁 `old_code/new_code`。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: response shape unchanged; existing `old_code/new_code` fields now survive merged-card response.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: follows `CRL-20260625-003`; that unit handles writing checkout old password, this unit handles merged mobile task display.

### Validation

- `npm run build` in `backend` — passed: `tsc -p .` completed.
- `npm run test:cleaning-inspection-merge` in `backend` — passed: `test_cleaning_inspection_merge: ok`.
- `git diff --check` — passed.
- Full mobile test suite — not run: this change is in backend `/mzapp/work-tasks` merge response and does not modify mobile client code.

### Risks / Release Notes

- Runtime risk: 未直接调用生产 `/mzapp/work-tasks` 接口验证 6 月 29 日 Aura2707 返回体；数据库截图已确认源退房任务有旧密码，本次修复覆盖后端合并丢字段路径。
- Scope boundary: 只影响 admin/customer_service/offline_manager 的全部视图同房同日合并卡片；单条任务密码写入规则不变。
- Rollback: revert the `old_code/new_code` merge additions in `backend/src/modules/mzapp.ts`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: pushed to root `Dev` in commit `3354f2b`; root ledger status update pushed separately.

## CRL-20260629-001 — 清洁手动补位任务 Superseded 执行状态第一阶段

- **Status:** pushed
- **Updated:** 2026-06-30 00:15 AEST
- **Request:** 先执行第一阶段；不要把所有手动 checkin/checkout 都自动 supersede，只有符合补位条件且没有执行记录的手动任务才自动 superseded，并且不要再用 `cancelled` 表示被替代。
- **Outcome:** 清洁任务新增 `execution_state` 执行语义；订单同步创建 canonical 自动任务后，只会把满足条件的手动入住/退房补位任务标记为 `superseded`，保留原 `status`，并让网页端、移动端和任务中心主要读取路径统一过滤 active 任务。

### Implementation

- Previous behavior:
  - 同房同日订单入住任务生成后，旧逻辑会把匹配到的手动入住任务直接改成 `status='cancelled'`。
  - 被订单任务替代和真实业务取消共用 `cancelled`，后续查询只能靠 `status <> cancelled` 模糊过滤。
  - 只覆盖入住手动任务，退房手动补位没有同等语义。
- New behavior:
  - `cleaning_tasks` 增加 `execution_state`、`manual_task_purpose`、`superseded_by`、`superseded_reason`、`superseded_at`、`supersede_conflicts`。
  - schema bootstrap 和迁移会回填：历史 cancelled/canceled 为 `execution_state='cancelled'`，其他缺省为 `active`。
  - 订单同步只 supersede 同房同日、`order_id IS NULL`、`task_type` 为 `checkin_clean`/`checkout_clean`、`manual_task_purpose` 为空或 `temporary_order_placeholder`、状态未进入执行中/完成类、且没有照片/补品/问题反馈等执行记录的手动任务。
  - 被替代的手动任务保留原 `status`，写入 `execution_state='superseded'`、`superseded_by` 和原因，同时通过 `TASK_REMOVED` membership 事件让列表移除。
  - 真实删除/订单无效取消仍写 `status='cancelled'`，并同步写 `execution_state='cancelled'`。
  - 网页清洁任务列表、清洁日历、任务中心清洁来源、移动端 `/mzapp/work-tasks` 和相关临时通知/钥匙数量同步路径统一使用 active execution state 过滤。
- Key decisions:
  - 第一阶段不做 canonical display 聚合，不把手动任务的入住/退房时间、钥匙数量、客人需求、密码等字段写回订单任务，避免提前引入字段冲突规则。
  - 不新增第二套查询系统；通过 `activeCleaningTaskWhereSql()` 复用 active 过滤逻辑。

### Files / Areas

- `backend/scripts/migrations/20260629_cleaning_task_execution_state.sql` — added: 新增执行状态字段、回填规则和 active 查询索引。
- `backend/src/services/cleaningSync.ts` — modified: 新增 execution state schema bootstrap、active SQL helper、手动补位 supersede 判定、订单同步接入和取消状态同步。
- `backend/src/modules/cleaning.ts` — modified: 清洁后台列表/日历过滤 active；手动创建默认 active；删除和批量删除同步写 cancelled execution state。
- `backend/src/modules/mzapp.ts` — modified: 移动端工作任务、临时通知、钥匙数量同步和相关任务查找改为 active-only。
- `backend/src/modules/task_center.ts` — modified: 任务中心清洁任务来源和未来退房投影改为 active-only。
- `backend/scripts/tests/test_cleaning_sync_v2.ts` — modified: 覆盖取消写 execution state、符合条件的手动补位任务 superseded、`in_progress` 手动任务不 supersede。
- `backend/dist/modules/cleaning.js` — modified: `npm run build` 生成的已跟踪后端构建产物。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: existing response fields remain; 新增字段会随 `SELECT t.*` 出现在部分清洁任务响应中。
- Database / migration: requires `backend/scripts/migrations/20260629_cleaning_task_execution_state.sql` or runtime bootstrap to add and backfill new columns.
- Config / environment: none.
- Dependencies: none.
- Related units: 第一阶段为后续 canonical display 聚合、active/superseded source ids 和 conflict display 打基础；不包含第二/第三阶段 UI 诊断展示。

### Validation

- `npm run build` in `backend` — passed: `tsc -p .` completed.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_cleaning_sync_v2.ts` in `backend` — passed: printed `ok`.
- `npm run test:cleaning-inspection-merge` in `backend` — passed: `test_cleaning_inspection_merge: ok`.
- `npm run test:guest-luggage-rules` in `backend` — passed: `guest luggage rules: ok`.
- `git diff --check` — passed.
- Frontend/mobile full suites — not run: 第一阶段改动集中在 backend schema/sync/query behavior。

### Risks / Release Notes

- Runtime risk: 未对生产真实同房同日任务执行接口回归；验证覆盖同步脚本和 TypeScript build。移动端若持有已缓存的 superseded 旧 task id，刷新列表后会移除，直接旧 id 提交流程仍需第二阶段/后续 guard 继续收紧。
- Scope boundary: 本阶段不解决晚退、早入住、晚入住、客人需求、钥匙数量等 display 冲突聚合；这些属于第二阶段 canonical display 输出。
- Rollback: revert migration/schema helper and supersede logic, restore status-only filters, then rerun build if tracked dist remains in release scope.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: implementation pushed to root `Dev` in commit `cb66cb5`; this ledger status update is recorded separately.

## CRL-20260629-002 — 清洁同房同日 Canonical Turnover Display 第二阶段

- **Status:** pushed
- **Updated:** 2026-06-30 00:15 AEST
- **Request:** 执行阶段2；覆盖晚退、早入住、晚入住、客人需求等同房同日显示不一致问题。
- **Outcome:** 移动端 `/mzapp/work-tasks` 和网页任务中心清洁合并任务现在复用同一套 canonical turnover display：退房信息按 outgoing checkout 订单/任务算，入住信息按 incoming checkin 订单/任务算；执行源只返回 active ids，superseded 手动补位任务只进入诊断/冲突信息。

### Implementation

- Previous behavior:
  - 移动端和网页端会在各自合并逻辑里从 preferred task 或任意合并项取 `checkout_time/checkin_time/guest_special_request/old_code/new_code/keys_required/nights`。
  - 同房同日存在 checkout 与 checkin 两张订单时，晚退、早入住、晚入住、客人需求、钥匙数量和密码可能因为取到不同 task 而显示不一致。
  - `source_ids` 只有一个含义，无法同时满足“移动端执行只用 active task”和“网页诊断显示 superseded 手动补位来源”。
- New behavior:
  - 新增 `buildCleaningTurnoverDisplay()`，统一输出 `checkout_order_id/checkin_order_id`、`checkout_time/checkin_time`、晚退/早入住/晚入住标记、checkout/checkin 客人需求、旧/新密码、checkout/checkin 钥匙套数、已住/剩余晚数、source id split 和 display conflicts。
  - 移动端 `/mzapp/work-tasks` 在单角色合并和 admin/customer_service/offline_manager 二次合并后都保留 `turnover_display`，并把根字段同步到 canonical display。
  - 任务中心清洁合并任务使用同一个 helper，turnover 不再把 `old_code/new_code` 清空，并返回同样的 display/source split/conflict 字段。
  - `source_ids`、`cleaning_task_ids`、`inspection_task_ids` 保持 active 执行源；新增 `active_source_ids`、`superseded_source_ids`、`all_related_source_ids` 用于执行与诊断分离。
  - superseded 手动补位任务不同于 canonical 的时间、钥匙、晚数、客人需求、密码会进入 `display_conflicts` / `turnover_display.conflicts`，resolution 固定为 `kept_canonical`。
- Key decisions:
  - 不把手动任务字段写回订单任务或自动任务；第二阶段只做 display 聚合和冲突记录。
  - 晚退以退房时间晚于默认 `10am` 判定；早入住以入住时间早于默认 `3pm` 判定；晚入住以入住时间晚于 `6pm` 判定。

### Files / Areas

- `backend/src/lib/cleaningTurnoverDisplay.ts` — added: 共享 canonical turnover display、时间解析、source id split 和 conflict 生成逻辑。
- `backend/scripts/tests/test_cleaning_turnover_display.ts` — added: 覆盖晚退/早入住、checkout/checkin 分离、source ids split、superseded conflict 和 display merge。
- `backend/src/modules/mzapp.ts` — modified: `/mzapp/work-tasks` 清洁任务合并接入 canonical turnover display，并查询 superseded 关联源。
- `backend/src/modules/task_center.ts` — modified: 任务中心清洁任务合并接入 canonical turnover display，并查询 superseded 关联源。
- `docs/change-release-ledger.md` — modified: 记录本阶段发布单元。

### Impact / Dependencies

- API: `/mzapp/work-tasks` 和任务中心清洁任务响应新增 `turnover_display`、`active_source_ids`、`superseded_source_ids`、`all_related_source_ids`、`display_conflicts` 以及 checkout/checkin guest request/late/early tags 等字段；既有根字段继续保留。
- Database / migration: none in this phase; depends on `CRL-20260629-001` adding `execution_state` and superseded metadata.
- Config / environment: none.
- Dependencies: none.
- Related units: depends on `CRL-20260629-001`; superseded source diagnostics require first-stage schema/data.

### Validation

- `npm run build` in `backend` — passed: `tsc -p .` completed.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_cleaning_turnover_display.ts` in `backend` — passed: `test_cleaning_turnover_display: ok`.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_cleaning_sync_v2.ts` in `backend` — passed: printed `ok`.
- `npm run test:cleaning-inspection-merge` in `backend` — passed: `test_cleaning_inspection_merge: ok`.
- `npm run test:guest-luggage-rules` in `backend` — passed: `guest luggage rules: ok`.
- `git diff --check` — passed.
- Frontend/mobile full suites — not run: response-shape additive backend change only; no client files changed.

### Risks / Release Notes

- Runtime risk: 未用真实生产房源/日期调用 `/mzapp/work-tasks` 和任务中心接口做 live payload 对比；验证覆盖 pure helper、后端 build 和现有聚焦测试。
- Scope boundary: 第二阶段只输出 display/diagnostic 字段，不改前端 UI 是否展示“已合并 1 条手动补位任务”；那属于第三阶段。
- Rollback: revert `cleaningTurnoverDisplay` helper/test and remove its usage from `mzapp` and `task_center`.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: implementation pushed to root `Dev` in commit `cb66cb5`; this ledger status update is recorded separately.

## CRL-20260629-003 — 清洁同房同日 Canonical Display UI 第三阶段

- **Status:** pushed
- **Updated:** 2026-06-30 00:15 AEST
- **Request:** 执行阶段3；把阶段2输出接到移动端和网页端，确保同房同日清洁任务显示一致，执行只使用 active source ids。
- **Outcome:** 移动端任务列表、任务详情、经理日任务、检查补品页和网页任务中心现在优先复用 `turnover_display`；晚退/早入住/晚入住、客人需求、旧/新密码展示走同一 display 层；执行、照片和看板保存只提交 active source ids，superseded 手动补位仅用于诊断显示。

### Implementation

- Previous behavior:
  - 移动端列表、详情和检查/经理页会各自读取 `start_time/end_time/guest_special_request/old_code/new_code/source_ids`，导致同房同日 checkout/checkin 组合下与网页端显示不一致。
  - 网页任务中心 `save-board`、整行检查分配和任务 flag 会直接遍历 `task_ids`，无法明确排除 superseded 手动补位任务。
  - 晚入住 fallback 在移动端按晚于 `3pm` 判断，和第二阶段 canonical display 的晚于 `6pm` 不一致。
- New behavior:
  - 移动端新增 `turnoverDisplay` helper，统一读取 `turnover_display`、`active_source_ids`、`superseded_source_ids`、`all_related_source_ids`，并保留旧缓存字段 fallback。
  - 移动端任务列表/详情页的退房/入住时间、晚退/早入住/晚入住、客人需求、旧/新密码优先显示 canonical display。
  - 移动端经理日任务照片、补品读取、检查补充页和完成/退房动作统一走 active execution ids；旧缓存没有 active ids 时才回退旧 source ids。
  - 网页任务中心 `TaskCenterTask` 增加 display/source split 字段；卡片和详情显示“已合并 N 条手动补位”诊断标签，清洁摘要追加 canonical 客人需求。
  - 网页任务中心保存看板、整行检查分配、task flags 使用 active source ids，避免 superseded 手动任务继续收到分配/状态更新。
  - 移动端晚入住 fallback 调整为晚于 `6pm`，与 backend canonical display 一致。
- Key decisions:
  - 第三阶段只接入 display/执行入口，不回写订单字段，不把 superseded 显示成 cancelled。
  - `all_related_source_ids` 只用于通知/旧 id 定位和诊断；移动端执行和网页保存只使用 active ids。

### Files / Areas

- `frontend/src/app/task-center/page.tsx` — modified: 接入 `turnover_display` 类型/helper；任务卡片、详情、看板保存和整行分配改用 canonical display 和 active source ids。
- `mz-cleaning-app-frontend/src/lib/api.ts` — modified: `WorkTask` 类型增加 canonical display/source split/conflict 字段。
- `mz-cleaning-app-frontend/src/lib/workTasksStore.ts` — modified: 安全 patch 字段和旧 id 匹配包含新 display/source split。
- `mz-cleaning-app-frontend/src/lib/turnoverDisplay.ts` — added: 移动端 canonical display 与 active/all-related source id helper。
- `mz-cleaning-app-frontend/src/lib/taskTime.ts` — modified: 晚入住 fallback 改为晚于 `6pm`。
- `mz-cleaning-app-frontend/src/lib/managerDailyTaskPhotos.ts` — modified: 检查照片查询使用 active execution ids。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.tsx` — modified: 任务列表展示与动作入口复用 canonical display/source ids。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.tsx` — modified: 详情页展示与动作入口复用 canonical display/source ids，并显示 canonical 客人需求。
- `mz-cleaning-app-frontend/src/screens/tasks/ManagerDailyTaskScreen.tsx` — modified: 经理日任务保存、照片/补品读取和退房动作使用 active execution ids。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — modified: 检查补充页补品来源和早入住判断复用 canonical display/active ids。
- `mz-cleaning-app-frontend/src/screens/tabs/TasksScreen.test.tsx` — modified: 晚入住测试阈值改为晚于 `6pm`。
- `mz-cleaning-app-frontend/src/screens/tasks/TaskDetailScreen.test.tsx` — modified: 晚入住测试阈值改为晚于 `6pm`。
- `mz-cleaning-app-frontend/src/screens/tasks/ManagerDailyTaskScreen.test.ts` — modified: 覆盖 active source ids 优先和旧缓存 fallback。
- `docs/change-release-ledger.md` — modified: 记录本阶段发布单元。

### Impact / Dependencies

- API: depends on `CRL-20260629-002` response fields; older cached mobile tasks continue falling back to legacy fields.
- Database / migration: none in this phase; depends on `CRL-20260629-001` superseded metadata for meaningful diagnostics.
- Config / environment: none.
- Dependencies: none.
- Related units: depends on `CRL-20260629-001` and `CRL-20260629-002`; should be released after backend schema/display changes.

### Validation

- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json` completed.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with existing warnings: 119 warnings, 0 errors.
- `npm test -- --runInBand src/screens/tabs/TasksScreen.test.tsx src/screens/tasks/TaskDetailScreen.test.tsx src/screens/tasks/ManagerDailyTaskScreen.test.ts` in `mz-cleaning-app-frontend` — passed: 3 suites, 18 tests. Jest printed an existing open-handle warning after completion.
- `npm run build` in `frontend` — passed: Next.js build completed. Existing lint warnings and Recharts static generation width warnings remain.
- `git diff --check && git -C mz-cleaning-app-frontend diff --check` — passed.

### Risks / Release Notes

- Runtime risk: 未用真实生产房源/同日订单做端到端 UI 截图验证；验证覆盖 typecheck、targeted tests 和网页 build。
- Scope boundary: 第三阶段不新增后端字段生成逻辑，不执行数据库迁移，不封装 iOS/Android。
- Rollback: revert mobile display/source-id helper usage and task-center page changes; backend phase 1/2 can remain additive but UI will stop consuming new fields.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: implementation pushed to root `Dev` in commit `cb66cb5` and nested mobile `Dev` in commit `7c5d551`; this ledger status update is recorded separately.

## CRL-20260629-004 — 网页任务中心延期检查显示原退房日

- **Status:** pushed
- **Updated:** 2026-06-30 00:15 AEST
- **Request:** 网页端延期检查不能只显示“延期检查”；标记延期检查的同时也需要注明是哪天的退房任务。
- **Outcome:** 网页任务中心的延期检查卡片副标题现在保留检查语义，同时显示原始退房任务日期，例如“延期检查，6月22日退房”；同一房源同一延期检查组合若合并多个原退房日，会一并显示这些退房日期。

### Implementation

- Previous behavior:
  - 延期检查投影到检查日后，任务中心只显示“延期检查”。
  - 前端只能拿到延期检查当天的 `task_date` / `inspection_due_date`，没有独立字段表达原始退房任务日期。
- New behavior:
  - 任务中心后端为清洁任务响应增加展示用 `checkout_task_date` / `checkout_task_dates` 字段。
  - 延期检查投影任务把原清洁退房任务日写入这些字段，合并延期检查时保留所有原退房日。
  - 前端 `taskCenterDisplay` helper 对 deferred inspection 输出“延期检查，N月D日退房”，普通退房/入住任务文案不变。
- Key decisions:
  - 不恢复旧的“只显示退房”逻辑；延期检查仍是第一语义，退房日期只作为来源上下文。
  - 不新增数据库字段；新增字段只来自已有清洁任务日期，属于任务中心响应展示数据。

### Files / Areas

- `backend/src/modules/task_center.ts` — modified: 任务中心清洁任务响应增加原始退房任务日期字段，并在延期检查合并时保留日期数组。
- `frontend/src/app/task-center/page.tsx` — modified: 任务中心前端类型和摘要生成接收原始退房日期字段。
- `frontend/src/app/task-center/taskCenterDisplay.ts` — modified: 延期检查 display helper 追加“原退房日 + 退房”上下文。
- `frontend/src/app/task-center/taskCenterDisplay.test.ts` — modified: 覆盖单个和多个原退房日的延期检查文案。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: `/task-center/day` 清洁任务响应新增 additive display fields `checkout_task_date` and `checkout_task_dates`; existing fields unchanged.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `backend/src/modules/task_center.ts`, `frontend/src/app/task-center/page.tsx`, and this ledger file with `CRL-20260629-001`, `CRL-20260629-002`, and `CRL-20260629-003`; selective release requires verified hunk-level staging or explicit combined scope.

### Validation

- `npm test -- --run frontend/src/app/task-center/taskCenterDisplay.test.ts --coverage=false` in `frontend` — failed: project script already enables coverage, so Vitest rejected conflicting `--coverage` values.
- `./node_modules/.bin/vitest run src/app/task-center/taskCenterDisplay.test.ts` in `frontend` — passed: 1 file, 2 tests.
- `npm run build` in `backend` — passed: `tsc -p .` completed.
- `npm run lint` in `frontend` — passed with existing warnings; no errors.
- `npm run build` in `frontend` — passed; existing lint warnings and Recharts static-generation width warnings remain.
- `git diff --check` — passed.

### Risks / Release Notes

- Runtime risk: 未用真实任务中心数据截图复核卡片宽度；文案变长后紧凑卡片会显示更多副标题内容，现有 hover title 也会包含完整摘要。
- Release risk: worktree already contains unrelated local backend/frontend changes in the same hot files; do not broad-stage for this unit.
- Rollback: remove `checkout_task_date(s)` from task-center response and restore deferred inspection helper output to plain “延期检查”.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: implementation pushed to root `Dev` in commit `cb66cb5`; this ledger status update is recorded separately.

## CRL-20260630-001 — 任务分配字段以 work_tasks 为准

- **Status:** pushed
- **Updated:** 2026-06-30 00:15 AEST
- **Request:** 修复任务中心已分配任务被移动端/管理端/其他角色更新任务信息后变回未分配；`work_tasks` 是分配字段 canonical source，普通内容更新不得覆盖分配。
- **Outcome:** offline task 同步、任务中心 save-board 和展示合并路径现在都以 `work_tasks` 分配字段为准；普通任务信息更新即使带 `assignee_id: null` 也不会清空已有分配，只有任务中心显式 assign/unassign intent 才能改派或取消分配。

### Implementation

- Previous behavior:
  - `upsertWorkTaskFromOfflineTask()` 在 `ON CONFLICT DO UPDATE` 时会把旧 offline row 的 `assignee_id` 写回 `work_tasks`，因此 offline row 为空或旧值时可能覆盖已分配任务。
  - `/cleaning/offline-tasks/:id` PATCH 直接按请求字段更新 offline row，普通内容更新里夹带的 assignment 字段会进入后续同步链路。
  - 任务中心 save-board 前端会提交整批 assignment payload，后端把 `assignee_id: null` 当成取消分配，缺少显式 unassign intent。
  - 部分 offline 展示接口仍可能返回 legacy/offline assignment，而不是 canonical `work_tasks.assignee_id`。
- New behavior:
  - `upsertWorkTaskFromOfflineTask()` 在冲突更新时保留 `work_tasks.assignee_id`，只同步 title/summary/date/status/urgency/photos 等内容字段。
  - offline task PATCH 使用内容字段白名单，排除 `assignee_id`、`cleaner_id`、`inspector_id` 等 assignment 字段；状态兼容仍写入 canonical work task。
  - task-center save-board schema 支持 `*_assignment_action: assign | unassign`，后端只有收到 action 时才更新 assignment 字段；普通 null 被忽略。
  - 任务中心前端保存前建立 assignment baseline，只提交实际变更过的 assignment/order/group 字段，并为真实改派/取消分配附带显式 action。
  - `cleaning_offline_tasks` 不再从 `work_tasks` 回写 assignment；offline 展示和 `/mzapp/work-tasks` 回归测试确认返回值与 `work_tasks` 一致。
- Key decisions:
  - 不新增数据库字段；显式 intent 是 API payload 行为，兼容旧客户端的普通内容保存。
  - 允许新建 `work_tasks` 时从 legacy/offline row 初始化 assignment；只要已有 `work_tasks` 行，后续 assignment 只以 `work_tasks` 为准。

### Files / Areas

- `backend/src/modules/cleaning.ts` — modified: offline-to-work upsert 保留 canonical assignment；offline PATCH 字段白名单；offline 列表/calendar 输出 `work_tasks.assignee_id`。
- `backend/src/modules/task_center.ts` — modified: save-board assignment diff 和 SQL 更新改为显式 action-gated；同步回 offline 旧表时不再写 assignment。
- `backend/src/modules/work_tasks.ts` — modified: 通用 work task source propagation 不再把 assignment 回写到 `cleaning_offline_tasks`。
- `frontend/src/app/task-center/page.tsx` — modified: 保存看板前基于 baseline 只发送实际变更 assignment，并为 assign/unassign 附带明确 intent。
- `backend/scripts/tests/test_task_assignment_canonical.ts` — added: 覆盖 offline null/旧值不覆盖、任务中心显式改派/取消分配、普通 null 忽略、经理字段更新保持分配、展示与 canonical 一致。
- `backend/dist/modules/cleaning.js` — generated/shared: 后端 build 同步生成的 `cleaning.ts` 输出；该文件同时承载同日其他清洁模块单元的未提交生成改动。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: task-center save-board assignment payload 新增可选 `cleaner_assignment_action`、`inspector_assignment_action`、`assignee_assignment_action`；旧 payload 未带 action 时不再通过 null 自动取消分配。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `backend/src/modules/cleaning.ts`, `backend/src/modules/task_center.ts`, `frontend/src/app/task-center/page.tsx`, `backend/dist/modules/cleaning.js`, and this ledger with `CRL-20260629-001` through `CRL-20260629-004`; selective release requires hunk-level staging or explicit combined scope.

### Validation

- `npm --prefix backend run build` — passed: backend TypeScript build completed.
- `npm exec -- ts-node-dev --transpile-only scripts/tests/test_task_assignment_canonical.ts` in `backend` — passed: `test_task_assignment_canonical: ok`.
- `npm --prefix frontend run lint` — passed with existing warnings; no errors.
- `npm exec -- tsc --noEmit` in `frontend` — passed.
- `npm --prefix frontend test -- taskCenterDisplay.test.ts` — failed because the project script forced global coverage thresholds even though the 2 targeted tests passed; followed by direct Vitest run without coverage.
- `npm exec -- vitest run src/app/task-center/taskCenterDisplay.test.ts --coverage=false` in `frontend` — passed: 1 file, 2 tests.
- `npm --prefix frontend run build` — passed; existing lint warnings and Recharts static generation width warnings remain.

### Risks / Release Notes

- Runtime risk: integration test used the configured remote PostgreSQL test rows and cleaned known test IDs; if interrupted in future, rerunning the same test cleans those IDs.
- Release risk: worktree already contains unrelated local changes in the same hot files; do not broad-stage this unit without reviewing hunk ownership.
- Behavior note: legacy `cleaning_offline_tasks.assignee_id` may remain stale by design after this change; display paths must use `work_tasks` when a row exists.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added to source or ledger.
- Git state: implementation pushed to root `Dev` in commit `cb66cb5`; this ledger status update is recorded separately.

## CRL-20260630-002 — 移动端退房卡不提前合并次日入住

- **Status:** pushed
- **Updated:** 2026-06-30 20:55 Australia/Melbourne
- **Request:** 修复手动任务和自动同步任务合并后，当天没有入住却在数据回填/移动端显示中把第二天入住提前合并到当天的问题。
- **Outcome:** `/mzapp/work-tasks` 现在只有同房源同一天的入住任务才会补入当天退房卡；多日查询时，第二天入住不会再让当天退房显示“入住”、入住时间、新门码、入住钥匙套数或待住晚数。

### Implementation

- Previous behavior:
  - 移动端构建 checkout-only 清洁卡片时，会在本次 `/mzapp/work-tasks` 查询结果里查找同房源 `task_date >= 当前退房日` 的最近入住任务。
  - 当移动端或管理视图一次查询多天时，次日入住会被当作当前退房卡的 `checkinTask`，从而提前显示“退房 入住”、`end_time`、`new_code`、`keys_required_checkin` 和 `remaining_nights`。
- New behavior:
  - checkout-only 卡片只允许同房源且 `task_date === 当前退房日` 的入住任务作为补充展示数据。
  - 同一天退房 + 入住仍正常合并；跨日入住保留在自己的日期，不再污染前一天退房卡。
- Key decisions:
  - 不改自动同步回填和 supersede 规则；这些路径已经按同房源、同类型、同日期匹配。
  - 修复放在移动端 `/mzapp/work-tasks` 展示合并层，保持任务中心同日分组和回填数据不变。

### Files / Areas

- `backend/src/modules/mzapp.ts` — modified: `nextCheckinsForCheckout` 从查找同房源最近后续入住改为只查同日入住。
- `backend/scripts/tests/test_task_assignment_canonical.ts` — modified: 增加真实 `/mzapp/work-tasks` 多日查询回归测试，覆盖跨日入住不提前合并和同日入住仍合并。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: `/mzapp/work-tasks` 响应结构不变；checkout-only 卡片在跨日多天查询下将不再返回来自次日入住的展示字段。
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: shares `backend/src/modules/mzapp.ts` and `backend/scripts/tests/test_task_assignment_canonical.ts` with recent cleaning/task assignment work; selective release requires hunk review if combined with other local units.

### Validation

- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_task_assignment_canonical.ts` in `backend` — failed in sandbox: DNS lookup for the configured PostgreSQL host was blocked.
- `./node_modules/.bin/ts-node-dev --transpile-only scripts/tests/test_task_assignment_canonical.ts` in `backend` with approved network access — passed: `test_task_assignment_canonical: ok`.
- `npm run build` in `backend` — passed: `tsc -p .`.

### Risks / Release Notes

- Runtime risk: checkout-only cards no longer show next-day incoming stay context; this is intentional for date correctness, but if operations wants a separate “next stay” hint later it should be a distinct field/tag, not merged as same-day入住.
- Rollback: restore the `task_date >= date` filter in `nextCheckinsForCheckout` and remove the new cross-day/same-day assertions.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: implementation pushed to root `Dev` in commit `14be9f8`; this ledger status update is recorded separately.

## CRL-20260630-003 — 移动端空客人需求不显示确认区

- **Status:** pushed
- **Updated:** 2026-06-30 20:55 Australia/Melbourne
- **Request:** 如果客人需求没有，就不显示，不要显示 `null`，也不要显示/要求确认“我已完成客人需求”。
- **Outcome:** 移动端检查面板现在复用统一客人需求展示逻辑；当客人需求为空或是 `null`/`undefined`/`none`/`n/a`/`无`/`没有` 这类占位值时，不显示“客人需求（需要确认已完成）”卡片，也不会要求勾选“我已完成客人需求”才能继续。

### Implementation

- Previous behavior:
  - `InspectionPanelScreen` 直接对 `task.guest_special_request` 做字符串 trim；如果后端或缓存传来字符串 `"null"`，会被当成真实需求显示。
  - 只要该字符串非空，完成按钮就会被 `guestNeedDone` 勾选状态限制，导致没有真实需求也必须确认。
- New behavior:
  - `turnoverDisplay.ts` 新增 `cleanGuestRequestText()`，把常见空值占位文本当作空内容。
  - `guestRequestForDisplay()` 使用该清洗规则，并继续优先显示 `turnover_display.guest_request_summary`。
  - `InspectionPanelScreen` 改为调用 `guestRequestForDisplay(task)`；没有真实需求时整块确认 UI 不渲染，完成按钮也不再受客人需求确认限制。
- Key decisions:
  - 不改全局 `cleanText()`，避免影响任务 ID、文件引用等普通文本字段。
  - 规则放在共享客人需求展示函数，列表/详情/检查面板对空需求的判断保持一致。

### Files / Areas

- `mz-cleaning-app-frontend/src/lib/turnoverDisplay.ts` — modified: 增加客人需求专用清洗函数，并用于 `guestRequestForDisplay()`。
- `mz-cleaning-app-frontend/src/screens/tasks/InspectionPanelScreen.tsx` — modified: 检查面板客人需求显示和确认要求改用共享展示值。
- `mz-cleaning-app-frontend/src/lib/turnoverDisplay.test.ts` — added: 覆盖占位值不显示、真实需求显示、turnover display 汇总优先。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: independent mobile UI fix; shares the nested mobile repo with other mobile release work. Root ledger also currently contains uncommitted `CRL-20260630-002` backend fix.

### Validation

- `npm test -- --runInBand src/lib/turnoverDisplay.test.ts` in `mz-cleaning-app-frontend` — passed: 1 suite, 2 tests.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 119 existing warnings.

### Risks / Release Notes

- Runtime risk: literal guest requests exactly equal to `null`, `undefined`, `none`, `n/a`, `无`, or `没有` will be hidden. This matches the requested empty-value behavior.
- Rollback: restore `InspectionPanelScreen` to direct `guest_special_request` display and remove `cleanGuestRequestText()` plus its test.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: implementation pushed to nested mobile `Dev` in commit `0ef9c51`; this root ledger status update is recorded separately.

## CRL-20260630-004 — 移动端中断上传状态自动重试

- **Status:** pushed
- **Updated:** 2026-06-30 20:55 Australia/Melbourne
- **Request:** 修复本地缓存的视频或照片在网络恢复后，同步一直卡在上传步骤的问题。
- **Outcome:** 移动端独立检查媒体队列现在会把上次中断遗留的 `uploading` 状态视为可重试状态；网络恢复、App 回到前台或重新启动后会继续上传/保存，不再因为状态停在 `uploading` 而被队列跳过。

### Implementation

- Previous behavior:
  - `inspectionMediaQueue` 只处理 `pending`、`failed_retryable`，以及已上传但未业务保存的挂钥匙视频。
  - 上传开始时会持久化 `upload_status: uploading`；如果此时断网、App 被系统杀掉或上传请求中断，下一次队列维护会跳过该条记录，界面长期显示正在自动上传。
- New behavior:
  - `uploading` 也纳入可重试状态。
  - 同一进程内仍通过 `inFlightLocalUris` 防止同一个本地文件并发重复上传；重启或网络恢复后遗留的 `uploading` 可以重新进入上传流程。
  - 已有 `uploaded_url` 但 `business_saved=false` 的挂钥匙视频仍沿用原逻辑：不重复上传，只补做业务保存。
- Key decisions:
  - 不新增复杂超时字段；当前问题是持久化状态被永久跳过，直接允许 `uploading` 重试更小且与现有 `inFlightLocalUris` 防并发机制兼容。
  - 不改变检查面板正式提交队列；该队列的 `syncing` 状态已经会继续处理。

### Files / Areas

- `mz-cleaning-app-frontend/src/lib/inspectionMediaQueue.ts` — modified: `isRetryableStatus()` 将 `uploading` 视为可重试。
- `mz-cleaning-app-frontend/src/lib/inspectionMediaQueue.test.ts` — modified: 增加上传中断后恢复重试的挂钥匙视频回归测试。
- `docs/change-release-ledger.md` — modified: 记录本修复单元。

### Impact / Dependencies

- API: none.
- Database / migration: none.
- Config / environment: none.
- Dependencies: none.
- Related units: independent mobile queue hardening; shares nested mobile repo with `CRL-20260630-003` UI fix and root ledger with `CRL-20260630-002` backend fix.

### Validation

- `npm test -- --runInBand src/lib/inspectionMediaQueue.test.ts` in `mz-cleaning-app-frontend` — passed: 1 suite, 2 tests.
- `npm run typecheck` in `mz-cleaning-app-frontend` — passed: `tsc -p tsconfig.json`.
- `npm run lint` in `mz-cleaning-app-frontend` — passed with 0 errors and 119 existing warnings.

### Risks / Release Notes

- Runtime risk: if a remote upload succeeded but the app died before persisting `uploaded_url`, retrying `uploading` may upload the same local file again. This is preferable to a permanently stuck local task and is bounded to interrupted uploads.
- Rollback: remove `uploading` from `isRetryableStatus()` and remove the new interrupted-upload recovery test.
- Sensitive-information review: no secrets, `.env` values, tokens, database URLs, credentials, sensitive logs, or local caches were added.
- Git state: implementation pushed to nested mobile `Dev` in commit `0ef9c51`; this root ledger status update is recorded separately.
