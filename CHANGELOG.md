# Changelog

## Dev (2026-03-25)

- Version: (no bump)
- Cleaning App: Saved avatar now renders on Home header and Contacts list/detail.
- Cleaning App: Inspector notifications now use banner + Tab red dot, dedupe by stable ids, and exclude generic “系统通知”.
- Cleaning App (Inspector): Add “检查与补充” panel (restock proof + inspection photos) and a separate “标记已完成” page for lockbox video + completion; inspection tasks on Home show 3 quick buttons.
- Cleaning App (Inspector): Fix restock-proof / inspection-photos submissions by routing to `/cleaning-app/tasks/:id/*`; re-order steps and allow multi photos per area (toilet 3, living 1, sofa 2, bedroom 4, kitchen 2); adjust spacing and button heights; increase upload compression quality.
- Cleaning App: Notices list/detail render photo thumbnails and full preview instead of showing photo URLs.
- Cleaning App: Add in-app photo zoom for supplies reporting and loading states for key/restock/supplies uploads.
- Cleaning App (Inspector): Tap inspection tasks to open “检查与补充” directly; restock photos show inline thumbnails; “无需补充” no longer requires a photo; auto-collapse to next step after submit/save.
- Cleaning App (Inspector): Expand room photo limits (toilet 9, living 3, bedroom 8).
- Backend: Relax restock proof schema to allow “unavailable” without photo (stores placeholder url).
- MZApp Backend: For customer_service/admin/offline_manager (view=all), merge same-property same-day checkin+checkout tasks into one card to avoid duplicates.
- Cleaning App (Manager): Add “每日清洁” manager detail screen; customer_service can edit times/codes/guest note; admin/customer_service/offline_manager can view inspection issue + room photos.
- MZApp Backend: Add `PATCH /mzapp/cleaning-tasks/manager-fields`, add `cleaning_tasks.guest_special_request`, and include cleaning/inspection status + ids in merged work-tasks.
- Cleaning App: Remove task card quick-action buttons on Tasks home for inspectors.
- Cleaning App (Manager): Move “房源问题反馈” below “保存修改”; rename “媒体” to “钥匙与挂钥匙视频” with clearer empty state.
- Cleaning App (Manager): Hide “清洁问题照片” for customer_service; only admin/offline_manager can view.
- Cleaning App: Show inspection-only tasks as “待检查” instead of “待处理”.
- Cleaning App (Customer Service): Add “标记已退房/取消已退房” in manager task page.
- Cleaning App: Generate notices on refresh for check-out and manager field updates.
- Cleaning App/Backend: Manager task edit now supports POST fallback when PATCH is unavailable.
- Cleaning App (Manager): Show “标记已退房/房源问题反馈” under each cleaning/inspection task card on home.
- Cleaning App: Show guest special request on task cards for all roles and include full details in notices.
- Cleaning App (Inspector): Restore Home quick buttons and require confirming guest special request before completion.
- Cleaning App: Request notification permission after login (expo-notifications).
- Cleaning App/Backend: Add Expo Push token register + send push on checkout/manager updates.
- Cleaning App/Backend: Push notifications now also fire on key upload, inspection photos, restock proof, ready, issues, and work task updates; push messages are mirrored into 信息中心.
- MZApp Backend: Fix manager task list duplicates by merging same property/day regardless of time and id/code mismatches.
- Cleaning App: Deduplicate manager Home tasks client-side as a fallback for old backend.
- MZApp Backend: Add `GET/POST /mzapp/cleaning-tasks/:id/inspection-photos` and `GET/POST /mzapp/cleaning-tasks/:id/restock-proof`; extend `cleaning_task_media` with `note` and task+type index.

## Dev (2026-03-24)

