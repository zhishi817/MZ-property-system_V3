#!/usr/bin/env bash
set -euo pipefail

candidate_ref="${1:-}"
mobile_remote="https://github.com/zhishi817/mz-cleaning-app-frontend.git"

if [[ -z "$candidate_ref" ]]; then
  printf '%s\n' 'Dev'
  exit 0
fi

set +e
git ls-remote --exit-code --heads "$mobile_remote" "refs/heads/$candidate_ref" >/dev/null
lookup_status=$?
set -e

case "$lookup_status" in
  0)
    printf '%s\n' "$candidate_ref"
    ;;
  2)
    printf '%s\n' 'Dev'
    ;;
  *)
    printf 'Unable to resolve matching mobile branch %s (git ls-remote exit %s).\n' "$candidate_ref" "$lookup_status" >&2
    exit "$lookup_status"
    ;;
esac
