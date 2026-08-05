#!/usr/bin/env python3
"""Audit ledger coverage, a PR range, or one exact, read-only Release Attempt."""

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
SHA = re.compile(r"\b[0-9a-fA-F]{7,64}\b")


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
    fields: dict[str, str]


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


def coverage_audit(root: Path) -> int:
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
    lines = tuple(ledger.read_text(encoding="utf-8").splitlines())
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
        attempts.append(
            ReleaseAttempt(
                identifier=heading.group(1), selected_crls=selected, fields=fields
            )
        )
    return attempts


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
        "base": {"input": base_reference, "sha": None, "origin_dev_sha": None},
        "head": {"input": head_reference, "sha": None},
        "candidate_content_commit_sha": None,
        "release_attempt": None,
        "branch": None,
        "dependencies": "not recorded",
        "changed_files": [],
        "selected_files": [],
        "unselected_changed_files": [],
        "shared_files": [],
        "generated_files": [],
        "sensitive_information": [],
        "validation": {},
        "review": {},
        "authorization": "not recorded",
        "checks": checks,
    }
    selected_ids = frozenset(crl_ids)
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
    unavailable = sorted(selected_ids - sections.keys())
    if unavailable:
        errors.append(f"Selected CRL IDs are missing from this ledger: {', '.join(unavailable)}.")
        checks.append(check_item("selected CRLs", "FAIL", "A requested CRL is not in this repository ledger."))
        return finalize_report(report, errors, missing)
    selected_sections = [sections[identifier] for identifier in selected_ids]
    selected_files = set().union(*(section.files for section in selected_sections))
    report["selected_files"] = sorted(selected_files)
    attempts = [attempt for section in selected_sections for attempt in parse_attempts(section)]
    exact_attempts = [attempt for attempt in attempts if attempt.selected_crls == selected_ids]
    if not exact_attempts:
        missing.append("No Release Attempt binds exactly the selected CRL IDs.")
        checks.append(check_item("release attempt", "NOT VERIFIED", "No exact attempt record exists."))
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
    if authorization == "approved-for-push":
        checks.append(check_item("push authorization", "PASS", field_value(attempt, "User authorization")))
    else:
        missing.append("Explicit approved-for-push authorization is missing.")
        checks.append(check_item("push authorization", "NOT VERIFIED", field_value(attempt, "User authorization")))
    action = leading_status(field_value(attempt, "Intended action"), ("push", "commit"))
    if action == "push":
        checks.append(check_item("intended action", "PASS", "Attempt is evaluating push."))
    else:
        missing.append("Release Attempt is not explicitly evaluating the push action.")
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


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-report", action="store_true", help="Audit one exact Release Attempt without changing Git or the ledger.")
    parser.add_argument("--repo", choices=("root", "mobile"), help="Repository boundary for --release-report.")
    parser.add_argument("--base", help="Base commit/ref for a PR range or --release-report.")
    parser.add_argument("--head", help="Head commit/ref for a PR range or --release-report.")
    parser.add_argument("--crl", action="append", default=[], help="Selected CRL ID; repeat for each selected unit.")
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown", help="Output format for --release-report.")
    args = parser.parse_args(argv)
    if args.release_report:
        absent = [name for name in ("repo", "base", "head") if not getattr(args, name)]
        if absent or not args.crl:
            parser.error("--release-report requires --repo, --base, --head, and at least one --crl.")
    elif args.repo or args.crl:
        parser.error("--repo and --crl require --release-report.")
    elif bool(args.base) != bool(args.head):
        parser.error("--base and --head must be supplied together.")
    return args


def main(argv: list[str] | None = None, root: Path = ROOT, expected_repository: str = "root") -> int:
    args = parse_args(argv)
    if not args.release_report and args.base and args.head:
        return range_coverage_audit(root, args.base, args.head)
    if not args.release_report:
        return coverage_audit(root)
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