- Version: `0.2.7-statement-pdf.20260324+build.5`
- MZApp: `GET/POST /mzapp/property-feedbacks` supports mobile “问题反馈” and lists existing pending Maintenance/Deep Cleaning by property_id/property_code (joins properties and falls back to repair_orders), reducing duplicate submissions.
- Cleaning App: `POST /cleaning-app/upload` watermark overlay supports bottom-right white text (with fallback lines when watermark_text missing).
- DB: Add migration `20260324_property_maintenance_add_area.sql` (optional `property_maintenance.area`).
- Maintenance records: Normalize `photo_urls` / `repair_photo_urls` payloads (accept jsonb-string/array) to prevent photo URLs from failing to persist; public maintenance-share page now parses jsonb-string on load.
- Cleaning App: Watermark baseline padding adjusted to avoid text clipping on image bottom edge.
- MZApp: Property feedback create generates and persists `work_no` for maintenance/deep cleaning.

## Dev (2026-03-23)

- Version: `0.2.7-statement-pdf.20260316+build.7`
- RBAC Users: Add AU phone field (phone_au) for create/edit and make email optional.
- Auth: Fix “Forgot password” flow by implementing SMTP reset email + `/reset-password` page.
- Cleaning: Sync checkout/checkin task passwords from order guest phone (last 4 digits) and update when phone changes.
- CMS: Add Company Content Center (`/cms/company`) with Announcements / Docs / Warehouse Guides and blocks editor (text/steps/images/video links) + preview modal aligned to new UI.
- CMS Passwords: Add external access password management (view/reset/clear) and internal secret vault (encrypted with CMS_SECRET_KEY) with audit logs.
- MZApp: Add alerts table + APIs and key-upload SLA checks (with related migrations).
- DB/Schema: Update `cms_pages` columns/indexes; add `password_resets`, `company_secret_items`, `company_secret_access_logs`; add `users.phone_au`.
- Cleaning: Cleaning sync jobs UI defaults to all and shows job run history; scheduled runs now record `job_runs`.
- Cleaning: Add migrations to fix cleaning sync schema (v2) and ensure `audit_logs` exists.
- Audits: Enhance `/audits` to return items + actor info and add unified “操作记录” panel in multiple detail views.

## Dev (2026-03-19)

- Version: `0.2.7-statement-pdf.20260316+build.6` (no bump)
- Task Center: Introduce unified work-task view for pending Offline / Maintenance / Deep Cleaning items (no longer loads all maintenance records).
- Task Center: Show task status chips for Maintenance/Deep Cleaning; render task content as plain text (extract `content` from JSON); make work order id non-bold.
- Task Center: Fix staff column expand/scroll overlap and improve board scrolling behavior.
- Task Center: Fix “unlock day” hanging loading; add request timeout and reduce backend lock/unlock latency.
- Backend: Add `work_tasks` indexing table and APIs (`GET /task-center/day`, `POST/PATCH /work-tasks`); keep only pending maintenance/deep-cleaning in `work_tasks` and remove on done/cancel.
- Ops: Add migration `20260319_create_work_tasks.sql` (create `work_tasks` + indexes + backfill).
- Orders: Fix false-positive time conflict by excluding cancelled/void/invalid orders from overlap checks and using timezone-safe day-level range comparison.
- Orders UI: Add saving/loading feedback and disable close/repeat submits while creating a new order (incl. “继续创建（覆盖）”).

Author: MZ System Bot <dev@mzpropertygroup.com>

## Dev (2026-03-18)

- Version: `0.2.7-statement-pdf.20260316+build.6` (no bump)
- Task Center: Remove standalone “offline” view; merge offline tasks into Cleaning/Inspection pools and add “其他” filter for offline items.
- Task Center: Improve scheduling UX — sticky scrollable left pool, compact two-line task cards, drag grip hints, and clearer drop targets.
- Task Center: Switch staff board to responsive grid with vertical scan; add staff filters (all/busy/idle), staff search jump, and preview/expand/collapse states.
- Cleaning: Fix manual cleaning task creation (stayover) — no checkin time or passwords required; ensure manual tasks are assignable.
- Offline tasks: Fix create 400 by providing required fields; allow date selection on create and keep newly created tasks visible on the chosen day.
- Maintenance records: Fee settlement UI aligned to new layout; show total amount (incl. parts/GST) in list, edit form, and details view; improve save UX with progress feedback.
- Backend: Reduce maintenance save latency by caching schema-ensure work in-process (avoid repeated ALTER TABLE / schema checks per request).

