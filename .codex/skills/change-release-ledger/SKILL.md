---
name: change-release-ledger
description: Maintain a shared, cross-thread repository change ledger and prepare feature-selective releases. Use after any repository file is created, edited, deleted, renamed, generated, or reformatted; when work from multiple Codex threads may coexist; and before staging, committing, pushing, deploying, or asking the user which functional changes to release.
---

# Change Release Ledger

Keep every repository change traceable to a release unit in `docs/change-release-ledger.md`. Treat the ledger as shared state across all threads using the same worktree.

## At Task Start

1. Read the ledger if it exists.
2. Run `git status --short` and inspect relevant diffs.
3. Distinguish pre-existing changes from the current task. Never claim another thread's changes.
4. Report changed files not covered by the ledger as `unattributed`; do not guess their purpose.

## After Any Mutation

Before the final response, add or update one release unit in the ledger using `apply_patch`.

Use ID `CRL-YYYYMMDD-NNN`, choosing the next unused sequence for that date. One unit represents one user-selectable feature or fix. Split unrelated work into separate units.

Record status, user-visible outcome, request, previous/new behavior, exact files, API/database/config/dependency impact, validation commands and actual results, risks, sensitive-information review, rollback, dependencies, related IDs, and available Git evidence. Use statuses `in-progress`, `ready`, `blocked`, `staged`, `committed`, or `pushed`.

Never copy secrets, tokens, cookies, passwords, private keys, database URLs, `.env` values, or sensitive log contents into the ledger. If a unit changes later, append a dated update and preserve earlier failures or risks.

## Audit Coverage

Run:

```bash
python3 scripts/audit_change_release_ledger.py
```

The audit must pass before claiming all current changes are recorded. Add a release unit only when its purpose is supported by current-task evidence; otherwise leave the file unattributed and tell the user.

## Select Features for Release

Before staging, committing, pushing, or deploying:

1. List non-pushed units with ID, feature, status, files, dependencies, validation, and risks.
2. Ask the user to select IDs when multiple independent units exist and scope was not already specified.
3. Expand required dependencies and explain why they travel together.
4. Detect files shared by selected and unselected units.
5. Stage exact exclusive files. For shared files, stage only verified hunks; if unsafe, ask whether to combine units.
6. Inspect `git diff --cached --name-only` and `git diff --cached`, then check for sensitive information.
7. Run required validation and update statuses only after actions succeed.

Never use `git add .`, `git add -A`, wildcard staging, or unverified whole-file staging for a selective release.

## Ledger Template

```markdown
## CRL-YYYYMMDD-NNN — Feature name

- **Status:** ready
- **Updated:** YYYY-MM-DD HH:MM timezone
- **Request:** Original request
- **Outcome:** User-visible result

### Implementation

- Previous behavior: ...
- New behavior: ...
- Key decisions: ...

### Files / Areas

- `path/to/file` — modified: why

### Impact / Dependencies

- API: none
- Database / migration: none
- Config / environment: none
- Dependencies: none
- Related units: none

### Validation

- `command` — passed/failed/not run: evidence

### Risks / Release Notes

- Risk and rollback information
- Sensitive-information review result
- Git state: uncommitted
```

Use `not run` or `unknown` rather than inventing results.
