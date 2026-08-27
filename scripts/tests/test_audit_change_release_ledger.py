#!/usr/bin/env python3
"""Regression tests for ledger lineage and read-only Release Attempt reports."""

from __future__ import annotations

import importlib.util
import io
import json
import hashlib
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
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


def selected_files_without_ledger(env_file: bool, generated: bool) -> list[str]:
    paths = ["src/feature.txt"]
    if env_file:
        paths.append("config/.env")
    if generated:
        paths.append("dist/generated.js")
    return paths


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

    def _ledger(
        self,
        *,
        candidate_hash: str,
        commit_sha: str,
        scope_hunks: list[tuple[str, str]],
    ) -> str:
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
        hunk_lines = "\n".join(
            f"- `{path}` — SHA-256: `{fingerprint}`" for path, fingerprint in scope_hunks
        )
        return f"""# Change Release Ledger
{other_crl}
## CRL-20260803-777 — Fixture release attempt

- **Repository:** `{EXPECTED_REPOSITORY}`
- **Request:** Preserve this fixture's business identity.
- **Outcome:** Fixture behavior remains separately attributable.

### Implementation

- Fixture implementation identity.

### Files / Areas

{files}

### Validation

- `fixture-validation` — passed: isolated Git fixture.

### Staged Commit Scope

- **Repository:** `{EXPECTED_REPOSITORY}`
- **Status:** `prepared`
- **Untracked review:** `none`
{hunk_lines}

### Release Attempts

#### RA-20260803-777

- Repository: `{EXPECTED_REPOSITORY}`
- Selected CRLs: `CRL-20260803-777`
- Selected CRL identities: `{EXPECTED_REPOSITORY}/CRL-20260803-777`
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

## CRL-20260803-778 — Fixture dependency

- **Repository:** `{EXPECTED_REPOSITORY}`
- **Request:** Provide a verifiable dependency fixture.
- **Outcome:** The dependency CRL is bound to the candidate content commit.

### Files / Areas

- `src/dependency.txt` — dependency fixture path.

### Release Attempts

#### RA-20260803-778

- Repository: `{EXPECTED_REPOSITORY}`
- Selected CRLs: `CRL-20260803-778`
- Selected CRL identities: `{EXPECTED_REPOSITORY}/CRL-20260803-778`
- Commit SHA: `{commit_sha}`
- Technical state: `committed`
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
        git(self.root, "add", *selected_files_without_ledger(self.env_file, self.generated))
        scope_hunks = sorted(
            set().union(
                *(
                    AUDITOR.diff_hunk_fingerprints(self.root, path, "--cached")
                    for path in selected_files_without_ledger(self.env_file, self.generated)
                )
            )
        )
        self.scope_hunks = scope_hunks
        self._write(
            "docs/change-release-ledger.md",
            self._ledger(
                candidate_hash="0" * 64,
                commit_sha="not committed",
                scope_hunks=scope_hunks,
            ),
        )
        git(self.root, "add", ".")
        git(self.root, "commit", "-qm", "candidate content")
        self.candidate_commit = git(self.root, "rev-parse", "HEAD")
        candidate_hash = AUDITOR.content_patch_sha256(
            self.root, self.base, self.candidate_commit
        )
        self._write(
            "docs/change-release-ledger.md",
            self._ledger(
                candidate_hash=candidate_hash,
                commit_sha=self.candidate_commit,
                scope_hunks=scope_hunks,
            ),
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

    def update_attempt_field(self, name: str, value: str) -> None:
        ledger = self.root / "docs/change-release-ledger.md"
        new_line = f"- {name}: {value}"
        lines = ledger.read_text(encoding="utf-8").splitlines()
        for index, line in enumerate(lines):
            if line.startswith(f"- {name}:"):
                lines[index] = new_line
                break
        else:
            dependency_index = next(
                index for index, line in enumerate(lines) if line.startswith("- Dependencies:")
            )
            lines.insert(dependency_index + 1, new_line)
        content = "\n".join(lines) + "\n"
        self._write(
            "docs/change-release-ledger.md",
            content,
        )
        git(self.root, "add", "docs/change-release-ledger.md")
        git(self.root, "commit", "-qm", f"record {name.lower()} evidence")
        self.head = git(self.root, "rev-parse", "HEAD")

    def stage_pre_commit_candidate(self, content: str = "pre-commit candidate\n") -> None:
        self._write("src/feature.txt", content)
        scope_hunks = sorted(
            AUDITOR.diff_hunk_fingerprints(self.root, "src/feature.txt", "HEAD")
        )
        ledger = self.root / "docs/change-release-ledger.md"
        old_line = f"- `src/feature.txt` — SHA-256: `{self.scope_hunks[0][1]}`"
        new_line = f"- `src/feature.txt` — SHA-256: `{scope_hunks[0][1]}`"
        ledger.write_text(
            ledger.read_text(encoding="utf-8").replace(old_line, new_line),
            encoding="utf-8",
        )
        git(self.root, "add", "src/feature.txt", "docs/change-release-ledger.md")

    def stage_historical_receipt_candidate(self, source_attempt: str = "RA-20260803-777") -> None:
        self.historical_base = self.head
        git(self.root, "update-ref", "refs/remotes/origin/Dev", self.historical_base)
        empty_patch = hashlib.sha256(b"").hexdigest()
        attempt = f"""#### RA-20260803-779

