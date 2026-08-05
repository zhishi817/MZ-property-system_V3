#!/usr/bin/env python3
"""Regression tests for the read-only Release Attempt report."""

from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path


AUDITOR_PATH = Path(__file__).resolve().parents[1] / "audit_change_release_ledger.py"
EXPECTED_REPOSITORY = (
    "mobile" if "mz-cleaning-app-frontend" in str(AUDITOR_PATH) else "root"
)


def load_auditor():
    spec = importlib.util.spec_from_file_location("release_ledger_auditor", AUDITOR_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


AUDITOR = load_auditor()


def git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=root, check=True, capture_output=True, text=True
    )
    return result.stdout.strip()


class ReleaseReportFixture:
    def __init__(
        self,
        test_case: unittest.TestCase,
        *,
        shared: bool = False,
        env_file: bool = False,
        generated: bool = False,
    ) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        test_case.addCleanup(self._temporary.cleanup)
        self.root = Path(self._temporary.name)
        self.shared = shared
        self.env_file = env_file
        self.generated = generated
        self._create()

    def _write(self, relative_path: str, content: str) -> None:
        path = self.root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def _ledger(self, *, candidate_hash: str, commit_sha: str) -> str:
        other_crl = ""
        if self.shared:
            other_crl = """
## CRL-20260101-099 — Concurrent fixture

### Files / Areas

- `src/feature.txt` — shared fixture path.
"""
        selected_files = ["src/feature.txt", "docs/change-release-ledger.md"]
        if self.env_file:
            selected_files.append("config/.env")
        if self.generated:
            selected_files.append("dist/generated.js")
        files = "\n".join(f"- `{path}` — fixture release path." for path in selected_files)
        return f"""# Change Release Ledger
{other_crl}
## CRL-20260803-777 — Fixture release attempt

### Files / Areas

{files}

### Validation

- `fixture-validation` — passed: isolated Git fixture.

### Release Attempts

#### RA-20260803-777

- Repository: `{EXPECTED_REPOSITORY}`
- Selected CRLs: `CRL-20260803-777`
- Intended action: `push`
- Branch: `codex/fixture`
- Base: `origin/Dev@{self.base}`; fetched at `fixture-time`
- Candidate patch SHA-256: `{candidate_hash}`
- Commit SHA: `{commit_sha}`
- Dependencies: none
- Required validation: `PASS`; evidence: `fixture-validation`
- Shared-hunk review: `not applicable`; evidence: `fixture has no shared path`
- Generated-file review: `not applicable`; evidence: `fixture has no generated path`
- Technical state: `committed`
- User authorization: `approved-for-push`; evidence: `fixture approval`
- Independent review: `GO`; evidence: `fixture review`
- Action conclusion: `GO`; blockers: none
"""

    def _create(self) -> None:
        git(self.root, "init", "-q")
        git(self.root, "config", "user.email", "fixture@example.invalid")
        git(self.root, "config", "user.name", "Release Fixture")
        self._write("src/feature.txt", "before\n")
        self._write("docs/change-release-ledger.md", "# Change Release Ledger\n")
        git(self.root, "add", "src/feature.txt", "docs/change-release-ledger.md")
        git(self.root, "commit", "-qm", "base fixture")
        self.base = git(self.root, "rev-parse", "HEAD")
        git(self.root, "update-ref", "refs/remotes/origin/Dev", self.base)

        self._write("src/feature.txt", "after\n")
        if self.env_file:
            self._write("config/.env", "FIXTURE_VALUE=not-a-secret\n")
        if self.generated:
            self._write("dist/generated.js", "generated fixture\n")
        self._write(
            "docs/change-release-ledger.md",
            self._ledger(candidate_hash="0" * 64, commit_sha="not committed"),
        )
        git(self.root, "add", ".")
        git(self.root, "commit", "-qm", "candidate content")
        self.candidate_commit = git(self.root, "rev-parse", "HEAD")
        candidate_hash = AUDITOR.content_patch_sha256(
            self.root, self.base, self.candidate_commit
        )
        self._write(
            "docs/change-release-ledger.md",
            self._ledger(candidate_hash=candidate_hash, commit_sha=self.candidate_commit),
        )
        git(self.root, "add", "docs/change-release-ledger.md")
        git(self.root, "commit", "-qm", "record release evidence")
        self.head = git(self.root, "rev-parse", "HEAD")

    def report(self, *, head: str | None = None, base: str | None = None):
        return AUDITOR.build_release_report(
            root=self.root,
            expected_repository=EXPECTED_REPOSITORY,
            repository=EXPECTED_REPOSITORY,
            base_reference=base or self.base,
            head_reference=head or self.head,
            crl_ids=["CRL-20260803-777"],
        )