Author: MZ System Bot <dev@mzpropertygroup.com>

## Dev (2026-03-17)

- Version: `0.2.7-statement-pdf.20260316+build.6` (no bump)
- Cleaning: Add scheduled cleaning backfill runner (fast/slow schedules) with owner+heartbeat lock renew/release, and timezone-based window calculation.
- Cleaning: Add external trigger `POST /jobs/cleaning-backfill/cron-trigger` (cron token or permission) protected by the same lock.
- Cleaning: Add job run history (`job_runs`) and system-tasks UI page for cleaning backfill.
- Ops: Add migrations `20260317_create_job_locks.sql`, `20260317_job_locks_heartbeat.sql`, and `20260317_create_job_runs.sql`.

Author: MZ System Bot <dev@mzpropertygroup.com>

## Dev (2026-03-16)

## Dev (2026-03-24)

- Version: `0.2.7-statement-pdf.20260324+build.2`
- MZApp: Add property feedback APIs (`GET/POST /mzapp/property-feedbacks`) to unify mobile “问题反馈” and to list existing pending Maintenance/Deep Cleaning by property_id/property_code, reducing duplicate submissions.
- Cleaning App: Add optional bottom-right watermark support for uploads (`POST /cleaning-app/upload`) via form fields (e.g., `purpose=key_photo`, `watermark_text`).
- DB: Add migration `20260324_property_maintenance_add_area.sql` (optional area field for maintenance records).

Author: MZ System Bot <dev@mzpropertygroup.com>

- Version: `0.2.7-statement-pdf.20260316+build.6`
- Finance PDF: Fix monthly statement exports showing only 1 job photo when photosMode=thumbnail (applies to both print-based monthly statement PDF and template photo-only PDFs).
- Finance PDF: In thumbnail mode, use `/public/r2-image` compression (w/q) to keep large photo months stable and smaller (avoid requesting non-existent `.thumb.jpg` keys that can 404).
- Finance PDF: When photo count is too high, merge download generates base (no-photos) statement and relies on photo split PDFs to avoid Playwright timeouts.
- Finance PDF: Monthly statement PDF generation now waits for root + data-loaded markers and reports clearer timeout diagnostics (no longer hard-blocked by monthly-statement-ready).
- Finance PDF: When photo count is too high, merge download generates base (no-photos) statement and relies on photo split PDFs to avoid Playwright timeouts.
- Finance PDF: Monthly statement PDF generation now waits for root + data-loaded markers and reports clearer timeout diagnostics (no longer hard-blocked by monthly-statement-ready).
- Finance PDF: Add persistent merge job APIs (`POST/GET /finance/merge-monthly-pack`) and a DB-backed worker to generate merged outputs asynchronously, avoiding 502/504 for huge months.
- Finance UI: Switch monthly “merge download” to job polling + direct R2 download (no statement re-upload).
- Finance PDF: Web process also schedules pdf-jobs (DB-backed) for single-service deployments; photo stats are shown again during merge.
- Finance recurring: Fix fixed-expenses page ensure-snapshot connection timeouts by limiting frontend concurrency and reducing backend DB load (avoid PG pool exhaustion).
- Finance PDF: Fix merge download stuck in queued by triggering job processing during status polling and returning kick diagnostics.
- Finance PDF: Fix “no-photos” statement PDF showing 0 totals by waiting monthly-statement-ready before printing (applies to merge job statement_base and /finance/monthly-statement-pdf).
- Ops: Add migration `20260316_create_pdf_jobs.sql` and Render worker entries for pdf-jobs.
- Finance recurring: Add Referral fee as recurring payment mode (percent of previous month property total income; locked on the 5th) with backend-calculated snapshots and a new ensure endpoint; includes DB migration `20260316_recurring_referral_fee.sql`.

Author: MZ System Bot <dev@mzpropertygroup.com>

## Dev (2026-03-04)