- Repository: `{EXPECTED_REPOSITORY}`
- Selected CRLs: `CRL-20260803-777`
- Selected CRL identities: `{EXPECTED_REPOSITORY}/CRL-20260803-777`
- Intended action: `commit`
- Branch: `codex/historical-receipt-fixture`
- Base: `origin/Dev@{self.historical_base}`; fetched at `fixture-time`
- Candidate patch SHA-256: `{empty_patch}`
- Commit SHA: `not committed`
- Dependencies: none
- Required validation: `PASS`; evidence: `fixture historical receipt`
- Shared-hunk review: `PASS`; evidence: `ledger-only fixture`
- Generated-file review: `not applicable`; evidence: `Markdown only`
- Historical receipt: `true`
- Historical source attempt: `{source_attempt}`
- Technical state: `candidate`
- User authorization: `selected-for-commit`; evidence: `fixture selection`
- Independent review: `not run`
- Action conclusion: `GO`; blockers: none

"""
        ledger = self.root / "docs/change-release-ledger.md"
        ledger.write_text(
            ledger.read_text(encoding="utf-8").replace("\n## CRL-20260803-778", f"\n{attempt}## CRL-20260803-778"),
            encoding="utf-8",
        )
        git(self.root, "add", "docs/change-release-ledger.md")

    def forge_current_historical_source_attempt(self) -> None:
        ledger = self.root / "docs/change-release-ledger.md"
        text = ledger.read_text(encoding="utf-8")
        source_start = text.index("#### RA-20260803-777")
        source_end = text.index("\n#### RA-20260803-779", source_start)
        source_block = text[source_start:source_end].replace(
            "#### RA-20260803-777", "#### RA-20260803-781", 1
        )
        text = text[:source_end] + "\n" + source_block + text[source_end:]
        text = text.replace(
            "Historical source attempt: `RA-20260803-777`",
            "Historical source attempt: `RA-20260803-781`",
            1,
        )
        ledger.write_text(text, encoding="utf-8")
        git(self.root, "add", "docs/change-release-ledger.md")

    def rewrite_historical_source_attempt(self) -> None:
        ledger = self.root / "docs/change-release-ledger.md"
        ledger.write_text(
            ledger.read_text(encoding="utf-8").replace(
                "fixture approval", "forged fixture approval", 1
            ),
            encoding="utf-8",
        )
        git(self.root, "add", "docs/change-release-ledger.md")
        git(self.root, "commit", "-qm", "rewrite historical source attempt")
        self.head = git(self.root, "rev-parse", "HEAD")

    def finish_historical_receipt(self, *, include_nonledger_path: bool = False) -> None:
        git(self.root, "commit", "-qm", "historical receipt candidate")
        self.historical_candidate = git(self.root, "rev-parse", "HEAD")
        empty_patch = AUDITOR.content_patch_sha256(
            self.root, self.historical_base, self.historical_candidate
        )
        push_attempt = f"""#### RA-20260803-780

