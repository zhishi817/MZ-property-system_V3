# Development workspace lifecycle

These rules apply to new features, fixes, testing and release preparation. They supplement, and never relax, AGENTS.md, the change ledger, release review or user authorization requirements.

## Before starting or retrying work

1. Inspect `git worktree list --porcelain` and the task's existing workspace, branch, CRL, uncommitted/untracked changes and dependency links. Reuse the workspace for the same scope; do not create another dated full copy on every retry.
2. Keep each independent repository's existing Git common directory. When isolation is necessary, create a source-only Git worktree from an explicitly recorded commit. Do not copy `.git`, `node_modules`, `.next`, `dist`, `build`, `Pods` or native build caches into it. Git-tracked generated files remain tracked evidence and are not disposable merely because of their directory name.
3. Keep one active workspace per task/scope per repository. Parallel independent tasks may have separate source worktrees. A selected multi-task release uses one integration worktree/temporary release branch per repository, as the existing release topology requires, not one per CRL. Do not bypass clean release-worktree requirements to save space.
4. Record workspace path, repository/common directory, base SHA, scope/CRL, active owner, dependency sources/consumers and retention status in the task's local operational receipt. Keep machine-specific paths out of committed project instructions. Existing legacy-frozen/mixed workspaces are protected source evidence, never bulk-reset or cleaned.

## Dependencies and writable build outputs

- Do not reinstall or duplicate dependencies by default. Reuse only after verifying the exact package manifest/lockfile, Node/runtime version and architecture match, and that this task does not change dependencies or require an isolated native build.
- A symlink is not a backup. Resolve the complete link chain and record all consumers. Never run installation/update/removal through shared dependency links; concurrent installs into a shared target are prohibited. Dependency changes require independent installation and existing user approval rules. Do not change package manager as an incidental cleanup.
- Keep `.next` and other writable build outputs isolated per worktree. Do not link writable build caches across branches. Reuse the same task's build workspace when safe, instead of creating a fresh full project copy.
- Do not remove outputs supporting an active preview, debugger, simulator/native build or pending verification. Finishing one unit does not mean another consumer is finished.

## Completion and cleanup gate

1. Keep source, untracked changes, lockfiles, commits, CRLs, test/review receipts and necessary release artifacts. Preserve unique local work regardless of age or merge labels.
2. Inventory exact candidate paths and disk use without double-counting hardlinks/shared targets. Report candidate size and exclusions to the user before cleanup. If process/reference/state checks are incomplete, mark the candidate NOT VERIFIED, not safe.
3. Recheck full Git status (including untracked files), tracked-file membership, active processes/open files, inbound and transitive symlinks, and other worktree consumers immediately before removal. Stop on concurrent changes, active users or an unknown consumer. Never infer safety from folder date alone.
4. Only remove the approved cache paths. Have a verified equivalent recovery copy or normal product recovery, or obtain the required action-time confirmation for permanent deletion. A lockfile/rebuild command alone is not proof of an equivalent copy of the bytes being deleted. Obtain any other required permissions before acting.
5. Verify a recovery archive against every original file/link before deleting originals. Record the restore command, verification result, archive location and before/after disk space. Retained backup size must be subtracted from claimed space savings; APFS sharing and background activity can change measured free-space results.
6. Never automatically permanently delete, empty Trash, delete recovery archives, run `git clean -fdx`, force-remove worktrees, remove shared dependencies, or clear the user's npm cache. No scheduler, install hook or CI job may perform workstation cleanup under these rules.
7. Removing an entire source worktree is a separate step: verify all changes/commits and evidence are retained, dependencies have no consumers, and authorization covers that worktree; use normal `git worktree remove`, never `--force`.

## Boundaries and reporting

This is a development-storage procedure, not authorization to alter production data, roles, business rules, dependency versions, system permissions or deployment settings. Existing confirmation and independent release gates remain in force.

Report cleanup actually performed separately from proposed cleanup, and local rules changes separately from committed/merged rules. Rules in an uncommitted isolated worktree do not automatically govern other existing checkouts. Do not claim global adoption until the relevant repository changes are merged and the consuming checkout includes them.