- Version: `0.2.7-statement-pdf.20260304+build.3`
- Finance PDF: Fix merge download “no photos” statement swallowing expenses — deep-clean owner costs are counted even when deep/maint sections are not rendered.
- Finance PDF: When photos are split into separate PDFs, main report exports base statement only (no job record pages).
- Finance PDF: Photo-only PDFs (deep cleaning / maintenance) now split photos into Before/After groups, use the correct section title style, and paginate cleanly.
- Finance PDF: Fix photo-only PDFs rendering blank pages/images — improve Playwright image waiting (eager + scroll + fallback-aware) and make photo URL normalization more robust (relative paths + object arrays).
- Finance PDF: Fix photo-only PDFs returning tiny blank PDFs when `occurred_at` is missing (fallback to completed/started/created dates) and add request-level debug headers/metrics for production verification.
- Finance PDF: Align photo section title bar layout (main title + phase) and match print page header sizing.

Author: MZ System Bot <dev@mzpropertygroup.com>

## Dev (2026-03-03)

- Version: `0.2.7-statement-pdf.20260303+build.7`
- Invoice PDF: Remove country line (e.g., Australia) from the header address and render the company address as a single line.
- Invoice PDF: Fix pagination margins by printing the top-level invoice-print page and forcing A4 + 20mm Playwright margins (preferCSSPageSize=false).
- Invoice PDF: Render invoice-print without iframe to prevent footer blocks (e.g., Payment Instructions) from being clipped.
- Finance: Add region filter to the Property Revenue (房源营收) page.
- Finance PDF: Split download polish — main “no photos” PDF uses base sections only; module PDFs hide the MONTHLY STATEMENT header for manual merging.
- Finance PDF: Add compressed photo mode (JPEG resize/quality) to keep all photos but reduce PDF size for merging.
- Finance recurring: Respect frequency_months; only generate fixed-expense snapshots on due months (e.g., quarterly), preventing monthly over-deduction in Property Revenue.
- DB: Add a production-safe cleanup migration to remove future non-due recurring snapshots: `20260303_recurring_frequency_months_cleanup_future.sql`.
- Orders: Add `stay_type` (guest/owner) to mark landlord self-stays for reporting.
- Finance: Exclude landlord self-stay nights from occupancy rate and daily-average metrics (available-days denominator).
- DB: Add migration `20260303_orders_stay_type.sql` and provide manual backfill script for historical self-stays.
- Finance PDF: Fix merge/download failures caused by Playwright waiting for monthly-statement ready forever — add request timeouts + safe fallback on print rendering, plus backend timeout diagnostics.
- Finance PDF: Add per-attachment fetch timeout in `/finance/merge-pdf` to avoid hanging on slow invoice URLs.
- Finance PDF: Refactor `/finance/monthly-statement-pdf` to enterprise template rendering (Playwright `setContent`), remove frontend ready dependency, cap image waiting to 20s, direct-link R2 images, deep-cleaning photo pagination, and auto-thumbnail downgrade when too many photos.
- Finance: Fix “preview shows expenses but exported PDF misses deductions” by unifying statement tx mapping, adding occurred-at fallback (paid/due/month_key/created_at), and normalizing property_code matching; add unit tests.
- Finance PDF: Restore “full statement” download to match preview by rendering `/public/monthly-statement-print`; keep a separate `/finance/monthly-statement-photos-pdf` for photo-only exports (maintenance/deep-cleaning).
- Finance PDF: Fix “合并PDF下载”与弹窗预览不一致：同步孤儿快照排除开关到下载链路，并让预览/导出预览/合并下载共享同一套照片模式与拆分提示（照片分卷命名更清晰）。

Author: MZ System Bot <dev@mzpropertygroup.com>

## Dev (2026-03-02)

