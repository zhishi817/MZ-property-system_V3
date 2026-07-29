#!/usr/bin/env python3
"""Report likely button dimension violations in the MZ mobile source."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

STYLE_DECLARATION = re.compile(r"^\s{2}([A-Za-z][A-Za-z0-9_]*)\s*:\s*\{")
DIMENSION = re.compile(r"\b(minHeight|height|width|minWidth)\s*:\s*([0-9]+)")
BUTTON_HINTS = re.compile(r"(?:button|btn|action|submit|primary|secondary|danger|destructive|confirm|complete|upload|retry|remove|delete|close|back|refresh|save|continue|checkout|ack)", re.IGNORECASE)
NON_BUTTON_HINTS = re.compile(r"(?:input|wrap|row|card|iconwrap|avatar|thumb|badge|pill|chip|segment|suggest|option|picker|header|footer|modal|content|image|photo|media|text|label|title|divider|separator|list|item|container|overlay|dot)", re.IGNORECASE)
ALLOWED_VISUAL_DIMENSIONS = {36, 44}
SOURCE_EXTENSIONS = {".tsx", ".ts"}


def find_mobile_root(start: Path) -> Path:
    for candidate in (start, start / "mz-cleaning-app-frontend"):
        if (candidate / "src").is_dir() and (candidate / "package.json").is_file():
            return candidate
    raise SystemExit("Could not locate mz-cleaning-app-frontend from the current directory")


def scan_file(path: Path) -> list[tuple[Path, int, str, str]]:
    findings: list[tuple[Path, int, str, str]] = []
    current_style: str | None = None
    style_indent: int | None = None
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        declaration = STYLE_DECLARATION.match(line)
        if declaration:
            current_style = declaration.group(1)
            style_indent = len(line) - len(line.lstrip())
            continue
        if current_style is None or style_indent is None:
            continue
        stripped = line.strip()
        indent = len(line) - len(line.lstrip())
        if stripped and indent <= style_indent and not stripped.startswith("//"):
            current_style = None
            style_indent = None
            continue
        match = DIMENSION.search(line)
        if not match or not BUTTON_HINTS.search(current_style):
            continue
        if NON_BUTTON_HINTS.search(current_style) and not re.search(r"(?:button|btn|action|submit|primary|secondary|danger|confirm|complete|upload|retry|remove|delete|close|back|refresh|save|continue|checkout|ack)", current_style, re.IGNORECASE):
            continue
        dimension_name, value_text = match.groups()
        value = int(value_text)
        if dimension_name in {"height", "minHeight"} and value not in ALLOWED_VISUAL_DIMENSIONS:
            findings.append((path, line_number, current_style, f"{dimension_name}={value}; review semantic class and use a shared token or documented exception"))
        elif dimension_name in {"width", "minWidth"} and value < 44:
            findings.append((path, line_number, current_style, f"{dimension_name}={value}; icon/action touch frame may be smaller than 44"))
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, help="Mobile repo root; defaults to the current workspace")
    parser.add_argument("--strict", action="store_true", help="Exit 1 when findings remain")
    args = parser.parse_args()
    mobile_root = find_mobile_root((args.root or Path.cwd()).resolve())
    findings: list[tuple[Path, int, str, str]] = []
    for path in sorted((mobile_root / "src").rglob("*")):
        if path.suffix in SOURCE_EXTENSIONS and path.is_file():
            findings.extend(scan_file(path))
    if not findings:
        print("button-contract: no suspicious hard-coded button dimensions found")
        return 0
    print("button-contract: review these semantic-looking dimensions before changing them:")
    for path, line_number, style_name, reason in findings:
        print(f"- {path.relative_to(mobile_root)}:{line_number} {style_name}: {reason}")
    print(f"button-contract: {len(findings)} finding(s); classify each as button, exception, or non-button")
    return 1 if args.strict else 0


if __name__ == "__main__":
    sys.exit(main())
