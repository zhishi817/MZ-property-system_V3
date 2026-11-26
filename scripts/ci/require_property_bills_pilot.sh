#!/usr/bin/env bash
# Enforced by the existing required Fast Regression check.
set -euo pipefail
if [[ "$#" -ne 3 || "$1" != success || ! "$3" =~ ^[0-9a-f]{40}$ || "$2" != "$3" ]]; then
  echo "Property Bills required validation did not complete for this merge revision." >&2
  exit 1
fi
echo "Property Bills required validation completed for the current merge revision."