- Version: `0.2.7-statement-pdf.20260302+build.1`
- Finance recurring: Fix duplicate fixed-expense snapshots triggered by pause/resume; introduce dedicated `POST /recurring/payments/:id/pause` and `POST /recurring/payments/:id/resume` with transaction-level locking and idempotent snapshot ensure.
- Finance recurring UI: Switch Pause/Resume buttons to the new endpoints and suppress the auto-snapshot effect right after toggles to avoid repeated inserts on refresh/re-focus.
- DB: Add a production-safe dedup + unique index migration with transaction + backup tables + post-check queries: `20260302_recurring_fixed_expense_month_unique_safe.sql` (fixed_expense_id + month_key).
- Safety: Deprecate using `DELETE /crud/recurring_payments/:id` as “pause” (now returns 405 and points to the pause endpoint); keep `purge=1` for actual delete.
- Finance PDF: Add global concurrency limiter for `/finance/monthly-statement-pdf` and `/finance/merge-pdf` (queue + 429 when busy) to reduce OOM risk.
- Finance PDF: Harden Playwright rendering — short-lived context/page, container-friendly Chromium args, and strict timeouts to avoid hangs.
- Finance PDF: Only retry once for “browser/context/target closed” class errors (reset browser cache and retry).
- Finance PDF: Preview renders in the same mode as download (no toggle), and download/preview share a single statement tx mapping layer.
- Finance PDF: Only include maintenance/deep-cleaning photos when status is completed or reviewed approved.
- Finance PDF: Normalize typography (Times New Roman for Latin, PingFang SC for CJK) and bolden section headers/photo labels.
- Finance PDF: Reduce calendar page splitting by compact layout + dynamic zoom to fit the remaining page.
- Finance PDF: When photos are too many, auto-split download — merged statement excludes photos and provides separate Maintenance/Deep Cleaning photo PDFs.

Author: MZ System Bot <dev@mzpropertygroup.com>

## Dev (2026-03-01)

- Finance recurring: Fix pause/resume lifecycle — pause keeps current-month paid records in revenue, removes current-month unpaid + future snapshots; prevent duplicate charges and add fixed_expense_id+month_key unique guard migration.
- Finance: Add backend Dockerfile for Render Docker deployment (Playwright base image) to ensure monthly statement PDF generation/merge has working Chromium.
- Finance: Align Playwright Docker image version to backend lockfile and add /health/playwright + browsers-path fallback for easier diagnosis.
- Auth: Add token-protected /internal/bootstrap-admin to create/reset admin password when login is unavailable.
- Finance recurring UI: Keep paused status stable across refresh; add “已停用/恢复”; “已付” no confirm, “取消已付” requires double confirm; speed up first load.
- Dashboard: Reduce “multi-refresh” on login by deduping permission preload and initial data loads; add loading skeleton and improve responsiveness for platform share donut chart.

Author: MZ System Bot <dev@mzpropertygroup.com>

## Dev (2026-02-27)

- Maintenance: Fix missing “after-repair” photos by persisting `repair_photo_urls` on create and adding a safe fallback parser on record view/edit.
- Maintenance: Make “completed date” reflect the selected date (write to `completed_at` for internal progress + public submit) and prevent edit-save from overwriting it; show completion date on mobile/detail view.
- Deep cleaning: Align list/overview date display and filtering to `completed_at` (matches edit drawer).

Author: MZ System Bot <dev@mzpropertygroup.com>

## Dev (2026-02-25)

- Cleaning: Auto-sync daily task status in backend updates — when both cleaner + inspector are set → `assigned`, otherwise → `pending` (applies to single update and bulk patch).
- Cleaning UI: Fix quick-assign state sync so choosing cleaner+inspector immediately reflects `assigned` (supports merged tasks via `entity_ids`).
- Orders: Ensure any order create/update/delete reliably triggers cleaning task sync (remove duplicate PATCH route, fix PG transaction consistency, and prevent accidental delete-sync on missing orders).
- Tests: Add end-to-end script to verify order changes propagate to cleaning tasks.
- Tests: Add integration script to validate the auto status transitions.

Author: MZ System Bot <dev@mzpropertygroup.com>

## Dev (2026-02-21)

