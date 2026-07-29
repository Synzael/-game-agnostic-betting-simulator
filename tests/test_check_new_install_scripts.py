"""
Tests for the CI check that flags newly introduced npm dependencies
with install scripts (scripts/check_new_install_scripts.py).

Covers the pure comparison logic plus an end-to-end run against a
temporary Git repository.
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from check_new_install_scripts import (
    LockfileError,
    find_new_install_script_packages,
    parse_lockfile_packages,
    run_check,
)

SCRIPT = Path(__file__).parent.parent / "scripts" / "check_new_install_scripts.py"


def lockfile(packages: dict) -> str:
    """Build minimal lockfileVersion-3 JSON text with the given packages."""
    return json.dumps(
        {
            "name": "fixture",
            "version": "1.0.0",
            "lockfileVersion": 3,
            "requires": True,
            "packages": {"": {"name": "fixture", "version": "1.0.0"}, **packages},
        }
    )


def packages_of(text: str) -> dict:
    return parse_lockfile_packages(text, "fixture")


class TestComparisonLogic:
    def test_new_dependency_with_install_script_is_flagged(self):
        base = packages_of(lockfile({}))
        head = packages_of(
            lockfile(
                {
                    "node_modules/evil-pkg": {
                        "version": "1.0.0",
                        "hasInstallScript": True,
                    }
                }
            )
        )
        findings = find_new_install_script_packages(base, head, "package-lock.json")
        assert len(findings) == 1
        assert findings[0].name == "evil-pkg"
        assert findings[0].version == "1.0.0"
        assert findings[0].key == "node_modules/evil-pkg"
        assert findings[0].lockfile == "package-lock.json"

    def test_new_dependency_without_install_script_passes(self):
        base = packages_of(lockfile({}))
        head = packages_of(
            lockfile({"node_modules/benign": {"version": "2.0.0"}})
        )
        assert find_new_install_script_packages(base, head, "l") == []

    def test_existing_dependency_with_install_script_passes(self):
        entry = {"node_modules/esbuild": {"version": "0.27.3", "hasInstallScript": True}}
        base = packages_of(lockfile(entry))
        head = packages_of(lockfile(entry))
        assert find_new_install_script_packages(base, head, "l") == []

    def test_existing_dependency_version_change_passes(self):
        base = packages_of(
            lockfile(
                {"node_modules/sharp": {"version": "0.34.5", "hasInstallScript": True}}
            )
        )
        head = packages_of(
            lockfile(
                {"node_modules/sharp": {"version": "0.35.0", "hasInstallScript": True}}
            )
        )
        assert find_new_install_script_packages(base, head, "l") == []

    def test_multiple_suspicious_dependencies_all_flagged(self):
        base = packages_of(lockfile({}))
        head = packages_of(
            lockfile(
                {
                    "node_modules/bad-one": {"version": "1.0.0", "hasInstallScript": True},
                    "node_modules/fine": {"version": "1.0.0"},
                    "node_modules/bad-two": {"version": "2.0.0", "hasInstallScript": True},
                }
            )
        )
        findings = find_new_install_script_packages(base, head, "l")
        assert sorted(f.name for f in findings) == ["bad-one", "bad-two"]

    def test_new_lockfile_uses_empty_baseline(self):
        head = packages_of(
            lockfile(
                {
                    "node_modules/native-thing": {
                        "version": "3.1.0",
                        "hasInstallScript": True,
                    },
                    "node_modules/plain": {"version": "1.0.0"},
                }
            )
        )
        findings = find_new_install_script_packages(None, head, "l")
        assert [f.name for f in findings] == ["native-thing"]

    def test_root_project_entry_ignored(self):
        head = packages_of(
            json.dumps(
                {
                    "lockfileVersion": 3,
                    "packages": {"": {"name": "root", "hasInstallScript": True}},
                }
            )
        )
        assert find_new_install_script_packages({}, head, "l") == []

    def test_nested_package_path_flagged_independently(self):
        # Same name already present at the top level, but a NEW nested copy
        # appears: flagged (the nested copy may be a different release).
        base = packages_of(
            lockfile(
                {"node_modules/dep": {"version": "1.0.0", "hasInstallScript": True}}
            )
        )
        head = packages_of(
            lockfile(
                {
                    "node_modules/dep": {"version": "1.0.0", "hasInstallScript": True},
                    "node_modules/wrapper/node_modules/dep": {
                        "version": "0.0.1",
                        "hasInstallScript": True,
                    },
                }
            )
        )
        findings = find_new_install_script_packages(base, head, "l")
        assert len(findings) == 1
        assert findings[0].key == "node_modules/wrapper/node_modules/dep"
        assert findings[0].name == "dep"

    def test_workspace_style_path_flagged(self):
        base = packages_of(lockfile({}))
        head = packages_of(
            lockfile(
                {
                    "packages/native-addon": {
                        "name": "@app/native-addon",
                        "version": "0.1.0",
                        "hasInstallScript": True,
                    }
                }
            )
        )
        findings = find_new_install_script_packages(base, head, "l")
        assert [f.name for f in findings] == ["@app/native-addon"]


class TestMalformedInput:
    def test_invalid_json_raises(self):
        with pytest.raises(LockfileError, match="not valid JSON"):
            parse_lockfile_packages("{not json", "broken")

    def test_non_object_top_level_raises(self):
        with pytest.raises(LockfileError, match="JSON object"):
            parse_lockfile_packages("[1, 2, 3]", "broken")

    def test_missing_packages_object_raises(self):
        # npm lockfileVersion 1 has no "packages" object: unsupported,
        # must fail closed instead of silently passing.
        v1 = json.dumps({"lockfileVersion": 1, "dependencies": {}})
        with pytest.raises(LockfileError, match="lockfileVersion: 1"):
            parse_lockfile_packages(v1, "legacy")

    def test_non_object_package_entry_raises(self):
        bad = json.dumps({"lockfileVersion": 3, "packages": {"node_modules/x": 42}})
        with pytest.raises(LockfileError, match="not an object"):
            parse_lockfile_packages(bad, "broken")


@pytest.fixture()
def git_repo(tmp_path):
    """Temporary git repo with helper to commit lockfile contents."""

    def git(*args):
        subprocess.run(
            ["git", *args],
            cwd=tmp_path,
            check=True,
            capture_output=True,
            env={
                "GIT_AUTHOR_NAME": "t",
                "GIT_AUTHOR_EMAIL": "t@t",
                "GIT_COMMITTER_NAME": "t",
                "GIT_COMMITTER_EMAIL": "t@t",
                "HOME": str(tmp_path),
                "PATH": "/usr/bin:/bin",
            },
        )

    git("init", "-q")

    def commit(files: dict) -> str:
        for rel, text in files.items():
            target = tmp_path / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
            git("add", rel)
        git("commit", "-q", "-m", "commit", "--allow-empty")
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=tmp_path,
            check=True,
            capture_output=True,
            text=True,
        )
        return out.stdout.strip()

    return tmp_path, commit


class TestEndToEnd:
    def test_clean_pr_exits_zero(self, git_repo, capsys):
        repo, commit = git_repo
        base = commit({"app/package-lock.json": lockfile({"node_modules/a": {"version": "1.0.0"}})})
        commit({"app/package-lock.json": lockfile({"node_modules/a": {"version": "1.1.0"}})})
        assert run_check(str(repo), base) == 0
        assert "OK" in capsys.readouterr().out

    def test_new_install_script_dep_exits_one(self, git_repo, capsys):
        repo, commit = git_repo
        base = commit({"app/package-lock.json": lockfile({})})
        commit(
            {
                "app/package-lock.json": lockfile(
                    {"node_modules/evil": {"version": "6.6.6", "hasInstallScript": True}}
                )
            }
        )
        assert run_check(str(repo), base) == 1
        out = capsys.readouterr().out
        assert "evil@6.6.6" in out
        assert "app/package-lock.json" in out
        assert "manual security review" in out

    def test_newly_added_lockfile_is_checked(self, git_repo):
        repo, commit = git_repo
        base = commit({"README.md": "hi"})
        commit(
            {
                "newapp/package-lock.json": lockfile(
                    {"node_modules/sneaky": {"version": "1.0.0", "hasInstallScript": True}}
                )
            }
        )
        assert run_check(str(repo), base) == 1

    def test_malformed_head_lockfile_fails_closed(self, git_repo, capsys):
        repo, commit = git_repo
        base = commit({"app/package-lock.json": lockfile({})})
        commit({"app/package-lock.json": "{broken"})
        assert run_check(str(repo), base) == 2
        assert "Failing closed" in capsys.readouterr().err

    def test_unavailable_base_revision_fails_closed(self, git_repo, capsys):
        repo, commit = git_repo
        commit({"app/package-lock.json": lockfile({})})
        missing_sha = "0" * 40
        assert run_check(str(repo), missing_sha) == 2
        assert "not available" in capsys.readouterr().err

    def test_cli_entrypoint_runs(self, git_repo):
        repo, commit = git_repo
        base = commit({"app/package-lock.json": lockfile({})})
        commit({"app/package-lock.json": lockfile({"node_modules/ok": {"version": "1.0.0"}})})
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--base", base, "--repo-root", str(repo)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr
        assert "OK" in result.stdout
