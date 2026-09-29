import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
export const PREVIEW_ROOT = path.resolve(SCRIPT_DIR, '..')
export const PREVIEW_MOBILE = path.resolve(PREVIEW_ROOT, '..', 'mobile')
export const GIT_GUARD_DIR = path.join(PREVIEW_ROOT, '.dev-preview', 'git-hooks')
export const GIT_GUARD_MARKER = '[MZ-DEV-PREVIEW-GIT-GUARD]'

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

export function buildDenyHook(previewRoots = [PREVIEW_ROOT, PREVIEW_MOBILE]) {
  const rootPatterns = previewRoots
    .map((root) => shellQuote(path.resolve(root)))
    .join('|')

  return `#!/bin/sh
set -eu

worktree="$(git rev-parse --show-toplevel 2>/dev/null || true)"
case "$worktree" in
  ${rootPatterns}) ;;
  *)
    echo "${GIT_GUARD_MARKER} refused: guard invoked outside the registered Preview worktrees" >&2
    exit 1
    ;;
esac

operation="$(basename "$0")"
echo "${GIT_GUARD_MARKER} refused: $operation is disabled in MZ-Dev-Preview; use a separate clean release candidate worktree" >&2
exit 1
`
}

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function assertPreviewWorktree(expectedRoot) {
  if (!fs.existsSync(expectedRoot)) throw new Error(`Preview worktree is missing: ${expectedRoot}`)
  const actualRoot = path.resolve(runGit(expectedRoot, ['rev-parse', '--show-toplevel']))
  if (actualRoot !== path.resolve(expectedRoot)) {
    throw new Error(`unexpected Preview worktree root: ${actualRoot}`)
  }

  const branch = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: expectedRoot,
    encoding: 'utf8',
  })
  if (branch.status === 0) throw new Error(`Preview worktree must remain detached: ${expectedRoot}`)
  if (branch.status !== 1) throw new Error(`cannot verify detached Preview worktree: ${expectedRoot}`)
}

function configuredHooksPath(worktree) {
  return path.resolve(runGit(worktree, ['config', '--worktree', '--get', 'core.hooksPath']))
}

function assertHookBlocked(worktree, hookName) {
  const result = spawnSync('git', ['hook', 'run', hookName], {
    cwd: worktree,
    encoding: 'utf8',
  })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  if (result.status === 0 || !output.includes(`${GIT_GUARD_MARKER} refused: ${hookName} is disabled in MZ-Dev-Preview`)) {
    throw new Error(`${hookName} is not blocking ${worktree}`)
  }
}

export function installPreviewGitGuard() {
  const worktrees = [PREVIEW_ROOT, PREVIEW_MOBILE]
  worktrees.forEach(assertPreviewWorktree)

  fs.mkdirSync(GIT_GUARD_DIR, { recursive: true, mode: 0o700 })
  const hookSource = buildDenyHook(worktrees)
  for (const hookName of ['pre-commit', 'pre-push']) {
    const hookPath = path.join(GIT_GUARD_DIR, hookName)
    fs.writeFileSync(hookPath, hookSource, { encoding: 'utf8', mode: 0o700 })
    fs.chmodSync(hookPath, 0o700)
  }

  for (const worktree of worktrees) {
    runGit(worktree, ['config', 'extensions.worktreeConfig', 'true'])
    runGit(worktree, ['config', '--worktree', 'core.hooksPath', GIT_GUARD_DIR])
  }

  verifyPreviewGitGuard()
}

export function verifyPreviewGitGuard() {
  const worktrees = [PREVIEW_ROOT, PREVIEW_MOBILE]
  worktrees.forEach(assertPreviewWorktree)

  for (const hookName of ['pre-commit', 'pre-push']) {
    const hookPath = path.join(GIT_GUARD_DIR, hookName)
    if (!fs.existsSync(hookPath)) throw new Error(`Preview Git hook is missing: ${hookName}`)
    fs.accessSync(hookPath, fs.constants.X_OK)
  }

  for (const worktree of worktrees) {
    if (configuredHooksPath(worktree) !== path.resolve(GIT_GUARD_DIR)) {
      throw new Error(`Preview hooksPath mismatch: ${worktree}`)
    }
    assertHookBlocked(worktree, 'pre-commit')
    assertHookBlocked(worktree, 'pre-push')
  }
}

function main() {
  const command = process.argv[2] || 'verify'
  if (command === 'install') {
    installPreviewGitGuard()
    console.log(`${GIT_GUARD_MARKER} installed root=blocked mobile=blocked commit=blocked push=blocked`)
    return
  }
  if (command === 'verify') {
    verifyPreviewGitGuard()
    console.log(`${GIT_GUARD_MARKER} verified root=blocked mobile=blocked commit=blocked push=blocked`)
    return
  }
  throw new Error(`unknown command: ${command}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`${GIT_GUARD_MARKER} failed: ${String(error?.message || error)}`)
    process.exit(1)
  }
}