- Git: Strongly isolate `MZStay_app/` (ignore and prevent commit/push to any branch).
- Orders: Fix calendar date shifting (displayed day -1) by using day-only parsing (no timezone conversion) and add TZ/DST unit tests.
- Cleaning: Fix schedule duplication caused by invalid `property_id` suffix (`<uuid>true/false`) and cancel orphan tasks when orders are removed.
- Cleaning: Enforce color rule — unassigned tasks always use Ant Design blue `#1890ff`; other colors only after assignment; add unit tests.
- Cleaning: Implement daily task card UI header summary (region + code + checkout/checkin time), nights badge, loading skeleton, and empty state.
- Backend: Extend `/cleaning/calendar-range` to return `property_region`, `nights`, and summary fields; add interface documentation and audit scripts.
- UI QA: Add pixel-diff scripts and reports for cleaning overview and daily task card rendering.

Author: MZ System Bot <dev@mzpropertygroup.com>

## Dev (2026-02-11)

- Cleaning: Add “清洁总览” submenu and page under “清洁安排”.
- Cleaning overview: Show today check-in/out counts with platform breakdown (Airbnb/Booking/Direct/Other) and drill-down to order detail.
- Cleaning overview: Move “未来7天入住/退房趋势” to cleaning overview (bar chart) and highlight peak-pressure date.
- Cleaning: Add offline task list (status + urgency) with create/update support.
- Backend: Add `GET /stats/cleaning-overview` and cleaning offline task APIs.
- Fix: Allow cleaning roles to access `GET /stats/cleaning-overview` without `order.view` (prevents empty overview due to RBAC).
- Fix: Make `/stats/cleaning-overview` compatible when `orders.checkin/checkout` are stored as text/timestamp (cast via substring to date to avoid SQL type errors).
- Tests: Add unit tests + coverage gate for cleaning overview utilities.

Author: MZ System Bot <dev@mzpropertygroup.com>

## Dev (2026-02-15)

- Property guides: Redesign “复制” as template copy flow (room cleared, must re-select within same building).
- Property guides: Add copy trace fields (copied_from_id/copied_at/copied_by) and base_version/building_key for grouping and validation.
- Property guides: Add idempotent uniqueness guard on assign (advisory lock + server-side duplicate check) and building usage API for fast client-side validation.
- Property guides: Add delete action for draft/archived guides (published requires archive first).
- Tests: Add unit tests for guide copy/version/building validation helpers with coverage ≥90%.

Author: MZ System Bot <dev@mzpropertygroup.com>

## Dev (2026-02-10)

- Guides editor: Restore Steps block title editing (block title shown on public page), and fix Steps step-title inputs losing focus due to drag handlers.
- Guides editor: Add validation + inline hints for step titles (1–80 chars, no line breaks) and block invalid saves.
- Public guide: Fix mobile password input zoom; add per-route viewport config and smooth focus zoom-in/out without layout shift (iOS/Android).
- Public guide: Keep initial “Contents” page, enable continuous scroll across all chapters, and add sticky side TOC with active highlight + smooth jump.
- Public guide: Refine sticky TOC overlay (alpha/blur/hover/focus transitions), hide sticky TOC on catalog area, and reduce scroll jank (overflow-anchor/scrollbar-gutter).
- Guide links: Add auto-sync service to write latest active public guide URL into properties.access_guide_link (realtime on link creation + batch/manual sync), with logs, consistency checks, and optional webhook failure alerts.

Author: MZ System Bot <dev@mzpropertygroup.com>

## Dev (2026-02-09)

- Guides editor: Fix section block dragging (independent select/drag, cross-section drop), add clearer drop indicator + drag ghost, and add bottom “新增章节” button.
- Guides content: Remove “Wi‑Fi” as a section block type (keeps header Wi‑Fi card via meta fields).
- Guides versioning: Allow editing published guides; add revision auto-increment and revision history storage with list endpoint.
- Public guide: Add chapter contents directory with click-to-jump.

Author: MZ System Bot <dev@mzpropertygroup.com>

## Dev (2026-02-08)

