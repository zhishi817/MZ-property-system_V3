# Backend Route Patterns

## `/crud`

- Purpose: generic resource CRUD over a controlled allowlist in `backend/src/modules/crud.ts`
- Typical shape: `GET /:resource`, `GET /:resource/:id`, `POST /:resource`, `PATCH /:resource/:id`, `DELETE /:resource/:id`
- Best for: table-like resources and generic admin editing
- Caveat: being on the allowlist does not mean all meaningful business actions live here
- Common exceptions: uploads, PDFs, reviews, import flows, share links, public links, finance helpers

## `/properties`

- Purpose: property master data
- Standard CRUD: yes
- Key subflows: onboarding and guides are separate modules, not nested route implementations here
- Do not misread property management as only one table; many downstream modules attach to property IDs

## `/landlords`

- Purpose: landlord master data and management fee rules
- Standard CRUD: yes for landlord rows
- Subresources: `/management-fee-rules`
- Special actions: fee rule editing is a first-class nested resource
- Do not collapse rules into plain landlord patch payloads

## `/orders`

- Purpose: booking/order operations and reconciliation
- Standard CRUD: partially; read/update/delete exist, but creation is workflow-heavy
- Subresources: internal deductions
- Special actions: sync, import, import resolve, validate duplicate, cleaning sync retry, confirm payment, unconfirm payment
- Do not assume `POST /crud/orders` is the primary creation path

## `/inventory`

- Purpose: inventory catalog, stock movement, purchasing, linen operations
- Standard CRUD: mixed; some resources are full CRUD, some are read/create/update only, some are workflow-only
- Key subresources/domains: warehouses, linen types, room types, room-type requirements, items, stocks, movements, transfers, suppliers, supplier item prices, region rules, purchase orders, purchase-order lines, deliveries, stock change requests, linen reserve policies, linen delivery plans, return intakes, supplier return batches, supplier refunds
- Special actions: transfers, room-type transfers, delivery receipt, export, reserve policies, dashboard flows, returns/refunds
- Caveat: frontend currently contains warehouse create/update calls, but the backend route file presently exposes only `GET /inventory/warehouses`; verify actual server support before changing warehouse flows
- Do not assume every inventory entity has delete support

## `/onboarding`

- Purpose: property onboarding workflow and preset pricing tables
- Standard CRUD: yes for onboarding record, prices, items, fees; attachments are upload/delete oriented
- Subresources: `daily-items-prices`, `fa-items-prices`, `:id/items`, `:id/fees`, `:id/attachments`
- Special actions: `confirm`, `unlock`, `generate-pdf`, `merge-pdf`, `merge-pdf-binary`
- Treat this as a workflow module with nested CRUD, not a single form endpoint

## `/property-guides`

- Purpose: guide content management and public sharing
- Standard CRUD: yes for guide rows
- Subresources: revisions, public links
- Special actions: publish, archive, duplicate, copy, upload-image, public-link create, revoke public link
- Do not reduce guide lifecycle to plain update/delete

## `/rbac`

- Purpose: roles, users, permission assignments, permission lookup
- Standard CRUD: yes for roles and users
- Subresources: role permissions are assignment-oriented
- Special actions: my-permissions lookup, role-permission replacement via post/delete patterns
- Treat `role-permissions` as mapping management, not standard record CRUD

## `/keys`

- Purpose: key sets, key items, key flows, history
- Standard CRUD: partial; sets are create/read-centric, items are full CRUD
- Subresources: set items, history, flows
- Special actions: lost/flow actions and image upload in key item operations
- Do not assume key sets have a full generic patch/delete lifecycle

## `/maintenance`

- Purpose: maintenance workflow helpers around maintenance records
- Standard CRUD: no primary record CRUD here; that lives in `/crud/property_maintenance`
- Special actions: upload, share-link, PDF, PDF jobs, downloads
- Use this module when the task involves files, public sharing, or document generation

## `/deep-cleaning`

- Purpose: deep cleaning workflow helpers around deep cleaning records
- Standard CRUD: no primary record CRUD here; that lives in `/crud/property_deep_cleaning`
- Special actions: upload, review, share-link, PDF, PDF jobs, downloads
- Use this module when the task involves audit/review or asset generation

## `/finance`

- Purpose: finance transactions, expense attachments, statements, payouts, property revenue utilities
- Standard CRUD: mixed; base transactions can be created/updated/deleted, but large parts are workflow/reporting APIs
- Key subdomains: base finance transactions, expense invoice attachments, auto-expense helpers, property revenue status, payouts, company payouts, statement-photo-pack jobs, merge-monthly-pack jobs
- Special actions: auto-expense backfill/inspect, expense invoice upload/search/delete, monthly statement photo stats, statement-photo-pack jobs, merge-monthly-pack jobs, monthly statement PDFs, send-monthly, send-annual, management fee calculation, duplicate scans
- Do not equate finance with one generic transaction table
- Do not assume `/crud/finance_transactions` is the main frontend entry; the visible editor page uses `/finance` directly

## `/invoices`

- Purpose: invoice company/customer management and invoice lifecycle
- Standard CRUD: yes for companies, customers, invoices
- Special actions: issue, void, mark-sent, mark-paid, record-payment, refund, draft-from-sources, file upload, merge-pdf, invoice-pdf
- Use this module directly instead of trying to model invoices through `/crud`

## `/cleaning-app`

- Purpose: cleaning task execution API for the mobile app
- Standard CRUD: no; task list is readable but most changes happen through action endpoints
- Special actions: start, issues, consumables, restock proof, inspection photos, completion photos, lockbox video, self-complete, ready state, day-end backup keys
- Treat this as an operational task-state machine

## `/mzapp`

- Purpose: mobile-side alerts, work tasks, cleaning task manager utilities
- Standard CRUD: mostly no; list/read/action patterns dominate
- Special actions: alerts read, work task mark, manager field updates, media helper routes, checklist item operations in manager context
- Use this mount when the feature belongs to the mobile/operations experience rather than the admin console
