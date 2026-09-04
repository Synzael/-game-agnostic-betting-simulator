#!/usr/bin/env python3
"""
CI security check: flag newly introduced npm dependencies with install scripts.

Compares every tracked package-lock.json in the current checkout (the PR head)
against the same file at a base Git revision, and fails if the head lockfile
introduces a package entry that

  * did not exist in the base lockfile, and
  * declares "hasInstallScript": true.

Install/postinstall hooks run arbitrary code on every ``npm install``, so a
brand-new dependency carrying one is a common supply-chain attack vector.
Existing install-script dependencies (esbuild, sharp, ...) are unaffected
because they are present in the base lockfile.

Identity rule
-------------
A package is identified by its exact key in the lockfile's top-level
"packages" object -- i.e. its installation path, such as
``node_modules/foo`` or ``node_modules/a/node_modules/foo``. An entry is
"new" only if that exact key is absent from the base lockfile. Consequences:

* Version or metadata changes of an existing entry are NOT flagged.
* A package that appears at a new nested path (e.g. after a dedupe change)
  IS flagged even if the same name already exists elsewhere in the tree.
  This is intentional, fail-closed behaviour: a nested copy can resolve to a
  different, potentially malicious release.

The root project entry (``packages[""]``) is ignored.

Safety properties
-----------------
* Lockfiles are parsed as JSON with the Python standard library only.
* No ``npm`` invocation, no dependency lifecycle scripts, no JavaScript
  execution.
* Malformed or unsupported lockfiles (e.g. lockfileVersion 1 without a
  "packages" object) abort the check with a nonzero exit code rather than
  silently passing.

Exit codes: 0 = clean, 1 = suspicious dependency found, 2 = error.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Dict, List, Optional


class LockfileError(Exception):
    """Raised when a lockfile cannot be parsed or has an unsupported shape."""


@dataclass(frozen=True)
class Finding:
    """A newly introduced package entry that declares an install script."""

    lockfile: str
    key: str
    name: str
    version: str


def parse_lockfile_packages(text: str, label: str) -> Dict[str, dict]:
    """
    Parse lockfile JSON text and return its "packages" mapping.

    Parameters
    ----------
    text : str
        Raw lockfile contents.
    label : str
        Human-readable identifier (path plus revision) used in error messages.

    Raises
    ------
    LockfileError
        If the text is not valid JSON, is not an object, lacks a "packages"
        object (npm lockfileVersion 1 is unsupported), or contains
        non-object package entries.
    """
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise LockfileError(f"{label}: not valid JSON ({exc})") from exc

    if not isinstance(data, dict):
        raise LockfileError(f"{label}: expected a JSON object at the top level")

    packages = data.get("packages")
    if packages is None:
        version = data.get("lockfileVersion", "unknown")
        raise LockfileError(
            f"{label}: no top-level \"packages\" object "
            f"(lockfileVersion: {version}). Only npm lockfileVersion 2/3 "
            f"lockfiles are supported; refusing to pass unchecked."
        )
    if not isinstance(packages, dict):
        raise LockfileError(f"{label}: \"packages\" is not an object")

    for key, meta in packages.items():
        if not isinstance(meta, dict):
            raise LockfileError(
                f"{label}: package entry {key!r} is not an object"
            )
    return packages


def package_name_from_key(key: str, meta: dict) -> str:
    """Best-effort package name: explicit "name" field, else the path key."""
    name = meta.get("name")
    if isinstance(name, str) and name:
        return name
    marker = "node_modules/"
    idx = key.rfind(marker)
    if idx != -1:
        return key[idx + len(marker):]
    return key


def find_new_install_script_packages(
    base_packages: Optional[Dict[str, dict]],
    head_packages: Dict[str, dict],
    lockfile: str,
) -> List[Finding]:
    """
    Return head package entries absent from base that declare install scripts.

    Parameters
    ----------
    base_packages : dict or None
        "packages" mapping from the base revision, or None when the lockfile
        did not exist in the base (treated as an empty baseline).
    head_packages : dict
        "packages" mapping from the head revision.
    lockfile : str
        Repo-relative lockfile path, recorded on each finding.
    """
    baseline = base_packages if base_packages is not None else {}
    findings: List[Finding] = []
    for key, meta in head_packages.items():
        if key == "":  # root project entry
            continue
        if key in baseline:
            continue
        if meta.get("hasInstallScript"):
            findings.append(
                Finding(
                    lockfile=lockfile,
                    key=key,
                    name=package_name_from_key(key, meta),
                    version=str(meta.get("version", "unknown")),
                )
            )
    return findings


def git(args: List[str], repo_root: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=repo_root,
        capture_output=True,
        text=True,
    )


def list_head_lockfiles(repo_root: str) -> List[str]:
    """List tracked package-lock.json files in the current checkout."""
    result = git(["ls-files", "-z"], repo_root)
    if result.returncode != 0:
        raise LockfileError(f"git ls-files failed: {result.stderr.strip()}")
    return sorted(
        path
        for path in result.stdout.split("\0")
        if path and PurePosixPath(path).name == "package-lock.json"
    )


def read_base_lockfile(repo_root: str, base: str, path: str) -> Optional[str]:
    """
    Return the lockfile contents at ``base``, or None if it did not exist.

    Raises
    ------
    LockfileError
        If the base revision itself cannot be read (e.g. not fetched).
    """
    exists = git(["cat-file", "-e", f"{base}:{path}"], repo_root)
    if exists.returncode != 0:
        # Distinguish "file absent in base" from "base revision unreadable".
        rev_ok = git(["cat-file", "-e", f"{base}^{{commit}}"], repo_root)
        if rev_ok.returncode != 0:
            raise LockfileError(
                f"base revision {base!r} is not available locally; "
                f"ensure the workflow fetches enough history "
                f"({rev_ok.stderr.strip()})"
            )
        return None
    show = git(["show", f"{base}:{path}"], repo_root)
    if show.returncode != 0:
        raise LockfileError(
            f"could not read {path} at {base}: {show.stderr.strip()}"
        )
    return show.stdout


def run_check(repo_root: str, base: str) -> int:
    """Run the full check; returns the process exit code."""
    try:
        lockfiles = list_head_lockfiles(repo_root)
        if not lockfiles:
            print("No package-lock.json files found; nothing to check.")
            return 0

        all_findings: List[Finding] = []
        for path in lockfiles:
            try:
                head_text = (Path(repo_root) / path).read_text(
                    encoding="utf-8"
                )
            except OSError as exc:
                raise LockfileError(
                    f"could not read {path} in the working tree: {exc}"
                ) from exc
            head_packages = parse_lockfile_packages(
                head_text, f"{path} (head)"
            )

            base_text = read_base_lockfile(repo_root, base, path)
            if base_text is None:
                print(f"{path}: not present in base revision; "
                      f"treating every entry as newly introduced.")
                base_packages: Optional[Dict[str, dict]] = None
            else:
                base_packages = parse_lockfile_packages(
                    base_text, f"{path} (base {base})"
                )

            all_findings.extend(
                find_new_install_script_packages(
                    base_packages, head_packages, path
                )
            )
    except LockfileError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        print(
            "Failing closed: the lockfile comparison could not be completed.",
            file=sys.stderr,
        )
        return 2

    if not all_findings:
        print(
            f"OK: no newly introduced dependencies with install scripts "
            f"across {len(lockfiles)} lockfile(s)."
        )
        return 0

    print("SUSPICIOUS DEPENDENCIES DETECTED")
    print("=" * 60)
    for f in all_findings:
        print(f"  lockfile: {f.lockfile}")
        print(f"  package:  {f.name}@{f.version}")
        print(f"  key:      packages[\"{f.key}\"]")
        print("-" * 60)
    print(
        f"{len(all_findings)} newly introduced dependenc"
        f"{'y' if len(all_findings) == 1 else 'ies'} declare(s) "
        f"\"hasInstallScript\": true."
    )
    print(
        "Install scripts execute arbitrary code during `npm install` and are\n"
        "a common supply-chain attack vector. Each package above requires\n"
        "manual security review before this PR can merge: inspect the\n"
        "package's install/postinstall scripts on npm (do NOT install it),\n"
        "verify the publisher and repository, and confirm the dependency is\n"
        "genuinely needed. See scripts/README.md for the review procedure."
    )
    return 1


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Flag package-lock.json entries added since a base revision "
            "that declare \"hasInstallScript\": true."
        )
    )
    parser.add_argument(
        "--base",
        required=True,
        help="Base Git revision (the PR base commit SHA).",
    )
    parser.add_argument(
        "--repo-root",
        default=None,
        help="Repository root (default: git rev-parse --show-toplevel).",
    )
    args = parser.parse_args(argv)

    repo_root = args.repo_root
    if repo_root is None:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            print(
                f"ERROR: not inside a git repository: {result.stderr.strip()}",
                file=sys.stderr,
            )
            return 2
        repo_root = result.stdout.strip()

    return run_check(repo_root, args.base)


if __name__ == "__main__":
    sys.exit(main())