- Repository: `{EXPECTED_REPOSITORY}`
- Selected CRLs: `CRL-20260803-777`
- Selected CRL identities: `{EXPECTED_REPOSITORY}/CRL-20260803-777`
- Intended action: `push`
- Branch: `codex/historical-receipt-fixture`
- Base: `origin/Dev@{self.historical_base}`; fetched at `fixture-time`
- Candidate patch SHA-256: `{empty_patch}`
- Commit SHA: `{self.historical_candidate}`
- Dependencies: none
- Required validation: `PASS`; evidence: `fixture historical receipt`
- Shared-hunk review: `PASS`; evidence: `ledger-only fixture`
- Generated-file review: `not applicable`; evidence: `Markdown only`
- Historical receipt: `true`
- Historical source attempt: `RA-20260803-777`
- Technical state: `committed`
- User authorization: `approved-for-push`; evidence: `fixture approval`
- Independent review: `GO`; evidence: `fixture review`
- Action conclusion: `GO`; blockers: none

"""
        ledger = self.root / "docs/change-release-ledger.md"
        ledger.write_text(
            ledger.read_text(encoding="utf-8").replace("\n## CRL-20260803-778", f"\n{push_attempt}## CRL-20260803-778"),
            encoding="utf-8",
        )
        if include_nonledger_path:
            self._write("src/feature.txt", "historical receipt must remain ledger-only\n")
            git(self.root, "add", "src/feature.txt")
        git(self.root, "add", "docs/change-release-ledger.md")
        git(self.root, "commit", "-qm", "historical receipt evidence")
        self.head = git(self.root, "rev-parse", "HEAD")

    def historical_receipt_report(self):
        return self.report(base=self.historical_base)


class ReleaseReportTests(unittest.TestCase):
    def test_pre_commit_gate_accepts_initial_historical_receipt_candidate(self) -> None:
        fixture = ReleaseReportFixture(self)
        fixture.stage_historical_receipt_candidate()

        report = AUDITOR.build_pre_commit_report(
            fixture.root, EXPECTED_REPOSITORY, EXPECTED_REPOSITORY, ["CRL-20260803-777"]
        )

        self.assertEqual("GO", report["conclusion"])
        self.assertTrue(any(item["gate"] == "ledger-only receipt" and item["result"] == "PASS" for item in report["checks"]))

    def test_historical_receipt_report_accepts_verified_ledger_only_range(self) -> None:
        fixture = ReleaseReportFixture(self)
        fixture.stage_historical_receipt_candidate()
        fixture.finish_historical_receipt()

        report = fixture.historical_receipt_report()

        self.assertEqual("GO", report["conclusion"])
        self.assertTrue(report["historical_receipt"])
        self.assertTrue(any(item["gate"] == "historical source proof" and item["result"] == "PASS" for item in report["checks"]))

    def test_historical_receipt_blocks_nonledger_current_range(self) -> None:
        fixture = ReleaseReportFixture(self)
        fixture.stage_historical_receipt_candidate()
        fixture.finish_historical_receipt(include_nonledger_path=True)

        report = fixture.historical_receipt_report()

        self.assertEqual("BLOCKED", report["conclusion"])
        self.assertTrue(any("must change only docs/change-release-ledger.md" in blocker for blocker in report["blockers"]))

    def test_historical_receipt_blocks_unknown_source_attempt(self) -> None:
        fixture = ReleaseReportFixture(self)
        fixture.stage_historical_receipt_candidate("RA-20260803-999")

        report = AUDITOR.build_pre_commit_report(
            fixture.root, EXPECTED_REPOSITORY, EXPECTED_REPOSITORY, ["CRL-20260803-777"]
        )

        self.assertEqual("BLOCKED", report["conclusion"])
        self.assertTrue(any("Historical source attempt is missing" in blocker for blocker in report["blockers"]))

    def test_historical_receipt_blocks_source_added_in_current_ledger(self) -> None:
        fixture = ReleaseReportFixture(self)
        fixture.stage_historical_receipt_candidate()
        fixture.forge_current_historical_source_attempt()

        report = AUDITOR.build_pre_commit_report(
            fixture.root, EXPECTED_REPOSITORY, EXPECTED_REPOSITORY, ["CRL-20260803-777"]
        )

        self.assertEqual("BLOCKED", report["conclusion"])
        self.assertTrue(any("must already exist" in blocker for blocker in report["blockers"]))

    def test_historical_receipt_report_blocks_rewritten_source_attempt(self) -> None:
        fixture = ReleaseReportFixture(self)
        fixture.stage_historical_receipt_candidate()
        fixture.finish_historical_receipt()
        fixture.rewrite_historical_source_attempt()

        report = fixture.historical_receipt_report()

        self.assertEqual("BLOCKED", report["conclusion"])
        self.assertTrue(any("byte-for-byte unchanged" in blocker for blocker in report["blockers"]))

    def test_pre_commit_gate_accepts_exact_staged_hunk_scope(self) -> None:
        fixture = ReleaseReportFixture(self)
        fixture.stage_pre_commit_candidate()

        report = AUDITOR.build_pre_commit_report(
            fixture.root,
            EXPECTED_REPOSITORY,
            EXPECTED_REPOSITORY,
            ["CRL-20260803-777"],
        )

        self.assertEqual("GO", report["conclusion"])
        self.assertEqual([], report["untracked_files"])
        self.assertEqual([], report["unexpected_hunks"])

    def test_pre_commit_gate_blocks_untracked_file_without_content_output(self) -> None:
        fixture = ReleaseReportFixture(self)
        fixture.stage_pre_commit_candidate()
        fixture._write("scratch.txt", "do not disclose this content\n")

        report = AUDITOR.build_pre_commit_report(
            fixture.root,
            EXPECTED_REPOSITORY,
            EXPECTED_REPOSITORY,
            ["CRL-20260803-777"],
        )

        self.assertEqual("BLOCKED", report["conclusion"])
        self.assertIn("scratch.txt", report["untracked_files"])
        self.assertNotIn("do not disclose", AUDITOR.markdown_pre_commit_report(report))

    def test_pre_commit_gate_blocks_staged_hunk_outside_declared_scope(self) -> None:
        fixture = ReleaseReportFixture(self)
        fixture._write("src/feature.txt", "undeclared candidate\n")
        git(fixture.root, "add", "src/feature.txt")

        report = AUDITOR.build_pre_commit_report(
            fixture.root,
            EXPECTED_REPOSITORY,
            EXPECTED_REPOSITORY,
            ["CRL-20260803-777"],
        )

        self.assertEqual("BLOCKED", report["conclusion"])
        self.assertTrue(report["unexpected_hunks"])

    def test_pre_commit_gate_accepts_verified_ledger_only_receipt(self) -> None:
        fixture = ReleaseReportFixture(self)
        ledger = fixture.root / "docs/change-release-ledger.md"
        ledger.write_text(
            ledger.read_text(encoding="utf-8").replace(
                "fixture approval", "fixture receipt renewal"
            ),
            encoding="utf-8",
        )
        git(fixture.root, "add", "docs/change-release-ledger.md")

        report = AUDITOR.build_pre_commit_report(
            fixture.root,
            EXPECTED_REPOSITORY,
            EXPECTED_REPOSITORY,
            ["CRL-20260803-777"],
        )

        self.assertEqual("GO", report["conclusion"])
        self.assertTrue(any(item["gate"] == "ledger-only receipt" and item["result"] == "PASS" for item in report["checks"]))

    def test_pre_commit_gate_blocks_ledger_only_change_outside_receipt(self) -> None:
        fixture = ReleaseReportFixture(self)
        ledger = fixture.root / "docs/change-release-ledger.md"
        ledger.write_text(
            ledger.read_text(encoding="utf-8").replace(
                "Fixture release attempt", "Mutated fixture business identity"
            ),
            encoding="utf-8",
        )
        git(fixture.root, "add", "docs/change-release-ledger.md")

        report = AUDITOR.build_pre_commit_report(
            fixture.root,
            EXPECTED_REPOSITORY,
            EXPECTED_REPOSITORY,
            ["CRL-20260803-777"],
        )

        self.assertEqual("BLOCKED", report["conclusion"])
        self.assertTrue(any("outside selected CRL Release Attempts" in blocker for blocker in report["blockers"]))

    def test_pre_commit_gate_blocks_selected_candidate_ledger_hunk_in_other_crl(self) -> None:
        fixture = ReleaseReportFixture(self, shared=True)
        fixture.stage_pre_commit_candidate()
        ledger = fixture.root / "docs/change-release-ledger.md"
        ledger.write_text(
            ledger.read_text(encoding="utf-8").replace(
                "Concurrent fixture", "Mutated unselected fixture"
            ),
            encoding="utf-8",
        )
        git(fixture.root, "add", "docs/change-release-ledger.md")

        report = AUDITOR.build_pre_commit_report(
            fixture.root,
            EXPECTED_REPOSITORY,
            EXPECTED_REPOSITORY,
            ["CRL-20260803-777"],
        )

        self.assertEqual("BLOCKED", report["conclusion"])
        self.assertTrue(any("outside selected CRL sections" in blocker for blocker in report["blockers"]))

    def test_pre_commit_gate_blocks_ledger_receipt_with_bad_content_fingerprint(self) -> None:
        fixture = ReleaseReportFixture(self)
        original = fixture.report()["candidate_patch_sha256"]["recorded"]
        ledger = fixture.root / "docs/change-release-ledger.md"
        ledger.write_text(
            ledger.read_text(encoding="utf-8").replace(original, "0" * 64),
            encoding="utf-8",
        )
        git(fixture.root, "add", "docs/change-release-ledger.md")

        report = AUDITOR.build_pre_commit_report(
            fixture.root,
            EXPECTED_REPOSITORY,
            EXPECTED_REPOSITORY,
            ["CRL-20260803-777"],
        )

        self.assertEqual("BLOCKED", report["conclusion"])
        self.assertTrue(any("candidate patch fingerprint" in blocker for blocker in report["blockers"]))

    def test_cli_range_coverage_accepts_base_and_head_without_release_report(self) -> None:
        fixture = ReleaseReportFixture(self)
        stream = io.StringIO()

        with redirect_stdout(stream):
            code = AUDITOR.main(["--base", fixture.base, "--head", fixture.head], root=fixture.root)

        self.assertEqual(0, code)
        self.assertIn("Audit scope:", stream.getvalue())
        self.assertIn("Coverage: PASS", stream.getvalue())

    def test_cli_range_coverage_reports_unrecorded_paths(self) -> None:
        fixture = ReleaseReportFixture(self)
        fixture._write("src/unrecorded.txt", "outside the fixture ledger\n")
        git(fixture.root, "add", "src/unrecorded.txt")
        git(fixture.root, "commit", "-qm", "unrecorded range path")
        stream = io.StringIO()

        with redirect_stdout(stream):
            code = AUDITOR.main(["--base", fixture.base, "--head", "HEAD"], root=fixture.root)

        self.assertEqual(1, code)
        self.assertIn("src/unrecorded.txt", stream.getvalue())

    def test_cli_range_coverage_requires_complete_range(self) -> None:
        fixture = ReleaseReportFixture(self)
        with self.assertRaises(SystemExit) as error, redirect_stderr(io.StringIO()):
            AUDITOR.main(["--base", fixture.base], root=fixture.root)
        self.assertEqual(2, error.exception.code)

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

    def test_same_repository_dependency_must_be_an_ancestor_of_head(self) -> None:
        fixture = ReleaseReportFixture(self)
        current_branch = git(fixture.root, "branch", "--show-current")
        git(fixture.root, "checkout", "-qb", "dependency-side", fixture.base)
        fixture._write("src/dependency.txt", "side dependency\n")
        git(fixture.root, "add", "src/dependency.txt")
        git(fixture.root, "commit", "-qm", "side dependency")
        side_commit = git(fixture.root, "rev-parse", "HEAD")
        git(fixture.root, "checkout", "-q", current_branch)
        fixture.update_attempt_field(
            "Dependencies",
            f"{EXPECTED_REPOSITORY}/CRL-20260803-778@{side_commit}",
        )

        report = fixture.report()

        self.assertEqual("BLOCKED", report["conclusion"])
        self.assertTrue(any("is not an ancestor" in blocker for blocker in report["blockers"]))

    def test_same_repository_dependency_ancestor_is_verified(self) -> None:
        fixture = ReleaseReportFixture(self)
        fixture.update_attempt_field(
            "Dependencies",
            f"{EXPECTED_REPOSITORY}/CRL-20260803-778@{fixture.candidate_commit}",
        )

        report = fixture.report()

        self.assertEqual("GO", report["conclusion"])
        self.assertIn(
            f"{EXPECTED_REPOSITORY}/CRL-20260803-778@{fixture.candidate_commit}",
            report["dependency_references"],
        )

    def test_same_repository_dependency_requires_an_existing_crl(self) -> None:
        fixture = ReleaseReportFixture(self)
        fixture.update_attempt_field(
            "Dependencies",
            f"{EXPECTED_REPOSITORY}/CRL-20260803-779@{fixture.candidate_commit}",
        )

        report = fixture.report()

        self.assertEqual("BLOCKED", report["conclusion"])
        self.assertTrue(any("does not name a CRL" in blocker for blocker in report["blockers"]))

    def test_same_repository_dependency_sha_must_bind_to_its_crl(self) -> None:
        fixture = ReleaseReportFixture(self)
        fixture.update_attempt_field(
            "Dependencies",
            f"{EXPECTED_REPOSITORY}/CRL-20260803-778@{fixture.base}",
        )

        report = fixture.report()

        self.assertEqual("BLOCKED", report["conclusion"])
        self.assertTrue(any("is not bound" in blocker for blocker in report["blockers"]))

    def test_cross_repository_dependency_requires_exact_separate_evidence(self) -> None:
        fixture = ReleaseReportFixture(self)
        other_repository = "mobile" if EXPECTED_REPOSITORY == "root" else "root"
        reference = f"{other_repository}/CRL-20260803-778@{fixture.candidate_commit}"
        fixture.update_attempt_field("Dependencies", reference)

        unverified = fixture.report()

        self.assertEqual("NOT VERIFIED", unverified["conclusion"])
        self.assertTrue(any("cannot be verified from a free-text field" in item for item in unverified["missing_evidence"]))
        fixture.update_attempt_field(
            "Cross-repository dependency verification",
            f"PASS — {reference} confirmed in the paired repository at fixture-time.",
        )

        asserted = fixture.report()

        self.assertEqual("NOT VERIFIED", asserted["conclusion"])
        self.assertTrue(any("cannot be verified from a free-text field" in item for item in asserted["missing_evidence"]))

    def test_dependency_reference_requires_full_canonical_sha(self) -> None:
        fixture = ReleaseReportFixture(self)
        fixture.update_attempt_field("Dependencies", f"{EXPECTED_REPOSITORY}/CRL-20260803-778")

        report = fixture.report()

        self.assertEqual("BLOCKED", report["conclusion"])
        self.assertTrue(any("Dependencies must be" in blocker for blocker in report["blockers"]))

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

    def test_missing_push_authorization_is_blocked_in_dirty_worktree(self) -> None:
        fixture = ReleaseReportFixture(self)
        ledger = fixture.root / "docs/change-release-ledger.md"
        ledger.write_text(
            ledger.read_text(encoding="utf-8").replace(
                "approved-for-push", "selected-for-commit"
            ),
            encoding="utf-8",
        )

        report = fixture.report()

        self.assertEqual("BLOCKED", report["conclusion"])
        self.assertIn("Explicit approved-for-push authorization is missing.", report["missing_evidence"])
        self.assertEqual("dirty", report["git_worktree_state"])
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

        coverage_output = io.StringIO()
        with redirect_stdout(coverage_output):
            coverage_code = AUDITOR.main([], root=fixture.root, expected_repository=EXPECTED_REPOSITORY)
        self.assertEqual(1, coverage_code)
        self.assertIn("Duplicate CRL ID", coverage_output.getvalue())

    def test_published_crl_cannot_append_behavior_update(self) -> None:
        fixture = ReleaseReportFixture(self)
        ledger = fixture.root / "docs/change-release-ledger.md"
        ledger.write_text(
            ledger.read_text(encoding="utf-8").replace(
                "- Technical state: `committed`", "- Technical state: pushed"
            )
            + "\n### Update — Fixture behavior correction\n\n- New behavior: fixture changes after publication.\n",
            encoding="utf-8",
        )

        coverage_output = io.StringIO()
        with redirect_stdout(coverage_output):
            coverage_code = AUDITOR.main([], root=fixture.root, expected_repository=EXPECTED_REPOSITORY)

        self.assertEqual(1, coverage_code)
        self.assertIn("Published CRL cannot add a behavior update", coverage_output.getvalue())
        self.assertEqual("BLOCKED", fixture.report()["conclusion"])

    def test_origin_crl_identity_change_blocks_coverage_audit(self) -> None:
        fixture = ReleaseReportFixture(self)
        git(fixture.root, "update-ref", "refs/remotes/origin/Dev", fixture.head)
        ledger = fixture.root / "docs/change-release-ledger.md"
        ledger.write_text(
            ledger.read_text(encoding="utf-8").replace(
                "Fixture release attempt", "Different business unit"
            ),
            encoding="utf-8",
        )

        coverage_output = io.StringIO()
        with redirect_stdout(coverage_output):
            coverage_code = AUDITOR.main([], root=fixture.root, expected_repository=EXPECTED_REPOSITORY)

        self.assertEqual(1, coverage_code)
        self.assertIn("immutable business identity", coverage_output.getvalue())
        report = fixture.report()
        self.assertEqual("BLOCKED", report["conclusion"])
        self.assertTrue(any("immutable business identity" in blocker for blocker in report["blockers"]))

    def test_origin_crl_cannot_be_omitted_from_local_ledger(self) -> None:
        fixture = ReleaseReportFixture(self)
        git(fixture.root, "update-ref", "refs/remotes/origin/Dev", fixture.head)
        (fixture.root / "docs/change-release-ledger.md").write_text(
            "# Change Release Ledger\n", encoding="utf-8"
        )

        coverage_output = io.StringIO()
        with redirect_stdout(coverage_output):
            coverage_code = AUDITOR.main([], root=fixture.root, expected_repository=EXPECTED_REPOSITORY)

        self.assertEqual(1, coverage_code)
        self.assertIn("omits CRLs already present in origin/Dev", coverage_output.getvalue())

    def test_validation_evidence_may_change_without_reusing_business_identity(self) -> None:
        fixture = ReleaseReportFixture(self)
        git(fixture.root, "update-ref", "refs/remotes/origin/Dev", fixture.head)
        ledger = fixture.root / "docs/change-release-ledger.md"
        ledger.write_text(
            ledger.read_text(encoding="utf-8").replace(
                "fixture-validation` — passed: isolated Git fixture",
                "fixture-validation` — passed: refreshed local evidence",
            ),
            encoding="utf-8",
        )

        with redirect_stdout(io.StringIO()):
            coverage_code = AUDITOR.main([], root=fixture.root, expected_repository=EXPECTED_REPOSITORY)

        self.assertEqual(0, coverage_code)

    def test_missing_origin_dev_is_not_verified(self) -> None:
        fixture = ReleaseReportFixture(self)
        git(fixture.root, "update-ref", "-d", "refs/remotes/origin/Dev")

        coverage_output = io.StringIO()
        with redirect_stdout(coverage_output):
            coverage_code = AUDITOR.main([], root=fixture.root, expected_repository=EXPECTED_REPOSITORY)

        self.assertEqual(2, coverage_code)
        self.assertIn("NOT VERIFIED", coverage_output.getvalue())


if __name__ == "__main__":
    unittest.main()
