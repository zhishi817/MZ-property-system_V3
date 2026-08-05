#!/usr/bin/env python3
"""Protect the mobile-source prerequisite of Root Quality Check."""

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/quality.yml"


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
        self.assertIn("ref: Dev", job)
        self.assertIn("path: mz-cleaning-app-frontend", job)
        self.assertLess(job.index(mobile_checkout), job.index(backend_checks))


if __name__ == "__main__":
    unittest.main()
