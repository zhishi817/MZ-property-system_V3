# Anti-Patterns

## 1. Maintenance is not only `/crud/property_maintenance`

- Wrong assumption: `/crud/property_maintenance` contains the full maintenance capability surface.
- Why it is wrong: the generic CRUD router handles base row creation, reading, patching, and deletion, but upload, share-link, PDF, and document job flows live under `/maintenance`.
- Use instead: start with `/crud/property_maintenance` for record fields, then check `/maintenance/upload`, `/maintenance/share-link/:id`, `/maintenance/pdf/:id`, and `/maintenance/pdf-jobs/:id` for workflow actions.

## 2. Orders are not created like a plain CRUD table

- Wrong assumption: new orders should usually be created through `POST /crud/orders`.
- Why it is wrong: the repo's real order creation paths are workflow-driven, especially `/orders/sync`, `/orders/import`, `/orders/import/start`, and `/orders/actions/importBookings`.
- Use instead: treat orders as a reconciliation/import domain first. Only use generic CRUD thinking for read/update/delete or for fields already persisted.

## 3. Cleaning app APIs are not admin CRUD

- Wrong assumption: the cleaning mobile app should be reasoned about like a normal resource CRUD app with table views, row edits, and delete operations.
- Why it is wrong: `cleaning-app` and much of `mzapp` are task-driven operational APIs. Most state changes happen through action endpoints such as start, report issue, upload proof, mark complete, or mark alert as read.
- Use instead: map the screen to its task stage, then trace the corresponding action routes in `/cleaning-app` or `/mzapp`.

## 4. Inventory does not guarantee delete for every resource

- Wrong assumption: every inventory resource supports the full create/read/update/delete matrix.
- Why it is wrong: some inventory entities are read/create/update only, while others are workflow records such as deliveries, daily replacements, delivery plans, or stock change requests. Delete routes are uneven across the module.
- Use instead: verify the specific resource in `backend/src/modules/inventory.ts` before promising delete support or designing a destructive UI action.

## 5. Frontend pages do not all use `apiList/apiCreate/apiUpdate/apiDelete`

- Wrong assumption: once a resource exists in `/crud`, all related frontend pages use the generic helper functions.
- Why it is wrong: many important pages call dedicated modules directly, including properties, landlords, orders, guides, invoices, onboarding, finance transactions, and most inventory flows.
- Use instead: inspect the actual page entrypoint first. Use `/crud` only when the page really uses the generic helper layer.

## 6. Deep cleaning is not only a generic CRUD record

- Wrong assumption: `property_deep_cleaning` can be fully handled through `/crud/property_deep_cleaning`.
- Why it is wrong: review, upload, share-link, and PDF generation are split into `/deep-cleaning` workflow routes, and those actions matter to how the feature works in practice.
- Use instead: use `/crud/property_deep_cleaning` for base record fields, then switch to `/deep-cleaning/*` for review/media/document behavior.

## 7. Warehouse writes should not be assumed from the page alone

- Wrong assumption: because `/inventory/warehouses` page calls `POST /inventory/warehouses` and `PATCH /inventory/warehouses/:id`, the backend definitely exposes those write routes today.
- Why it is wrong: the current `backend/src/modules/inventory.ts` route scan shows `GET /inventory/warehouses`, but no matching warehouse create/update routes in the visible module file.
- Use instead: verify the live backend or current source before implementing warehouse mutations, and treat warehouse write support as a compatibility check item.

## 8. Finance reporting pages are not the same as finance transaction CRUD

- Wrong assumption: pages under `/finance/*` all edit the same base transaction rows.
- Why it is wrong: `transactions` is the manual CRUD surface, while `expenses`, `properties-overview`, monthly statement export, photo-pack jobs, and payout status use a mix of report, workflow, attachment, and async job APIs.
- Use instead: first decide whether the user means base finance transactions, expense attachments, monthly report generation, payout status, or invoice lifecycle.