class ReleaseReportTests(unittest.TestCase):
    def test_legacy_pr_range_audit_remains_available(self) -> None:
        fixture = ReleaseReportFixture(self)
        stream = io.StringIO()
        with redirect_stdout(stream):
            code = AUDITOR.main(["--base", fixture.base, "--head", fixture.head], root=fixture.root)

        self.assertEqual(0, code)
        self.assertIn("Audit scope:", stream.getvalue())
        self.assertIn("Coverage: PASS", stream.getvalue())

    def test_legacy_pr_range_audit_rejects_unrecorded_path(self) -> None:
        fixture = ReleaseReportFixture(self)
        fixture._write("src/unrecorded.txt", "unrecorded\n")
        git(fixture.root, "add", "src/unrecorded.txt")
        git(fixture.root, "commit", "-qm", "unrecorded fixture path")
        stream = io.StringIO()
        with redirect_stdout(stream):
            code = AUDITOR.main(["--base", fixture.base, "--head", "HEAD"], root=fixture.root)

        self.assertEqual(1, code)
        self.assertIn("src/unrecorded.txt", stream.getvalue())

    def test_complete_attempt_is_go_and_has_markdown_json_evidence(self) -> None:
        fixture = ReleaseReportFixture(self)
        report = fixture.report()

        self.assertEqual("GO", report["conclusion"])
        self.assertEqual(fixture.head, report["head"]["sha"])
        self.assertEqual(fixture.candidate_commit, report["candidate_content_commit_sha"])
        self.assertEqual(
            report["candidate_patch_sha256"]["recorded"],
            report["candidate_patch_sha256"]["actual"],
        )
        self.assertEqual([], report["unselected_changed_files"])
        self.assertIn("Release Attempt Report", AUDITOR.markdown_report(report))
        self.assertEqual("GO", json.loads(json.dumps(report))["conclusion"])

    def test_cli_json_is_read_only_and_returns_go(self) -> None:
        fixture = ReleaseReportFixture(self)
        before_ledger = (fixture.root / "docs/change-release-ledger.md").read_bytes()
        before_status = git(fixture.root, "status", "--porcelain")
        stream = io.StringIO()
        with redirect_stdout(stream):
            code = AUDITOR.main(
                [
                    "--release-report",
                    "--repo",
                    EXPECTED_REPOSITORY,
                    "--base",
                    fixture.base,
                    "--head",
                    fixture.head,
                    "--crl",
                    "CRL-20260803-777",
                    "--format",
                    "json",
                ],
                root=fixture.root,
                expected_repository=EXPECTED_REPOSITORY,
            )

        self.assertEqual(0, code)
        self.assertEqual("GO", json.loads(stream.getvalue())["conclusion"])
        self.assertEqual(before_ledger, (fixture.root / "docs/change-release-ledger.md").read_bytes())
        self.assertEqual(before_status, git(fixture.root, "status", "--porcelain"))
        markdown = io.StringIO()
        with redirect_stdout(markdown):
            markdown_code = AUDITOR.main(
                [
                    "--release-report",
                    "--repo",
                    EXPECTED_REPOSITORY,
                    "--base",
                    fixture.base,
                    "--head",
                    fixture.head,
                    "--crl",
                    "CRL-20260803-777",
                ],
                root=fixture.root,
                expected_repository=EXPECTED_REPOSITORY,
            )
        self.assertEqual(0, markdown_code)
        self.assertIn("# Release Attempt Report", markdown.getvalue())

    def test_missing_push_authorization_is_not_verified(self) -> None:
        fixture = ReleaseReportFixture(self)
        ledger = fixture.root / "docs/change-release-ledger.md"
        ledger.write_text(
            ledger.read_text(encoding="utf-8").replace(
                "approved-for-push", "selected-for-commit"
            ),
            encoding="utf-8",
        )

        report = fixture.report()

        self.assertEqual("NOT VERIFIED", report["conclusion"])
        self.assertIn("Explicit approved-for-push authorization is missing.", report["missing_evidence"])
        with redirect_stdout(io.StringIO()):
            code = AUDITOR.main(
                [
                    "--release-report",
                    "--repo",
                    EXPECTED_REPOSITORY,
                    "--base",
                    fixture.base,
                    "--head",
                    fixture.head,
                    "--crl",
                    "CRL-20260803-777",
                ],
                root=fixture.root,
                expected_repository=EXPECTED_REPOSITORY,
            )
        self.assertEqual(2, code)

    def test_stale_origin_base_and_unselected_file_are_blocked(self) -> None:
        fixture = ReleaseReportFixture(self)
        fixture._write("src/unselected.txt", "outside selected CRL\n")
        git(fixture.root, "add", "src/unselected.txt")
        git(fixture.root, "commit", "-qm", "unselected change")
        later_head = git(fixture.root, "rev-parse", "HEAD")
        git(fixture.root, "update-ref", "refs/remotes/origin/Dev", later_head)

        report = fixture.report(head=later_head)

        self.assertEqual("BLOCKED", report["conclusion"])
        self.assertIn("src/unselected.txt", report["unselected_changed_files"])
        self.assertTrue(any("origin/Dev" in blocker for blocker in report["blockers"]))

    def test_shared_file_without_hunk_evidence_is_not_verified(self) -> None:
        fixture = ReleaseReportFixture(self, shared=True)

        report = fixture.report()

        self.assertEqual("NOT VERIFIED", report["conclusion"])
        self.assertIn("src/feature.txt", report["shared_files"])

    def test_sensitive_path_blocks_without_printing_fixture_content(self) -> None:
        fixture = ReleaseReportFixture(self, env_file=True)

        report = fixture.report()
        rendered = AUDITOR.markdown_report(report)

        self.assertEqual("BLOCKED", report["conclusion"])
        self.assertIn("sensitive-file-path", report["sensitive_information"])
        self.assertNotIn("FIXTURE_VALUE", rendered)

    def test_generated_file_requires_explicit_review_evidence(self) -> None:
        fixture = ReleaseReportFixture(self, generated=True)

        report = fixture.report()

        self.assertEqual("NOT VERIFIED", report["conclusion"])
        self.assertIn("dist/generated.js", report["generated_files"])

    def test_repository_boundary_mismatch_is_blocked(self) -> None:
        fixture = ReleaseReportFixture(self)
        other_repository = "mobile" if EXPECTED_REPOSITORY == "root" else "root"

        report = AUDITOR.build_release_report(
            root=fixture.root,
            expected_repository=EXPECTED_REPOSITORY,
            repository=other_repository,
            base_reference=fixture.base,
            head_reference=fixture.head,
            crl_ids=["CRL-20260803-777"],
        )

        self.assertEqual("BLOCKED", report["conclusion"])
        self.assertTrue(any("Repository must be" in blocker for blocker in report["blockers"]))

    def test_invalid_base_reference_is_blocked_and_legacy_coverage_still_passes(self) -> None:
        fixture = ReleaseReportFixture(self)

        invalid = fixture.report(base="deadbeef")
        self.assertEqual("BLOCKED", invalid["conclusion"])
        self.assertEqual(0, AUDITOR.main([], root=fixture.root, expected_repository=EXPECTED_REPOSITORY))

    def test_duplicate_crl_id_blocks_report(self) -> None:
        fixture = ReleaseReportFixture(self)
        ledger = fixture.root / "docs/change-release-ledger.md"
        ledger.write_text(
            ledger.read_text(encoding="utf-8")
            + "\n## CRL-20260803-777 — Duplicate fixture record\n",
            encoding="utf-8",
        )

        report = fixture.report()

        self.assertEqual("BLOCKED", report["conclusion"])
        self.assertIn(
            "Duplicate CRL ID in this repository ledger: CRL-20260803-777",
            report["blockers"],
        )
        with redirect_stdout(io.StringIO()):
            code = AUDITOR.main(
                [
                    "--release-report",
                    "--repo",
                    EXPECTED_REPOSITORY,
                    "--base",
                    fixture.base,
                    "--head",
                    fixture.head,
                    "--crl",
                    "CRL-20260803-777",
                ],
                root=fixture.root,
                expected_repository=EXPECTED_REPOSITORY,
            )
        self.assertEqual(1, code)


if __name__ == "__main__":
    unittest.main()
