---
name: mz-app-self-test-guardrails
description: Use when testing, auditing, optimizing, or fixing MZ Property System web/admin, backend, or cleaning mobile app functionality. Enforces scoped read-only discovery, complex cascade checks, evidence-based issue reports, approval gates, and MZ-specific validation before code changes.
---

# MZ App Self-Test Guardrails

## Trigger

Use this skill when the user asks Codex to:

- test the existing app
- inspect web/admin functionality
- inspect mobile app functionality
- find bugs automatically
- optimize functionality or UI
- run a functional audit
- fix issues found during testing

## Phase 1: Scope And Plan

Before executing, restate:

- Surface: backend, Next.js web admin, Expo cleaning mobile app
- Pages, screens, APIs, or workflows in scope
- Roles/accounts in scope
- Data environment: local, staging, production
- Allowed write actions
- Explicitly excluded modules
- Expected business behavior
- Stop conditions
- Validation plan

If scope is unclear, default to read-only discovery and ask only when the missing detail is required.

## Phase 2: Read-Only Testing

Allowed:

- inspect source code
- run existing checks
- start local dev services
- browse local pages
- inspect console errors
- inspect network/API failures
- inspect backend logs
- run non-mutating API checks
- capture screenshots or payload evidence

Complex business cascade audit:

Before opening pages or calling read-like APIs, check whether the action may trigger:

- external reservation/channel sync
- third-party API calls
- cleaning/order synchronization
- background jobs
- notification/event queue writes
- mobile work-task refresh events
- PDF/media/export jobs
- multi-store or cache mutation

If a read-like action may trigger writes, external synchronization, or cross-module side effects, stop and ask before running it.

## Phase 3: Issue Report

For each issue, report:

- Severity: P0/P1/P2
- Surface: backend, web, or mobile
- Route/screen/module
- Reproduction steps
- Expected behavior
- Actual behavior
- Evidence
- Suspected owner file/API
- Proposed fix scope

Do not fix yet unless the user has already authorized automatic repair.

## Phase 4: Repair Gate

Only fix approved issues.

Rules:

- Fix one issue at a time
- Keep changes narrowly scoped
- Do not refactor architecture
- Do not add a parallel system
- Do not introduce new dependencies unless approved
- Do not make unrelated UI polish
- Do not change production data
- Preserve existing business rules unless the user explicitly changes them

Stop and ask before:

- database schema changes
- permission/auth core rewrites
- production writes
- external API sync
- broad shared-file changes
- changes outside the approved scope

## Phase 5: MZ Validation

Run the smallest correct validation set for the touched surface.

Backend: Node/Postgres

- `npm run build --prefix backend`
- Run targeted backend script tests when relevant, for example:
  - `npm run test:cleaning-rules --prefix backend`
  - `npm run test:cleaning-inspection-merge --prefix backend`
  - targeted `backend/scripts/tests/*.ts` through the repo's existing `ts-node-dev` pattern
- For DB-backed tests, confirm the target database is not production before write tests.
- If Supabase/Postgres-specific workflows are involved, run the matching local or targeted database validation. Do not invent Supabase commands unless the repo actually contains that workflow.

Web: Next.js Admin

- `npm run lint --prefix frontend`
- `npm run test --prefix frontend` or targeted Vitest when repo-wide coverage is too broad
- `npm run build --prefix frontend`
- For UI changes, check B-end admin conventions:
  - Ant Design consistency
  - table action order
  - drawer/form behavior
  - permission-based action visibility
  - no cramped or overlapping text
- Run existing UI diff/check scripts when the touched page has one.

Mobile: Expo Cleaning App

- `npm run typecheck --prefix mz-cleaning-app-frontend`
- `npm run lint --prefix mz-cleaning-app-frontend`
- `npm run test --prefix mz-cleaning-app-frontend`
- Do not claim a mobile build unless an actual EAS/native build command was run.
- For task-flow changes, verify:
  - `/mzapp/work-tasks` payload
  - `available_actions`
  - task detail navigation
  - mixed cleaning/checking/offline ordering
  - same-day merged-card behavior
  - mobile type definitions around merged tasks/materials

Cross-Layer Task Flow

When a task-center, cleaning, notification, or mobile visibility issue is touched, verify both sides:

- backend payload/query/action resolver
- web or mobile rendering
- cache/event refresh behavior
- role/permission/capability semantics

## Phase 6: Release Ledger

After repository mutations:

- update `docs/change-release-ledger.md`
- keep release units granular
- include files changed, behavior change, validation, risk, dependencies, and Git state
- run `python3 scripts/audit_change_release_ledger.py`
- do not claim coverage if the audit reports uncovered files

## Final Response

Report:

- Modified files
- Cleanup performed
- Risks
- Sensitive data risk
- Validation commands and results
- Unverified items
- Decisions still needed from the user
