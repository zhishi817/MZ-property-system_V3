#!/usr/bin/env python3
"""Protect the event layering and paired-mobile contract of Root Quality Gate."""

from pathlib import Path
import os
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/quality.yml"
RISK_CLASSIFIER = ROOT / "scripts/ci/classify_pr_risk.sh"
MOBILE_REF_RESOLVER = ROOT / "scripts/ci/resolve_mobile_ci_ref.sh"


def job_section(workflow: str, job: str, next_job: str | None = None) -> str:
    start = workflow.index(f"\n  {job}:\n")
    if next_job is None:
        return workflow[start:]
    return workflow[start:workflow.index(f"\n  {next_job}:\n", start)]


class RootQualityWorkflowContractTests(unittest.TestCase):
    def test_pull_requests_target_dev_while_integration_pushes_cover_dev_and_main(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        trigger = workflow[:workflow.index("\nconcurrency:")]
        self.assertIn("pull_request:\n    branches: [Dev]", trigger)
        self.assertNotIn("branches: [Dev, main]", trigger)
        self.assertIn("push:\n    branches:\n      - main\n      - Dev", trigger)

    def test_root_quality_check_is_a_lightweight_required_aggregator(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        check = job_section(workflow, "check")
        self.assertIn("name: Root Quality Check", check)
        self.assertIn("needs: [risk, ledger, registry, fast, full]", check)
        self.assertIn("if: ${{ always() }}", check)
        self.assertNotIn("npm run check:backend", workflow)
        self.assertNotIn("npm run check:frontend", workflow)
        self.assertNotIn("npm ci", check)

    def test_code_events_run_fast_and_pull_requests_defer_full_until_integration(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        fast = job_section(workflow, "fast", "full")
        full = job_section(workflow, "full", "check")
        self.assertIn("RUN_FAST: ${{ needs.risk.outputs.ledger_only != 'true' }}", fast)
        self.assertIn("Fast regression not required for a ledger-only pull request", fast)
        self.assertNotIn(
            "RUN_FAST: ${{ github.event_name == 'pull_request'",
            fast,
        )
        self.assertEqual(1, fast.count("npm run check:ci"))
        self.assertIn("RUN_FULL: ${{ github.event_name != 'pull_request' }}", full)
        self.assertIn("Full regression deferred until integration", full)
        self.assertEqual(1, full.count("npm run check:full"))

    def test_ledger_only_pull_request_keeps_checks_without_installing_dependencies(self) -> None:
        classified = subprocess.run(
            ["bash", str(RISK_CLASSIFIER), "--stdin"],
            input="docs/change-release-ledger.md\n",
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertIn("ledger_only=true", classified.stdout)
        self.assertIn("full_required=false", classified.stdout)

        workflow = WORKFLOW.read_text(encoding="utf-8")
        registry = job_section(workflow, "registry", "fast")
        fast = job_section(workflow, "fast", "full")
        self.assertIn("ledger_only", registry)
        self.assertIn("Registry audit not required for a ledger-only pull request", registry)
        self.assertIn("ledger_only", fast)

    def test_code_change_is_not_classified_as_ledger_only(self) -> None:
        classified = subprocess.run(
            ["bash", str(RISK_CLASSIFIER), "--stdin"],
            input=".github/workflows/quality.yml\ndocs/change-release-ledger.md\n",
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertIn("ledger_only=false", classified.stdout)
        self.assertIn("full_required=true", classified.stdout)

    def test_all_real_mobile_checkouts_use_the_resolved_ref(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertEqual(3, workflow.count("ref: ${{ steps.mobile-ref.outputs.ref }}"))
        self.assertEqual(3, workflow.count("resolve_mobile_ci_ref.sh"))

    def test_resolver_prefers_a_matching_branch_and_falls_back_to_dev(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fake_git = Path(temporary) / "git"
            fake_git.write_text(
                "#!/usr/bin/env bash\ncase \"$*\" in *matching-branch*) exit 0 ;; *) exit 2 ;; esac\n",
                encoding="utf-8",
            )
            fake_git.chmod(0o755)
            environment = {**os.environ, "PATH": f"{temporary}:{os.environ['PATH']}"}
            matching = subprocess.run(
                ["bash", str(MOBILE_REF_RESOLVER), "matching-branch"],
                check=True,
                capture_output=True,
                text=True,
                env=environment,
            )
            fallback = subprocess.run(
                ["bash", str(MOBILE_REF_RESOLVER), "missing-branch"],
                check=True,
                capture_output=True,
                text=True,
                env=environment,
            )
        self.assertEqual("matching-branch", matching.stdout.strip())
        self.assertEqual("Dev", fallback.stdout.strip())

    def test_resolver_fails_closed_when_branch_lookup_errors(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fake_git = Path(temporary) / "git"
            fake_git.write_text(
                "#!/usr/bin/env bash\necho 'simulated remote failure' >&2\nexit 128\n",
                encoding="utf-8",
            )
            fake_git.chmod(0o755)
            environment = {**os.environ, "PATH": f"{temporary}:{os.environ['PATH']}"}
            failed = subprocess.run(
                ["bash", str(MOBILE_REF_RESOLVER), "matching-branch"],
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )
        self.assertEqual(128, failed.returncode)
        self.assertEqual("", failed.stdout)
        self.assertIn("simulated remote failure", failed.stderr)
        self.assertIn("Unable to resolve matching mobile branch", failed.stderr)


if __name__ == "__main__":
    unittest.main()
