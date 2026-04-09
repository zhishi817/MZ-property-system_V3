# Frontend Entrypoints

## Next.js Admin App (`frontend/src/app`)

| Page | Main Resources | API Pattern | Mixes `/crud`? | Notes |
| --- | --- | --- | --- | --- |
| `/properties` | `properties` | Direct `/properties` fetches | No | Main property list/editor and launch point to onboarding |
| `/properties/[id]` | `properties` | Direct `/properties/:id` | No | Detail edit page |
| `/properties/[id]/onboarding` | `onboarding`, `items`, `fees`, `attachments`, price presets | Direct `/onboarding/*` plus `/properties/:id` | No | Rich workflow page with uploads, confirm/unlock, merge PDF |
| `/landlords` | `landlords`, `management-fee-rules` | Direct `/landlords*` | No | Parent resource plus nested rules editor |
| `/orders` | `orders`, `internal-deductions` | Direct `/orders*`, import jobs, job helpers | No | Mixed list/detail/import/reconciliation workflow |
| `/orders/[id]` | `orders.internal-deductions` | Direct `/orders/:id/internal-deductions*` | No | Focused deduction editor |
| `/maintenance` | `property_maintenance` | `getJSON('/crud/property_maintenance')` plus direct `/maintenance/upload` | Yes | Simple management page over generic CRUD with upload helper |
| `/maintenance/records` | `property_maintenance` | `/crud/property_maintenance` plus dedicated `/maintenance/*` helpers | Yes | Full records UI, still depends on workflow routes for uploads/share/pdf |
| `/maintenance/progress` | `property_maintenance` | Generic CRUD create plus supporting fetches | Yes | Workflow-like data entry screen |
| `/deep-cleaning/records` | `property_deep_cleaning` | `/crud/property_deep_cleaning` plus `/deep-cleaning/*` helpers | Yes | Generic row CRUD plus review/share/pdf |
| `/deep-cleaning/upload` | `property_deep_cleaning` | `apiCreate('property_deep_cleaning')` plus upload helpers | Yes | Intake-style page rather than generic table |
| `/deep-cleaning/overview` | `property_deep_cleaning` | `/crud/property_deep_cleaning` | Yes | Overview/report surface |
| `/properties/guides` | `property-guides`, `public-links` | Direct `/property-guides*` | No | Complex guide editor with publish/archive/copy/public links |
| `/finance/transactions` | `finance_transactions` | Direct `/finance`, `/finance/:id` | No | Manual transaction editing for statement support |
| `/finance/expenses` | `property_expenses` and expense invoices | `apiList/apiCreate/apiUpdate/apiDelete` over `/crud`, plus direct `/finance/expense-invoices*` and duplicate validation | Yes | Good example of CRUD plus finance-specific actions |
| `/finance/company-revenue` | `company_incomes`, `company_expenses` | Generic CRUD helpers over `/crud` | Yes | Mostly plain CRUD in UI |
| `/finance/recurring` | `recurring_payments`, expense snapshots | Direct `/crud/recurring_payments` and supporting finance routes | Yes | Template CRUD plus recurring workflow actions |
| `/finance/monthly-statement` | property statement data | Generic list helpers plus statement component | Yes | Legacy statement surface tied to monthly report logic |
| `/finance/properties-overview` | `property_revenue_status`, `property_expenses`, recurring, monthly export jobs, photo-pack jobs | Mixed: `/finance/*` reporting routes plus some `/crud` list helpers | Yes | Main landlord revenue/monthly package workflow surface |
| `/finance/performance/revenue` and `/finance/performance/property` | property revenue reporting | Reuses finance overview/reporting APIs | Partial | Reporting-first surfaces, not row CRUD |
| `/finance/invoices` | `invoices`, `invoice.companies`, `invoice.customers` | Direct `/invoices*` | No | Dedicated invoice center, not `/crud` |
| `/finance/invoices/[id]` | `invoices` | Direct `/invoices/:id` and action routes | No | Editor/issue/payment lifecycle |
| `/finance/invoices/new` | `invoices` | Direct `/invoices`, `/invoices/customers`, `/invoices/companies` | No | Draft creation flow |
| `/inventory/items` | `inventory.items` | Direct `/inventory/items` | No | Resource editor for active inventory items |
| `/inventory/warehouses` | `inventory.warehouses` | Direct warehouse routes | No | Frontend assumes create/update routes exist; confirm backend before changing behavior |
| `/inventory/stocks` | `inventory.stocks`, `inventory.movements`, `inventory.transfers` | Direct `/inventory/stocks`, `/inventory/movements`, `/inventory/transfers` | No | Operational stock movement surface |
| `/inventory/movements` | `inventory.movements` | Direct `/inventory/movements` | No | Read-heavy operational view |
| `/inventory/suppliers` | `inventory.suppliers`, `inventory.supplier-item-prices`, `inventory.linen-types` | Direct `/inventory/*`, with fallback to `/crud/supplier_item_prices` in some paths | Partial | Multi-resource editor, purchasing-oriented |
| `/inventory/region-rules` | `inventory.region-supplier-rules` | Direct `/inventory/region-supplier-rules` | No | Rule editing page |
| `/inventory/purchase-orders` | `inventory.purchase-orders` | Redirects to linen category PO list | No | Purchase-order entrypoint |
| `/inventory/purchase-orders/new` | `inventory.purchase-orders` | Direct `/inventory/purchase-orders` create | No | Form-driven create flow |
| `/inventory/purchase-orders/[id]` | `inventory.purchase-orders`, `inventory.deliveries` | Direct `/inventory/purchase-orders/:id*` | No | Edit, export, receive delivery |
| `/inventory/category/[category]/stocks` | linen dashboard or generic stock view | Category-routed inventory views | No | Linen routes switch into specialized components |
| `/inventory/category/[category]/deliveries` | linen delivery planning or generic delivery views | Category-routed delivery views | No | Linen category uses `LinenTransfersView` |
| `/inventory/category/[category]/returns` | linen return batches, refunds, stock-change requests | Category-routed returns view | No | Linen category uses `LinenReturnsDamageView` |
| `/inventory/category/daily/replacements` | `inventory.daily-replacements` | Direct `/inventory/daily-replacements` | No | Read-heavy daily replacement view |

