# Repository Agent Instructions

## Shared Change Ledger

For every repository mutation, use `.codex/skills/change-release-ledger/SKILL.md` in the same turn.

- Record each user-selectable feature or fix in `docs/change-release-ledger.md` before the final response.
- Include exact files, behavior changes, validation results, risks, dependencies, and Git state.
- At task start, inspect existing ledger entries and Git changes. Preserve changes from other threads and never infer ownership without evidence.
- Run the ledger audit after updating the record. Do not claim complete coverage while it reports uncovered files.
- Before staging, committing, pushing, or deploying multiple independent release units, show the available units and let the user choose the IDs unless the user already specified the scope.
- Never use broad staging for a selective release. Shared files require verified hunk-level staging or explicit user approval to combine units.
- Never record or commit secrets, `.env` contents, tokens, cookies, credentials, private keys, database URLs, sensitive logs, or local caches.

These requirements apply to every Codex thread and agent working in this repository.

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
