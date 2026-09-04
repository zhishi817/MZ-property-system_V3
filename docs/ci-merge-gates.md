# CI Merge Gates

## Root repository

Every pull request to `Dev` publishes these stable checks:

- `Risk Classification`
- `Change Ledger Audit`
- `Regression Registry Audit`
- `Fast Regression`
- `Full Regression`

`Root Quality Check` is the lightweight required-check aggregator. It performs no dependency installation or regression work itself and succeeds only when all five layers above succeed.

For a normal code pull request, `Fast Regression` runs `npm run check:ci`. `Full Regression` publishes an explicit successful deferral result and runs the real `npm run check:full` suite only after integration, on pushes to `Dev` or `main`, or on a manual dispatch. On those integration events, Fast and Full run in parallel because the current Full command does not formally include every Fast-only governance and idempotency contract.

For a pull request that changes only `docs/change-release-ledger.md`, `Change Ledger Audit` still checks the exact range. `Regression Registry Audit`, `Fast Regression` and `Full Regression` publish explicit successful no-op results without repository checkouts or dependency installation. Required status contexts therefore remain present; the workflow does not use `paths-ignore`.

High-risk paths include CI/workflow and package changes; all backend source, schemas and migrations; Web API/auth/task-center/cleaning/finance/RBAC paths; shared code; and the feature-regression registry. These cover permissions, task state/actions, cleaning synchronization, upload queues, API clients, database changes, notifications and financial/shared business rules. The exact classifier is `scripts/ci/classify_pr_risk.sh` and can be tested locally with `--stdin`. It retains `full_required` for compatibility and also emits `ledger_only` for the ledger fast path.

## GitHub protection target

Protect both `Dev` and `main` with `Root Quality Check` as the stable required status, strict up-to-date branch checks, required conversation resolution and one independent approval. Direct pushes and force pushes should be blocked, including administrator bypasses. Configure the remote rule only through a reviewed PR so the first rule does not require checks that have never existed on the branch.

The supported root flow is feature branch → `Dev` pull request → `Dev` push → `main`. Pull-request checks intentionally target `Dev` only, while push checks target both `Dev` and `main`; this avoids launching a second pull-request workflow for the same `Dev` commit during the `Dev` → `main` promotion.

The independent mobile repository documents its own equivalent names in its own `docs/ci-merge-gates.md`. Cross-repository exact root/mobile commit pairing remains the Phase 4 integration workflow; this Phase 3 gate intentionally does not claim to provide it.
