# Late Checkout Income Backfill

This backfill covers the currently visible rows in `late check out.xlsx`.

- Bug CSV exclusion list: 83 unique confirmation codes
- Visible Excel rows: 458
- Excluded visible confirmation codes: 58
- Embedded backfill candidates: 400
- Embedded candidate total: AUD 7,999.97

Hidden Excel rows are not included.

## 1. Preview

Open the production Neon SQL Editor and run:

`late_checkout_income_2026_01_05_preview_neon.sql`

The preview always ends with `ROLLBACK` and does not persist changes.

The `_neon.sql` file keeps the executable SQL on one line so copying from a
preview pane cannot truncate the 400-row `VALUES` list. Use the non-Neon
`preview.sql` file only when running the file directly from a SQL client.

Review all result sets:

- `ready`: can be inserted.
- `missing_order`: no order matched the confirmation code.
- `ambiguous_order`: more than one order matched.
- `missing_checkout`: the matched order has no checkout date.
- `existing_finance_transaction`: a linked late-checkout transaction already exists.
- `existing_company_income`: a linked company-income row already exists.

## 2. Apply

Only after reviewing the preview, run:

`late_checkout_income_2026_01_05_apply_neon.sql`

Use the non-Neon `apply.sql` file only when running the file directly from a
SQL client.

The apply script:

- validates the embedded count and amount;
- inserts only `ready` rows;
- writes matching `finance_transactions` and `company_incomes` rows;
- writes audit-log entries;
- skips existing, missing, or ambiguous records;
- does not update `orders.price`, `orders.net_income`, or any landlord-rent fields.

The final result sets show the inserted counts, inserted totals, and skipped records.

The finance and company-income inserted counts and totals must match. A mismatch raises an exception and rolls back the transaction.
