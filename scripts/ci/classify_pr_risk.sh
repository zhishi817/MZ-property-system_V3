#!/usr/bin/env bash
set -euo pipefail

# Print GitHub Actions output lines:
#   full_required=true|false
#   ledger_only=true|false
# Usage: classify_pr_risk.sh <base-sha> <head-sha>
#        printf '%s\n' path ... | classify_pr_risk.sh --stdin

if [[ "${1:-}" == "--stdin" && "$#" -eq 1 ]]; then
  changed_paths="$(cat)"
elif [[ "$#" -eq 2 ]]; then
  changed_paths="$(git diff --name-only "$1" "$2")"
else
  echo "usage: $0 <base-sha> <head-sha> | --stdin" >&2
  exit 64
fi

# Backend source is conservatively high-risk: it owns permissions, task state,
# sync/upload queues, notifications and shared business rules. The listed Web
# paths own API/auth, task/cleaning state, financial data or RBAC settings.
readonly HIGH_RISK_PATTERN='^(\.github/workflows/|package(-lock)?\.json$|shared/|backend/(package(-lock)?\.json$|src/|scripts/(schema|init_db|migrations/)|migrations/)|frontend/(package(-lock)?\.json$|src/(lib/|app/(task-center|cleaning|login|auth|finance|rbac)/))|docs/feature-regression-registry\.md$)'

normalized_paths="$(printf '%s\n' "$changed_paths" | sed '/^[[:space:]]*$/d')"

if [[ -n "$normalized_paths" ]] && ! printf '%s\n' "$normalized_paths" | grep -Evq '^docs/change-release-ledger\.md$'; then
  echo 'ledger_only=true'
else
  echo 'ledger_only=false'
fi

if printf '%s\n' "$normalized_paths" | grep -Eq "$HIGH_RISK_PATTERN"; then
  echo 'full_required=true'
else
  echo 'full_required=false'
fi
