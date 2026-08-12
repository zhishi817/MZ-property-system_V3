#!/usr/bin/env python3
"""Protect the paired mobile-source prerequisite of Root Quality Gate."""

from pathlib import Path
import os
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/quality.yml"
MOBILE_REF_RESOLVER = ROOT / "scripts/ci/resolve_mobile_ci_ref.sh"


class RootQualityWorkflowContractTests(unittest.TestCase):
    def test_checks_out_mobile_before_backend_checks(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        job_start = workflow.index("\n  check:\n")
        job_end = workflow.index("\n  ledger:\n", job_start)
        job = workflow[job_start:job_end]

        mobile_checkout = "- name: Checkout mobile repository"
        backend_checks = "- name: Run backend checks"
        self.assertIn(mobile_checkout, job)
        self.assertIn("repository: zhishi817/mz-cleaning-app-frontend", job)
        self.assertIn("id: mobile-ref", job)
        self.assertIn("MOBILE_CANDIDATE_REF", job)
        self.assertIn("github.event_name == 'pull_request'", job)
        self.assertIn("resolve_mobile_ci_ref.sh", job)
        self.assertIn("ref: ${{ steps.mobile-ref.outputs.ref }}", job)
        self.assertIn("path: mz-cleaning-app-frontend", job)
        self.assertLess(job.index(mobile_checkout), job.index(backend_checks))

    def test_all_mobile_checkouts_use_the_resolved_ref(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertEqual(4, workflow.count("ref: ${{ steps.mobile-ref.outputs.ref }}"))
        self.assertEqual(4, workflow.count("resolve_mobile_ci_ref.sh"))

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
                check=True, capture_output=True, text=True, env=environment,
            )
            fallback = subprocess.run(
                ["bash", str(MOBILE_REF_RESOLVER), "missing-branch"],
                check=True, capture_output=True, text=True, env=environment,
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
                check=False, capture_output=True, text=True, env=environment,
            )
        self.assertEqual(128, failed.returncode)
        self.assertEqual("", failed.stdout)
        self.assertIn("simulated remote failure", failed.stderr)
        self.assertIn("Unable to resolve matching mobile branch", failed.stderr)


if __name__ == "__main__":
    unittest.main()
