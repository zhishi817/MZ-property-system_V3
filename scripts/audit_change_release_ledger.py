#!/usr/bin/env python3
"""Check that every Git change in a working tree or commit range is in the ledger."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / "docs" / "change-release-ledger.md"
FILES_HEADING = "### Files / Areas"


class GitInspectionError(RuntimeError):
    """Raised when the requested Git state cannot be inspected safely."""


def git_output(*args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=ROOT, check=False, capture_output=True, text=True
    )
    if result.returncode:
        detail = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
        raise GitInspectionError(detail or f"git {' '.join(args)} failed with exit code {result.returncode}.")
    return result.stdout


def git_paths(*args: str) -> set[str]:
    return {line.strip() for line in git_output(*args).splitlines() if line.strip()}


def changed_paths() -> set[str]:
    return (
        git_paths("diff", "--name-only")
        | git_paths("diff", "--cached", "--name-only")
        | git_paths("ls-files", "--others", "--exclude-standard")
    )


def changed_paths_in_range(base: str, head: str) -> tuple[set[str], str, str]:
    try:
        base_sha = git_output("rev-parse", "--verify", f"{base}^{{commit}}").strip()
        head_sha = git_output("rev-parse", "--verify", f"{head}^{{commit}}").strip()
    except GitInspectionError as error:
        raise GitInspectionError(f"Unable to resolve exact PR range `{base}`...`{head}`.\n{error}") from error
    revision_range = f"{base_sha}...{head_sha}"
    paths = git_paths("diff", "--name-only", revision_range)
    paths |= git_paths("diff", "--name-only", "--no-renames", revision_range)
    git_output("diff", "--check", revision_range)
    return paths, base_sha, head_sha


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


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", help="Base commit SHA or ref for a pull-request range")
    parser.add_argument("--head", help="Head commit SHA or ref for a pull-request range")
    args = parser.parse_args(argv)
    if bool(args.base) != bool(args.head):
        parser.error("--base and --head must be supplied together.")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.base and args.head:
            changed, base_sha, head_sha = changed_paths_in_range(args.base, args.head)
            print(f"Audit scope: {base_sha}...{head_sha}")
        else:
            changed = changed_paths()
            print("Audit scope: working tree")
    except GitInspectionError as error:
        print(str(error), file=sys.stderr)
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