- Properties: Add “入住指南” with per-property versioned content (sections + blocks JSON), draft/published/archived.
- Public link: Generate external URL /guide/p/{token} with fixed 4–6 digit password, HttpOnly session (<=12h and <=expires_at), and one-click revoke.
- SEO/Security: Public guide page sets noindex; backend checks token active and expiry on every content access.

Author: MZ System Bot <dev@mzpropertygroup.com>

## v0.2.7-invoice-types.20260207+build.2 (2026-02-07)

- R2: Fix production uploads by enabling S3 path-style requests (forcePathStyle) to support Cloudflare R2 bucket addressing.
- Versions: frontend 0.2.7-invoice-types.20260207+build.2, backend 0.2.7-invoice-types.20260207+build.2.

Author: MZ System Bot <dev@mzpropertygroup.com>

## v0.2.7-invoice-types.20260207+build.3 (2026-02-07)

- Invoice settings: Fix company logo upload by correctly sending the picked file from AntD Upload (originFileObj).
- Versions: frontend 0.2.7-invoice-types.20260207+build.3, backend 0.2.7-invoice-types.20260207+build.3.

Author: MZ System Bot <dev@mzpropertygroup.com>

## v0.2.7-invoice-types.20260207+build.1 (2026-02-07)

- Invoice center: Add Quote/Invoice/Receipt types with permissions (invoice.type.switch).
- Numbering: company code + INV/QT/REC + YYYY + 4-digit sequence; Receipt number auto-generated on mark-paid/issue.
- Receipt workflow: keep line items, hide GST; show PAID after Save/Submit (not on select).
- Templates: type-aware preview/print; Receipt/Quote hide payment info; remove signature section.
- List UX: records actions use pill buttons (View/Edit/Delete=void) aligned with Properties UI.
- PDF export: fix layout distortion, email wrapping, and extra blank page.
- Versions: frontend 0.2.7-invoice-types.20260207+build.1, backend 0.2.7-invoice-types.20260207+build.1.

Author: MZ System Bot <dev@mzpropertygroup.com>
Commit: b267683

## Dev (2026-01-16)

- Email sync
  - Enforce 50-mail hard cap across all triggers (manual/preview/schedule)
  - Skip non-order mails early with `reason=not_whitelisted` (no raw/orders writes)
  - Add cancellation ingestion: write `order_cancellations` (unique by confirmation_code), update matching order `status=cancelled`
  - Fix: prevent empty string writes to `orders.checkin/checkout` (use null when missing)
  - Failures list API now excludes rows already inserted to orders
- UI
  - Fix login and reports logo path to `/mz-logo.png`
  - Orders page: manual sync button, and improved failure handling views
- Schema
  - Add `order_cancellations` table to `schema_neon.sql` and runtime ensure
- Build
  - Remove invalid import `pgDeleteByUrl` from notifications module

Commit: 81b6e30

## v0.2.1 (2025-12-21)

- Orders: Implement order-level internal deductions (Admin/Finance/CS only), with audit logging.
- Landlord view: Simplified statements showing visible_net_income only; hide expenses/adjustments for landlords.
- Derived fields: internal_deduction_total and visible_net_income returned from order list/detail queries.
- Splitting: Attribute internal deductions to checkout month; add segment-level visible_net_income.
- UI/UX:
  - Orders list uses a right-side drawer for “查看”，adds payment currency and received status; inline “确认到账” without reordering.
  - Add a red “扣减” tag for orders with deductions.
  - Edit dialog supports recording deduction as “事项描述 + 备注”。
- Payment flags: Add `payment_received` (boolean) and `payment_currency` (text, default AUD) to orders; backend confirm-payment endpoint.
- Reporting:
  - MonthlyStatement aggregates visible_net_income; hides other income and expense sections in landlord simple view.
  - Performance overview and property revenue pages compute rent income using visible_net_income.
  - Fix: Cleaning fee attribution for checkout on first day of next month counts in previous month.
- Build fixes: Remove stray lib/debug import; clean up legacy cleaning task references.

Main tag: `v0.2.1` → commit 99be83b
Dev tag: `v0.2.1-dev` → commit bfe5ce9
