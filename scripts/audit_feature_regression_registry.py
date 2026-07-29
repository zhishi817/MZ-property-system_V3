#!/usr/bin/env python3
"""Validate the structural integrity of the feature regression registry."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "docs" / "feature-regression-registry.md"
MOBILE_PREFIX = "mz-cleaning-app-frontend/"
FR_HEADER = re.compile(r"^##\s+(FR-\d{3})[：:]\s*(.+)$", re.MULTILINE)
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
STATUS_VALUES = {"active", "deprecated", "replaced"}
COVERAGE_VALUES = {"sufficient", "partial", "not-wired", "missing"}


def field(section: str, label: str) -> str | None:
    pattern = rf"^\s*-\s*\*\*{re.escape(label)}：\*\*\s*(.+?)\s*$"
    match = re.search(pattern, section, re.MULTILINE)
    return match.group(1).strip() if match else None


def subsection(section: str, title: str) -> str:
    marker = f"### {title}"
    start = section.find(marker)
    if start < 0:
        return ""
    body = section[start + len(marker) :]
    next_heading = re.search(r"^###\s+", body, re.MULTILINE)
    return body[: next_heading.start()] if next_heading else body


def table_rows(body: str) -> list[list[str]]:
    rows: list[list[str]] = []
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or stripped.count("|") < 3:
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if cells and all(set(cell) <= {"-", ":", " "} for cell in cells):
            continue
        if cells and cells[0] in {"保护点", "Invariant"}:
            continue
        rows.append(cells)
    return rows


def main() -> int:
    if not REGISTRY.exists():
        print(f"Feature registry audit: FAILED\nMissing {REGISTRY}", file=sys.stderr)
        return 1

    text = REGISTRY.read_text(encoding="utf-8")
    headers = list(FR_HEADER.finditer(text))
    errors: list[str] = []
    ids: set[str] = set()
    deferred_mobile_mappings = 0

    if not headers:
        errors.append("no FR sections found")

    for index, match in enumerate(headers):
        fr_id = match.group(1)
        if fr_id in ids:
            errors.append(f"{fr_id}: duplicate ID")
        ids.add(fr_id)

        section_end = headers[index + 1].start() if index + 1 < len(headers) else len(text)
        section = text[match.start() : section_end]
        status = field(section, "状态")
        scope = field(section, "维护责任范围")
        review_date = field(section, "最后审查日期")

        if status not in STATUS_VALUES:
            errors.append(f"{fr_id}: invalid or missing 状态")
        if not scope or scope == "—":
            errors.append(f"{fr_id}: missing 维护责任范围")
        if not review_date or not DATE.fullmatch(review_date):
            errors.append(f"{fr_id}: invalid or missing 最后审查日期")

        for required in ("业务保护规则", "测试映射", "验证策略", "最后验证", "相关 CRL", "非保护范围"):
            if f"### {required}" not in section:
                errors.append(f"{fr_id}: missing section {required}")

        mappings = table_rows(subsection(section, "测试映射"))
        if not mappings:
            errors.append(f"{fr_id}: no test mapping rows")
        non_missing_mapping = False
        for row_number, row in enumerate(mappings, start=1):
            if len(row) < 5:
                errors.append(f"{fr_id}: test mapping row {row_number} must have 5 columns")
                continue
            test_path = row[1].strip().strip("`")
            coverage = row[3].strip()
            command = row[4]
            if coverage not in COVERAGE_VALUES:
                errors.append(f"{fr_id}: invalid coverage status {coverage!r} in row {row_number}")
            if coverage != "missing":
                non_missing_mapping = True
                if not test_path or test_path in {"—", "-"}:
                    errors.append(f"{fr_id}: row {row_number} claims coverage without a test path")
                elif test_path.startswith(MOBILE_PREFIX) and not (ROOT / "mz-cleaning-app-frontend").is_dir():
                    deferred_mobile_mappings += 1
                elif not (ROOT / test_path).exists():
                    errors.append(f"{fr_id}: referenced test file does not exist: {test_path}")
            if "npm run" not in command and "ts-node" not in command:
                errors.append(f"{fr_id}: row {row_number} has no executable test command")

        if status == "active" and not non_missing_mapping:
            errors.append(f"{fr_id}: active FR must have at least one existing test mapping")

        last_verified = subsection(section, "最后验证")
        if not all(label in last_verified for label in ("**CRL：**", "**Commit：**", "**日期：**")):
            errors.append(f"{fr_id}: 最后验证 must contain CRL, Commit and 日期")

    if errors:
        print("Feature registry audit: FAILED", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    deferred_note = f"; {deferred_mobile_mappings} mobile mapping(s) deferred" if deferred_mobile_mappings else ""
    print(f"Feature registry audit: PASS ({len(headers)} FRs; {sum(len(table_rows(subsection(text[m.start() : (headers[i + 1].start() if i + 1 < len(headers) else len(text))], '测试映射'))) for i, m in enumerate(headers))} test mappings{deferred_note})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
