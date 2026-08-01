# CI Merge Gates

## Root repository

Every pull request to `Dev` or `main` publishes these stable checks:

- `Risk Classification`
- `Change Ledger Audit`
- `Regression Registry Audit`
- `Fast Regression`
- `Full Regression`

`Fast Regression` is always required. `Full Regression` runs `npm run check:full` for a high-risk pull request and on every push or manual dispatch. On a low-risk pull request it completes an explicit no-op step with success, so its required status is present rather than silently skipped.

High-risk paths include CI/workflow and package changes; all backend source, schemas and migrations; Web API/auth/task-center/cleaning/finance/RBAC paths; shared code; and the feature-regression registry. These cover permissions, task state/actions, cleaning synchronization, upload queues, API clients, database changes, notifications and financial/shared business rules. The exact classifier is `scripts/ci/classify_pr_risk.sh` and can be tested locally with `--stdin`.

## GitHub protection target

After these job names have run on each repository, protect both `Dev` and `main` with the listed required checks, strict up-to-date branch checks, required conversation resolution and one independent approval. Direct pushes and force pushes should be blocked, including administrator bypasses. Configure the remote rule only through a reviewed PR so the first rule does not require checks that have never existed on the branch.

The independent mobile repository documents its own equivalent names in its own `docs/ci-merge-gates.md`. Cross-repository exact root/mobile commit pairing remains the Phase 4 integration workflow; this Phase 3 gate intentionally does not claim to provide it.
