#!/usr/bin/env python3
"""Regression coverage for exact PR release-ledger auditing."""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "audit_change_release_ledger.py"


class LedgerRangeAuditTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp.name) / "repo"
        (self.repo / "docs").mkdir(parents=True)
        (self.repo / "scripts").mkdir()
        shutil.copy2(SCRIPT, self.repo / "scripts" / SCRIPT.name)
        self.git("init", "-q")
        self.git("config", "user.email", "ledger-audit@example.test")
        self.git("config", "user.name", "Ledger Audit Test")
        self.ledger("docs/change-release-ledger.md")
        self.commit("initial")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def git(self, *args: str) -> str:
        return subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, message: str) -> str:
        self.git("add", "-A")
        self.git("commit", "-qm", message)
        return self.git("rev-parse", "HEAD")

    def ledger(self, *paths: str) -> None:
        entries = "\n".join(f"- `{path}` — fixture." for path in paths)
        (self.repo / "docs/change-release-ledger.md").write_text(
            f"# Change Release Ledger\n\n## CRL-test\n\n### Files / Areas\n{entries}\n", encoding="utf-8"
        )

    def audit(self, base: str, head: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, "scripts/audit_change_release_ledger.py", "--base", base, "--head", head], cwd=self.repo, capture_output=True, text=True)

    def test_rejects_an_unrecorded_committed_pr_file(self) -> None:
        base = self.git("rev-parse", "HEAD")
        (self.repo / "unrecorded.txt").write_text("missing\n", encoding="utf-8")
        head = self.commit("unrecorded")
        result = self.audit(base, head)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("- unrecorded.txt", result.stdout)

    def test_rejects_an_unresolvable_range(self) -> None:
        result = self.audit("not-a-commit", self.git("rev-parse", "HEAD"))
        self.assertEqual(result.returncode, 2)
        self.assertIn("not-a-commit", result.stderr)


if __name__ == "__main__":
    unittest.main()
