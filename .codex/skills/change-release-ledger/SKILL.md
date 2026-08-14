---
name: change-release-ledger
description: Maintain a shared, cross-thread repository change ledger and prepare feature-selective releases. Use after any repository file is created, edited, deleted, renamed, generated, or reformatted; when work from multiple Codex threads may coexist; and before staging, committing, pushing, deploying, or asking the user which functional changes to release.
---

# Change Release Ledger

Keep every repository change traceable to a release unit in `docs/change-release-ledger.md`. Treat the ledger as shared state across all threads using the same worktree.

## Legacy Frozen Workspace Boundary

`LEGACY_FROZEN_WORKSPACE` is the formal state for every staged, unstaged, and untracked delta present in an original dirty worktree at its recorded freeze snapshot. It is not a date-based category: do not infer an unresolved hunk's creation date or attempt a bulk retrospective CRL attribution.

Keep a frozen workspace as source evidence only. Do not reset, restore, stage, commit, or release it as a whole. When the user later selects one historical business change, create a new CRL and extract only that verified file/hunk scope into a clean worktree from the current `origin/Dev` baseline.

Root and Mobile remain independent repositories. A canonical CRL identity is always repository-qualified where ambiguity is possible: `root/CRL-YYYYMMDD-NNN` or `mobile/CRL-YYYYMMDD-NNN`. The numeric ID alone is unique only inside its own repository ledger.

## At Task Start

1. Read the ledger if it exists.
2. Run `git status --short` and inspect relevant diffs.
3. Distinguish pre-existing changes from the current task. Never claim another thread's changes.
4. Report changed files not covered by the ledger as `unattributed`; do not guess their purpose.

## After Any Mutation

Before the final response, add or update one release unit in the ledger using `apply_patch`.

Use ID `CRL-YYYYMMDD-NNN`, choosing the next unused sequence for that date after checking both the current ledger and freshly fetched `origin/Dev`. Within one repository ledger, an ID has one immutable business-unit lineage; resolve a collision by assigning a new ID and recording a controlled historical migration, never by silently reusing the number. A paired root/mobile feature may share an ID, but each repository must retain its own explicit entry and release evidence. One unit represents one user-selectable feature or fix. Split unrelated work into separate units.

Every new CRL must include `- **Repository:** \`root\`` or `- **Repository:** \`mobile\`` directly below its heading. Cite related units, dependencies, scope manifests, and Release Attempts with their canonical identity when they cross a repository boundary.

The audit compares the current ledger with the locally fetched `origin/Dev` ledger. A current ledger must retain every remote CRL, and a shared ID must preserve its title, Request, Outcome, `### Implementation`, `### Files / Areas`, and `### Impact / Dependencies` exactly (whitespace aside). Status, validation evidence, Release Attempts, risks, and a dated reconciliation receipt may change under their existing rules. If `origin/Dev` is unavailable, the audit is `NOT VERIFIED`; if a remote entry is missing or its business identity differs, it is `BLOCKED` and the later work needs a new CRL.

Record status, user-visible outcome, request, previous/new behavior, exact files, API/database/config/dependency impact, validation commands and actual results, risks, sensitive-information review, rollback, dependencies, related IDs, and available Git evidence. `Status` describes implementation tracking, not blanket release authority. New units should normally use `in-progress`, `ready`, or `blocked`; legacy `staged`, `committed`, or `pushed` values need exact Release Attempt evidence and never prove later edits to the same CRL are released.

Never copy secrets, tokens, cookies, passwords, private keys, database URLs, `.env` values, or sensitive log contents into the ledger. A dated update may add only evidence, clarification, or a historical-reconciliation receipt. Once a unit has a committed, pushed, merged, or deployed Release Attempt, any new runtime, API, schema, UI, or behavior change must receive a new CRL and link the earlier unit; do not append it under the released CRL or reuse its Git state.

## Release Attempts

Keep Release Attempt records inside the relevant CRL; they are evidence records, not a second ledger. A CRL can have multiple attempts when its implementation changes after a prior commit or push.

