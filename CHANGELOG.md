# Changelog

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
