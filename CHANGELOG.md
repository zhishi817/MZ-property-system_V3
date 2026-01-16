# Changelog

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