Each attempt must contain:

- Attempt ID, repository, selected CRL IDs, intended action, branch, dependency CRLs/SHAs.
- Exact base ref/SHA and fetch time; candidate patch SHA-256; candidate content commit SHA once committed. The report command supplies the exact audit head SHA because a commit cannot self-record its own object SHA.
- Technical state: `candidate`, `verified`, `committed`, `pushed`, `merged`, or `deployed`.
- User authorization: `not-selected`, `selected-for-commit`, or `approved-for-push`, with a concise reference to the user instruction. Never infer authorization from `ready`, a successful test, a commit, or a reviewer verdict.
- Action conclusion: `GO`, `BLOCKED`, or `NOT VERIFIED`, plus evidence and blockers.

`NOT VERIFIED` means required evidence is missing. `BLOCKED` means evidence identifies a failed gate, including a stale/invalid base, range mismatch, scope collision, uncovered path, test failure, generated-file issue, or sensitive-information risk. Do not use "probably ready" or similar wording.

Candidate patch SHA-256 is the selected `base...head` content diff excluding `docs/change-release-ledger.md`, so recording the hash and commit evidence cannot become self-referential. The exact range audit still includes the ledger path. A recorded candidate content commit must be a descendant of the recorded base and an ancestor of the report head.

`commit-ready` requires a `verified` attempt, `selected-for-commit`, and `GO` for the commit action. `push-ready` requires a `committed` attempt, a passing exact `base...head` range audit, `approved-for-push`, and `GO` for the push action. Changing the CRL selection, base SHA, candidate content commit SHA, or branch invalidates prior push authorization and requires a new attempt.

## Audit Coverage

Run:

```bash
python3 scripts/audit_change_release_ledger.py
```

The audit must pass before claiming all current changes are recorded. It requires a locally fetched `origin/Dev` ledger for lineage verification. Add a release unit only when its purpose is supported by current-task evidence; otherwise leave the file unattributed and tell the user.

Use three separate audit layers. They prove different things and must not be substituted for one another:

1. **Current-worktree coverage:** `python3 scripts/audit_change_release_ledger.py` checks local path coverage and fetched `origin/Dev` lineage. It is not a release candidate and does not classify a Legacy frozen workspace.
2. **Local pre-commit candidate:** after exact staging in a clean candidate worktree, run `python3 scripts/audit_change_release_ledger.py --pre-commit --repo <root|mobile> --crl <CRL-ID>`. It blocks untracked paths, selected-path mismatches, missing repository-qualified identity, and hunk fingerprints that do not exactly match `### Staged Commit Scope`.
3. **PR committed range:** run `--release-report` with exact `--base`, `--head`, `--repo`, and selected `--crl` values. It checks only `base...head`: canonical CRL identity, selected paths/hunks, candidate content receipt, Git ancestry/base freshness, and generated/sensitive-file evidence. It must not claim visibility into any separate historical working tree.

## Release Report

After a candidate content commit exists, audit one exact attempt without modifying Git, the ledger, or remote state:

```bash
python3 scripts/audit_change_release_ledger.py \
  --release-report \
  --repo root \
  --base <origin-dev-sha> \
  --head <audit-head-sha> \
  --crl <CRL-ID> \
  --format markdown
```

Use the independent mobile repository's own script with `--repo mobile`; never use root output as mobile evidence. The report resolves only locally available refs and never fetches. It checks that locally fetched `origin/Dev` still equals the requested base, checks the exact three-dot range, selected files, shared-file evidence, generated-file evidence, candidate patch SHA-256, validation, review, authorization, and configured sensitive categories.

`--format json` emits the same evidence for automation. Exit `0` means `GO`; `1` means `BLOCKED`; `2` means `NOT VERIFIED`. A report result is evidence for one action only and never performs staging, commit, push, PR creation, merge, deployment, EAS, API calls, or production writes.

## Select Features for Release

Before staging, committing, pushing, or deploying:

