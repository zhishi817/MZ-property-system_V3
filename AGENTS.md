# Repository Agent Instructions

## Shared Change Ledger

For every repository mutation, use `.codex/skills/change-release-ledger/SKILL.md` in the same turn.

- Record each user-selectable feature or fix in `docs/change-release-ledger.md` before the final response.
- Include exact files, behavior changes, validation results, risks, dependencies, and Git state.
- At task start, inspect existing ledger entries and Git changes. Preserve changes from other threads and never infer ownership without evidence.
- Run the ledger audit after updating the record. Do not claim complete coverage while it reports uncovered files.
- The audit must compare the local ledger with freshly fetched `origin/Dev`: every existing remote CRL must remain present, and its title, Request, Outcome, Implementation, Files / Areas, and Impact / Dependencies must remain unchanged. A mismatch is `BLOCKED`; create a new CRL and add only a controlled reconciliation receipt.
- Before staging, committing, pushing, or deploying multiple independent release units, show the available units and let the user choose the IDs unless the user already specified the scope.
- Never use broad staging for a selective release. Shared files require verified hunk-level staging or explicit user approval to combine units.
- Never record or commit secrets, `.env` contents, tokens, cookies, credentials, private keys, database URLs, sensitive logs, or local caches.

These requirements apply to every Codex thread and agent working in this repository.

## Branch And Release Topology

- A CRL is a tracking/release unit, **not** a Git branch. For one user-selected release scope, create or reuse one temporary release branch; do not create a branch for every screenshot row or for each CRL when several selected CRLs must travel together.
- `Dev` is the default integration target for reviewed, release-ready fixes. A successful push to a temporary branch is not a push to `Dev` and must be reported as such.
- Once the user has selected CRL IDs (or a single clearly bounded release scope) and asked to commit, push, or release, create or reuse a `codex/<release-scope>` temporary branch targeting `Dev`. A protected `Dev`, required PR, missing status check, or direct-push rejection is a normal reason to use that branch and PR flow, not a reason to stop after the user has authorized the release scope.
- Do not create, switch to, push, or open a PR when no release scope has been selected; first list the available non-pushed units and obtain the user's selection. A temporary branch has one stated scope and must be reused for subsequent fixes within that scope rather than duplicated.
- Open the PR against `Dev` after the independent release review and required checks pass. Use the repository's “automatically delete head branches” setting when it is enabled; after merge, verify and report the actual deletion result separately from PR creation and merge.
- Keep the lifecycle explicit: branch name, selected CRL IDs, target `Dev`, PR status, merge result, and deletion result are separate facts. Never claim any of them from another.

## Release Decision Contract

- A CRL describes a user-selectable implementation change. A **Release Attempt** is one exact attempt to release one or more selected CRLs. Do not use a CRL's historical `pushed` label as evidence that later edits to the same CRL are released.
- Every Release Attempt must record its repository, CRL IDs, target action, base ref/SHA and fetch time, candidate patch SHA-256, candidate content commit SHA when one exists, branch, dependencies, validation/review evidence, user authorization, and remote/PR/deployment evidence when those actions occur. The report command, not a self-referential ledger line, records the exact audit `head` SHA.
- Report technical state separately from authorization and the action gate:
  - technical state: `candidate`, `verified`, `committed`, `pushed`, `merged`, or `deployed`;
  - authorization: `not-selected`, `selected-for-commit`, or `approved-for-push`;
  - conclusion for one stated action: `GO`, `BLOCKED`, or `NOT VERIFIED`.
- `NOT VERIFIED` means required evidence is absent. `BLOCKED` means evidence shows a failed test, stale/invalid base, scope collision, uncovered path, secret risk, or another concrete release violation. Never replace either with vague wording such as "基本可以推".
- `commit-ready` is derived only when the attempt is `verified`, the user selected its exact scope for commit, and the commit action conclusion is `GO`. `push-ready` is derived only when the attempt is `committed`, its exact `base...head` range audit passes, and the user explicitly approved push of that repository, commit SHA, and branch.
- A user selection authorizes staging/commit only. It never authorizes push. Any change to the selected CRLs, base SHA, commit SHA, or branch invalidates an earlier `approved-for-push` authorization.
- Candidate patch SHA-256 is calculated from the selected `base...head` content diff excluding `docs/change-release-ledger.md`; attempt metadata must be excluded because recording a hash or commit SHA inside the same ledger commit would otherwise be self-referential. The exact range audit still includes and verifies the ledger path. A recorded candidate content commit must be an ancestor of the report head and a descendant of the recorded base.

### Completion And Delivery Claims

