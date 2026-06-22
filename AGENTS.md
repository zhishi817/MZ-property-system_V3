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