## Expo Cleaning App (`mz-cleaning-app-frontend`)

| Screen or Area | Main Resources | API Pattern | Mixes `/crud`? | Notes |
| --- | --- | --- | --- | --- |
| `src/screens/tabs/TasksScreen.tsx` | `cleaning-app.tasks` | Mobile helper functions in `src/lib/api.ts` | No | Task list surface driven by `/cleaning-app/tasks` |
| `src/screens/tasks/TaskDetailScreen.tsx` | `cleaning-app.tasks` | Dedicated task action routes | No | Entry point for start/proof/photo workflows |
| `src/screens/tasks/FeedbackFormScreen.tsx` | task issues/feedback | Dedicated `/cleaning-app/tasks/:id/issues` style actions | No | Workflow form, not generic row CRUD |
| `src/screens/tasks/SuppliesFormScreen.tsx` | task consumables/restock | Dedicated task action routes | No | Consumable reporting and restock proof |
| `src/screens/tasks/InspectionPanelScreen.tsx` | inspection photos/proof | Dedicated task action routes | No | Inspection lifecycle |
| `src/screens/tasks/InspectionCompleteScreen.tsx` | inspection completion | Dedicated task action routes | No | Final inspection completion step |
| `src/screens/tasks/CleaningSelfCompleteScreen.tsx` | completion photos/self-complete | Dedicated task action routes | No | Close-out flow |
| `src/screens/tasks/ManagerDailyTaskScreen.tsx` | `mzapp.work-tasks`, manager fields | `mzapp/*` helper functions | No | Mobile management workflow, still action-based |
| `src/screens/tasks/DayEndBackupKeysScreen.tsx` | day-end backup keys | Dedicated `/cleaning-app/day-end/backup-keys*` routes | No | Operational end-of-day flow |
| `src/screens/tabs/NoticesScreen.tsx` and notice details | `mzapp.alerts` | Direct alert list/read helpers | No | Read/ack flow, not CRUD |
| `src/screens/me/*` | auth/profile | `auth/*`, `/users/me`, profile helpers | No | Account/profile maintenance, outside CRUD map focus |

## Notes

- In the Next.js app, `/crud` is common but not universal. Many of the most important pages call dedicated routers directly.
- In the Expo app, think in terms of task actions and acknowledgments, not admin CRUD.
