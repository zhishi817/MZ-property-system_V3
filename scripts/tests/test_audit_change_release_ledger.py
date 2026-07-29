#!/usr/bin/env python3
"""Regression coverage for release-ledger PR range auditing."""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_SOURCE = Path(__file__).resolve().parents[1] / "audit_change_release_ledger.py"


class LedgerRangeAuditTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.repo = Path(self.tempdir.name) / "repo"
        (self.repo / "docs").mkdir(parents=True)
        (self.repo / "scripts").mkdir()
        shutil.copy2(SCRIPT_SOURCE, self.repo / "scripts" / SCRIPT_SOURCE.name)
        self.git("init", "-q")
        self.git("config", "user.email", "ledger-audit@example.test")
        self.git("config", "user.name", "Ledger Audit Test")
        self.write_ledger("docs/change-release-ledger.md")
        self.commit("initial ledger")

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def git(self, *args: str) -> str:
        return subprocess.run(
            ["git", *args],
            cwd=self.repo,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    def commit(self, message: str) -> str:
        self.git("add", "-A")
        self.git("commit", "-qm", message)
        return self.git("rev-parse", "HEAD")

    def write_ledger(self, *paths: str) -> None:
        entries = "\n".join(f"- `{path}` — test fixture." for path in paths)
        (self.repo / "docs" / "change-release-ledger.md").write_text(
            "# Change Release Ledger\n\n"
            "## CRL-test — range fixture\n\n"
            "### Files / Areas\n"
            f"{entries}\n",
            encoding="utf-8",
        )

    def run_audit(self, base: str, head: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                "scripts/audit_change_release_ledger.py",
                "--base",
                base,
                "--head",
                head,
            ],
            cwd=self.repo,
            capture_output=True,
            text=True,
        )

    def test_fails_for_committed_file_missing_from_ledger(self) -> None:
        base = self.git("rev-parse", "HEAD")
        (self.repo / "unregistered.txt").write_text("missing\n", encoding="utf-8")
        head = self.commit("add unregistered file")

        result = self.run_audit(base, head)

        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("- unregistered.txt", result.stdout)

    def test_fails_for_an_unknown_sha_instead_of_reporting_zero_changes(self) -> None:
        head = self.git("rev-parse", "HEAD")

        result = self.run_audit("not-a-commit", head)

        self.assertEqual(result.returncode, 2)
        self.assertIn("Unable to resolve base commit", result.stderr)
        self.assertNotIn("Changed files: 0", result.stdout)

    def test_requires_both_paths_for_rename_and_deleted_path(self) -> None:
        (self.repo / "legacy-name.txt").write_text("legacy\n", encoding="utf-8")
        (self.repo / "removed.txt").write_text("removed\n", encoding="utf-8")
        self.write_ledger(
            "docs/change-release-ledger.md", "legacy-name.txt", "removed.txt"
        )
        base = self.commit("add source files")
        self.git("mv", "legacy-name.txt", "renamed.txt")
        (self.repo / "removed.txt").unlink()
        self.write_ledger(
            "docs/change-release-ledger.md",
            "legacy-name.txt",
            "renamed.txt",
            "removed.txt",
        )
        head = self.commit("rename and delete")

        result = self.run_audit(base, head)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Changed files: 4", result.stdout)
        self.assertIn("Coverage: PASS", result.stdout)

    def test_works_when_head_is_detached(self) -> None:
        base = self.git("rev-parse", "HEAD")
        (self.repo / "covered.txt").write_text("covered\n", encoding="utf-8")
        self.write_ledger("docs/change-release-ledger.md", "covered.txt")
        head = self.commit("add covered file")
        self.git("checkout", "--detach", "-q", head)

        result = self.run_audit(base, head)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Audit scope:", result.stdout)

    def test_fails_when_range_contains_whitespace_error(self) -> None:
        base = self.git("rev-parse", "HEAD")
        (self.repo / "whitespace.txt").write_text("trailing space \n", encoding="utf-8")
        self.write_ledger("docs/change-release-ledger.md", "whitespace.txt")
        head = self.commit("add whitespace error")

        result = self.run_audit(base, head)

        self.assertEqual(result.returncode, 2)
        self.assertIn("trailing whitespace", result.stderr)

    def test_acceptance_negative_control(self) -> None:
        self.fail("ACCEPTANCE_NEGATIVE: deliberate Phase 3 root Fast failure")


if __name__ == "__main__":
    unittest.main()