- Never use unqualified wording such as “已修复”, “已完成”, “已交付”, “已发布”, or “已上线” when the evidence only proves a smaller stage. Say `source fixed`, `local regression passed`, `committed`, `pushed to branch`, `merged into Dev`, `backend deployed`, `OTA published`, or `device verified` exactly as supported by evidence.
- A local code change, passing local tests, a CRL entry, a commit, a branch push, a PR, and a `Dev` merge are separate facts. None proves a later fact. In particular, a mobile user-visible defect is not “fixed for users” until the required backend version (when applicable), the matching OTA/build/channel, and the declared real-device regression are all recorded.
- At the end of every implementation or release report, state the CRL ID, repository, commit SHA or `not committed`, remote branch/SHA or `not pushed`, PR/merge state or `not created`/`not merged`, deployment/OTA state or `not deployed`/`not published`, and device/production verification or `not run`. Do not omit an unperformed stage.
- When asked whether a repair was committed, pushed, or released, re-check and report the exact repository and evidence. Do not infer Git or delivery state from a prior “fix completed” statement, local diff, test result, ledger status, or another repository’s status.

### Answering “哪些更新可以推送”

- Inspect root and `mz-cleaning-app-frontend` as independent repositories. Do not infer mobile evidence from root evidence or the reverse.
- A `candidate` is an implementation range awaiting this release attempt; it is not defined merely as a CRL with no historical push and must never be called pushable before all gates pass.
- State only what was checked. If other local worktrees, commits, or `codex/*` branches were not inspected, report them as `NOT VERIFIED`, not absent.
- Use this fixed result order: `可供选择的候选`、`已选择但仍被阻塞`、`已获授权且可提交`、`已提交、已批准且可推送`、`已推送`、`不在本次范围`.

### Release Worktree Boundary

- Do not pull, rebase, stash, reset, clean, or otherwise synchronize a mixed development worktree in order to prepare a release.
- After the user has selected a release scope, fetch and record the exact `origin/Dev` SHA, then prepare the attempt in a clean release worktree based on that SHA. The release worktree may contain only selected CRL changes while preparing the candidate and must be clean again after its commit.
- Preserve the original development worktree as source evidence only. Extract exact files or verified hunks; never derive a release scope from a broad working-tree diff.

## Pre-Release Independent Codex Review

Before committing, pushing, or deploying a release, open an independent Codex review task using `docs/codex-release-review.md`.

- The review task is review-only: it must not modify files, commit, push, deploy, call production APIs, or write production data.
- For a pre-commit candidate, provide the exact base SHA, staged candidate patch SHA-256 (excluding ledger attempt metadata), selected CRL IDs, changed surfaces, and completed regression commands. For a committed range, provide the exact base/head, candidate content commit SHA, and require the range patch fingerprint to match the reviewed candidate.
- The reviewer must inspect `AGENTS.md`, the ledger, the complete diff, test coverage, unrelated files, production-write risk, and secret/token risk.
- A P0/P1 finding, uncovered current-task file, or unverified production/secret risk blocks release until the implementation thread resolves it and updates the ledger.
- A reviewer `GO` for a candidate enables only the stated commit action. It is not user push authorization and does not establish push, PR, merge, deployment, or device/production evidence.
- Keep the review report with the release discussion; the review thread does not replace targeted fixes or final validation.

## Self-Test And Optimization Guardrails

When the user asks Codex to test, audit, optimize, inspect, or find and fix issues in this repository:

1. Start with a scoped plan unless the user explicitly authorizes direct execution.
2. Default to read-only discovery when scope, environment, accounts, or allowed writes are unclear.
3. Restate the approved scope before running tests:
   - app surface: backend, web admin, mobile app
   - pages/screens/routes
   - roles/accounts
   - data environment
   - allowed write actions
   - excluded modules
4. Do not treat "optimize" as permission for broad refactors.
5. Do not make unrelated UI polish, architecture changes, dependency changes, or cleanup unless explicitly approved.
6. Every reported issue must include:
   - severity: P0/P1/P2
   - route/screen/module
   - reproduction steps
   - expected behavior
   - actual behavior
   - evidence from API, logs, console, screenshot, payload, or test output
   - likely owner file/API
7. Before any read-only testing, check complex business cascades:
   - whether opening a page or calling a read-like endpoint may trigger external API sync
   - whether it may enqueue background jobs
   - whether it may update reservation/channel state
   - whether it may emit notifications or work-task events
   - whether it may create media/PDF/export jobs
   - whether it may mutate multi-store/cache state
8. If a supposedly read-only flow can trigger writes, external sync, or cross-module side effects, stop and ask before executing it.
9. Do not modify production data unless the user explicitly authorizes the exact action.
10. Stop and ask before:
    - database schema changes
    - dependency installs
    - permission/core auth rewrites
    - production writes
    - external API sync
    - broad refactors
    - changes outside the approved module scope
11. Fix one confirmed issue at a time unless the user approves a grouped fix.
12. After repository mutations, update `docs/change-release-ledger.md` and run `python3 scripts/audit_change_release_ledger.py`.
13. After edits, run relevant validation and report commands/results honestly.
