# Changelog

## Dev (2026-03-04)

- Version: `0.2.7-statement-pdf.20260304+build.3`
- Finance PDF: Fix merge download “no photos” statement swallowing expenses — deep-clean owner costs are counted even when deep/maint sections are not rendered.
- Finance PDF: When photos are split into separate PDFs, main report exports base statement only (no job record pages).
- Finance PDF: Photo-only PDFs (deep cleaning / maintenance) now split photos into Before/After groups, use the correct section title style, and paginate cleanly.
- Finance PDF: Fix photo-only PDFs rendering blank pages/images — improve Playwright image waiting (eager + scroll + fallback-aware) and make photo URL normalization more robust (relative paths + object arrays).
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
