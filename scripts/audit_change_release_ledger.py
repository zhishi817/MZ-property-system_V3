#!/usr/bin/env python3
"""Check that every current Git change is named by a release unit."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / "docs" / "change-release-ledger.md"
FILES_HEADING = "### Files / Areas"


def git_paths(*args: str) -> set[str]:
    result = subprocess.run(
        ["git", *args], cwd=ROOT, check=True, capture_output=True, text=True
    )
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


def changed_paths() -> set[str]:
    return (
        git_paths("diff", "--name-only")
        | git_paths("diff", "--cached", "--name-only")
        | git_paths("ls-files", "--others", "--exclude-standard")
    )


def recorded_paths() -> set[str]:
    if not LEDGER.exists():
        return set()
    paths: set[str] = set()
    in_files = False
    for line in LEDGER.read_text(encoding="utf-8").splitlines():
        if line == FILES_HEADING:
            in_files = True
            continue
        if in_files and line.startswith("### "):
            in_files = False
        if in_files:
            match = re.match(r"^- `([^`]+)`(?:\s|$)", line)
            if match:
                paths.add(match.group(1))
    return paths


def main() -> int:
    try:
        changed = changed_paths()
    except subprocess.CalledProcessError as error:
        print(error.stderr.strip() or "Unable to inspect Git changes.", file=sys.stderr)
        return 2
    recorded = recorded_paths()
    uncovered = sorted(changed - recorded)
    print(f"Changed files: {len(changed)}")
    print(f"Recorded changed files: {len(changed & recorded)}")
    if uncovered:
        print("Uncovered files:")
        for path in uncovered:
            print(f"- {path}")
        return 1
    print("Coverage: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
