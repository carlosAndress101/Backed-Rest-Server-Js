#!/usr/bin/env python3
"""Extract one non-empty, exact SemVer section from the curated changelog."""

import argparse
import re
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("version", help="release version without the leading v")
    parser.add_argument("changelog", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    changelog = args.changelog.read_text(encoding="utf-8")
    headings = list(re.finditer(r"(?m)^## \[(\d+\.\d+\.\d+)\].*$", changelog))
    matches = [index for index, match in enumerate(headings) if match.group(1) == args.version]

    if len(matches) != 1:
        print(
            f"Expected exactly one CHANGELOG section for [{args.version}], found {len(matches)}",
            file=sys.stderr,
        )
        return 1

    index = matches[0]
    start = headings[index].end()
    end = headings[index + 1].start() if index + 1 < len(headings) else len(changelog)
    notes = changelog[start:end].strip()
    if not notes:
        print(f"CHANGELOG section [{args.version}] is empty", file=sys.stderr)
        return 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(notes + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
