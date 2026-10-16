# MZ-035 Dev/main Synchronization Receipt

This document records the review boundary for the temporary synchronization pull request that unblocks PR #397 without updating the protected `Dev` branch directly.

## Fixed inputs

- Repository: `zhishi817/MZ-property-system_V3` (`root`).
- Target branch: `Dev`.
- Temporary branch: `codex/mz035-sync-main-into-dev-20261016`.
- Dev input: `5f90637aae1a90b4602cc11566869d41b2e86054`.
- Main input: `eeaf4bb5433ab4833f98e64de6aea8da9dcd92be`.
- Merge base: `9b3108be5fc5cf9d2d86545be4a6e1a91f35f325`.
- PR #397 remains `Dev` to `main` and is not modified by this candidate.

## Required history shape

The synchronization commit must be a normal merge commit whose first-parent history contains the fixed Dev input and whose second parent is the fixed main input. The synchronization pull request must later be merged into `Dev` with the ordinary merge method. Squash or rebase is not acceptable because it would discard the `main` parent ancestry that this synchronization exists to preserve.

## Content boundary

An isolated merge preflight completed without conflicts. Before this receipt was added, the net tree change from the fixed Dev input was only the 23-line main release receipt in `docs/change-release-ledger.md`. This receipt adds no runtime behavior and does not reinterpret that historical receipt.

The candidate does not change application source, tests, package manifests, workflows, branch protection, migrations, dependencies, environment configuration, deployment configuration, or Mobile code.

## Safety boundary

This synchronization performs no production database or API operation, migration, deployment, preview, Mobile build, OTA publication, external synchronization, notification, or device verification. Final merge of the synchronization pull request and PR #397 remains a manual user action.

## Verification

The implementation thread must verify the exact merge parents, changed paths, candidate fingerprint, ledger gates, repository fast regression, independent review, remote branch SHA, Draft PR target, and terminal GitHub checks before reporting the candidate ready for manual merge.
