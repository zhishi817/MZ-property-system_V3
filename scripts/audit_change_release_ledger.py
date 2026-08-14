#!/usr/bin/env python3
"""Audit ledger coverage, an exact pull-request range, or a Release Attempt."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
LEDGER_RELATIVE_PATH = Path("docs/change-release-ledger.md")
FILES_HEADING = "### Files / Areas"
CRL_HEADING = re.compile(r"^## (CRL-\d{8}-\d{3})\b")
ATTEMPT_HEADING = re.compile(r"^#### (RA-[^\s]+)\b")
FIELD_LINE = re.compile(r"^- (?:\*\*)?([^:*]+?)(?:\*\*)?:\s*(.*)$")
CRL_ID = re.compile(r"CRL-\d{8}-\d{3}")
CRL_IDENTITY = re.compile(r"\b(root|mobile)/(CRL-\d{8}-\d{3})\b")
SHA = re.compile(r"\b[0-9a-fA-F]{7,64}\b")
PUBLISHED_TECHNICAL_STATE = re.compile(
    r"^- Technical state:\s*(?:pushed|merged|deployed)\b", re.IGNORECASE
)
BEHAVIOR_UPDATE_HEADING = re.compile(r"^### Update\b")
IMMUTABLE_IDENTITY_SUBSECTIONS = (
    "### Implementation",
    "### Files / Areas",
    "### Impact / Dependencies",
)
IMMUTABLE_IDENTITY_FIELDS = ("Request", "Outcome")
STAGED_SCOPE_HEADING = "### Staged Commit Scope"
SCOPE_HUNK = re.compile(
    r"^- `([^`]+)`\s+—\s+SHA-256:\s*`([0-9a-fA-F]{64})`\s*$"
)
DIFF_HUNK_HEADER = re.compile(
    r"^@@ -(?P<old_start>\d+)(?:,(?P<old_count>\d+))? \+(?P<new_start>\d+)(?:,(?P<new_count>\d+))? @@"
)


@dataclass(frozen=True)
class CrlSection:
    identifier: str
    lines: tuple[str, ...]
    files: frozenset[str]
    validation_lines: tuple[str, ...]


@dataclass(frozen=True)
class ReleaseAttempt:
    identifier: str
    selected_crls: frozenset[str]
    selected_identities: frozenset[str]
    fields: dict[str, str]


@dataclass(frozen=True)
class StagedCommitScope:
    repository: str | None
    status: str | None
    hunk_fingerprints: frozenset[tuple[str, str]]
    untracked_review: str


class GitError(RuntimeError):
    """A Git operation needed for a report could not be completed."""


def run_git(root: Path, *args: str, text: bool = True) -> str | bytes:
    result = subprocess.run(
        ["git", *args],
        cwd=root,
        check=False,
        capture_output=True,
        text=text,
    )
    if result.returncode:
        message = result.stderr.strip() if text else "Git command failed."
        raise GitError(message or "Git command failed.")
    return result.stdout


def git_paths(root: Path, *args: str) -> set[str]:
    output = run_git(root, *args)
    assert isinstance(output, str)
    return {line.strip() for line in output.splitlines() if line.strip()}


def changed_paths(root: Path) -> set[str]:
    return (
        git_paths(root, "diff", "--name-only")
        | git_paths(root, "diff", "--cached", "--name-only")
        | git_paths(root, "ls-files", "--others", "--exclude-standard")
    )


def recorded_paths(ledger: Path) -> set[str]:
    if not ledger.exists():
        return set()
    paths: set[str] = set()
    in_files = False
    for line in ledger.read_text(encoding="utf-8").splitlines():
        if line == FILES_HEADING:
            in_files = True
            continue
        if in_files and line.startswith("### "):
            in_files = False
        if in_files:
            match = re.match(r"^- `([^`]+)`(?:\s|$)", line)
            if match:
                paths.add(match.group(1))
    return paths


def ledger_preflight(root: Path) -> int | None:
    try:
        sections = parse_crl_sections(root / LEDGER_RELATIVE_PATH)
    except ValueError as error:
        print("Ledger structure errors:")
        print(f"- {error}")
        return 1
    structure_errors = published_crl_update_errors(sections)
    if structure_errors:
        print("Ledger structure errors:")
        for error in structure_errors:
            print(f"- {error}")
        return 1
    try:
        lineage_errors = remote_lineage_errors(root, sections)
    except GitError:
        print("Ledger lineage: NOT VERIFIED (locally fetched origin/Dev ledger is unavailable).")
        return 2
    except ValueError as error:
        print("Ledger lineage errors:")
        print(f"- {error}")
        return 1
    if lineage_errors:
        print("Ledger lineage errors:")
        for error in lineage_errors:
            print(f"- {error}")
        return 1
    return None


def coverage_audit(root: Path) -> int:
    preflight = ledger_preflight(root)
    if preflight is not None:
        return preflight
    try:
        changed = changed_paths(root)
    except GitError as error:
        print(str(error) or "Unable to inspect Git changes.", file=sys.stderr)
        return 2
    recorded = recorded_paths(root / LEDGER_RELATIVE_PATH)
    uncovered = sorted(changed - recorded)
    print(f"Changed files: {len(changed)}")
    print(f"Recorded changed files: {len(changed & recorded)}")
    if uncovered:
        print("Uncovered files:")
        for path in uncovered:
            print(f"- {path}")
        return 1
    print("Coverage: PASS")
    return 0


def range_coverage_audit(root: Path, base_reference: str, head_reference: str) -> int:
    preflight = ledger_preflight(root)
    if preflight is not None:
        return preflight
    try:
        base = resolve_ref(root, base_reference)
        head = resolve_ref(root, head_reference)
        revision_range = f"{base}...{head}"
        changed = git_paths(root, "diff", "--name-only", revision_range)
        changed |= git_paths(root, "diff", "--name-only", "--no-renames", revision_range)
        run_git(root, "diff", "--check", revision_range)
    except GitError as error:
        print(str(error) or "Unable to inspect the pull-request range.", file=sys.stderr)
        return 2
    recorded = recorded_paths(root / LEDGER_RELATIVE_PATH)
    uncovered = sorted(changed - recorded)
    print(f"Audit scope: {base}...{head}")
    print(f"Changed files: {len(changed)}")
    print(f"Recorded changed files: {len(changed & recorded)}")
    if uncovered:
        print("Uncovered files:")
        for path in uncovered:
            print(f"- {path}")
        return 1
    print("Coverage: PASS")
    return 0


def canonical_field_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def looks_like_path(value: str) -> bool:
    if value.startswith(("CRL-", "FR-", "file://")) or " " in value:
        return False
    return value == "AGENTS.md" or "/" in value or "." in Path(value).name


def subsection(lines: tuple[str, ...], heading: str) -> tuple[str, ...]:
    start = next((index for index, line in enumerate(lines) if line == heading), None)
    if start is None:
        return ()
    result: list[str] = []
    for line in lines[start + 1 :]:
        if line.startswith("### ") or line.startswith("## "):
            break
        result.append(line)
    return tuple(result)


def parse_crl_sections(ledger: Path) -> dict[str, CrlSection]:
    if not ledger.exists():
        raise ValueError("Ledger file is missing.")
    return parse_crl_sections_text(ledger.read_text(encoding="utf-8"))


def parse_crl_sections_text(text: str) -> dict[str, CrlSection]:
    lines = tuple(text.splitlines())
    starts = [(index, match.group(1)) for index, line in enumerate(lines) if (match := CRL_HEADING.match(line))]
    sections: dict[str, CrlSection] = {}
    for position, (start, identifier) in enumerate(starts):
        if identifier in sections:
            raise ValueError(f"Duplicate CRL ID in this repository ledger: {identifier}")
        end = starts[position + 1][0] if position + 1 < len(starts) else len(lines)
        section_lines = lines[start:end]
        file_lines = subsection(section_lines, FILES_HEADING)
        files = {
            candidate
            for line in file_lines
            for candidate in re.findall(r"`([^`]+)`", line)
            if looks_like_path(candidate)
        }
        sections[identifier] = CrlSection(
            identifier=identifier,
            lines=section_lines,
            files=frozenset(files),
            validation_lines=subsection(section_lines, "### Validation"),
        )
    return sections


def parse_attempts(section: CrlSection) -> list[ReleaseAttempt]:
    starts = [index for index, line in enumerate(section.lines) if ATTEMPT_HEADING.match(line)]
    attempts: list[ReleaseAttempt] = []
    for position, start in enumerate(starts):
        heading = ATTEMPT_HEADING.match(section.lines[start])
        assert heading is not None
        end = starts[position + 1] if position + 1 < len(starts) else len(section.lines)
        fields: dict[str, str] = {}
        for line in section.lines[start + 1 : end]:
            match = FIELD_LINE.match(line)
            if match:
                fields[canonical_field_name(match.group(1))] = match.group(2).strip()
        selected = frozenset(CRL_ID.findall(fields.get("selected_crls", "")))
        selected_identities = frozenset(
            f"{repository}/{identifier}"
            for repository, identifier in CRL_IDENTITY.findall(
                fields.get("selected_crl_identities", "")
            )
        )
        attempts.append(
            ReleaseAttempt(
                identifier=heading.group(1),
                selected_crls=selected,
                selected_identities=selected_identities,
                fields=fields,
            )
        )
    return attempts


def canonical_crl_identity(repository: str, identifier: str) -> str:
    return f"{repository}/{identifier}"


def declared_repository(section: CrlSection) -> str | None:
    value = identity_field(section, "Repository")
    return leading_status(value, ("root", "mobile"))


def parse_staged_commit_scope(section: CrlSection) -> StagedCommitScope:
    lines = subsection(section.lines, STAGED_SCOPE_HEADING)
    fields: dict[str, str] = {}
    hunk_fingerprints: set[tuple[str, str]] = set()
    for line in lines:
        field = FIELD_LINE.match(line)
        if field:
            fields[canonical_field_name(field.group(1))] = field.group(2).strip()
        hunk = SCOPE_HUNK.match(line)
        if hunk:
            hunk_fingerprints.add((hunk.group(1), hunk.group(2).lower()))
    return StagedCommitScope(
        repository=leading_status(fields.get("repository", ""), ("root", "mobile")),
        status=leading_status(fields.get("status", ""), ("prepared", "not prepared")),
        hunk_fingerprints=frozenset(hunk_fingerprints),
        untracked_review=fields.get("untracked_review", ""),
    )


def published_crl_update_errors(sections: dict[str, CrlSection]) -> list[str]:
    """Reject a behavior update appended after a CRL was already released."""
    errors: list[str] = []
    for section in sections.values():
        published_at = max(
            (
                index
                for index, line in enumerate(section.lines)
                if PUBLISHED_TECHNICAL_STATE.match(line)
            ),
            default=None,
        )
        if published_at is None:
            continue
        if any(BEHAVIOR_UPDATE_HEADING.match(line) for line in section.lines[published_at + 1 :]):
            errors.append(
                "Published CRL cannot add a behavior update after release evidence: "
                f"{section.identifier}. Allocate a new CRL and link the earlier unit."
            )
    return errors


def normalized_identity_text(value: str) -> str:
    return " ".join(value.split())


def identity_field(section: CrlSection, name: str) -> str:
    marker = re.compile(rf"^- \*\*{re.escape(name)}:\*\*\s*(.*)$")
    return next(
        (
            normalized_identity_text(match.group(1))
            for line in section.lines
            if (match := marker.match(line))
        ),
        "",
    )


def immutable_identity(section: CrlSection) -> dict[str, str]:
    identity = {"title": normalized_identity_text(section.lines[0]) if section.lines else ""}
    identity.update({name: identity_field(section, name) for name in IMMUTABLE_IDENTITY_FIELDS})
    identity.update(
        {
            heading: normalized_identity_text("\n".join(subsection(section.lines, heading)))
            for heading in IMMUTABLE_IDENTITY_SUBSECTIONS
        }
    )
    return identity


def remote_lineage_errors(root: Path, sections: dict[str, CrlSection]) -> list[str]:
    """Require local CRLs to preserve every existing origin/Dev business identity."""
    remote_text = run_git(root, "show", f"origin/Dev:{LEDGER_RELATIVE_PATH.as_posix()}")
    assert isinstance(remote_text, str)
    remote_sections = parse_crl_sections_text(remote_text)
    errors: list[str] = []
    missing_ids = sorted(remote_sections.keys() - sections.keys())
    if missing_ids:
        errors.append(
            "Local ledger omits CRLs already present in origin/Dev: "
            + ", ".join(missing_ids)
            + ". Restore the remote records before adding new units."
        )
    for identifier in sorted(remote_sections.keys() & sections.keys()):
        remote_identity = immutable_identity(remote_sections[identifier])
        local_identity = immutable_identity(sections[identifier])
        changed_parts = [
            name for name in remote_identity if remote_identity[name] != local_identity[name]
        ]
        if changed_parts:
            errors.append(
                f"CRL {identifier} changes origin/Dev immutable business identity "
                f"({', '.join(changed_parts)}). Allocate a new CRL and retain the remote record unchanged."
            )
    return errors


def field_value(attempt: ReleaseAttempt, name: str) -> str:
    return attempt.fields.get(canonical_field_name(name), "")


def leading_status(value: str, allowed: tuple[str, ...]) -> str | None:
    normalized = value.replace("`", "").replace("*", "").strip().lower()
    for status in allowed:
        if normalized.startswith(status):
            return status
    return None


def resolve_ref(root: Path, reference: str) -> str:
    output = run_git(root, "rev-parse", "--verify", f"{reference}^{{commit}}")
    assert isinstance(output, str)
    return output.strip()


def is_ancestor(root: Path, ancestor: str, descendant: str) -> bool:
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", ancestor, descendant],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def range_paths(root: Path, base: str, head: str) -> list[str]:
    return sorted(git_paths(root, "diff", "--name-only", f"{base}...{head}"))


def diff_hunk_fingerprints(root: Path, path: str, *range_args: str) -> set[tuple[str, str]]:
    """Return stable hashes for each textual zero-context diff hunk in one path."""
    output = run_git(
        root,
        "diff",
        "--no-ext-diff",
        "--unified=0",
        *range_args,
        "--",
        path,
    )
    assert isinstance(output, str)
    hunks: list[str] = []
    current: list[str] = []
    for line in output.splitlines(keepends=True):
        if line.startswith("@@ "):
            if current:
                hunks.append("".join(current))
            current = [line]
        elif current:
            current.append(line)
    if current:
        hunks.append("".join(current))
    return {
        (path, hashlib.sha256(f"{path}\0{hunk}".encode("utf-8")).hexdigest())
        for hunk in hunks
    }


def staged_paths(root: Path) -> list[str]:
    return sorted(git_paths(root, "diff", "--cached", "--name-only"))


def untracked_paths(root: Path) -> list[str]:
    return sorted(git_paths(root, "ls-files", "--others", "--exclude-standard"))


def selected_scope_hunks(sections: list[CrlSection]) -> set[tuple[str, str]]:
    return set().union(*(parse_staged_commit_scope(section).hunk_fingerprints for section in sections))


def selected_identity_issues(
    sections: list[CrlSection], expected_repository: str
) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    missing: list[str] = []
    for section in sections:
        repository = declared_repository(section)
        identity = canonical_crl_identity(expected_repository, section.identifier)
        if repository is None:
            missing.append(f"CRL canonical identity is missing its Repository field: {identity}.")
        elif repository != expected_repository:
            errors.append(
                f"CRL canonical identity does not match this audit repository: {repository}/{section.identifier}."
            )
    return errors, missing


def selected_scope_issues(
    sections: list[CrlSection], expected_repository: str
) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    missing: list[str] = []
    for section in sections:
        identity = canonical_crl_identity(expected_repository, section.identifier)
        scope = parse_staged_commit_scope(section)
        if scope.repository is None:
            missing.append(f"Staged Commit Scope repository is missing for {identity}.")
        elif scope.repository != expected_repository:
            errors.append(f"Staged Commit Scope repository does not match {identity}.")
        if scope.status != "prepared":
            missing.append(f"Staged Commit Scope is not prepared for {identity}.")
        if not scope.untracked_review:
            missing.append(f"Staged Commit Scope has no untracked-review evidence for {identity}.")
    return errors, missing


def subsection_line_ranges(
    text: str, identifiers: frozenset[str], heading: str
) -> list[tuple[int, int]]:
    """Return one-based, inclusive line ranges for a named subsection in selected CRLs."""
    lines = text.splitlines()
    ranges: list[tuple[int, int]] = []
    starts = [(index, match.group(1)) for index, line in enumerate(lines) if (match := CRL_HEADING.match(line))]
    for position, (start, identifier) in enumerate(starts):
        if identifier not in identifiers:
            continue
        end = starts[position + 1][0] if position + 1 < len(starts) else len(lines)
        subsection_start = next(
            (index for index in range(start + 1, end) if lines[index] == heading), None
        )
        if subsection_start is None:
            continue
        subsection_end = next(
            (
                index
                for index in range(subsection_start + 1, end)
                if lines[index].startswith("### ") or lines[index].startswith("## ")
            ),
            end,
        )
        ranges.append((subsection_start + 2, subsection_end))
    return ranges


def crl_line_ranges(text: str, identifiers: frozenset[str]) -> list[tuple[int, int]]:
    """Return one-based, inclusive full-section line ranges for selected CRLs."""
    lines = text.splitlines()
    starts = [(index, match.group(1)) for index, line in enumerate(lines) if (match := CRL_HEADING.match(line))]
    return [
        (start + 1, starts[position + 1][0] if position + 1 < len(starts) else len(lines))
        for position, (start, identifier) in enumerate(starts)
        if identifier in identifiers
    ]


def line_range_is_within(
    start: int, count: int, allowed_ranges: list[tuple[int, int]]
) -> bool:
    if count == 0:
        return True
    end = start + count - 1
    return any(start >= allowed_start and end <= allowed_end for allowed_start, allowed_end in allowed_ranges)


def staged_ledger_scope_issues(root: Path, selected_ids: frozenset[str]) -> list[str]:
    """Require every staged ledger hunk to remain inside one selected CRL section."""
    try:
        before = run_git(root, "show", f"HEAD:{LEDGER_RELATIVE_PATH.as_posix()}")
        staged = run_git(root, "show", f":{LEDGER_RELATIVE_PATH.as_posix()}")
        assert isinstance(before, str) and isinstance(staged, str)
        before_ranges = crl_line_ranges(before, selected_ids)
        staged_ranges = crl_line_ranges(staged, selected_ids)
        diff = run_git(root, "diff", "--cached", "--unified=0", "--", LEDGER_RELATIVE_PATH.as_posix())
        assert isinstance(diff, str)
    except GitError:
        return ["Unable to verify staged ledger CRL scope."]
    errors: list[str] = []
    if len(staged_ranges) != len(selected_ids):
        errors.append("Staged ledger is missing a selected CRL section.")
    for line in diff.splitlines():
        match = DIFF_HUNK_HEADER.match(line)
        if not match:
            continue
        old_count = int(match.group("old_count") or "1")
        new_count = int(match.group("new_count") or "1")
        if not line_range_is_within(int(match.group("old_start")), old_count, before_ranges):
            errors.append("Staged ledger changes a line outside selected CRL sections.")
        if not line_range_is_within(int(match.group("new_start")), new_count, staged_ranges):
            errors.append("Staged ledger adds a line outside selected CRL sections.")
    return errors


def receipt_only_issues(
    root: Path, selected_sections: list[CrlSection], selected_identities: frozenset[str]
) -> list[str]:
    """Allow a ledger-only stage only for a verified receipt in selected Release Attempts."""
    errors: list[str] = []
    selected_ids = frozenset(section.identifier for section in selected_sections)
    try:
        before = run_git(root, "show", f"HEAD:{LEDGER_RELATIVE_PATH.as_posix()}")
        staged = run_git(root, "show", f":{LEDGER_RELATIVE_PATH.as_posix()}")
        assert isinstance(before, str) and isinstance(staged, str)
        before_ranges = subsection_line_ranges(before, selected_ids, "### Release Attempts")
        staged_ranges = subsection_line_ranges(staged, selected_ids, "### Release Attempts")
        diff = run_git(
            root,
            "diff",
            "--cached",
            "--unified=0",
            "--",
            LEDGER_RELATIVE_PATH.as_posix(),
        )
        assert isinstance(diff, str)
    except (GitError, ValueError):
        return ["Unable to verify the staged ledger-only Release Attempt receipt."]
    if len(before_ranges) != len(selected_ids) or len(staged_ranges) != len(selected_ids):
        errors.append("Ledger-only receipt requires a Release Attempts subsection in every selected CRL.")
    for line in diff.splitlines():
        match = DIFF_HUNK_HEADER.match(line)
        if not match:
            continue
        old_count = int(match.group("old_count") or "1")
        new_count = int(match.group("new_count") or "1")
        if not line_range_is_within(int(match.group("old_start")), old_count, before_ranges):
            errors.append("Ledger-only receipt changes a line outside selected CRL Release Attempts.")
        if not line_range_is_within(int(match.group("new_start")), new_count, staged_ranges):
            errors.append("Ledger-only receipt adds a line outside selected CRL Release Attempts.")
    attempts = [attempt for section in selected_sections for attempt in parse_attempts(section)]
    exact_attempts = [attempt for attempt in attempts if attempt.selected_identities == selected_identities]
    if not exact_attempts:
        return errors + ["Ledger-only receipt has no Release Attempt bound to exactly the selected canonical CRL identities."]
    attempt = exact_attempts[-1]
    if leading_status(field_value(attempt, "Technical state"), ("committed", "pushed", "merged", "deployed")) is None:
        errors.append("Ledger-only receipt must record a committed-or-later technical state.")
    if leading_status(field_value(attempt, "Independent review"), ("go",)) != "go":
        errors.append("Ledger-only receipt requires independent-review GO evidence.")
    candidate_match = SHA.search(field_value(attempt, "Commit SHA"))
    base_match = SHA.search(field_value(attempt, "Base"))
    patch_match = SHA.search(field_value(attempt, "Candidate patch SHA-256"))
    if not candidate_match or not base_match or not patch_match:
        errors.append("Ledger-only receipt requires parseable base, candidate patch, and content commit evidence.")
        return errors
    try:
        base = resolve_ref(root, base_match.group(0))
        candidate = resolve_ref(root, candidate_match.group(0))
        head = resolve_ref(root, "HEAD")
    except GitError:
        return errors + ["Ledger-only receipt records a base or content commit that cannot be resolved."]
    if not is_ancestor(root, base, candidate) or not is_ancestor(root, candidate, head):
        errors.append("Ledger-only receipt content commit is not inside the current base...HEAD ancestry.")
    elif content_patch_sha256(root, base, candidate) != patch_match.group(0).lower():
        errors.append("Ledger-only receipt candidate patch fingerprint does not match its recorded content commit.")
    if not selected_scope_hunks(selected_sections):
        errors.append("Ledger-only receipt requires an existing selected content-hunk scope.")
    return errors


def content_patch_sha256(root: Path, base: str, head: str) -> str:
    output = run_git(
        root,
        "diff",
        "--binary",
        f"{base}...{head}",
        "--",
        ".",
        ":(exclude)docs/change-release-ledger.md",
        text=False,
    )
    assert isinstance(output, bytes)
    return hashlib.sha256(output).hexdigest()


def generated_paths(paths: list[str]) -> list[str]:
    generated: list[str] = []
    for path in paths:
        parts = Path(path).parts
        if {"dist", "build", ".next", "coverage"}.intersection(parts) or path.endswith(
            ".map"
        ):
            generated.append(path)
    return generated


def sensitive_categories(root: Path, base: str, head: str, paths: list[str]) -> list[str]:
    categories: set[str] = set()
    for path in paths:
        name = Path(path).name.lower()
        if name == ".env" or name.startswith(".env.") or name.endswith((".pem", ".key", ".p12")):
            categories.add("sensitive-file-path")
    output = run_git(root, "diff", "--unified=0", f"{base}...{head}")
    assert isinstance(output, str)
    added = "\n".join(
        line[1:] for line in output.splitlines() if line.startswith("+") and not line.startswith("+++")
    )
    patterns = {
        "private-key-material": r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
        "aws-access-key": r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
        "github-token": r"\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b",
        "slack-token": r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b",
        "credential-assignment": r"(?im)^\s*(?:database_url|password|secret|api[_-]?key|token)\s*=\s*[^\s#]{8,}",
    }
    for category, pattern in patterns.items():
        if re.search(pattern, added):
            categories.add(category)
    return sorted(categories)


def safe_text(value: str, limit: int = 240) -> str:
    if not value:
        return "not recorded"
    if re.search(r"-----BEGIN|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:ghp|github_pat)_", value):
        return "[redacted potential sensitive evidence]"
    return " ".join(value.split())[:limit]


def check_item(name: str, result: str, evidence: str) -> dict[str, str]:
    return {"gate": name, "result": result, "evidence": safe_text(evidence)}


def build_pre_commit_report(
    root: Path, expected_repository: str, repository: str, crl_ids: list[str]
) -> dict[str, Any]:
    errors: list[str] = []
    missing: list[str] = []
    checks: list[dict[str, str]] = []
    selected_ids = frozenset(crl_ids)
    report: dict[str, Any] = {
        "repository": repository,
        "expected_repository": expected_repository,
        "crl_ids": sorted(selected_ids),
        "crl_identities": [
            canonical_crl_identity(repository, identifier) for identifier in sorted(selected_ids)
        ],
        "staged_files": [],
        "untracked_files": [],
        "unselected_staged_files": [],
        "unexpected_hunks": [],
        "missing_hunks": [],
        "checks": checks,
    }
    if repository != expected_repository:
        errors.append(f"Repository must be `{expected_repository}`, not `{repository}`.")
        checks.append(
            check_item(
                "repository boundary", "FAIL", "Pre-commit repository does not match this audit script."
            )
        )
    else:
        checks.append(check_item("repository boundary", "PASS", "Repository matches this audit script."))
    try:
        sections = parse_crl_sections(root / LEDGER_RELATIVE_PATH)
    except ValueError as error:
        errors.append(str(error))
        checks.append(check_item("ledger structure", "FAIL", str(error)))
        return finalize_report(report, errors, missing)
    unavailable = sorted(selected_ids - sections.keys())
    if unavailable:
        errors.append(f"Selected CRL IDs are missing from this ledger: {', '.join(unavailable)}.")
        checks.append(check_item("selected CRLs", "FAIL", "A requested CRL is not in this repository ledger."))
        return finalize_report(report, errors, missing)
    selected_sections = [sections[identifier] for identifier in selected_ids]
    identity_errors, identity_missing = selected_identity_issues(selected_sections, expected_repository)
    errors.extend(identity_errors)
    missing.extend(identity_missing)
    checks.append(
        check_item(
            "canonical CRL identity",
            "FAIL" if identity_errors else "NOT VERIFIED" if identity_missing else "PASS",
            "; ".join(identity_errors + identity_missing) or ", ".join(report["crl_identities"]),
        )
    )
    scope_errors, scope_missing = selected_scope_issues(selected_sections, expected_repository)
    errors.extend(scope_errors)
    missing.extend(scope_missing)
    checks.append(
        check_item(
            "staged commit scope",
            "FAIL" if scope_errors else "NOT VERIFIED" if scope_missing else "PASS",
            "; ".join(scope_errors + scope_missing) or "Selected CRL scopes are prepared.",
        )
    )
    try:
        staged = staged_paths(root)
        untracked = untracked_paths(root)
        report["staged_files"] = staged
        report["untracked_files"] = untracked
        if not staged:
            missing.append("No staged candidate files are present.")
            checks.append(check_item("staged candidate", "NOT VERIFIED", "No staged files."))
        else:
            checks.append(check_item("staged candidate", "PASS", f"{len(staged)} staged file(s)."))
        selected_files = set().union(*(section.files for section in selected_sections))
        unselected = sorted(set(staged) - selected_files)
        report["unselected_staged_files"] = unselected
        if unselected:
            errors.append("Staged candidate contains files outside the selected CRL file lists.")
            checks.append(check_item("staged path coverage", "FAIL", f"{len(unselected)} unselected staged file(s)."))
        else:
            checks.append(check_item("staged path coverage", "PASS", "Every staged path is selected."))
        if untracked:
            errors.append(
                "Untracked files are present; prepare the candidate in a clean worktree instead of the Legacy frozen workspace."
            )
            checks.append(check_item("untracked files", "FAIL", f"{len(untracked)} untracked file(s)."))
        else:
            checks.append(check_item("untracked files", "PASS", "No untracked files."))
        if LEDGER_RELATIVE_PATH.as_posix() in staged:
            ledger_scope_errors = staged_ledger_scope_issues(root, selected_ids)
            if ledger_scope_errors:
                errors.extend(ledger_scope_errors)
                checks.append(check_item("staged ledger CRL scope", "FAIL", "; ".join(ledger_scope_errors)))
            else:
                checks.append(check_item("staged ledger CRL scope", "PASS", "Every staged ledger hunk remains inside a selected CRL."))
        receipt_only = staged == [LEDGER_RELATIVE_PATH.as_posix()]
        actual_hunks: set[tuple[str, str]] = set()
        non_text_hunk_paths: list[str] = []
        for path in staged:
            if path == LEDGER_RELATIVE_PATH.as_posix():
                continue
            fingerprints = diff_hunk_fingerprints(root, path, "--cached")
            if not fingerprints:
                non_text_hunk_paths.append(path)
            actual_hunks.update(fingerprints)
        if receipt_only:
            receipt_errors = receipt_only_issues(
                root,
                selected_sections,
                frozenset(report["crl_identities"]),
            )
            if receipt_errors:
                errors.extend(receipt_errors)
                checks.append(
                    check_item(
                        "ledger-only receipt",
                        "FAIL",
                        "; ".join(receipt_errors),
                    )
                )
            else:
                checks.append(
                    check_item(
                        "ledger-only receipt",
                        "PASS",
                        "Only selected Release Attempt receipt lines changed with verified content-commit evidence.",
                    )
                )
        elif non_text_hunk_paths:
            errors.append("Staged candidate contains a path without a textual hunk fingerprint.")
            checks.append(check_item("staged hunk fingerprints", "FAIL", ", ".join(non_text_hunk_paths)))
        else:
            declared_hunks = selected_scope_hunks(selected_sections)
            unexpected_hunks = sorted(actual_hunks - declared_hunks)
            missing_hunks = sorted(declared_hunks - actual_hunks)
            report["unexpected_hunks"] = [f"{path}#{fingerprint}" for path, fingerprint in unexpected_hunks]
            report["missing_hunks"] = [f"{path}#{fingerprint}" for path, fingerprint in missing_hunks]
            if unexpected_hunks or missing_hunks:
                errors.append("Staged hunk fingerprints do not exactly match the selected CRL Staged Commit Scope.")
                checks.append(
                    check_item(
                        "staged hunk fingerprints",
                        "FAIL",
                        f"unexpected={len(unexpected_hunks)}, missing={len(missing_hunks)}",
                    )
                )
            else:
                checks.append(
                    check_item(
                        "staged hunk fingerprints",
                        "PASS",
                        f"{len(actual_hunks)} non-ledger hunk(s) match scope.",
                    )
                )
    except GitError:
        errors.append("Unable to inspect staged or untracked Git state.")
        checks.append(check_item("local Git state", "FAIL", "Git inspection failed."))
    return finalize_report(report, errors, missing)


def build_release_report(
    root: Path,
    expected_repository: str,
    repository: str,
    base_reference: str,
    head_reference: str,
    crl_ids: list[str],
) -> dict[str, Any]:
    errors: list[str] = []
    missing: list[str] = []
    checks: list[dict[str, str]] = []
    report: dict[str, Any] = {
        "repository": repository,
        "expected_repository": expected_repository,
        "crl_ids": sorted(set(crl_ids)),
        "crl_identities": [],
        "base": {"input": base_reference, "sha": None, "origin_dev_sha": None},
        "head": {"input": head_reference, "sha": None},
        "git_worktree_state": "not inspected",
        "candidate_content_commit_sha": None,
        "release_attempt": None,
        "branch": None,
        "dependencies": "not recorded",
        "changed_files": [],
        "selected_files": [],
        "unselected_changed_files": [],
        "shared_files": [],
        "unexpected_hunks": [],
        "missing_hunks": [],
        "generated_files": [],
        "sensitive_information": [],
        "validation": {},
        "review": {},
        "authorization": "not recorded",
        "checks": checks,
    }
    selected_ids = frozenset(crl_ids)
    selected_identities = frozenset(
        canonical_crl_identity(repository, identifier) for identifier in selected_ids
    )
    report["crl_identities"] = sorted(selected_identities)
    if repository != expected_repository:
        errors.append(f"Repository must be `{expected_repository}`, not `{repository}`.")
        checks.append(check_item("repository boundary", "FAIL", "Report repository does not match this audit script."))
    else:
        checks.append(check_item("repository boundary", "PASS", "Repository matches this audit script."))
    try:
        base = resolve_ref(root, base_reference)
        head = resolve_ref(root, head_reference)
        report["base"]["sha"] = base
        report["head"]["sha"] = head
        checks.append(check_item("git references", "PASS", "Base and head resolve to commits."))
    except GitError:
        errors.append("Base or head is not a valid commit reference.")
        checks.append(check_item("git references", "FAIL", "Base or head could not be resolved."))
        return finalize_report(report, errors, missing)
    if not is_ancestor(root, base, head):
        errors.append("Base is not an ancestor of head.")
        checks.append(check_item("exact range", "FAIL", "The supplied range is not base...head."))
    else:
        checks.append(check_item("exact range", "PASS", "Base is an ancestor of head."))
    try:
        status_output = run_git(root, "status", "--porcelain=v1", "-uall")
        assert isinstance(status_output, str)
        if status_output.strip():
            report["git_worktree_state"] = "dirty"
            errors.append(
                "PR range audit requires a clean checked-out Git worktree; historical Legacy worktrees are outside this audit."
            )
            checks.append(
                check_item(
                    "checked-out Git state",
                    "FAIL",
                    "Working tree has local staged, unstaged, or untracked paths.",
                )
            )
        else:
            report["git_worktree_state"] = "clean"
            checks.append(check_item("checked-out Git state", "PASS", "Working tree is clean."))
    except GitError:
        errors.append("Unable to inspect the checked-out Git worktree state.")
        checks.append(check_item("checked-out Git state", "FAIL", "Git status inspection failed."))
    try:
        origin_dev = resolve_ref(root, "origin/Dev")
        report["base"]["origin_dev_sha"] = origin_dev
        if origin_dev != base:
            errors.append("Locally fetched origin/Dev does not match the supplied base SHA.")
            checks.append(check_item("base freshness", "FAIL", "origin/Dev differs from the requested base."))
        else:
            checks.append(check_item("base freshness", "PASS", "Locally fetched origin/Dev matches base."))
    except GitError:
        missing.append("Locally fetched origin/Dev is unavailable, so base freshness is not verified.")
        checks.append(check_item("base freshness", "NOT VERIFIED", "origin/Dev is unavailable locally; report never fetches."))
    try:
        sections = parse_crl_sections(root / LEDGER_RELATIVE_PATH)
    except ValueError as error:
        errors.append(str(error))
        checks.append(check_item("ledger structure", "FAIL", str(error)))
        return finalize_report(report, errors, missing)
    structure_errors = published_crl_update_errors(sections)
    if structure_errors:
        errors.extend(structure_errors)
        checks.append(check_item("ledger structure", "FAIL", "; ".join(structure_errors)))
        return finalize_report(report, errors, missing)
    try:
        lineage_errors = remote_lineage_errors(root, sections)
    except GitError:
        missing.append("Locally fetched origin/Dev ledger is unavailable, so immutable CRL lineage is not verified.")
        checks.append(check_item("remote ledger lineage", "NOT VERIFIED", "origin/Dev ledger is unavailable locally; report never fetches."))
    except ValueError as error:
        errors.append(str(error))
        checks.append(check_item("remote ledger lineage", "FAIL", str(error)))
        return finalize_report(report, errors, missing)
    else:
        if lineage_errors:
            errors.extend(lineage_errors)
            checks.append(check_item("remote ledger lineage", "FAIL", "; ".join(lineage_errors)))
            return finalize_report(report, errors, missing)
        checks.append(check_item("remote ledger lineage", "PASS", "Current CRL identities preserve the fetched origin/Dev ledger."))
    unavailable = sorted(selected_ids - sections.keys())
    if unavailable:
        errors.append(f"Selected CRL IDs are missing from this ledger: {', '.join(unavailable)}.")
        checks.append(check_item("selected CRLs", "FAIL", "A requested CRL is not in this repository ledger."))
        return finalize_report(report, errors, missing)
    selected_sections = [sections[identifier] for identifier in selected_ids]
    identity_errors, identity_missing = selected_identity_issues(
        selected_sections, expected_repository
    )
    errors.extend(identity_errors)
    missing.extend(identity_missing)
    checks.append(
        check_item(
            "canonical CRL identity",
            "FAIL" if identity_errors else "NOT VERIFIED" if identity_missing else "PASS",
            "; ".join(identity_errors + identity_missing) or ", ".join(report["crl_identities"]),
        )
    )
    selected_files = set().union(*(section.files for section in selected_sections))
    report["selected_files"] = sorted(selected_files)
    attempts = [attempt for section in selected_sections for attempt in parse_attempts(section)]
    exact_attempts = [
        attempt for attempt in attempts if attempt.selected_identities == selected_identities
    ]
    if not exact_attempts:
        missing.append("No Release Attempt binds exactly the selected canonical CRL identities.")
        checks.append(
            check_item("release attempt", "NOT VERIFIED", "No exact canonical-identity attempt record exists.")
        )
        return finalize_report(report, errors, missing)
    attempt = exact_attempts[-1]
    report["release_attempt"] = attempt.identifier
    checks.append(check_item("release attempt", "PASS", f"Using {attempt.identifier}."))
    attempt_repository = leading_status(field_value(attempt, "Repository"), ("root", "mobile"))
    if attempt_repository != expected_repository:
        errors.append("Release Attempt repository does not match this audit script.")
        checks.append(check_item("attempt repository", "FAIL", field_value(attempt, "Repository")))
    else:
        checks.append(check_item("attempt repository", "PASS", attempt_repository))
    base_field = field_value(attempt, "Base")
    if base.lower() not in base_field.lower():
        errors.append("Release Attempt Base field does not contain the resolved base SHA.")
        checks.append(check_item("attempt base", "FAIL", base_field))
    elif "fetched at" not in base_field.lower():
        missing.append("Release Attempt Base field has no fetch-time evidence.")
        checks.append(check_item("attempt base", "NOT VERIFIED", base_field))
    else:
        checks.append(check_item("attempt base", "PASS", base_field))
    branch = field_value(attempt, "Branch")
    report["branch"] = safe_text(branch)
    if not branch or "not created" in branch.lower():
        missing.append("Release Attempt branch is not recorded.")
        checks.append(check_item("branch", "NOT VERIFIED", branch))
    else:
        checks.append(check_item("branch", "PASS", branch))
    report["dependencies"] = safe_text(field_value(attempt, "Dependencies"))
    report["validation"] = {
        "required_validation": safe_text(field_value(attempt, "Required validation")),
        "ledger_validation_entries": [safe_text(line) for line in selected_sections[0].validation_lines if line.strip()],
    }
    validation = leading_status(field_value(attempt, "Required validation"), ("pass", "fail", "not verified"))
    if validation == "pass":
        checks.append(check_item("required validation", "PASS", field_value(attempt, "Required validation")))
    elif validation == "fail":
        errors.append("Release Attempt records failed required validation.")
        checks.append(check_item("required validation", "FAIL", field_value(attempt, "Required validation")))
    else:
        missing.append("Release Attempt has no PASS required-validation evidence.")
        checks.append(check_item("required validation", "NOT VERIFIED", field_value(attempt, "Required validation")))
    review = field_value(attempt, "Independent review")
    review_status = leading_status(review, ("go", "no-go", "needs owner", "not run"))
    report["review"] = {"status": review_status or "not recorded", "evidence": safe_text(review)}
    if review_status == "go":
        checks.append(check_item("independent review", "PASS", review))
    elif review_status in {"no-go", "needs owner"}:
        errors.append("Independent review did not approve this attempt.")
        checks.append(check_item("independent review", "FAIL", review))
    else:
        missing.append("Independent review GO evidence is missing.")
        checks.append(check_item("independent review", "NOT VERIFIED", review))
    authorization = leading_status(
        field_value(attempt, "User authorization"),
        ("approved-for-push", "selected-for-commit", "not-selected"),
    )
    report["authorization"] = authorization or "not recorded"
    action = leading_status(field_value(attempt, "Intended action"), ("push", "commit"))
    if action == "push":
        checks.append(check_item("intended action", "PASS", "Attempt is evaluating push."))
        if authorization == "approved-for-push":
            checks.append(check_item("push authorization", "PASS", field_value(attempt, "User authorization")))
        else:
            missing.append("Explicit approved-for-push authorization is missing.")
            checks.append(check_item("push authorization", "NOT VERIFIED", field_value(attempt, "User authorization")))
    elif action == "commit":
        checks.append(check_item("intended action", "PASS", "Attempt is evaluating commit."))
        if authorization in {"selected-for-commit", "approved-for-push"}:
            checks.append(check_item("commit authorization", "PASS", field_value(attempt, "User authorization")))
        else:
            missing.append("Selected-for-commit authorization is missing.")
            checks.append(check_item("commit authorization", "NOT VERIFIED", field_value(attempt, "User authorization")))
    else:
        missing.append("Release Attempt has no supported intended action.")
        checks.append(check_item("intended action", "NOT VERIFIED", field_value(attempt, "Intended action")))
    technical = leading_status(
        field_value(attempt, "Technical state"),
        ("committed", "pushed", "merged", "deployed", "verified", "candidate"),
    )
    if technical in {"committed", "pushed", "merged", "deployed"}:
        checks.append(check_item("technical state", "PASS", technical))
    else:
        missing.append("Release Attempt is not recorded as committed or later.")
        checks.append(check_item("technical state", "NOT VERIFIED", field_value(attempt, "Technical state")))
    commit_field = field_value(attempt, "Commit SHA")
    commit_match = SHA.search(commit_field)
    if not commit_match:
        missing.append("Candidate content commit SHA is missing.")
        checks.append(check_item("candidate content commit", "NOT VERIFIED", commit_field))
    else:
        try:
            candidate_commit = resolve_ref(root, commit_match.group(0))
            report["candidate_content_commit_sha"] = candidate_commit
            if not is_ancestor(root, base, candidate_commit) or not is_ancestor(root, candidate_commit, head):
                errors.append("Candidate content commit is not inside the exact base...head range.")
                checks.append(check_item("candidate content commit", "FAIL", "Recorded commit is outside the report range."))
            else:
                checks.append(check_item("candidate content commit", "PASS", candidate_commit))
        except GitError:
            errors.append("Recorded candidate content commit SHA cannot be resolved.")
            checks.append(check_item("candidate content commit", "FAIL", "Recorded commit cannot be resolved."))
    try:
        changed = range_paths(root, base, head)
        report["changed_files"] = changed
        unselected = sorted(set(changed) - selected_files)
        report["unselected_changed_files"] = unselected
        if unselected:
            errors.append("Exact range contains files outside the selected CRL file lists.")
            checks.append(check_item("selected range coverage", "FAIL", f"{len(unselected)} unselected changed file(s)."))
        else:
            checks.append(check_item("selected range coverage", "PASS", f"{len(changed)} changed file(s) are selected."))
        scope_errors, scope_missing = selected_scope_issues(
            selected_sections, expected_repository
        )
        errors.extend(scope_errors)
        missing.extend(scope_missing)
        checks.append(
            check_item(
                "committed hunk scope",
                "FAIL" if scope_errors else "NOT VERIFIED" if scope_missing else "PASS",
                "; ".join(scope_errors + scope_missing) or "Selected CRL scopes are prepared.",
            )
        )
        actual_hunks: set[tuple[str, str]] = set()
        non_text_hunk_paths: list[str] = []
        for path in changed:
            if path == LEDGER_RELATIVE_PATH.as_posix():
                continue
            fingerprints = diff_hunk_fingerprints(root, path, f"{base}...{head}")
            if not fingerprints:
                non_text_hunk_paths.append(path)
            actual_hunks.update(fingerprints)
        if non_text_hunk_paths:
            errors.append("Exact range contains a path without a textual hunk fingerprint.")
            checks.append(check_item("committed hunk fingerprints", "FAIL", ", ".join(non_text_hunk_paths)))
        else:
            declared_hunks = selected_scope_hunks(selected_sections)
            unexpected_hunks = sorted(actual_hunks - declared_hunks)
            missing_hunks = sorted(declared_hunks - actual_hunks)
            report["unexpected_hunks"] = [f"{path}#{fingerprint}" for path, fingerprint in unexpected_hunks]
            report["missing_hunks"] = [f"{path}#{fingerprint}" for path, fingerprint in missing_hunks]
            if unexpected_hunks or missing_hunks:
                errors.append("Committed hunk fingerprints do not exactly match the selected CRL Staged Commit Scope.")
                checks.append(
                    check_item(
                        "committed hunk fingerprints",
                        "FAIL",
                        f"unexpected={len(unexpected_hunks)}, missing={len(missing_hunks)}",
                    )
                )
            else:
                checks.append(
                    check_item(
                        "committed hunk fingerprints",
                        "PASS",
                        f"{len(actual_hunks)} non-ledger hunk(s) match scope.",
                    )
                )
        shared = sorted(
            selected_files.intersection(
                set().union(
                    *(section.files for identifier, section in sections.items() if identifier not in selected_ids)
                )
            )
        )
        report["shared_files"] = shared
        shared_review = leading_status(field_value(attempt, "Shared-hunk review"), ("pass", "not applicable", "not verified"))
        if shared and shared_review != "pass":
            missing.append("Selected files are shared with unselected CRLs without PASS shared-hunk evidence.")
            checks.append(check_item("shared-file hunks", "NOT VERIFIED", f"{len(shared)} shared file(s)."))
        else:
            evidence = "No shared files." if not shared else field_value(attempt, "Shared-hunk review")
            checks.append(check_item("shared-file hunks", "PASS", evidence))
        generated = generated_paths(changed)
        report["generated_files"] = generated
        generated_review = leading_status(field_value(attempt, "Generated-file review"), ("pass", "not applicable", "not verified"))
        if generated and generated_review != "pass":
            missing.append("Generated files require PASS generated-file review evidence.")
            checks.append(check_item("generated files", "NOT VERIFIED", f"{len(generated)} generated file(s)."))
        else:
            evidence = "No generated files." if not generated else field_value(attempt, "Generated-file review")
            checks.append(check_item("generated files", "PASS", evidence))
        actual_patch = content_patch_sha256(root, base, head)
        recorded_patch = SHA.search(field_value(attempt, "Candidate patch SHA-256"))
        report["candidate_patch_sha256"] = {
            "recorded": recorded_patch.group(0).lower() if recorded_patch else None,
            "actual": actual_patch,
            "ledger_excluded": str(LEDGER_RELATIVE_PATH),
        }
        if not recorded_patch:
            missing.append("Candidate patch SHA-256 is missing.")
            checks.append(check_item("candidate patch fingerprint", "NOT VERIFIED", "No recorded SHA-256."))
        elif recorded_patch.group(0).lower() != actual_patch:
            errors.append("Candidate patch SHA-256 does not match the exact range content excluding ledger metadata.")
            checks.append(check_item("candidate patch fingerprint", "FAIL", "Recorded and computed hashes differ."))
        else:
            checks.append(check_item("candidate patch fingerprint", "PASS", actual_patch))
        sensitive = sensitive_categories(root, base, head, changed)
        report["sensitive_information"] = sensitive
        if sensitive:
            errors.append("Sensitive-file or credential-pattern risk is present in the exact range.")
            checks.append(check_item("sensitive information", "FAIL", ", ".join(sensitive)))
        else:
            checks.append(check_item("sensitive information", "PASS", "No configured sensitive categories detected."))
    except GitError:
        errors.append("Unable to inspect the exact Git range.")
        checks.append(check_item("exact range inspection", "FAIL", "Git diff inspection failed."))
    return finalize_report(report, errors, missing)


def finalize_report(report: dict[str, Any], errors: list[str], missing: list[str]) -> dict[str, Any]:
    conclusion = "BLOCKED" if errors else "NOT VERIFIED" if missing else "GO"
    report["conclusion"] = conclusion
    report["blockers"] = errors
    report["missing_evidence"] = missing
    return report


def markdown_report(report: dict[str, Any]) -> str:
    def cell(value: Any) -> str:
        return str(value).replace("|", "\\|").replace("\n", " ")

    lines = [
        "# Release Attempt Report",
        "",
        f"- Repository: `{report['repository']}`",
        f"- Release Attempt: `{report['release_attempt'] or 'not recorded'}`",
        f"- CRLs: {', '.join(report['crl_ids']) or 'none'}",
        f"- Base: `{report['base']['sha'] or report['base']['input']}`",
        f"- Head: `{report['head']['sha'] or report['head']['input']}`",
        f"- Checked-out Git state: `{report['git_worktree_state']}`",
        f"- Candidate content commit: `{report['candidate_content_commit_sha'] or 'not recorded'}`",
        f"- Branch: `{report['branch'] or 'not recorded'}`",
        f"- Dependencies: {report['dependencies']}",
        f"- Authorization: `{report['authorization']}`",
        f"- Conclusion: **{report['conclusion']}**",
        "",
        "## Gate checks",
        "",
        "| Gate | Result | Evidence |",
        "| --- | --- | --- |",
    ]
    lines.extend(f"| {cell(item['gate'])} | {cell(item['result'])} | {cell(item['evidence'])} |" for item in report["checks"])
    lines.extend(["", "## Exact range", ""])
    lines.append("Changed files: " + (", ".join(f"`{path}`" for path in report["changed_files"]) or "none"))
    lines.append("Shared files: " + (", ".join(f"`{path}`" for path in report["shared_files"]) or "none"))
    lines.append("Unselected changed files: " + (", ".join(f"`{path}`" for path in report["unselected_changed_files"]) or "none"))
    lines.append("Generated files: " + (", ".join(f"`{path}`" for path in report["generated_files"]) or "none"))
    lines.append("Sensitive-information categories: " + (", ".join(report["sensitive_information"]) or "none"))
    lines.extend(["", "## Evidence gaps / blockers", ""])
    for item in report["blockers"] + report["missing_evidence"]:
        lines.append(f"- {item}")
    if not report["blockers"] and not report["missing_evidence"]:
        lines.append("- None.")
    return "\n".join(lines)


def markdown_pre_commit_report(report: dict[str, Any]) -> str:
    def file_list(paths: list[str]) -> str:
        return ", ".join(f"`{path}`" for path in paths) or "none"

    lines = [
        "# Pre-commit Ledger Gate",
        "",
        f"- Repository: `{report['repository']}`",
        f"- CRL identities: {', '.join(report['crl_identities']) or 'none'}",
        f"- Conclusion: **{report['conclusion']}**",
        "",
        "## Gate checks",
        "",
        "| Gate | Result | Evidence |",
        "| --- | --- | --- |",
    ]
    lines.extend(
        f"| {item['gate']} | {item['result']} | {item['evidence']} |"
        for item in report["checks"]
    )
    lines.extend(["", "## Local candidate", ""])
    lines.append("Staged files: " + file_list(report["staged_files"]))
    lines.append("Untracked files: " + file_list(report["untracked_files"]))
    lines.append("Unselected staged files: " + file_list(report["unselected_staged_files"]))
    lines.append("Unexpected hunks: " + file_list(report["unexpected_hunks"]))
    lines.append("Missing hunks: " + file_list(report["missing_hunks"]))
    lines.extend(["", "## Evidence gaps / blockers", ""])
    for item in report["blockers"] + report["missing_evidence"]:
        lines.append(f"- {item}")
    if not report["blockers"] and not report["missing_evidence"]:
        lines.append("- None.")
    return "\n".join(lines)


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--pre-commit",
        action="store_true",
        help="Audit the local staged candidate, untracked paths, CRL identity, and hunk scope without changing Git or the ledger.",
    )
    parser.add_argument("--release-report", action="store_true", help="Audit one exact Release Attempt without changing Git or the ledger.")
    parser.add_argument("--repo", choices=("root", "mobile"), help="Repository boundary for --pre-commit or --release-report.")
    parser.add_argument("--base", help="Exact base commit or ref for --release-report.")
    parser.add_argument("--head", help="Exact head commit or ref for --release-report.")
    parser.add_argument("--crl", action="append", default=[], help="Selected CRL ID; repeat for each selected unit.")
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown", help="Output format for --release-report.")
    args = parser.parse_args(argv)
    if args.pre_commit and args.release_report:
        parser.error("--pre-commit and --release-report are mutually exclusive.")
    if args.pre_commit:
        if not args.repo or not args.crl:
            parser.error("--pre-commit requires --repo and at least one --crl.")
        if args.base or args.head:
            parser.error("--base and --head require --release-report.")
    elif args.release_report:
        absent = [name for name in ("repo", "base", "head") if not getattr(args, name)]
        if absent or not args.crl:
            parser.error("--release-report requires --repo, --base, --head, and at least one --crl.")
    else:
        if args.repo or args.crl:
            parser.error("--repo and --crl require --release-report.")
        if bool(args.base) != bool(args.head):
            parser.error("--base and --head must be supplied together for pull-request range coverage.")
    return args


def main(argv: list[str] | None = None, root: Path = ROOT, expected_repository: str = "root") -> int:
    args = parse_args(argv)
    if args.pre_commit:
        report = build_pre_commit_report(
            root=root,
            expected_repository=expected_repository,
            repository=args.repo,
            crl_ids=args.crl,
        )
        if args.format == "json":
            print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
        else:
            print(markdown_pre_commit_report(report))
        return {"GO": 0, "BLOCKED": 1, "NOT VERIFIED": 2}[report["conclusion"]]
    if not args.release_report:
        return range_coverage_audit(root, args.base, args.head) if args.base else coverage_audit(root)
    report = build_release_report(
        root=root,
        expected_repository=expected_repository,
        repository=args.repo,
        base_reference=args.base,
        head_reference=args.head,
        crl_ids=args.crl,
    )
    if args.format == "json":
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(markdown_report(report))
    return {"GO": 0, "BLOCKED": 1, "NOT VERIFIED": 2}[report["conclusion"]]


if __name__ == "__main__":
    raise SystemExit(main())