1. Report root and mobile separately using `可供选择的候选`、`已选择但仍被阻塞`、`已获授权且可提交`、`已提交、已批准且可推送`、`已推送`、`不在本次范围`. A candidate is not automatically pushable.
2. Ask the user to select IDs when multiple independent units exist and scope was not already specified. Selection permits staging/commit only; ask again for explicit push authorization after the exact commit SHA exists.
3. Expand required dependencies and explain why they travel together. Record exact dependency SHAs when a dependency is already committed or pushed.
4. Preserve mixed development worktrees. After scope selection, fetch and record `origin/Dev@SHA`, then create a clean release worktree from that SHA. Do not pull, rebase, stash, reset, clean, or broad-stage the development worktree to manufacture a candidate.
5. Detect files shared by selected and unselected units. Stage exact exclusive files. For shared files, stage only verified hunks; if ownership cannot be proven, report `NOT VERIFIED` rather than assume it.
6. Capture the staged candidate patch SHA-256 excluding `docs/change-release-ledger.md`, run required validation, and obtain independent read-only review before the content commit. A candidate-review `GO` is limited to the commit action.
7. After commit, record the candidate content commit SHA in a later bookkeeping update if needed, then inspect `git diff --name-only <base>...<head>`, `git diff <base>...<head>`, and the exact range audit. Require the candidate content commit to be inside that range and its non-ledger patch fingerprint to match the reviewed candidate. Check for sensitive information and generated-file risk.
8. Update an attempt's technical state only after its action succeeds. Record remote branch/SHA for push, PR evidence for review, merge evidence for `Dev`, and deployment evidence separately.

Never use `git add .`, `git add -A`, wildcard staging, or unverified whole-file staging for a selective release.

## Ledger Template

~~~~markdown
## CRL-YYYYMMDD-NNN — Feature name

- **Status:** ready
- **Repository:** `root` or `mobile`
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

### Staged Commit Scope

- **Repository:** `root` or `mobile`
- **Status:** `not prepared` or `prepared`
- **Untracked review:** `not prepared` or `none`; a prepared candidate must come from a clean worktree.
- `` `path/to/file` — SHA-256: `<zero-context staged hunk fingerprint>` `` for every non-ledger staged hunk; add one line per hunk. Run the local pre-commit gate once to obtain any unexpected fingerprint, record the reviewed scope, stage only the ledger hunk, then rerun until it passes.

### Release Attempts

- None yet, or one block per exact release attempt:

```markdown
#### RA-YYYYMMDD-NNN

- Repository: `root` or `mobile`
- Selected CRLs: `CRL-...`
- Selected CRL identities: `root/CRL-...` or `mobile/CRL-...`; must exactly match the selected repository-qualified set
- Intended action: `commit` or `push`
- Branch: `codex/<release-scope>` or `not created`
- Base: `origin/Dev@<SHA>`; fetched at `<timestamp>`
- Candidate patch SHA-256: `<hash excluding docs/change-release-ledger.md>` or `not created`
- Commit SHA: `<candidate content SHA>` or `not committed`; audit head is emitted by the report command
- Dependencies: `<CRL / SHA>` or none
- Required validation: `PASS` / `FAIL` / `NOT VERIFIED`; evidence: `<safe concise evidence>`
- Shared-hunk review: `PASS` / `not applicable` / `NOT VERIFIED`; evidence: `<review reference>`
- Generated-file review: `PASS` / `not applicable` / `NOT VERIFIED`; evidence: `<review reference>`
- Technical state: `candidate` / `verified` / `committed` / `pushed` / `merged` / `deployed`
- User authorization: `not-selected` / `selected-for-commit` / `approved-for-push`; evidence: `<user instruction or not applicable>`
- Independent review: `GO` / `NO-GO` / `NEEDS OWNER`; evidence: `<review reference or not run>`
- Action conclusion: `GO` / `BLOCKED` / `NOT VERIFIED`; blockers: `<facts>`
```

### Risks / Release Notes

- Risk and rollback information
- Sensitive-information review result
- Git state: uncommitted
~~~~

Use `not run` or `unknown` rather than inventing results.
